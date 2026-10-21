// 系统级原语：窗口枚举/聚焦、剪贴板读写、启动应用。
//
// 为什么不走 FFI：这些操作都需要读回 UTF-16 字符串或回调枚举窗口，
// 在没有 Windows 真机的环境下无法验证 koffi 的字符串/回调互操作，
// 写进去就是不可测代码。这里统一复用已经过测试的
// “PowerShell + -EncodedCommand(UTF-16LE) + JSON”通道（见 uia-inspect.mjs），
// runner 可注入，因此全部逻辑都能在任意平台跑单测。
import { execFile, spawn as defaultSpawn } from "node:child_process";
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
    name   = $p.ProcessName
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
      name: String(item?.name ?? "").trim(),
      title: String(item?.title ?? "").replace(/\s+/g, " ").trim()
    }))
    .filter((item) => item.handle && item.title);
}

/**
 * 按标题或进程名正则聚焦窗口（不区分大小写）。无匹配时抛出并附上候选。
 * 很多应用的窗口标题是动态内容（播放器显示歌名、编辑器显示文件名），
 * 此时按进程名匹配更稳（如 QQMusic / notepad）。
 * @param {{title:string, runner?:Function, timeout?:number}} opts
 */
export async function focusWindow({ title, runner, timeout } = {}) {
  const pattern = new RegExp(String(title ?? "").trim(), "i");
  const windows = await listWindows({ runner, timeout });
  const matched = windows.filter((w) => pattern.test(w.title) || pattern.test(w.name));
  if (!matched.length) {
    const sample =
      windows
        .slice(0, 20)
        .map((w) => (w.name ? `${w.title} (${w.name})` : w.title))
        .join(" | ") || "(无可见窗口)";
    throw new Error(
      `没有标题或进程名匹配 /${pattern.source}/ 的窗口。当前窗口（标题 (进程名)）：${sample}`
    );
  }
  // 完全相等的优先（标题或进程名），其次取首个。
  const wanted = String(title).trim().toLowerCase();
  const target =
    matched.find(
      (w) => w.title.toLowerCase() === wanted || (w.name && w.name.toLowerCase() === wanted)
    ) ?? matched[0];
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
 * 启动应用（detached，不阻塞宿主）。
 *
 * 0.7.1 起 launch 是一条完整的「应用启动链」（修 #12 会话实锤的翻车点：
 * launch("msedge") 因 PATH/CreateProcess 问题永久挂起，而桌面明明有
 * 目标应用快捷方式）：
 *   1. 直接 spawn 可执行（现状，PATH/App Paths 可解析时最干净）；
 *   2. 失败（ENOENT）或超时（默认 15s 未确认，杀软钩子/慢 CreateProcess）
 *      → 自动回退**快捷方式索引**：桌面 + 两处开始菜单的 .lnk/.url 按名称
 *      归一化匹配（如「腾讯视频」），唯一命中即 start 该快捷方式（自带
 *      参数/工作目录/管理员标记）；多命中则报错附候选；
 *   3. 索引也无命中 → 报错附 apps 工具用法。
 * 注意：仅支持可执行文件（PE）。spawn 失败以异步 'error' 事件到达，
 * 未监听就是 uncaughtException，因此全部转为友好报错。
 * @param {{command:string, args?:string[], spawnImpl?:Function,
 *          runner?:Function, timeoutMs?:number}} opts
 * @returns {Promise<{launched:string, args?:string[], pid?:number|null, via?:"spawn"|"shortcut"}>}
 */
export async function launchApp({ command, args = [], spawnImpl, runner, timeoutMs = 15000 } = {}) {
  const target = String(command ?? "").trim();
  if (!target) throw new Error("launch 需要 command（可执行文件名或应用名，如 notepad、腾讯视频）");
  // 注意：局部名不能叫 spawn——会遮蔽顶部 import 并落入自身 TDZ，
  // “const spawn = spawnImpl ?? spawn” 在生产路径（不注入 spawnImpl）必抛
  // “Cannot access 'spawn' before initialization”（注入 fake 的测试因 ?? 短路而全绿）。
  const spawnFn = spawnImpl ?? defaultSpawn;

  const trySpawn = () =>
    new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnFn(target, args, { detached: true, stdio: "ignore" });
      } catch (error) {
        reject(new Error(launchErrorMessage(target, error)));
        return;
      }
      // 兼容无事件接口的注入实现（测试）
      if (!child || typeof child.once !== "function") {
        child?.unref?.();
        resolve({ launched: target, args, pid: child?.pid ?? null, via: "spawn" });
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 超时：进程创建可能被杀软/系统拖死（实锤场景）。不再等事件，
        // 交给调用方走快捷方式回退（单实例应用自行去重，双开风险小）。
        reject(new LaunchTimeoutError(target, timeoutMs));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.unref?.();
        resolve({ launched: target, args, pid: child?.pid ?? null, via: "spawn" });
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new LaunchSpawnError(target, error));
      });
    });

  let spawnResult = null;
  let spawnError = null;
  try {
    spawnResult = await trySpawn();
  } catch (error) {
    spawnError = error;
  }
  if (spawnResult) return spawnResult;

  // —— 快捷方式回退：应用名匹配（「找不到用户想启动的应用」的解药）。
  let apps = [];
  try {
    apps = await listApps({ runner });
  } catch { /* 索引失败保留原始报错 */ }
  const matched = matchApps(apps, target);
  if (matched.length === 1) {
    const hit = matched[0];
    const launchViaShortcut = () =>
      new Promise((resolve, reject) => {
        let child;
        try {
          // start 的标题参数留空串，路径含空格/中文由数组参数安全转义。
          child = spawnFn("cmd", ["/c", "start", "", hit.file], { detached: true, stdio: "ignore" });
        } catch (error) {
          reject(new Error(launchErrorMessage(hit.file, error)));
          return;
        }
        if (!child || typeof child.once !== "function") {
          child?.unref?.();
          resolve({ launched: hit.name, via: "shortcut", pid: child?.pid ?? null });
          return;
        }
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ launched: hit.name, via: "shortcut", pid: null }); // start 异步成功即不阻塞
        }, 8000);
        if (timer.unref) timer.unref();
        child.once("spawn", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.unref?.();
          resolve({ launched: hit.name, via: "shortcut", pid: child.pid ?? null });
        });
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(launchErrorMessage(hit.name, error)));
        });
      });
    return await launchViaShortcut();
  }
  if (matched.length > 1) {
    const list = matched.slice(0, 10).map((a) => a.name).join(" | ");
    throw new Error(
      `「${target}」匹配到 ${matched.length} 个应用：${list}。请用更精确的名称重试 launch。`
    );
  }

  // 索引也无命中：把两层原因都讲清楚。
  const timeoutNote = spawnError instanceof LaunchTimeoutError
    ? `启动确认超时（${timeoutMs}ms，可能被安全软件拖慢，或进程已在创建中）。`
    : "";
  throw new Error(
    `启动失败（${target}）：${timeoutNote}${timeoutNote ? " " : ""}${spawnError instanceof LaunchSpawnError ? spawnError.hint : (spawnError?.message ?? String(spawnError))}。` +
    `已搜索桌面与开始菜单的快捷方式（共 ${apps.length} 个）未找到「${target}」。` +
    `建议：先用 apps 工具按名称搜索已安装应用（如 apps(query="腾讯")），再用 launch 启动；打开网址可直接 launch("msedge", ["https://…"]) 或 launch("cmd", ["/c", "start", "", "https://…"])。`
  );
}

