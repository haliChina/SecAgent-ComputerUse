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

test("listWindows：解析 JSON 并归一化字段，丢弃无标题项", async () => {
  const runner = runnerReturning([
    { handle: "100", pid: "42", title: " 记事本  " },
    { handle: "0", pid: "1", title: "" },
    { handle: "200", pid: 7, title: "Chrome" }
  ]);
  const windows = await listWindows({ runner });
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0], { handle: "100", pid: 42, title: "记事本" });
  assert.deepEqual(windows[1], { handle: "200", pid: 7, title: "Chrome" });
});

test("focusWindow：大小写不敏感匹配并调用 SetForegroundWindow", async () => {
  const runner = runnerReturning([{ handle: "555", pid: 99, title: "Untitled - Notepad" }]);
  const res = await focusWindow({ title: "notepad", runner });
  assert.equal(res.title, "Untitled - Notepad");
  assert.equal(res.pid, 99);
  assert.match(runner.calls.at(-1), /SetForegroundWindow/);
  assert.match(runner.calls.at(-1), /555/);
});

test("focusWindow：无匹配时列出候选窗口并报错", async () => {
  const runner = runnerReturning([{ handle: "1", pid: 1, title: "记事本" }]);
  await assert.rejects(() => focusWindow({ title: "chrome", runner }), /没有标题匹配.*记事本/s);
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

test("launchApp：detached 启动并 unref，命令为空报错", () => {
  const seen = {};
  const fakeChild = { pid: 4321, unref: () => { seen.unrefed = true; } };
  const res = launchApp({
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