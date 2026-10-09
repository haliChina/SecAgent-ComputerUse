// 回归测试：Windows 实机暴露的两个 bug（v0.5.1）。
// 共同点是"注入 fake 的单测全绿、生产路径必炸"——所以这里刻意走真实路径。
//
//   1) launch 的 TDZ：const spawn = spawnImpl ?? spawn 遮蔽了顶部 import，
//      生产路径（不注入）抛 "Cannot access 'spawn' before initialization"。
//   2) createKoffiNative 不幂等：koffi 具名类型全局注册，第二次调用抛
//      "Duplicate type name 'BITMAPINFOHEADER'"——第一次 doctor 全绿，
//      随后 screenshot/key/inspect 全挂的真实时序。
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchApp } from "../driver/system-ops.mjs";
import { createKoffiNative, resetKoffiNativeForTest } from "../driver/win-driver.mjs";

test("launch 走真实 spawn 路径：成功启动进程并拿到 pid（不注入 spawnImpl）", async () => {
  const result = await launchApp({ command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal(result.launched, process.execPath);
  assert.ok(Number.isFinite(result.pid) && result.pid > 0, `应有真实 pid，拿到 ${result.pid}`);
});

test("launch 找不到程序时给友好错误，而不是 ReferenceError（TDZ 回归）", async () => {
  await assert.rejects(
    () => launchApp({ command: "secagent-definitely-missing-xyz-42" }),
    (error) => {
      assert.equal(error instanceof ReferenceError, false, "不得再抛 TDZ ReferenceError");
      assert.match(error.message, /找不到该程序|启动失败/);
      return true;
    }
  );
});

test("createKoffiNative 同进程幂等：重复调用复用单例，不重复注册 koffi 类型", () => {
  const structNames = [];
  const fakeKoffi = {
    load: () => ({ func: () => () => 0 }),
    struct: (name) => { structNames.push(name); return {}; },
    as: (v) => v
  };
  resetKoffiNativeForTest();
  try {
    const n1 = createKoffiNative(fakeKoffi);
    // 第二次不传 impl：必须命中缓存——否则 Linux 上会走到真实 require + load("user32.dll") 抛错
    const n2 = createKoffiNative();
    assert.equal(n1, n2, "重复调用必须返回同一实例");
    assert.deepEqual(structNames, ["BITMAPINFOHEADER"], "koffi 类型只允许注册一次");
    // doctor 的 loadNative 与 driver 的 #ensureNative 两条路径共享同一实例
    assert.equal(createKoffiNative(), n1);
  } finally {
    resetKoffiNativeForTest();
  }
});
