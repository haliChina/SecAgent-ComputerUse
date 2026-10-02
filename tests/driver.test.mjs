import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowsDriver } from "../driver/win-driver.mjs";
import { decodePng } from "./decode-png.mjs";

// 构造可注入的 fake native，记录所有系统调用；getDIBits 填入已知 BGRA。
function makeFakeNative({ w = 8, h = 6, origin = { x: 0, y: 0 }, supports = true } = {}) {
  const calls = [];
  const rec = (name, ...a) => calls.push([name, ...a]);
  const metricMap = { 76: origin.x, 77: origin.y, 78: w, 79: h };
  return {
    calls,
    supportsThreadDpi: supports,
    dpiV2Handle: () => "V2",
    setThreadDpi: (ctx) => { rec("setThreadDpi", ctx); return "OLD"; },
    metrics: (i) => { rec("metrics", i); return metricMap[i]; },
    getDC: () => { rec("getDC"); return "screenDC"; },
    releaseDC: (h, dc) => rec("releaseDC", h, dc),
    createMemDC: () => { rec("createMemDC"); return "memDC"; },
    deleteDC: (dc) => rec("deleteDC", dc),
    createBitmap: () => { rec("createBitmap"); return "bmp"; },
    selectObject: (dc, o) => { rec("selectObject", o); return "oldBmp"; },
    bitBlt: (...a) => { rec("bitBlt", ...a); return true; },
    deleteObject: (o) => rec("deleteObject", o),
    allocBitmapInfo: (w, h) => { rec("allocBitmapInfo", w, h); return "bi"; },
    getDIBits: (dc, bmp, lines, bits) => {
      rec("getDIBits");
      for (let p = 0; p < w * h; p++) {
        bits[p * 4] = 10; // B
        bits[p * 4 + 1] = 20; // G
        bits[p * 4 + 2] = 30; // R
        bits[p * 4 + 3] = 255; // A
      }
      return lines;
    },
    setCursorPos: (x, y) => rec("setCursorPos", x, y),
    mouseEvent: (flags, data) => rec("mouseEvent", flags, data),
    keybdEvent: (vk, scan, flags) => rec("keybdEvent", vk, scan, flags),
    mapVirtualKey: (vk) => vk * 2
  };
}

const names = (n) => n.calls.map((c) => c[0]);
const count = (n, x) => names(n).filter((y) => y === x).length;

test("screenshot 走完整 GDI 链路并返回图片", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({ native });
  const result = await driver.screenshot();
  assert.equal(result.type, "image");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.width, 8);
  assert.equal(result.height, 6);
  // BGRA(10,20,30) 应被转为 RGBA(30,20,10)
  const png = Buffer.from(result.data, "base64");
  const decoded = decodePng(png);
  assert.deepEqual([...decoded.rgba.subarray(0, 4)], [30, 20, 10, 255]);
});

test("screenshot 成对释放所有 GDI 资源", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({ native });
  await driver.screenshot();
  assert.equal(count(native, "getDC"), 1);
  assert.equal(count(native, "releaseDC"), 1);
  assert.equal(count(native, "createMemDC"), 1);
  assert.equal(count(native, "deleteDC"), 1);
  assert.equal(count(native, "createBitmap"), 1);
  assert.equal(count(native, "deleteObject"), 1);
  assert.equal(count(native, "bitBlt"), 1);
  assert.equal(count(native, "getDIBits"), 1);
  // SelectObject：先选入 bitmap，finally 恢复 oldBmp
  const selected = native.calls.filter((c) => c[0] === "selectObject").map((c) => c[1]);
  assert.deepEqual(selected, ["bmp", "oldBmp"]);
});

test("线程级 DPI：操作前设置 V2、结束恢复旧上下文", async () => {
  const native = makeFakeNative({ supports: true });
  const driver = new WindowsDriver({ native });
  await driver.screenshot();
  assert.equal(native.calls[0][0], "setThreadDpi");
  assert.equal(native.calls[0][1], "V2");
  assert.equal(native.calls.at(-1)[0], "setThreadDpi");
  assert.equal(native.calls.at(-1)[1], "OLD");
});

test("不支持线程 DPI 时降级且不调用 setThreadDpi", async () => {
  const native = makeFakeNative({ supports: false });
  const driver = new WindowsDriver({ native });
  await driver.screenshot();
  assert.equal(count(native, "setThreadDpi"), 0);
});

