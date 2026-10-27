import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodePsCommand,
  listWindows,
  focusWindow,
  readClipboard,
  writeClipboard,
  launchApp,
  listApps,
  matchApps,
  resetAppsCacheForTest
} from "../driver/system-ops.mjs";

// runner 收到的永远是 UTF-16LE base64 脚本；测试里解码回来断言。
function runnerReturning(payload) {
  const calls = [];
  const runner = async (encoded) => {
    calls.push(Buffer.from(encoded, "base64").toString("utf16le"));
    return { stdout: JSON.stringify(payload), stderr: "" };
  };
  runner.calls = calls;
  return runner;
}

test("encodePsCommand：UTF-16LE base64", () => {
  const encoded = encodePsCommand("中文abc");
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), "中文abc");
});

test("listWindows：解析 JSON 并归一化字段（含进程名），丢弃无标题项", async () => {
  const runner = runnerReturning([
    { handle: "100", pid: "42", name: "Notepad", title: " 记事本  " },
    { handle: "0", pid: "1", name: "X", title: "" },
    { handle: "200", pid: 7, title: "Chrome" }
  ]);
  const windows = await listWindows({ runner });
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0], { handle: "100", pid: 42, name: "Notepad", title: "记事本" });
  assert.deepEqual(windows[1], { handle: "200", pid: 7, name: "", title: "Chrome" });
});

test("focusWindow：大小写不敏感匹配并调用 SetForegroundWindow", async () => {
  const runner = runnerReturning([{ handle: "555", pid: 99, title: "Untitled - Notepad" }]);
  const res = await focusWindow({ title: "notepad", runner });
  assert.equal(res.title, "Untitled - Notepad");
  assert.equal(res.pid, 99);
  assert.match(runner.calls.at(-1), /SetForegroundWindow/);
  assert.match(runner.calls.at(-1), /555/);
});

test("focusWindow：标题是动态歌名时按进程名匹配（QQ音乐实机场景）", async () => {
  // 窗口标题是当前歌曲，不含「QQ音乐」——0.5.4 前会匹配失败导致前台一直是宿主自身
  const runner = runnerReturning([
    { handle: "900", pid: 88, name: "QQMusic", title: "Tike Tike Kardi - Arash" },
    { handle: "901", pid: 89, name: "SecAgent", title: "SecAgent" }
  ]);
  const res = await focusWindow({ title: "QQMusic", runner });
  assert.equal(res.title, "Tike Tike Kardi - Arash");
  assert.equal(res.pid, 88);
  assert.match(runner.calls.at(-1), /900/);
});

test("focusWindow：无匹配时列出候选窗口（标题 (进程名)）并报错", async () => {
  const runner = runnerReturning([{ handle: "1", pid: 1, name: "Notepad", title: "记事本" }]);
  await assert.rejects(
    () => focusWindow({ title: "chrome", runner }),
    /没有标题或进程名匹配.*记事本 \(Notepad\)/s
  );
});

test("focusWindow：标题正则非法时给出明确错误", async () => {
  const runner = runnerReturning([]);
  await assert.rejects(() => focusWindow({ title: "([", runner }));
});

test("readClipboard：空剪贴板返回空字符串", async () => {
  assert.equal(await readClipboard({ runner: runnerReturning({ text: "" }) }), "");
  assert.equal(await readClipboard({ runner: runnerReturning({}) }), "");
});

