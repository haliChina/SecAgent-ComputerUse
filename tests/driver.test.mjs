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

test("screenshot 走完整 GDI 链路并返回图片 + 坐标契约", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({ native });
  const [result, note] = await driver.screenshot();
  assert.equal(result.type, "image");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.width, 8);
  assert.equal(result.height, 6);
  assert.equal(note.type, "text");
  assert.match(note.text, /相对本截图左上角/);
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

// ---- v0.2：元素地图 inspect 与按编号点击 ----
const uiaEls = [
  {
    name: "确定", role: "Button", automationId: "ok",
    bbox: { x: 100, y: 100, w: 40, h: 20 },
    cx: 120, cy: 110, enabled: true
  }
];
const uiaRunner = (els) => async () => ({ stdout: JSON.stringify(els), stderr: "" });

test("inspect 默认返回文本元素清单", async () => {
  const native = makeFakeNative({ w: 200, h: 150 });
  const driver = new WindowsDriver({ native, uiaRunner: uiaRunner(uiaEls) });
  const out = await driver.inspect();
  assert.equal(typeof out, "string");
  assert.match(out, /确定/);
  assert.match(out, /#0/);
});

test("inspect annotate=true 返回带编号框的标注图", async () => {
  const native = makeFakeNative({ w: 200, h: 150 });
  const driver = new WindowsDriver({ native, uiaRunner: uiaRunner(uiaEls) });
  const [out] = await driver.inspect({ annotate: true });
  assert.equal(out.type, "image");
  assert.equal(out.width, 200);
  const decoded = decodePng(Buffer.from(out.data, "base64"));
  const i = (100 * decoded.width + 110) * 4; // 元素上边 (110,100)
  assert.deepEqual([...decoded.rgba.subarray(i, i + 3)], [57, 255, 20]);
});

test("inspect annotate=true 同时返回元素清单文本（0.5.4：实机模型读不清框内编号）", async () => {
  const native = makeFakeNative({ w: 200, h: 150 });
  const driver = new WindowsDriver({ native, uiaRunner: uiaRunner(uiaEls) });
  const [, note] = await driver.inspect({ annotate: true });
  assert.equal(note.type, "text");
  assert.match(note.text, /#0 \[Button\] "确定"/);
  assert.match(note.text, /元素清单/);
});

test("inspect 前台是宿主自身时给出醒目警告（0.5.4：模型点宿主活动流 20+ 次的教训）", async () => {
  const native = makeFakeNative({ w: 200, h: 150 });
  const runner = async () => ({
    stdout: JSON.stringify({ fgPid: process.pid, elements: uiaEls }),
    stderr: ""
  });
  const driver = new WindowsDriver({ native, uiaRunner: runner });
  const out = await driver.inspect();
  assert.match(out, /前台窗口是 SecAgent 宿主自身/);
  assert.match(out, /focus/);
  // annotate 分支同样要带警告
  const [, note] = await driver.inspect({ annotate: true });
  assert.match(note.text, /前台窗口是 SecAgent 宿主自身/);
});

test("inspect 前台是其他进程时不误报告警", async () => {
  const native = makeFakeNative({ w: 200, h: 150 });
  const runner = async () => ({
    stdout: JSON.stringify({ fgPid: 999999, elements: uiaEls }),
    stderr: ""
  });
  const driver = new WindowsDriver({ native, uiaRunner: runner });
  const out = await driver.inspect();
  assert.doesNotMatch(out, /宿主自身/);
});

test("inspect 输出的 bbox 是截图内相对坐标（多屏负原点会被换算）", async () => {
  const native = makeFakeNative({ w: 200, h: 150, origin: { x: -100, y: -100 } });
  const driver = new WindowsDriver({
    native,
    uiaRunner: uiaRunner([
      { name: "确定", role: "Button", bbox: { x: -90, y: -80, w: 40, h: 20 }, cx: -70, cy: -70 }
    ])
  });
  const out = await driver.inspect();
  // UIA 给的是绝对 (-90,-80,40,20)，截图内应为 (10,20,40,20)
  assert.match(out, /bbox=\(10,20,40,20\)/);
  assert.match(out, /虚拟屏原点 -100,-100/);
});

test("缩放：截图降到长边上限，display 坐标与缩放后图一致，反向换算回物理坐标", async () => {
  const native = makeFakeNative({ w: 400, h: 200 });
  const driver = new WindowsDriver({
    native, maxSidePixels: 200, uiaRunner: uiaRunner([
      { name: "按钮", role: "Button", bbox: { x: 200, y: 100, w: 100, h: 50 }, cx: 250, cy: 125 }
    ])
  });
  const [shot, note] = await driver.screenshot();
  assert.equal(shot.width, 200); // 长边压到 200
  assert.equal(shot.height, 100);
  assert.match(note.text, /scale=0\.5000/);

  const out = await driver.inspect();
  // 绝对 (200,100) 在 scale 0.5 下是 display (100,50)
  assert.match(out, /截图尺寸 200x100/);
  assert.match(out, /bbox=\(100,50,50,25\)/);

  // 模型给出 display 坐标 (100,50) -> 应还原成物理 (200,100)
  await driver.clickTarget({ x: 100, y: 50 });
  const move = native.calls.filter((c) => c[0] === "setCursorPos").at(-1);
  assert.deepEqual([move[1], move[2]], [200, 100]);

  // elementId 走物理绝对中心点，不受缩放影响
  await driver.clickTarget({ elementId: 0 });
  const move2 = native.calls.filter((c) => c[0] === "setCursorPos").at(-1);
  assert.deepEqual([move2[1], move2[2]], [250, 125]);
});

test("cursorPosition 返回 display 与物理两套坐标", async () => {
  const native = makeFakeNative({ w: 400, h: 200, origin: { x: -100, y: 0 } });
  native.cursorPos = () => ({ x: 100, y: 50 });
  const driver = new WindowsDriver({ native, maxSidePixels: 200 });
  await driver.screenshot();
  const pos = await driver.cursorPosition();
  assert.deepEqual(pos, { x: 100, y: 25, screenX: 100, screenY: 50 });
});

test("clickTarget 按 elementId 使用元素绝对坐标（不加虚拟原点）", async () => {
  const native = makeFakeNative({ w: 200, h: 150, origin: { x: -100, y: -100 } });
  const driver = new WindowsDriver({ native, uiaRunner: uiaRunner(uiaEls) });
  await driver.inspect();
  await driver.clickTarget({ elementId: 0 });
  const move = native.calls.filter((c) => c[0] === "setCursorPos").at(-1);
  // UIA 的 cx/cy 已是绝对物理坐标，直接 (120,110)，不能再加 origin
  assert.deepEqual([move[1], move[2]], [120, 110]);
});

test("clickTarget 未知或过期 elementId 报错", async () => {
  const native = makeFakeNative({ w: 200, h: 150 });
  const driver = new WindowsDriver({ native, uiaRunner: uiaRunner(uiaEls) });
  await driver.inspect();
  await assert.rejects(() => driver.clickTarget({ elementId: 99 }), /不存在|过期/);
});

test("clickTarget 无 elementId 且无坐标时报错；坐标路径仍加原点", async () => {
  const native = makeFakeNative({ w: 200, h: 150, origin: { x: -50, y: 0 } });
  const driver = new WindowsDriver({ native, uiaRunner: uiaRunner(uiaEls) });
  await assert.rejects(() => driver.clickTarget({}), /elementId|x,y/);
  await driver.screenshot(); // 先捕获以同步虚拟原点 (-50,0)
  await driver.clickTarget({ x: 10, y: 10 });
  const move = native.calls.filter((c) => c[0] === "setCursorPos").at(-1);
  assert.deepEqual([move[1], move[2]], [-40, 10]);
});

test("inspect auto：UIA 元素过少且配置 OmniParser 时自动回退", async () => {
  const native = makeFakeNative({ w: 200, h: 150 });
  const omniDetections = Array.from({ length: 5 }, (_, i) => ({
    type: "icon",
    bbox: [i * 20, 50, i * 20 + 15, 70],
    interactivity: true,
    content: "d" + i
  }));
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ parsed_content_list: omniDetections })
  });
  const driver = new WindowsDriver({
    native,
    uiaRunner: uiaRunner(uiaEls), // 仅 1 个 < minElements(3)
    omniEndpoint: "http://127.0.0.1:8000",
    fetchImpl
  });
  const out = await driver.inspect();
  assert.match(out, /OmniParser/);
  assert.match(out, /d4/);
});

