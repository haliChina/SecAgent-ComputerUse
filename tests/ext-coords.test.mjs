// ext-coords：浏览器 CSS 像素 → 物理屏幕坐标 的换算数学。
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeViewportOriginDip, elementToPhysical, withinVirtualScreen } from "../driver/ext-coords.mjs";

// 基准视口：1080p、100% 缩放、无页面缩放、窗口位于 (100, 50)，
// 浏览器 chrome 顶部 87 DIP（标题栏+标签条+地址栏）、侧边框 8 DIP。
const BASE = {
  screenX: 100, screenY: 50,
  outerW: 1624, outerH: 1000,
  innerW: 1608, innerH: 913, // outer - 2*8 侧框 / outer - 87 顶栏
  dpr: 1, zoom: 1
};

test("100% 缩放无缩放：视口原点 = 窗口位置 + 边框", () => {
  const o = computeViewportOriginDip(BASE);
  assert.equal(o.x, 108); // 100 + (1624-1608)/2
  assert.equal(o.y, 137); // 50 + 87
  assert.equal(o.osScale, 1);
});

test("100% 缩放：元素 CSS 坐标原样映射到物理屏幕", () => {
  const p = elementToPhysical({ rect: { x: 100, y: 200, w: 40, h: 20 } }, BASE);
  assert.deepEqual(p, { x: 208, y: 337, w: 40, h: 20 });
});

test("150% 显示缩放：DIP×1.5（zoom=1 时 osScale=dpr）", () => {
  const v = { ...BASE, dpr: 1.5 };
  const p = elementToPhysical({ rect: { x: 0, y: 0, w: 100, h: 50 } }, v);
  // 视口原点 DIP (108,137) ×1.5
  assert.equal(p.x, 162);
  assert.equal(p.y, Math.round(205.5)); // 137*1.5=205.5
  assert.equal(p.w, 150);
  assert.equal(p.h, 75);
});

test("125% 页面缩放：CSS×zoom 换 DIP，osScale 反解不被 zoom 污染", () => {
  const v = { ...BASE, dpr: 1.5, zoom: 1.25 }; // 系统其实是 120%? 设 1.5/1.25=1.2
  const o = computeViewportOriginDip(v);
  assert.equal(o.osScale, 1.2);
  // zoom 后 inner DIP = innerW*zoom；本例 outer 固定，边框相应变大（页面内容变小）
  // innerW*zoom = 1608*1.25 = 2010 > outerW → 防御路径：视为无侧框
  assert.equal(o.x, v.screenX); // 100 + 0/2
});

test("125% 页面缩放（可行域）：元素 CSS × zoom × osScale", () => {
  // outerW 2000，innerW 1500（zoom=1.25 → inner DIP=1875，侧框 (2000-1875)/2=62.5）
  const v = { screenX: 0, screenY: 0, outerW: 2000, outerH: 1100, innerW: 1500, innerH: 1000, dpr: 1.25, zoom: 1.25 };
  const o = computeViewportOriginDip(v);
  assert.equal(o.osScale, 1);
  assert.equal(o.x, 62.5); // 不取整；取整只发生在 elementToPhysical 末端
  const p = elementToPhysical({ rect: { x: 100, y: 0, w: 50, h: 10 } }, v);
  assert.equal(p.x, 188); // (62.5 + 125) 四舍五入
  assert.equal(p.w, 63); // 62.5 四舍五入
});

test("最大化窗口：负 screenX 被不可见边框抵消，视口原点落在 (0, 顶部栏)", () => {
  const v = { screenX: -8, screenY: -8, outerW: 1616, outerH: 904, innerW: 1600, innerH: 808, dpr: 1, zoom: 1 };
  const o = computeViewportOriginDip(v);
  assert.equal(o.x, 0); // -8 + (1616-1600)/2 = -8+8
  assert.equal(o.y, 88); // -8 + 96
});

test("缺省 zoom/dpr 视为 1，防御非法值", () => {
  const o = computeViewportOriginDip({ screenX: 10, screenY: 10, outerW: 100, outerH: 100 });
  assert.equal(o.x, 10);
  assert.equal(o.osScale, 1);
  const o2 = computeViewportOriginDip({ ...BASE, zoom: 0, dpr: -3 });
  assert.equal(o2.osScale, 1);
});

test("withinVirtualScreen：屏幕内/外/容差", () => {
  const v = { x: 0, y: 0, w: 1920, h: 1080 };
  assert.equal(withinVirtualScreen({ x: 100, y: 100, w: 50, h: 50 }, v), true);
  assert.equal(withinVirtualScreen({ x: 5000, y: 100, w: 50, h: 50 }, v), false);
  assert.equal(withinVirtualScreen({ x: -60, y: 0, w: 50, h: 50 }, v), true); // 64 容差内
  assert.equal(withinVirtualScreen({ x: -60, y: 0, w: 50, h: 50 }, null), true); // 无虚拟屏信息 → 放行
});
