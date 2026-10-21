// #12：点击落点视觉标记（Agent 使用鼠标肉眼可循迹）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowsDriver } from "../driver/win-driver.mjs";

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
    cursorPos: () => ({ x: 0, y: 0 }),
    mouseEvent: (f) => rec("mouseEvent", f),
    keybdEvent: () => {}, mapVirtualKey: () => 0
  };
  if (flash) native.flashMarker = (x, y) => rec("flashMarker", x, y);
  return native;
}

test("click 默认触发落点标记（物理坐标）", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({ native });
  await driver.clickTarget({ x: 3, y: 2 }); // scale=1 origin=0 → 物理 (3,2)
  const flash = native.calls.find((c) => c[0] === "flashMarker");
  assert.ok(flash, "应调用 flashMarker");
  assert.equal(flash[1], 3);
  assert.equal(flash[2], 2);
});

test("设置 clickFlash=false 关闭标记", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({ native, configProvider: () => ({ clickFlash: false }) });
  await driver.clickTarget({ x: 3, y: 2 });
  assert.equal(native.calls.find((c) => c[0] === "flashMarker"), undefined);
});

test("旧 native 无 flashMarker 时点击不受影响", async () => {
  const native = makeFakeNative({ flash: false });
  const driver = new WindowsDriver({ native });
  const out = await driver.clickTarget({ x: 1, y: 1 });
  assert.ok(out.clicked);
  assert.equal(native.calls.find((c) => c[0] === "flashMarker"), undefined);
});

test("flashMarker 抛异常不影响点击结果", async () => {
  const native = makeFakeNative();
  native.flashMarker = () => { throw new Error("boom"); };
  const driver = new WindowsDriver({ native });
  const out = await driver.clickTarget({ x: 1, y: 1 });
  assert.ok(out.clicked);
});