test("inspect backend=omniparser 直接使用视觉后端", async () => {
  const native = makeFakeNative({ w: 200, h: 150 });
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({
      elements: [{ type: "icon", bbox: [10, 10, 30, 30], interactivity: true, content: "x" }]
    })
  });
  const driver = new WindowsDriver({
    native, omniEndpoint: "http://x", fetchImpl,
    uiaRunner: uiaRunner(uiaEls)
  });
  const out = await driver.inspect({ backend: "omniparser" });
  assert.match(out, /OmniParser/);
  assert.match(out, /"x"/);
});

test("drag 长距离分步插值：产生 mouse-move 事件流且终点精确", async () => {
  const native = makeFakeNative();
  const driver = new WindowsDriver({ native });
  await driver.drag(0, 0, 400, 300); // 物理距离 500px -> 7 步
  const moves = native.calls.filter((c) => c[0] === "setCursorPos").map((c) => [c[1], c[2]]);
  // 起点 + 7 个插值步（最后一步即终点）
  assert.ok(moves.length >= 6, `应有多次 setCursorPos，实际 ${moves.length}`);
  assert.deepEqual(moves[0], [0, 0], "先落起点");
  assert.deepEqual(moves.at(-1), [400, 300], "最后一步精确落在终点");
  // 单调递增：轨迹不能来回跳
  for (let i = 1; i < moves.length; i += 1) {
    assert.ok(moves[i][0] >= moves[i - 1][0] && moves[i][1] >= moves[i - 1][1], "轨迹应单调");
  }
  // down 在第一步移动前，up 在最后一步移动后
  const kinds = native.calls
    .filter((c) => c[0] === "setCursorPos" || c[0] === "mouseEvent")
    .map((c) => c[0]);
  assert.equal(kinds[0], "setCursorPos");
  assert.equal(kinds[1], "mouseEvent");
  assert.equal(kinds.at(-1), "mouseEvent");
});

test("inspect UIA 失败且无元素时，输出带失败原因与出路（不静默）", async () => {
  const native = makeFakeNative({ w: 200, h: 150 });
  const failing = async () => { throw new Error("powershell 不可用"); };
  const driver = new WindowsDriver({ native, uiaRunner: failing });
  const out = await driver.inspect();
  assert.match(out, /UIA 侦察失败：.*powershell 不可用/);
  assert.match(out, /doctor/);
  assert.match(out, /omniparser/);
});