test("多显示器：坐标自动加上负的虚拟原点", async () => {
  const native = makeFakeNative({ origin: { x: -100, y: -200 } });
  const driver = new WindowsDriver({ native });
  await driver.screenshot();
  await driver.click(5, 3);
  const move = native.calls.filter((c) => c[0] === "setCursorPos").at(-1);
  assert.deepEqual([move[1], move[2]], [-95, -197]);
});

test("click：左/右/中键与双击的事件序列", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({ native });
  await driver.click(1, 2, "left", false);
  let ev = native.calls.filter((c) => c[0] === "mouseEvent").map((c) => c[1]);
  assert.deepEqual(ev, [0x02, 0x04]);

  const n2 = makeFakeNative();
  await new WindowsDriver({ native: n2 }).click(1, 2, "left", true);
  ev = n2.calls.filter((c) => c[0] === "mouseEvent").map((c) => c[1]);
  assert.deepEqual(ev, [0x02, 0x04, 0x02, 0x04]);

  const n3 = makeFakeNative();
  await new WindowsDriver({ native: n3 }).click(1, 2, "right");
  ev = n3.calls.filter((c) => c[0] === "mouseEvent").map((c) => c[1]);
  assert.deepEqual(ev, [0x08, 0x10]);

  const n4 = makeFakeNative();
  await new WindowsDriver({ native: n4 }).click(1, 2, "middle");
  ev = n4.calls.filter((c) => c[0] === "mouseEvent").map((c) => c[1]);
  assert.deepEqual(ev, [0x20, 0x40]);

  await assert.rejects(() => driver.click(1, 2, "bad"));
});

test("move / drag 的调用顺序", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({ native });
  await driver.move(3, 4);
  await driver.drag(0, 0, 10, 10);
  const seq = native.calls
    .filter((c) => c[0] === "setCursorPos" || c[0] === "mouseEvent")
    .map((c) => c[0]);
  // drag: setCursorPos(from) -> down -> setCursorPos(to) -> up
  assert.deepEqual(seq.slice(1), ["setCursorPos", "mouseEvent", "setCursorPos", "mouseEvent"]);
  const dragEvents = native.calls.filter((c) => c[0] === "mouseEvent").map((c) => c[1]);
  assert.deepEqual(dragEvents, [0x02, 0x04]);
});

test("scroll：滚轮格数换算为 WHEEL_DELTA", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({ native });
  await driver.scroll(1, 1, 3);
  let wheel = native.calls.filter((c) => c[0] === "mouseEvent").at(-1);
  assert.equal(wheel[1], 0x0800);
  assert.equal(wheel[2], 360);
  await driver.scroll(1, 1, -2);
  wheel = native.calls.filter((c) => c[0] === "mouseEvent").at(-1);
  assert.equal(wheel[2], -240);
  await assert.rejects(() => driver.scroll(1, 1, 0));
});

test("type：Unicode 字符逐 code unit 发送 down/up", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({ native });
  await driver.type("A中");
  const keyEvents = native.calls.filter((c) => c[0] === "keybdEvent").map((c) => [c[1], c[2], c[3]]);
  assert.deepEqual(keyEvents, [
    [0, 65, 0x04],
    [0, 65, 0x06],
    [0, 0x4e2d, 0x04],
    [0, 0x4e2d, 0x06]
  ]);
  await assert.rejects(() => driver.type(123));
});

test("chord：修饰键先按下、主键后按，抬起逆序", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({ native });
  await driver.chord("ctrl+c");
  const keyEvents = native.calls.filter((c) => c[0] === "keybdEvent").map((c) => [c[1], c[2], c[3]]);
  assert.deepEqual(keyEvents, [
    [0x11, 0x22, 0],
    [0x43, 0x86, 0],
    [0x43, 0x86, 0x02],
    [0x11, 0x22, 0x02]
  ]);
});

test("chord：方向键带 EXTENDED 标志", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({ native });
  await driver.chord("alt+left");
  const keyEvents = native.calls.filter((c) => c[0] === "keybdEvent").map((c) => [c[1], c[2], c[3]]);
  assert.deepEqual(keyEvents, [
    [0x12, 0x24, 0],
    [0x25, 0x4a, 0x01],
    [0x25, 0x4a, 0x03],
    [0x12, 0x24, 0x02]
  ]);
});

test("chord：只有修饰键时报错", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({ native });
  await assert.rejects(() => driver.chord("ctrl"));
});
