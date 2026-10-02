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
$handle = [WinApi]::GetForegroundWindow()
$window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
$all = $window.FindAll(
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
Write-Output (ConvertTo-Json @($list) -Depth 5 -Compress)
`;

/** 把 PowerShell 脚本编码为 -EncodedCommand 需要的 UTF-16LE base64。 */
export function encodePsCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
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
 * 侦察前台窗口。
 * @param {object} opts
 * @param {(encoded:string,timeout:number)=>Promise<{stdout:string,stderr:string}>} [opts.runner]
 * @param {number} [opts.timeout=15000]
 * @returns {Promise<Array<object>>} 清洗后的原始元素记录（绝对物理坐标）
 */
export async function inspectViaUia({ runner, timeout = 15000 } = {}) {
  const run = runner ?? defaultRunner;
  const encoded = encodePsCommand(POWERSHELL_SCRIPT);
  let result;
  try {
    result = await run(encoded, timeout);
  } catch (error) {
    throw new Error(
      `UIA 侦察执行失败：${error?.message ?? error}。请确认在 Windows 上运行，且 PowerShell 可用。`
    );
  }
  const stdout = (result?.stdout ?? "").trim();
  if (!stdout) return [];
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`UIA 输出不是合法 JSON：${error.message}`);
  }
  const arr = Array.isArray(data) ? data : [data];
  return arr.map(cleanNumeric).filter((r) => r.bbox.w > 0 && r.bbox.h > 0);
}