/** 内部错误类型：区分「确认超时」与「spawn 失败」，用于回退与文案。 */
class LaunchTimeoutError extends Error {
  constructor(target, ms) {
    super(`launch 超时（${target}，${ms}ms）`);
    this.name = "LaunchTimeoutError";
  }
}
class LaunchSpawnError extends Error {
  constructor(target, cause) {
    super(`launch 失败（${target}）：${cause?.message ?? cause}`);
    this.name = "LaunchSpawnError";
    this.code = cause?.code;
    this.hint = launchHint(cause);
  }
}

function launchHint(error) {
  const code = error?.code;
  if (code === "ENOENT")
    return "找不到该程序（不在 PATH）。可执行文件请写完整路径或名称；应用直接写名字即可走快捷方式回退。";
  if (code === "EACCES") return "没有执行权限。";
  return error?.message ?? String(error);
}

function launchErrorMessage(target, error) {
  return `启动失败（${target}）：${launchHint(error)}`;
}

// ---------------------------------------------------------------------------
// 已安装应用索引（桌面 + 开始菜单快捷方式）。
// ---------------------------------------------------------------------------

const APPS_TTL_MS = 5 * 60 * 1000;
let appsCache = null; // { value: Array, at: number }

/**
 * 列出可启动应用（快捷方式）：桌面 + 两个开始菜单目录的 .lnk/.url 文件名。
 * 结果缓存 5 分钟（开始菜单递归扫描一次 ~1s）；注入 runner 时不缓存（测试确定性）。
 * @returns {Promise<Array<{name:string,file:string}>>}
 */
export async function listApps({ runner, timeout = 20000, force = false } = {}) {
  if (!runner && !force && appsCache && Date.now() - appsCache.at < APPS_TTL_MS) {
    return appsCache.value;
  }
  const script = `
$dirs = @(
  [Environment]::GetFolderPath('Desktop'),
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs"
) | Where-Object { Test-Path $_ }
$apps = @()
foreach ($d in $dirs) {
  $apps += Get-ChildItem -LiteralPath $d -Recurse -Include *.lnk,*.url -File -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -notmatch 'uninstall|卸载|help|readme|更新|update' } |
    ForEach-Object { [ordered]@{ name = $_.BaseName; file = $_.FullName } }
}
Write-Output (ConvertTo-Json @($apps) -Depth 3 -Compress)`;
  const data = await runPs(script, { runner, timeout });
  const arr = Array.isArray(data) ? data : data ? [data] : [];
  const value = arr
    .map((item) => ({ name: String(item?.name ?? "").trim(), file: String(item?.file ?? "").trim() }))
    // 双保险：PS 侧已过滤卸载项；这里再挡一次（含 runner 直供 JSON 的测试路径）
    .filter((a) => a.name && a.file && !/uninstall|卸载|help|readme|更新|update/i.test(a.name));
  if (!runner) appsCache = { value, at: Date.now() };
  return value;
}

/** 测试专用：清空应用索引缓存。 */
export function resetAppsCacheForTest() {
  appsCache = null;
}

/** 名称归一化：小写 + 去空白（中文应用名常见「腾讯视频」「腾讯视频.lnk」）。 */
const normAppName = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, "");

/**
 * 按名称匹配已安装应用。排序：精确相等 > 互相包含 > 其余。
 * @returns {Array<{name:string,file:string}>}
 */
export function matchApps(apps, query) {
  const q = normAppName(query);
  if (!q) return [];
  const hits = apps.filter((a) => {
    const n = normAppName(a.name);
    return n === q || n.includes(q) || q.includes(n);
  });
  return hits.sort((a, b) => {
    const rank = (x) => (normAppName(x.name) === q ? 0 : 1);
    return rank(a) - rank(b);
  });
}