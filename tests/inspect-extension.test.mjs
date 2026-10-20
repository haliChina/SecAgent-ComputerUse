// inspect 的浏览器扩展后端集成：显式 backend、auto 稀疏回退、坐标链路。
import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowsDriver } from "../driver/win-driver.mjs";

// 复用 driver.test.mjs 的 fake native 形态（8×6 物理屏）。
function makeFakeNative({ w = 8, h = 6, origin = { x: 0, y: 0 } } = {}) {
  const metricMap = { 76: origin.x, 77: origin.y, 78: w, 79: h };
  return {
    supportsThreadDpi: true,
    dpiV2Handle: () => "V2",
    setThreadDpi: () => "OLD",
    metrics: (i) => metricMap[i],
    getDC: () => "screenDC",
    releaseDC: () => {},
    createMemDC: () => "memDC",
    deleteDC: () => {},
    createBitmap: () => "bmp",
    selectObject: () => "oldBmp",
    deleteObject: () => {},
    allocBitmapInfo: () => ({}),
    bitBlt: () => 1,
    getDIBits: (dc, bmp, h, rgba) => { rgba.fill(0); return h; },
    setCursorPos: () => 1,
    cursorPos: () => ({ x: 0, y: 0 }),
    mouseEvent: () => {},
    keybdEvent: () => {},
    mapVirtualKey: () => 0
  };
}

// 假桥：返回固定的 DOM 元素（与 8×6 虚拟屏匹配的物理坐标）。
function makeFakeBridge(elements, { connected = true } = {}) {
  return {
    status: () => ({ running: true, port: 1, token: "x", connected, client: { browser: "Chrome/test" } }),
    collectElements: async () => ({
      tab: { id: 3, title: "测试页", url: "https://example.com/", windowId: 1 },
      zoom: 1,
      elements,
      // 零边框视口（原点=窗口原点），适配 8×6 假屏幕的 withinVirtualScreen 校验
      viewport: { vw: 8, vh: 6, screenX: 0, screenY: 0, outerW: 8, outerH: 6, innerW: 8, innerH: 6, dpr: 1 },
      total: elements.length
    }),
    listTabs: async () => ({}),
    focusTab: async () => ({}),
    readPage: async () => ({})
  };
}

const DOM_ELS = [
  { tag: "a", role: "link", name: "登录", rect: { x: 1, y: 1, w: 3, h: 2 } },
  { tag: "button", role: "button", name: "提交", rect: { x: 4, y: 3, w: 2, h: 2 } }
];

test("inspect(backend=extension)：DOM 元素经坐标换算进入编号地图", async () => {
  const driver = new WindowsDriver({ native: makeFakeNative(), extBridge: makeFakeBridge(DOM_ELS) });
  const out = await driver.inspect({ backend: "extension" });
  assert.match(out, /来源：浏览器扩展/);
  assert.match(out, /"登录"/);
  assert.match(out, /"提交"/);
  // 零边框视口：元素物理坐标 = CSS 坐标
  // 登录: (1,1,3,2)；提交: (4,3,2,2)
  assert.match(out, /bbox=\(1,1,3,2\)/);
});

test("inspect(backend=extension)：标签页上下文与切换提示", async () => {
  const driver = new WindowsDriver({ native: makeFakeNative(), extBridge: makeFakeBridge(DOM_ELS) });
  const out = await driver.inspect({ backend: "extension" });
  assert.match(out, /元素来自标签页「测试页」/);
  assert.match(out, /tabs 工具切换标签页/);
});

test("inspect(auto)：UIA 稀疏时回退扩展", async () => {
  // runner 契约：返回 {stdout}（PowerShell JSON），与 inspectViaUia 真实消费一致
  const sparseUia = async () => ({
    stdout: JSON.stringify({ fgPid: 0, elements: [{ name: "唯一控件", role: "Button", bbox: { x: 0, y: 0, w: 2, h: 2 } }] })
  });
  const driver = new WindowsDriver({
    native: makeFakeNative(),
    uiaRunner: sparseUia,
    extBridge: makeFakeBridge(DOM_ELS),
    configProvider: () => ({ backend: "auto", minElements: 3 })
  });
  const out = await driver.inspect({});
  assert.match(out, /来源：浏览器扩展/);
});

test("inspect(auto)：UIA 健康时不受扩展影响", async () => {
  const healthy = async () => ({
    stdout: JSON.stringify({
      fgPid: 0,
      elements: Array.from({ length: 8 }, (_, i) => ({ name: `控件${i}`, role: "Button", bbox: { x: i, y: 0, w: 1, h: 1 } }))
    })
  });
  const driver = new WindowsDriver({
    native: makeFakeNative(),
    uiaRunner: healthy,
    extBridge: makeFakeBridge(DOM_ELS),
    configProvider: () => ({ backend: "auto", minElements: 3 })
  });
  const out = await driver.inspect({});
  assert.match(out, /来源：Windows UI Automation/);
});

test("inspect(backend=extension)：桥未连接报可操作错误", async () => {
  const driver = new WindowsDriver({ native: makeFakeNative(), extBridge: makeFakeBridge([], { connected: false }) });
  await assert.rejects(
    () => driver.inspect({ backend: "extension" }),
    /浏览器扩展未连接/
  );
});

test("inspect(backend=extension)：无桥时报启用指引", async () => {
  const driver = new WindowsDriver({ native: makeFakeNative() });
  await assert.rejects(
    () => driver.inspect({ backend: "extension" }),
    /浏览器扩展桥未启用/
  );
});

test("inspect(extension)：算飞虚拟屏的元素被丢弃", async () => {
  const wild = [
    { tag: "a", role: "link", name: "正常", rect: { x: 1, y: 1, w: 2, h: 1 } },
    { tag: "a", role: "link", name: "飞出屏幕", rect: { x: 9000, y: 9000, w: 5, h: 5 } }
  ];
  const driver = new WindowsDriver({ native: makeFakeNative(), extBridge: makeFakeBridge(wild) });
  const out = await driver.inspect({ backend: "extension" });
  assert.match(out, /"正常"/);
  assert.doesNotMatch(out, /飞出屏幕/);
});
