import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSequenceRequest, sequenceNeedsConfirm, runSequence, SEQUENCE_ACTIONS } from "../driver/sequence.mjs";

test("校验：合法计划通过并规整默认值", () => {
  const plan = validateSequenceRequest({
    steps: [
      { action: "click", elementId: 12, note: "点搜索框" },
      { action: "type", text: "张三 积分" },
      { action: "key", keys: "enter" },
      { action: "wait", ms: 800 }
    ]
  });
  assert.equal(plan.steps.length, 4);
  assert.equal(plan.risk, "low");
  assert.equal(sequenceNeedsConfirm(plan), false);
  assert.equal(plan.stopOnError, true);
  assert.equal(plan.capture, "end");
  assert.equal(plan.endSettleMs, 750);
  assert.equal(plan.steps[0].settleMs, 0);
  assert.equal(plan.steps[3].ms, 800);
});

test("校验：空 steps / 非法 action / 缺字段全部拒绝", () => {
  assert.throws(() => validateSequenceRequest({ steps: [] }), /不能为空/);
  assert.throws(() => validateSequenceRequest({ steps: [{ action: "launch" }] }), /action 必须/);
  assert.throws(() => validateSequenceRequest({ steps: [{ action: "click" }] }), /click 需要/);
  assert.throws(() => validateSequenceRequest({ steps: [{ action: "type", text: "" }] }), /type 需要/);
  assert.throws(() => validateSequenceRequest({ steps: [{ action: "key", keys: "  " }] }), /key 需要/);
  assert.throws(() => validateSequenceRequest({ steps: [{ action: "act", elementId: 1 }] }), /actAction/);
  assert.throws(() => validateSequenceRequest({ steps: [{ action: "drag", from: { x: 1, y: 2 } }] }), /drag 需要/);
  assert.throws(() => validateSequenceRequest({ steps: [{ action: "wait", ms: 10 }] }), /50-10000/);
});

test("校验：步骤数上限来自配置 maxSequenceSteps", () => {
  const steps = Array.from({ length: 5 }, () => ({ action: "wait", ms: 100 }));
  assert.throws(() => validateSequenceRequest({ steps }, { maxSequenceSteps: 4 }), /超过上限/);
  const ok = validateSequenceRequest({ steps }, { maxSequenceSteps: 5 });
  assert.equal(ok.steps.length, 5);
});

test("风险：act setValue/clear 自动升 medium，invoke 不升", () => {
  const up = validateSequenceRequest({
    steps: [{ action: "act", elementId: 3, actAction: "setValue", value: "2 分" }]
  });
  assert.equal(up.risk, "medium");
  assert.equal(sequenceNeedsConfirm(up), true);
  assert.match(up.autoUpgraded, /覆写内容/);

  const clear = validateSequenceRequest({
    steps: [{ action: "act", elementId: 3, actAction: "clear" }]
  });
  assert.equal(clear.risk, "medium");

  const invoke = validateSequenceRequest({
    steps: [{ action: "act", elementId: 3, actAction: "invoke" }]
  });
  assert.equal(invoke.risk, "low");
  assert.equal(sequenceNeedsConfirm(invoke), false);
});

test("风险：显式声明优先保留，不会降级自动升级", () => {
  const declared = validateSequenceRequest({
    risk: "high",
    steps: [{ action: "act", elementId: 3, actAction: "setValue" }]
  });
  assert.equal(declared.risk, "high");
  const bad = () => validateSequenceRequest({ risk: "extreme", steps: [{ action: "wait" }] });
  assert.throws(bad, /risk 必须/);
});

test("执行：stopOnError 默认失败即停并报 remainingSteps", async () => {
  const plan = validateSequenceRequest({
    steps: [
      { action: "wait", ms: 60 },
      { action: "key", keys: "ctrl+a" },
      { action: "type", text: "x" }
    ]
  });
  const calls = [];
  const results = await runSequence(plan, async (action, step) => {
    calls.push(action);
    if (action === "key") throw new Error("STALE_STATE: 元素已变");
    return { done: true, action };
  });
  assert.deepEqual(calls, ["wait", "key"]);
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /STALE_STATE/);
  assert.equal(results[1].stoppedHere, true);
  assert.equal(results[1].remainingSteps, 1);
});

test("执行：stopOnError=false 跑完全部步骤", async () => {
  const plan = validateSequenceRequest({
    steps: [
      { action: "wait", ms: 60 },
      { action: "key", keys: "ctrl+a" },
      { action: "type", text: "x" }
    ],
    stopOnError: false
  });
  const results = await runSequence(plan, async (action) => {
    if (action === "key") throw new Error("boom");
    return null;
  });
  assert.equal(results.length, 3);
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.equal(results.every((r) => r.step > 0), true);
});

test("执行：步骤间 settleMs 生效（总时长可观测）", async () => {
  const plan = validateSequenceRequest({
    steps: [
      { action: "wait", ms: 60, settleMs: 120 },
      { action: "wait", ms: 60, settleMs: 120 }
    ]
  });
  const started = Date.now();
  await runSequence(plan, async () => null);
  assert.ok(Date.now() - started >= 230, "两步 settleMs 应累计到总时长");
});

test("工具面完整性：动作清单与文档一致", () => {
  assert.deepEqual(SEQUENCE_ACTIONS, ["click", "move", "drag", "scroll", "act", "type", "key", "wait"]);
});
