// 系统级原语：窗口枚举/聚焦、剪贴板读写、启动应用。
//
// 为什么不走 FFI：这些操作都需要读回 UTF-16 字符串或回调枚举窗口，
// 在没有 Windows 真机的环境下无法验证 koffi 的字符串/回调互操作，
// 写进去就是不可测代码。这里统一复用已经过测试的
// “PowerShell + -EncodedCommand(UTF-16LE) + JSON”通道（见 uia-inspect.mjs），
// runner 可注入，因此全部逻辑都能在任意平台跑单测。
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 把 PowerShell 脚本编码成 -EncodedCommand 需要的 UTF-16LE base64。 */
export function encodePsCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function defaultRunner(encoded, timeout) {
  const exe = process.platform === "win32" ? "powershell.exe" : "pwsh";
  return execFileAsync(
    exe,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { timeout, maxBuffer: 8 * 1024 * 1024 }
  );
}

const PREAMBLE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
`;

const USER32 = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SecAgentWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@
`;

async function runPs(script, { runner, timeout = 10000 }) {
  const run = runner ?? defaultRunner;
  const encoded = encodePsCommand(PREAMBLE + script);
  let result;
  try {
    result = await run(encoded, timeout);
  } catch (error) {
    throw new Error(`PowerShell 执行失败：${error?.message ?? error}`);
  }
  const stdout = (result?.stdout ?? "").trim();
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return stdout;
  }
}

/**
 * 列出可见顶层窗口（标题 + 进程 + 句柄）。
 * @returns {Promise<Array<{handle:string,title:string,pid:number}>>}
 */
export async function listWindows({ runner, timeout } = {}) {
  const script = `${USER32}
$list = New-Object System.Collections.ArrayList
foreach ($p in Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }) {
  [void]$list.Add([ordered]@{
    handle = $p.MainWindowHandle.ToString()
    pid    = [int]$p.Id
    title  = [string]$p.MainWindowTitle
  })
}
Write-Output (ConvertTo-Json @($list) -Depth 4 -Compress)`;
  const data = await runPs(script, { runner, timeout });
  const arr = Array.isArray(data) ? data : data ? [data] : [];
  return arr
    .map((item) => ({
      handle: String(item?.handle ?? ""),
      pid: Number(item?.pid) || 0,
      title: String(item?.title ?? "").replace(/\s+/g, " ").trim()
    }))
    .filter((item) => item.handle && item.title);
}

/**
 * 按标题正则聚焦窗口（不区分大小写）。无匹配时抛出并附上候选标题。
 * @param {{title:string, runner?:Function, timeout?:number}} opts
 */
export async function focusWindow({ title, runner, timeout } = {}) {
  const pattern = new RegExp(String(title ?? "").trim(), "i");
  const windows = await listWindows({ runner, timeout });
  const matched = windows.filter((w) => pattern.test(w.title));
  if (!matched.length) {
    const sample = windows.slice(0, 20).map((w) => w.title).join(" | ") || "(无可见窗口)";
    throw new Error(`没有标题匹配 /${pattern.source}/ 的窗口。当前窗口：${sample}`);
  }
  // 完全相等的优先，其次取首个。
  const target = matched.find((w) => w.title.toLowerCase() === String(title).trim().toLowerCase()) ?? matched[0];
  const script = `${USER32}
$h = [IntPtr]::new($(${target.handle}))
[void][SecAgentWin32]::ShowWindow($h, 9)
$ok = [SecAgentWin32]::SetForegroundWindow($h)
[void][SecAgentWin32]::BringWindowToTop($h)
Write-Output (ConvertTo-Json ([ordered]@{ focused = $ok; title = '${target.title.replace(/'/g, "''")}' }) -Compress)`;
  const res = await runPs(script, { runner, timeout });
  return { focused: Boolean(res?.focused), title: target.title, pid: target.pid, handle: target.handle };
}

/** 读取剪贴板文本。 */
export async function readClipboard({ runner, timeout } = {}) {
  const script = `
$t = Get-Clipboard -Raw -ErrorAction SilentlyContinue
if ($null -eq $t) { $t = '' }
Write-Output (ConvertTo-Json ([ordered]@{ text = [string]$t }) -Compress)`;
  const data = await runPs(script, { runner, timeout });
  return typeof data?.text === "string" ? data.text : "";
}

/** 写入剪贴板文本。 */
export async function writeClipboard({ text, runner, timeout } = {}) {
  const script = `
Set-Clipboard -Value ([string]::new([char[]]@(${Array.from(text ?? "").map((c) => Number(c.charCodeAt(0))).join(",")})))
Write-Output (ConvertTo-Json ([ordered]@{ ok = $true; length = ${String(text ?? "").length} }) -Compress)`;
  const data = await runPs(script, { runner, timeout });
  return { ok: Boolean(data?.ok), length: Number(data?.length) || 0 };
}

/**
 * 启动应用/打开文件（detached，不阻塞宿主）。
 * @param {{command:string, args?:string[], spawnImpl?:Function}} opts
 */
export function launchApp({ command, args = [], spawnImpl } = {}) {
  const target = String(command ?? "").trim();
  if (!target) throw new Error("launch 需要 command（可执行文件名或文件路径）");
  const spawn = spawnImpl ?? spawn;
  const child = spawn(target, args, { detached: true, stdio: "ignore" });
  child.unref?.();
  return { launched: target, args, pid: child.pid ?? null };
}