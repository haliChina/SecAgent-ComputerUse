// #12 回归：type 中文乱码根因修复（0.7.1）。
// 根因：keybd_event 的 bScan 是 8 位，中文（≥0x100）被截断；
// 修复：SendInput 路径 wScan 16 位，含代理对两半。
import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowsDriver } from "../driver/win-driver.mjs";

const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_KEYUP = 0x0002;

// 带 sendInputKeyboard 的 fake native：记录整批事件（真实路径只调一次）。
function makeSendInputNative({ accepted = null } = {}) {
  const calls = [];
  const batches = [];
  return {
    calls,
    batches,
    supportsThreadDpi: true,
    dpiV2Handle: () => "V2",
    setThreadDpi: () => "OLD",
    metrics: (i) => ({ 76: 0, 77: 0, 78: 8, 79: 6 }[i]),
    getDC: () => "dc", releaseDC: () => {},
    createMemDC: () => "m", deleteDC: () => {},
    createBitmap: () => "b", selectObject: () => "o", deleteObject: () => {},
    allocBitmapInfo: () => ({}), bitBlt: () => 1, getDIBits: (d, b, h, r) => { r.fill(0); return h; },
    setCursorPos: () => 1, cursorPos: () => ({ x: 0, y: 0 }),
    mouseEvent: (...a) => calls.push(["mouseEvent", ...a]),
    keybdEvent: (...a) => calls.push(["keybdEvent", ...a]),
    mapVirtualKey: (vk) => 0,
    sendInputKeyboard: (events) => {
      batches.push(events.map((e) => ({ ...e })));
      return accepted == null ? events.length : accepted;
    }
  };
}

// 无 sendInputKeyboard 的旧式 fake（走 legacy keybd_event 路径）。
function makeLegacyNative() {
  const n = makeSendInputNative();
  delete n.sendInputKeyboard;
  return n;
}

test("type 中文/emoji：SendInput 路径，wScan 保留完整 16 位 code unit", async () => {
  const native = makeSendInputNative();
  const driver = new WindowsDriver({ native });
  const out = await driver.type("A你😀");
  assert.equal(out.mode, "sendinput");
  assert.equal(out.typed.length, 4); // A + 你 + 😀 代理对两半
  // 一次原子提交，事件按字符逐个 down/up 成对顺序发送
  assert.equal(native.batches.length, 1);
  const ev = native.batches[0];
  assert.equal(ev.length, 8);
  assert.deepEqual(
    ev.map((e) => e.scan),
    [0x41, 0x41, 0x4f60, 0x4f60, 0xd83d, 0xd83d, 0xde00, 0xde00]
  );
  assert.ok(ev.every((e) => e.vk === 0));
  assert.deepEqual(
    ev.map((e) => e.flags),
    [
      KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
      KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
      KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
      KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
    ]
  );
  // SendInput 路径下不再逐字符调 keybd_event
  assert.equal(native.calls.filter((c) => c[0] === "keybdEvent").length, 0);
});

test("type：UIPI 拦截（管理员窗口）时给出可操作报错", async () => {
  const driver = new WindowsDriver({ native: makeSendInputNative({ accepted: 1 }) });
  await assert.rejects(() => driver.type("你好"), /管理员|UIPI/);
});

test("type：空串零事件", async () => {
  const native = makeSendInputNative();
  const driver = new WindowsDriver({ native });
  const out = await driver.type("");
  assert.equal(out.mode, "none");
  assert.equal(native.batches.length, 0);
});

test("type：旧 native（无 sendInputKeyboard）退回 keybd_event 路径", async () => {
  const native = makeLegacyNative();
  const driver = new WindowsDriver({ native });
  const out = await driver.type("A中");
  assert.equal(out.mode, "legacy");
  const keyEvents = native.calls.filter((c) => c[0] === "keybdEvent").map((c) => [c[1], c[2], c[3]]);
  assert.deepEqual(keyEvents, [
    [0, 65, 0x04],
    [0, 65, 0x06],
    [0, 0x4e2d, 0x04],
    [0, 0x4e2d, 0x06]
  ]);
});
