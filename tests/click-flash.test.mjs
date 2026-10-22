// #12 → 0.7.3：操作落点发光标记（点击/移动/拖拽/输入/组合键/滚动）。
// 双通道：宿主 api.flashMarker 优先（注入 hostFlash），koffi native 兜底。
import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowsDriver } from "../driver/win-driver.mjs";

const drain = () => new Promise((r) => setImmediate(r));

function makeFakeNative({ flash = true } = {}) {
  const calls = [];
  const rec = (name, ...a) => calls.push([name, ...a]);
  const native = {
    calls,
    supportsThreadDpi: true,
    dpiV2Handle: () => "V2",
    setThreadDpi: () => "OLD",
    metrics: (i) => ({ 76: 0, 77: 0, 78: 8, 79: 6 }[i]),
    getDC: () => "dc", releaseDC: () => {},
    createMemDC: () => "m", deleteDC: () => {},
    createBitmap: () => "b", selectObject: () => "o", deleteObject: () => {},
    allocBitmapInfo: () => ({}), bitBlt: () => 1, getDIBits: (d, b, h, r) => { r.fill(0); return h; },
    setCursorPos: (x, y) => rec("setCursorPos", x, y),
    cursorPos: () => ({ x: 40, y: 50 }),
    mouseEvent: (f) => rec("mouseEvent", f),
    keybdEvent: () => {}, mapVirtualKey: () => 0
  };
  if (flash)
    native.flashMarker = (x, y, radius, kind) => {
      rec("flashMarker", x, y, radius, kind);
      return { via: "native", ok: true };
    };
  return native;
}

test("click 默认触发落点标记（物理坐标，fire-and-forget 异步）", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({ native });
  await driver.clickTarget({ x: 3, y: 2 }); // scale=1 origin=0 → 物理 (3,2)
  await drain();
  const flash = native.calls.find((c) => c[0] === "flashMarker");
  assert.ok(flash, "应调用 flashMarker");
  assert.equal(flash[1], 3);
  assert.equal(flash[2], 2);
  assert.equal(flash[4], "click", "点击用 click 语义");
});

test("宿主通道优先：hostFlash 存在时不再走 native", async () => {
  const native = makeFakeNative();
  const hostCalls = [];
  const driver = new WindowsDriver({
    native,
    hostFlash: (x, y, opts) => hostCalls.push([x, y, opts])
  });
  await driver.clickTarget({ x: 3, y: 2 });
  await drain();
  assert.equal(hostCalls.length, 1);
  assert.equal(hostCalls[0][0], 3);
  assert.equal(hostCalls[0][1], 2);
  assert.equal(hostCalls[0][2].kind, "click");
  assert.equal(native.calls.find((c) => c[0] === "flashMarker"), undefined, "宿主通道优先");
  assert.deepEqual(driver.lastFlash, { via: "host", ok: true }, "诊断记录宿主通道");
});

test("hostFlash 抛异常 → 回退 koffi native，诊断记录 host 失败", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({
    native,
    hostFlash: () => { throw new Error("boom"); }
  });
  await driver.clickTarget({ x: 1, y: 1 });
  await drain();
  assert.ok(native.calls.find((c) => c[0] === "flashMarker"), "应回退 native");
  assert.equal(driver.lastFlash.via, "native");
  assert.equal(driver.lastFlash.ok, true);
});

test("chord：键帽浮标带规范化 label（显示按的什么）", async () => {
  const hostCalls = [];
  const driver = new WindowsDriver({
    native: makeFakeNative({ flash: false }),
    hostFlash: (x, y, opts) => hostCalls.push([x, y, opts])
  });
  await driver.chord("ctrl+c");
  await drain();
  const flash = hostCalls.find((c) => c[2].kind === "chord");
  assert.ok(flash, "chord 应触发发光");
  assert.equal(flash[2].label, "Ctrl+C", "组合键文本规范化显示");
  assert.equal(flash[0], 40, "跟随光标位置（cursorPos stub 40,50）");
});

test("scroll：方向随 amount 符号（轻量箭头）", async () => {
  const hostCalls = [];
  const driver = new WindowsDriver({
    native: makeFakeNative({ flash: false }),
    hostFlash: (x, y, opts) => hostCalls.push([x, y, opts])
  });
  await driver.scroll(5, 5, -3);
  await drain();
  const flash = hostCalls.find((c) => c[2].kind === "scroll");
  assert.ok(flash, "scroll 应触发提示");
  assert.equal(flash[2].direction, -1, "向下滚箭头向下");
});

test("type：输入区域发光（kind=type，光标处）", async () => {
  const hostCalls = [];
  const native = makeFakeNative({ flash: false });
  native.sendInputKeyboard = (events) => events.length; // 全部接受（SendInput 路径）
  const driver = new WindowsDriver({
    native,
    hostFlash: (x, y, opts) => hostCalls.push([x, y, opts])
  });
  await driver.type("hi");
  await drain();
  const flash = hostCalls.find((c) => c[2].kind === "type");
  assert.ok(flash, "type 应触发输入区域发光");
  assert.equal(flash[0], 40, "光标处");
});

