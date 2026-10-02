import { test } from "node:test";
import assert from "node:assert/strict";
import { createNudge } from "../reasoning/nudge.mjs";

const defaultConfig = {
  nudgeEnabled: true, thinkBudgetSec: 90, maxRounds: 12, nudgeText: "请尽快收敛。"
};

function makeNudge(config = defaultConfig) {
  let t = 1_000_000;
  const nudge = createNudge({ getConfig: () => config, now: () => t });
  return {
    nudge,
    advance: (ms) => { t += ms; }
  };
}

test("新任务开始时不提醒", () => {
  const { nudge } = makeNudge();
  nudge.beginTask();
  assert.equal(nudge.maybeNotice(), null);
});

test("prompt 注入思考预算", () => {
  const { nudge } = makeNudge();
  const text = nudge.prompt();
  assert.match(text, /思考预算/);
  assert.match(text, /约 90 秒/);
  assert.match(text, /12 轮/);
});

test("关闭提醒后 prompt 为空且不提醒", () => {
  const { nudge } = makeNudge({ ...defaultConfig, nudgeEnabled: false });
  assert.equal(nudge.prompt(), "");
  nudge.beginTask();
  for (let i = 0; i < 20; i++) nudge.observe();
  assert.equal(nudge.maybeNotice(), null);
});

test("达到轮次上限后强提醒", () => {
  const { nudge } = makeNudge();
  nudge.beginTask();
  for (let i = 0; i < 12; i++) nudge.observe();
  const notice = nudge.maybeNotice();
  assert.match(notice, /达到设定的 12 轮上限/);
  assert.match(notice, /向用户说明卡点/);
  // 仍超限时持续提醒
  assert.match(nudge.maybeNotice(), /轮上限/);
});

test("两次动作间隔过长触发一次温和提醒", () => {
  const { nudge, advance } = makeNudge();
  nudge.beginTask();
  nudge.observe();
  advance(90 * 1000 * 1.5 + 1000); // 超过预算 1.5 倍
  nudge.observe();
  const notice = nudge.maybeNotice();
  assert.match(notice, /思考耗时较长/);
  // slow 只提醒一次
  assert.equal(nudge.maybeNotice(), null);
});

test("正常间隔不触发 slow 提醒", () => {
  const { nudge, advance } = makeNudge();
  nudge.beginTask();
  nudge.observe();
  advance(5000);
  nudge.observe();
  assert.equal(nudge.maybeNotice(), null);
});
