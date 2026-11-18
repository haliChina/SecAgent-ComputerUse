import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowsDriver } from "../driver/win-driver.mjs";

/** 造一台「用户活跃可控」的假机器：clicks 队列控制 userIdleMs 返回值。 */
function fakeNative(idleValues) {
  let call = 0;
  return {
    userArbitrationAvailable: () => true,
    userIdleMs: () => idleValues[Math.min(call++, idleValues.length - 1)],
    // 坐标动作依赖的最小面
    metrics: () => 0,
    setCursorPos: () => true,
    mouseEvent: () => {},
  };
}

function makeDriver(native, config = {}) {
  return new WindowsDriver({ native, configProvider: () => config });
}

test("用户空闲超阈值：坐标动作零延迟直通（clear）", async () => {
  const d = makeDriver(fakeNative([99999]));
  const result = await d.click(10, 10);
  assert.equal(result.arbitration.arbitration, "clear");
});

test("用户活跃中：等待轮询直到空闲（waited）", async () => {
  // 第一次 100ms（活跃），之后 5000ms（空闲）——应等到第二次读数
  const d = makeDriver(fakeNative([100, 5000]));
  const result = await d.click(10, 10);
  assert.equal(result.arbitration.arbitration, "waited");
  assert.ok(result.arbitration.waitedMs >= 200, "至少等过一个轮询周期");
});

test("用户一直活跃：超时放行不 死锁（timeout）", async () => {
  const d = makeDriver(fakeNative([50]), { userArbitrationIdleMs: 500, userArbitrationTimeoutMs: 800 });
  const start = Date.now();
  const result = await d.click(10, 10);
  assert.equal(result.arbitration.arbitration, "timeout");
  assert.ok(Date.now() - start >= 700, "等满超时才放行");
});

test("设置关闭 userArbitration=false：完全不仲裁（off）", async () => {
  const d = makeDriver(fakeNative([0]), { userArbitration: false });
  const result = await d.click(10, 10);
  assert.equal(result.arbitration.arbitration, "off");
});

test("GetLastInputInfo 不可用：fail-open 直接执行（unavailable）", async () => {
  const native = { ...fakeNative([0]), userArbitrationAvailable: () => false };
  const d = makeDriver(native);
  const result = await d.click(10, 10);
  assert.equal(result.arbitration.arbitration, "unavailable");
});

test("仲裁等待期间不阻塞：250ms 粒度异步轮询", async () => {
  // 活跃 2 次后空闲——总等待应 < 1000ms（3 个轮询周期内）
  const d = makeDriver(fakeNative([10, 10, 99999]));
  const start = Date.now();
  await d.click(10, 10);
  assert.ok(Date.now() - start < 1500, "轮询粒度粗测（防同步阻塞回归）");
});
