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
  # 0.8.4：语义状态采集（仅对相关角色查 pattern，控制遍历开销）——
  # value=输入框现值；toggle=勾选态；expand=展开态；selected=选中态；
  # runtimeId 供 act/set_value/click 按元素直调与失效重查。密码框绝不回读值。
  $value = $null; $toggleState = $null; $expandState = $null; $selected = $null
  if ($c.IsPassword) {
    $value = '(密码，已隐藏)'
  } elseif ($role -match '^(Edit|Document|ComboBox)$') {
    $p = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $value = $p.Current.Value }
  }
  if ($role -match '^(CheckBox|RadioButton|ToggleButton)$') {
    $p = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $toggleState = $p.Current.ToggleState.ToString() }
  }
  if ($role -match '^(ComboBox|MenuItem|SplitButton)$') {
    $p = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $expandState = $p.Current.ExpandCollapseState.ToString() }
  }
  if ($role -match '^(ListItem|TabItem|DataItem|RadioButton|TreeItem)$') {
    $p = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $selected = [bool]$p.Current.IsSelected }
  }
  [void]$list.Add([ordered]@{
    id           = $i
    name         = $c.Name
    role         = $role
    automationId = $c.AutomationId
    runtimeId    = @($el.GetRuntimeId())
    bbox = [ordered]@{
      x = [int][Math]::Round($r.X)
      y = [int][Math]::Round($r.Y)
      w = [int][Math]::Round($r.Width)
      h = [int][Math]::Round($r.Height)
    }
    cx      = [int][Math]::Round($r.X + $r.Width / 2)
    cy      = [int][Math]::Round($r.Y + $r.Height / 2)
    enabled = $c.IsEnabled
    value   = $value
    toggleState  = $toggleState
    expandState  = $expandState
    selected     = $selected
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

// 0.8.4：语义动作执行脚本。按 inspect 上报的 runtimeId 在前台窗口内重新
// 解析元素（RuntimeId 是 UIA 会话内稳定的元素标识，界面重绘后旧 id 失效即
// 报 ELEMENT_NOT_FOUND，绝不盲点旧坐标）。动作映射：
//   invoke   = InvokePattern.Invoke（按钮/菜单项的默认动作）
//   toggle   = TogglePattern.Toggle（勾选框切换）
//   expand   = ExpandCollapsePattern.Expand/Collapse（按当前态取反）
//   select   = SelectionItemPattern.Select（列表项/标签页选中）
//   setValue = ValuePattern.SetValue（输入框直设值，绕开焦点与键盘）
// 脚本输出单行 JSON：{ok, action, found, newState?, error?}
const ACTION_SCRIPT_TEMPLATE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinApi2 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@
$rid = __RUNTIME_ID__
$act = '__ACTION__'
$value = __VALUE_JSON__
$root = [System.Windows.Automation.AutomationElement]::FromHandle([WinApi2]::GetForegroundWindow())
# RuntimeId 不能作 PropertyCondition（不可搜索属性），FindAll 后逐元素比对。
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition)
$el = $null
foreach ($cand in $all) {
  $candRid = $cand.GetRuntimeId()
  if ($candRid.Count -ne $rid.Count) { continue }
  $same = $true
  for ($k = 0; $k -lt $rid.Count; $k++) {
    if ([int]$candRid[$k] -ne [int]$rid[$k]) { $same = $false; break }
  }
  if ($same) { $el = $cand; break }
}
if (-not $el) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output '{"ok":false,"found":false,"error":"ELEMENT_NOT_FOUND: runtimeId 在前台窗口已不存在（界面已变化），请重新 inspect"}'
  exit 0
}
$p = $null
try {
  switch ($act) {
    'invoke' {
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { throw 'NOT_INVOKABLE' }
      $p.Invoke()
    }
    'toggle' {
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { throw 'NOT_TOGGLEABLE' }
      $p.Toggle()
      Start-Sleep -Milliseconds 60
      if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) {
        $after = $p.Current.ToggleState.ToString()
      }
    }
    'expand' {
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { throw 'NOT_EXPANDABLE' }
      if ($p.Current.ExpandCollapseState -eq 'Expanded') { $p.Collapse() } else { $p.Expand() }
      Start-Sleep -Milliseconds 60
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
        $after = $p.Current.ExpandCollapseState.ToString()
      }
    }
    'select' {
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { throw 'NOT_SELECTABLE' }
      $p.Select()
      Start-Sleep -Milliseconds 60
      if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
        $after = [bool]$p.Current.IsSelected
      }
    }
    'setValue' {
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { throw 'NOT_SETTABLE' }
      $p.SetValue([string]$value)
      Start-Sleep -Milliseconds 60
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
        $after = $p.Current.Value
      }
    }
    default { throw ("UNKNOWN_ACTION: " + $act) }
  }
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $stateJson = if ($null -ne $after) { ('"newState":' + (ConvertTo-Json $after -Compress) + ',') } else { '' }
  Write-Output ('{"ok":true,"found":true,"action":"' + $act + '",' + $stateJson + '"runtimeOk":true}')
} catch {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $msg = ([string]($_.Exception.Message) -replace '\\', '\\\\' -replace '"', '\\"' -replace \`r?\`n", ' ')
  Write-Output ('{"ok":false,"found":true,"error":"' + $msg + '"}')
  exit 0
}
`;

/** 生成语义动作 PowerShell 脚本。runtimeId 为 inspect 上报的整型数组。 */
export function buildUiaActionScript(runtimeId, action, value = null) {
  const rid = (runtimeId ?? [])
    .map((n) => Math.round(Number(n) || 0))
    .join(",");
  const valueJson = JSON.stringify(value ?? "");
  return ACTION_SCRIPT_TEMPLATE.replace("__RUNTIME_ID__", `@(${rid})`)
    .replace("__ACTION__", String(action))
    .replace("__VALUE_JSON__", valueJson);
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
  const out = {
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
  // 0.8.4 语义状态字段（inspect 脚本新增；旧测试桩没有则跳过）
  const rid = Array.isArray(rec.runtimeId) ? rec.runtimeId.map((n) => Math.round(Number(n) || 0)) : null;
  if (rid) out.runtimeId = rid;
  if (typeof rec.value === "string" && rec.value !== "") out.value = rec.value;
  if (rec.toggleState != null) out.toggleState = String(rec.toggleState);
  if (rec.expandState != null) out.expandState = String(rec.expandState);
  if (rec.selected != null) out.selected = rec.selected === true || rec.selected === "true";
  return out;
}

/**
 * 按 runtimeId 对前台窗口元素执行语义动作（0.8.4）。
 * @param {object} opts
 * @param {(encoded:string,timeout:number)=>Promise<{stdout:string,stderr:string}>} [opts.runner]
 * @param {number[]} opts.runtimeId inspect 上报的 RuntimeId 数组
 * @param {"invoke"|"toggle"|"expand"|"select"|"setValue"} opts.action
 * @param {string} [opts.value] setValue 的目标值
 * @param {number} [opts.timeout=15000]
 * @returns {Promise<{ok:boolean,found?:boolean,action?:string,newState?:string,error?:string}>}
 */
export async function actViaUia({ runner, runtimeId, action, value = null, timeout = 15000 } = {}) {
  const run = runner ?? defaultRunner;
  if (!Array.isArray(runtimeId) || !runtimeId.length)
    return { ok: false, error: "ELEMENT_NO_RUNTIME_ID: 该元素来自旧地图或非 UIA 后端，无 runtimeId。请重新 inspect 再试。" };
  const encoded = encodePsCommand(buildUiaActionScript(runtimeId, action, value));
  let result;
  try {
    result = await run(encoded, timeout);
  } catch (error) {
    return { ok: false, error: `UIA 动作执行失败：${error?.message ?? error}` };
  }
  const stdout = (result?.stdout ?? "").trim();
  if (!stdout) return { ok: false, error: "UIA 动作无输出（PowerShell 异常退出）" };
  // 脚本可能混入非 JSON 警告行，取最后一行 JSON。
  const lastLine = stdout.split(/\r?\n/).filter(Boolean).at(-1);
  try {
    const parsed = JSON.parse(lastLine);
    return {
      ok: parsed.ok === true,
      found: parsed.found !== false,
      action: parsed.action ?? action,
      ...(parsed.newState !== undefined ? { newState: parsed.newState } : {}),
      ...(parsed.error ? { error: String(parsed.error) } : {})
    };
  } catch {
    return { ok: false, error: `UIA 动作输出无法解析：${lastLine.slice(0, 300)}` };
  }
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
