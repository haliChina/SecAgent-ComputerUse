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

test("解析新版输出 {fgPid, elements} 并清洗字段", async () => {
  const stdout = JSON.stringify({
    fgPid: 4242,
    elements: [
      {
        name: "确定", role: "Button", automationId: "okBtn",
        bbox: { x: 100, y: 200, w: 80, h: 30 },
        cx: 140, cy: 215, enabled: true
      }
    ]
  });
  const { elements, foregroundPid } = await inspectViaUia({ runner: runnerReturning(stdout) });
  assert.equal(foregroundPid, 4242);
  assert.equal(elements.length, 1);
  assert.deepEqual(elements[0], {
    name: "确定", role: "Button", automationId: "okBtn",
    bbox: { x: 100, y: 200, w: 80, h: 30 },
    cx: 140, cy: 215, enabled: true
  });
});

test("兼容旧版/测试桩的纯元素数组输出：foregroundPid 为 0", async () => {
  const stdout = JSON.stringify([
    {
      name: "确定", role: "Button", automationId: "okBtn",
      bbox: { x: 100, y: 200, w: 80, h: 30 },
      cx: 140, cy: 215, enabled: true
    }
  ]);
  const { elements, foregroundPid } = await inspectViaUia({ runner: runnerReturning(stdout) });
  assert.equal(foregroundPid, 0);
  assert.equal(elements.length, 1);
  assert.equal(elements[0].name, "确定");
});

test("空输出返回空元素与 0 前台 pid", async () => {
  const { elements, foregroundPid } = await inspectViaUia({ runner: runnerReturning("   ") });
  assert.deepEqual(elements, []);
  assert.equal(foregroundPid, 0);
});

test("单个元素对象（非数组）也能正确包裹", async () => {
  const stdout = JSON.stringify({
    name: "取消", role: "Button", automationId: "",
    bbox: { x: 0, y: 0, w: 10, h: 10 }, cx: 5, cy: 5, enabled: true
  });
  const { elements } = await inspectViaUia({ runner: runnerReturning(stdout) });
  assert.equal(elements.length, 1);
  assert.equal(elements[0].name, "取消");
});

test("过滤掉宽高为 0 的无效元素", async () => {
  const stdout = JSON.stringify({
    fgPid: 1,
    elements: [
      { name: "好", role: "Button", bbox: { x: 0, y: 0, w: 10, h: 10 }, cx: 5, cy: 5 },
      { name: "坏", role: "Pane", bbox: { x: 0, y: 0, w: 0, h: 0 }, cx: 0, cy: 0 }
    ]
  });
  const { elements } = await inspectViaUia({ runner: runnerReturning(stdout) });
  assert.equal(elements.length, 1);
  assert.equal(elements[0].name, "好");
});

test("fgPid 非法时回退 0，不抛错", async () => {
  const stdout = JSON.stringify({ fgPid: "abc", elements: [] });
  const { foregroundPid } = await inspectViaUia({ runner: runnerReturning(stdout) });
  assert.equal(foregroundPid, 0);
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