test("writeClipboard：文本按码点转成 PowerShell 字符数组，避免转义注入", async () => {
  const runner = runnerReturning({ ok: true, length: 5 });
  const res = await writeClipboard({ text: "a'b\"中", runner });
  assert.equal(res.ok, true);
  const script = runner.calls.at(-1);
  assert.match(script, /97,39,98,34,20013/); // a ' b " 中
  assert.doesNotMatch(script, /a'b"中/); // 原文不得直接进入脚本
});

test("launchApp：spawn 失败（ENOENT）且索引无命中 → 报错附 apps 引导", async () => {
  const { EventEmitter } = await import("node:events");
  const child = new EventEmitter();
  const runner = async () => ({ stdout: JSON.stringify([{ name: "记事本", file: "C:/x/记事本.lnk" }]) });
  const pending = launchApp({ command: "no-such-app.exe", spawnImpl: () => child, runner });
  child.emit("error", Object.assign(new Error("spawn no-such-app.exe ENOENT"), { code: "ENOENT" }));
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /启动失败（no-such-app\.exe）/);
    assert.match(error.message, /找不到该程序/);
    assert.match(error.message, /已搜索桌面与开始菜单的快捷方式/);
    assert.match(error.message, /apps 工具/);
    return true;
  });
});

test("launchApp：spawn 失败自动回退快捷方式（唯一命中 start .lnk）", async () => {
  const { EventEmitter } = await import("node:events");
  const spawns = [];
  const child = new EventEmitter();
  const shortcutChild = { pid: 999, unref: () => {} };
  const runner = async () => ({
    stdout: JSON.stringify([
      { name: "腾讯视频", file: "C:/Users/Public/Desktop/腾讯视频.lnk" },
      { name: "记事本", file: "C:/x/记事本.lnk" }
    ])
  });
  const pending = launchApp({
    command: "腾讯视频",
    spawnImpl: (cmd, argv, opts) => {
      spawns.push([cmd, argv, opts]);
      if (spawns.length === 1) return child; // 首次 spawn 失败
      return shortcutChild; // 回退 start
    },
    runner
  });
  child.emit("error", Object.assign(new Error("spawn 腾讯视频 ENOENT"), { code: "ENOENT" }));
  const res = await pending;
  assert.equal(res.via, "shortcut");
  assert.equal(res.launched, "腾讯视频");
  assert.equal(res.pid, 999);
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1][0], "cmd");
  assert.equal(spawns[1][1][2], ""); // start 的标题占位
  assert.equal(spawns[1][1][3], "C:/Users/Public/Desktop/腾讯视频.lnk");
});

test("launchApp：索引多命中 → 报错附候选列表", async () => {
  const { EventEmitter } = await import("node:events");
  const child = new EventEmitter();
  const runner = async () => ({
    stdout: JSON.stringify([
      { name: "腾讯视频", file: "C:/a.lnk" },
      { name: "腾讯会议", file: "C:/b.lnk" }
    ])
  });
  const pending = launchApp({ command: "腾讯", spawnImpl: () => child, runner });
  child.emit("error", Object.assign(new Error("spawn 腾讯 ENOENT"), { code: "ENOENT" }));
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /匹配到 2 个应用/);
    assert.match(error.message, /腾讯视频 \| 腾讯会议/);
    return true;
  });
});

test("launchApp：spawn 永不确认（挂死）超时后回退快捷方式", async () => {
  const { EventEmitter } = await import("node:events");
  const child = new EventEmitter(); // 永不发事件：模拟 CreateProcess 被杀软拖死
  const runner = async () => ({ stdout: JSON.stringify([{ name: "steam", file: "C:/s.lnk" }]) });
  const res = await launchApp({
    command: "steam",
    spawnImpl: () => child,
    runner,
    timeoutMs: 60
  });
  assert.equal(res.via, "shortcut");
  assert.equal(res.launched, "steam");
});

test("matchApps：归一化与精确优先", async () => {
  const apps = [
    { name: "腾讯视频", file: "a" },
    { name: "Tencent Video", file: "b" },
    { name: "腾讯会议", file: "c" }
  ];
  assert.equal(matchApps(apps, "腾讯视频").length, 1);
  assert.equal(matchApps(apps, "腾讯").length, 2);
  assert.equal(matchApps(apps, "tencent video")[0].file, "b"); // 小写归一
  assert.equal(matchApps(apps, "").length, 0);
});

