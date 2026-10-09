// Windows UI Automation（UIA）元素侦察。
// 通过 PowerShell + .NET UIAutomationClient 查询前台窗口的可交互控件树，
// 返回每个元素的名称、角色、AutomationId、包围矩形与中心点（系统给的精确坐标）。
//
// runner 可注入（测试用）；生产环境默认 execFile 调 powershell，
// 脚本以 -EncodedCommand（UTF-16LE base64）传输，杜绝转义问题。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinApi {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@
$root = __ROOT__
$all = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition)

$list = New-Object System.Collections.ArrayList
$i = 0
foreach ($el in $all) {
  $c = $el.Current
  $r = $c.BoundingRectangle
  if (-not $c.IsEnabled) { continue }
  if ($r.Width -le 0 -or $r.Height -le 0) { continue }
  $role = ($c.ControlType.ProgrammaticName -replace 'ControlType\\.', '')
  $hasName = -not [string]::IsNullOrWhiteSpace($c.Name)
  $isInteractive = $role -match 'Edit|Button|CheckBox|ComboBox|ListItem|TabItem?|Hyperlink|RadioButton|Slider|Menu|DataItem'
  if (-not $hasName -and -not $isInteractive) { continue }
  [void]$list.Add([ordered]@{
    id           = $i
    name         = $c.Name
    role         = $role
    automationId = $c.AutomationId
    bbox = [ordered]@{
      x = [int][Math]::Round($r.X)
      y = [int][Math]::Round($r.Y)
      w = [int][Math]::Round($r.Width)
      h = [int][Math]::Round($r.Height)
    }
    cx      = [int][Math]::Round($r.X + $r.Width / 2)
    cy      = [int][Math]::Round($r.Y + $r.Height / 2)
    enabled = $c.IsEnabled
  })
  $i++
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output (ConvertTo-Json ([ordered]@{ fgPid = $fgPid; elements = @($list) }) -Depth 6 -Compress)
`;

/** 把 PowerShell 脚本编码为 -EncodedCommand 需要的 UTF-16LE base64。 */
export function encodePsCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

// foreground = 只看前台窗口（快、准，默认）；desktop = 从桌面根节点出发，
// 可覆盖任务栏 / 桌面图标 / 后台窗口（慢、元素多）。
// foreground 时上报前台窗口进程号（fgPid）：宿主用它在 inspect 结果里
// 识别「前台其实是 SecAgent 自己」的误操作场景（0.5.4 实机踩坑：focus
// 按标题匹配不到动态歌名窗口，模型把宿主活动流当成目标点了个遍）。
const ROOTS = {
  foreground:
    "$root = [System.Windows.Automation.AutomationElement]::FromHandle([WinApi]::GetForegroundWindow())\n" +
    "$fgPid = [int]$root.Current.ProcessId",
  desktop:
    "$root = [System.Windows.Automation.AutomationElement]::RootElement\n" +
    "$fgPid = 0"
};

/** 生成指定侦察范围的 PowerShell 脚本（scope 非法时回退 foreground）。 */
export function buildUiaScript(scope = "foreground") {
  return POWERSHELL_SCRIPT.replace("__ROOT__", ROOTS[scope] ?? ROOTS.foreground);
}

function defaultRunner(encoded, timeout) {
  const exe = process.platform === "win32" ? "powershell.exe" : "pwsh";
  return execFileAsync(
    exe,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { timeout, maxBuffer: 12 * 1024 * 1024 }
  );
}

function cleanNumeric(rec) {
  const b = rec.bbox ?? {};
  return {
    name: typeof rec.name === "string" ? rec.name : "",
    role: typeof rec.role === "string" ? rec.role : "Unknown",
    automationId: typeof rec.automationId === "string" ? rec.automationId : "",
    bbox: {
      x: Number(b.x) | 0,
      y: Number(b.y) | 0,
      w: Number(b.w) | 0,
      h: Number(b.h) | 0
    },
    cx: Number(rec.cx) | 0,
    cy: Number(rec.cy) | 0,
    enabled: rec.enabled !== false
  };
}

/**
 * 侦察窗口元素。
 * @param {object} opts
 * @param {(encoded:string,timeout:number)=>Promise<{stdout:string,stderr:string}>} [opts.runner]
 * @param {number} [opts.timeout=15000]
 * @param {"foreground"|"desktop"} [opts.scope="foreground"]
 * @returns {Promise<{elements:Array<object>, foregroundPid:number}>}
 *   elements 为清洗后的原始元素记录（绝对物理坐标）；foregroundPid 为前台窗口
 *   进程号（desktop 范围或旧版脚本输出时为 0）。
 */
export async function inspectViaUia({ runner, timeout = 15000, scope = "foreground" } = {}) {
  const run = runner ?? defaultRunner;
  const encoded = encodePsCommand(buildUiaScript(scope));
  let result;
  try {
    result = await run(encoded, timeout);
  } catch (error) {
    throw new Error(
      `UIA 侦察执行失败：${error?.message ?? error}。请确认在 Windows 上运行，且 PowerShell 可用。`
    );
  }
  const stdout = (result?.stdout ?? "").trim();
  if (!stdout) return { elements: [], foregroundPid: 0 };
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`UIA 输出不是合法 JSON：${error.message}`);
  }
  // 兼容两种形状：新版 {fgPid, elements}；旧版/测试桩为纯元素数组。
  const isNewShape = data && !Array.isArray(data) && Array.isArray(data.elements);
  const arr = isNewShape ? data.elements : Array.isArray(data) ? data : [data];
  const foregroundPid = isNewShape ? (Number(data.fgPid) | 0) : 0;
  return {
    elements: arr.map(cleanNumeric).filter((r) => r.bbox.w > 0 && r.bbox.h > 0),
    foregroundPid
  };
}
