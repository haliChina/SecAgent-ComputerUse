import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectViaUia, encodePsCommand } from "../driver/uia-inspect.mjs";

const runnerReturning = (stdout) => async () => ({ stdout, stderr: "" });

test("encodePsCommand 输出 UTF-16LE base64，可解码回脚本", () => {
  const enc = encodePsCommand("Add-Type -AssemblyName UIAutomationClient");
  assert.match(enc, /^[A-Za-z0-9+/=]+$/);
  const back = Buffer.from(enc, "base64").toString("utf16le");
  assert.match(back, /UIAutomationClient/);
});

test("解析 PowerShell 返回的元素数组并清洗字段", async () => {
  const stdout = JSON.stringify([
    {
      name: "确定", role: "Button", automationId: "okBtn",
      bbox: { x: 100, y: 200, w: 80, h: 30 },
      cx: 140, cy: 215, enabled: true
    }
  ]);
  const els = await inspectViaUia({ runner: runnerReturning(stdout) });
  assert.equal(els.length, 1);
  assert.deepEqual(els[0], {
    name: "确定", role: "Button", automationId: "okBtn",
    bbox: { x: 100, y: 200, w: 80, h: 30 },
    cx: 140, cy: 215, enabled: true
  });
});

test("空输出返回空数组", async () => {
  const els = await inspectViaUia({ runner: runnerReturning("   ") });
  assert.deepEqual(els, []);
});

test("单个元素对象（非数组）也能正确包裹", async () => {
  const stdout = JSON.stringify({
    name: "取消", role: "Button", automationId: "",
    bbox: { x: 0, y: 0, w: 10, h: 10 }, cx: 5, cy: 5, enabled: true
  });
  const els = await inspectViaUia({ runner: runnerReturning(stdout) });
  assert.equal(els.length, 1);
  assert.equal(els[0].name, "取消");
});

test("过滤掉宽高为 0 的无效元素", async () => {
  const stdout = JSON.stringify([
    { name: "好", role: "Button", bbox: { x: 0, y: 0, w: 10, h: 10 }, cx: 5, cy: 5 },
    { name: "坏", role: "Pane", bbox: { x: 0, y: 0, w: 0, h: 0 }, cx: 0, cy: 0 }
  ]);
  const els = await inspectViaUia({ runner: runnerReturning(stdout) });
  assert.equal(els.length, 1);
  assert.equal(els[0].name, "好");
});

test("非法 JSON 抛出可识别错误", async () => {
  await assert.rejects(
    () => inspectViaUia({ runner: runnerReturning("not-json") }),
    /JSON/
  );
});

test("runner 抛错时给出友好提示", async () => {
  const boom = async () => { throw new Error("spawn ENOENT"); };
  await assert.rejects(
    () => inspectViaUia({ runner: boom }),
    /UIA 侦察执行失败/
  );
});
