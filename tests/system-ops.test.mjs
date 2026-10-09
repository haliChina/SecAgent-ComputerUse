import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodePsCommand,
  listWindows,
  focusWindow,
  readClipboard,
  writeClipboard,
  launchApp
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
  assert.equal(seen.opts.detached, true);
  assert.equal(seen.unrefed, true);
  assert.throws(() => launchApp({ command: "  ", spawnImpl: () => fakeChild }), /launch 需要 command/);
});

test("launchApp：spawn 失败（ENOENT）转为友好报错，不产生未捕获异常", async () => {
  const { EventEmitter } = await import("node:events");
  const child = new EventEmitter();
  const pending = launchApp({ command: "no-such-app.exe", spawnImpl: () => child });
  child.emit("error", Object.assign(new Error("spawn no-such-app.exe ENOENT"), { code: "ENOENT" }));
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /启动失败（no-such-app\.exe）/);
    assert.match(error.message, /找不到该程序/);
    assert.match(error.message, /只能启动可执行文件/);
    return true;
  });
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