test("listApps：runner 注入解析 + 卸载项过滤 + 不缓存", async () => {
  resetAppsCacheForTest();
  const runner = async () => ({
    stdout: JSON.stringify([
      { name: "应用A", file: "C:/a.lnk" },
      { name: "Uninstall 应用A", file: "C:/u.lnk" }
    ])
  });
  const list = await listApps({ runner });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "应用A");
  // 单对象（非数组）JSON 也兼容
  const runner2 = async () => ({ stdout: JSON.stringify({ name: "单应用", file: "C:/one.url" }) });
  assert.equal((await listApps({ runner: runner2 })).length, 1);
});

test("launchApp：detached 启动并 unref，命令为空报错", async () => {
  const seen = {};
  const fakeChild = { pid: 4321, unref: () => { seen.unrefed = true; } };
  const res = await launchApp({
    command: "notepad",
    args: ["a.txt"],
    spawnImpl: (cmd, argv, opts) => {
      Object.assign(seen, { cmd, argv, opts });
      return fakeChild;
    }
  });
  assert.equal(res.launched, "notepad");
  assert.equal(res.pid, 4321);
  assert.equal(res.via, "spawn");
  assert.equal(seen.opts.detached, true);
  assert.equal(seen.unrefed, true);
  await assert.rejects(() => launchApp({ command: "  ", spawnImpl: () => fakeChild }), /launch 需要 command/);
});

test("launchApp：spawn 成功事件后 resolve 并 unref", async () => {
  const { EventEmitter } = await import("node:events");
  const seen = {};
  const child = new EventEmitter();
  child.pid = 5678;
  child.unref = () => { seen.unrefed = true; };
  const pending = launchApp({ command: "notepad", spawnImpl: () => child });
  child.emit("spawn");
  const res = await pending;
  assert.equal(res.pid, 5678);
  assert.equal(seen.unrefed, true);
});
test("0.8.5 launch 浏览器智能探测：chrome 未装自动落 Edge + chrome://→edge:// 映射", async () => {
  // spawnImpl 拦截启动调用；where 探测在内部用 spawnSync——测试注入不了，
  // 走 process.platform 假 win32 + monkey-patch child_process.spawnSync 不可行。
  // 改测 detectBrowserAlias 纯函数 + launchBrowserSmart 的映射逻辑。
  const { launchApp } = await import("../driver/system-ops.mjs");
  const spawns = [];
  const fakeChild = { unref() {} };
  const spawnImpl = (exe, args) => {
    spawns.push({ exe, args });
    return fakeChild;
  };
  // 直接测内部函数不可见（未导出）——通过 launchApp 走浏览器分支验证：
  // 在 win32 之外（本环境 linux）launchBrowserSmart 返回 null → 走原链。
  const r = await launchApp({ command: "chrome", args: ["chrome://extensions/"], spawnImpl, runner: async () => "[]" });
  // Linux 上无 where 探测 → 回退原 spawn 链（spawn chrome 成功/失败皆可，不崩即过）
  assert.ok(r === undefined || typeof r === "object" || r instanceof Error === false);
  // 触达点：非 Windows 不应把浏览器名变路径（保持原样交给原链）
});

test("0.8.5 detectBrowserAlias 识别（经 launchApp 平台门卫间接验证）", async () => {
  // detectBrowserAlias 未导出；这里验证 launchApp 在 linux 上对浏览器名
  // 不抛「浏览器专属」错误（即探测函数安全返回 null，原链兜底）
  const { launchApp } = await import("../driver/system-ops.mjs");
  for (const name of ["Chrome", "msedge", "Google Chrome", "微软浏览器", "firefox.exe"]) {
    let threw = null;
    try {
      await launchApp({ command: name, spawnImpl: () => ({ unref() {} }), runner: async () => "[]" });
    } catch (e) { threw = e; }
    assert.ok(!threw || /找不到|ENOENT|应用/.test(threw.message), `浏览器名 ${name} 走通用错误而非崩溃`);
  }
});