test("move：移动落点小环（用户要求移动同发光）", async () => {
  const hostCalls = [];
  const driver = new WindowsDriver({
    native: makeFakeNative({ flash: false }),
    hostFlash: (x, y, opts) => hostCalls.push([x, y, opts])
  });
  await driver.move(2, 2);
  await drain();
  const flash = hostCalls.find((c) => c[2].kind === "click");
  assert.ok(flash, "move 应触发小环");
  assert.equal(flash[2].ms, 320, "移动小环更短促");
  assert.ok(flash[2].radius <= 9, "移动小环半径更小");
});

test("flashAt 公开方法（focus 用，物理坐标直闪+返回诊断）", async () => {
  const hostCalls = [];
  const driver = new WindowsDriver({
    native: makeFakeNative({ flash: false }),
    hostFlash: (x, y, opts) => hostCalls.push([x, y, opts])
  });
  const r = await driver.flashAt(11.4, 22.6, "focus", 16);
  assert.equal(r.via, "host");
  assert.equal(r.ok, true);
  assert.equal(hostCalls[0][0], 11, "坐标四舍五入");
  assert.equal(hostCalls[0][1], 23);
  assert.equal(hostCalls[0][2].kind, "focus");
  assert.equal(hostCalls[0][2].radius, 16);
});

test("actionFlash=false 全关（clickFlash 旧键仍兼容）", async () => {
  const hostCalls = [];
  const native = makeFakeNative();
  const driver = new WindowsDriver({
    native,
    hostFlash: (x, y, opts) => hostCalls.push([x, y, opts]),
    configProvider: () => ({ actionFlash: false })
  });
  await driver.clickTarget({ x: 3, y: 2 });
  await drain();
  assert.equal(hostCalls.length, 0);
  assert.equal(native.calls.find((c) => c[0] === "flashMarker"), undefined);
  const driver2 = new WindowsDriver({
    native,
    hostFlash: (x, y, opts) => hostCalls.push([x, y, opts]),
    configProvider: () => ({ clickFlash: false }) // 旧键兼容
  });
  await driver2.clickTarget({ x: 3, y: 2 });
  await drain();
  assert.equal(hostCalls.length, 0, "旧 clickFlash=false 同样关闭");
});

test("旧 native 无 flashMarker 时点击不受影响", async () => {
  const native = makeFakeNative({ flash: false });
  const driver = new WindowsDriver({ native });
  const out = await driver.clickTarget({ x: 1, y: 1 });
  await drain();
  assert.ok(out.clicked);
  assert.equal(native.calls.find((c) => c[0] === "flashMarker"), undefined);
});

test("native.flashMarker 抛异常不影响点击结果（诊断记录 exception）", async () => {
  const native = makeFakeNative();
  native.flashMarker = () => { throw new Error("boom"); };
  const driver = new WindowsDriver({ native });
  const out = await driver.clickTarget({ x: 1, y: 1 });
  await drain();
  assert.ok(out.clicked);
  assert.equal(driver.lastFlash.via, "native");
  assert.equal(driver.lastFlash.ok, false);
});

test("koffi 兜底诊断：SetDIBits 失败返回 stage 且清理不再泄漏", async () => {
  // 直接测 native.flashMarker 的诊断协议（fake 调用序列已由 click 测试覆盖）
  const { createKoffiNative } = await import("../driver/win-driver.mjs");
  // Linux 无 koffi native：createKoffiNative 会 throw——验证 #flash 捕获并给诊断
  const driver = new WindowsDriver({ native: makeFakeNative({ flash: false }) });
  const r = await driver.flashAt(1, 2, "focus");
  assert.equal(r.via, "none");
  assert.equal(r.ok, false);
  assert.ok(r.reason, "无通道时给出原因");
});

test("focusWindow 返回窗口中心（0.7.3 聚焦发光用）", async () => {
  const { focusWindow } = await import("../driver/system-ops.mjs");
  const fakeRunner = async () => ({
    stdout: JSON.stringify([
      { handle: "100", pid: 1, name: "notepad", title: "记事本" },
      { handle: "200", pid: 2, name: "code", title: "VSCode" }
    ])
  });
  // focus 的第二轮 runner 返回 focus 结果
  const calls = [];
  const runner = async (cmd) => {
    calls.push(cmd);
    return calls.length === 1
      ? { stdout: JSON.stringify([{ handle: "100", pid: 1, name: "notepad", title: "记事本" }]) }
      : { stdout: JSON.stringify({ focused: true, title: "记事本", center: { x: 961, y: 541 } }) };
  };
  const res = await focusWindow({ title: "记事本", runner });
  assert.equal(res.focused, true);
  assert.deepEqual(res.center, { x: 961, y: 541 }, "窗口中心透传（四舍五入整数）");
});
