// collector.js：页面元素收集器（注入函数）。用极小 DOM 桩直接驱动。
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectElements, readVisibleText } from "../extension/collector.js";

function fakeEl(tag, { x = 0, y = 0, w = 20, h = 20, role, text, aria, placeholder, value, type, href, hidden } = {}) {
  return {
    tagName: tag.toUpperCase(),
    // 真 DOM 返回完整 DOMRect（含 top/right/bottom/left），桩一并补齐
    getBoundingClientRect: () => ({ x, y, width: w, height: h, top: y, bottom: y + h, left: x, right: x + w }),
    getAttribute: (name) => {
      if (name === "role") return role ?? null;
      if (name === "aria-label") return aria ?? null;
      if (name === "placeholder") return placeholder ?? null;
      if (name === "type") return type ?? null;
      if (name === "href") return href ?? null;
      return null;
    },
    textContent: text ?? "",
    innerText: text ?? "",
    value: value ?? ""
  };
}

function installDom({ els, vw = 1608, vh = 913, title = "t", url = "https://example.com/" } = {}) {
  const doc = {
    querySelectorAll: () => els,
    title,
    documentElement: { clientWidth: vw, clientHeight: vh }
  };
  const win = {
    innerWidth: vw, innerHeight: vh,
    screenX: 100, screenY: 50,
    outerWidth: 1624, outerHeight: 1000,
    devicePixelRatio: 1,
    location: { href: url },
    scrollX: 0, scrollY: 0
  };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.location = win.location;
  globalThis.getComputedStyle = () => ({ visibility: "visible", display: "block" });
}

test("收集：可见可交互元素被保留并排序", () => {
  const els = [
    fakeEl("button", { y: 200, x: 300, text: "提交" }),
    fakeEl("a", { y: 100, x: 10, text: "首页", href: "/" }),
    fakeEl("input", { y: 150, x: 10, placeholder: "搜索" })
  ];
  installDom({ els });
  const r = collectElements(80);
  assert.equal(r.elements.length, 3);
  // 排序：先按视觉行（y），再按 x
  assert.equal(r.elements[0].name, "首页");
  assert.equal(r.elements[1].name, "搜索");
  assert.equal(r.elements[2].name, "提交");
  assert.equal(r.elements[0].role, "link");
  assert.equal(r.elements[1].role, "edit");
  // 视口几何随行返回（供 ext-coords 换算）
  assert.equal(r.viewport.screenX, 100);
  assert.equal(r.viewport.dpr, 1);
});

test("收集：不可见 / 视口外元素被过滤", () => {
  const els = [
    fakeEl("a", { x: 0, y: 0, w: 0, h: 0, text: "零尺寸" }),        // w<2 过滤
    fakeEl("button", { x: 0, y: 2000, text: "屏幕下方" }),          // 视口外（vh 913 + margin 32）
    fakeEl("button", { x: 1650, y: 10, text: "右侧出界" }),         // > vw(1608)+32 过滤
    fakeEl("a", { x: 1585, y: 10, text: "贴边保留" })               // 1585 < 1640 → 保留
  ];
  installDom({ els });
  const r = collectElements(80);
  assert.equal(r.elements.length, 1);
  assert.equal(r.elements[0].name, "贴边保留");
});

test("收集：上限截断 + total 反映真实数量", () => {
  const els = Array.from({ length: 10 }, (_, i) => fakeEl("a", { y: i, x: 0, text: `链接${i}` }));
  installDom({ els });
  const r = collectElements(5);
  assert.equal(r.elements.length, 5);
  assert.equal(r.total, 10);
});

test("收集：名称取用次序 aria-label > 文本 > placeholder", () => {
  const els = [
    fakeEl("button", { aria: "确定按钮", text: "确定" }),
    fakeEl("input", { placeholder: "输入关键词" }),
    fakeEl("button", { text: "   " }) // 空白 → 兜底名
  ];
  installDom({ els });
  const r = collectElements(80);
  assert.equal(r.elements[0].name, "确定按钮");
  assert.equal(r.elements[1].name, "输入关键词");
  assert.ok(r.elements[2].name.length > 0); // 兜底：角色+位置
});

test("收集：同 key 去重（同角色同名同位置）", () => {
  const e = fakeEl("button", { x: 5, y: 5, text: "按钮" });
  installDom({ els: [e, fakeEl("button", { x: 5, y: 5, text: "按钮" })] });
  const r = collectElements(80);
  assert.equal(r.elements.length, 1);
});

test("readVisibleText：标题/URL/截断标记", () => {
  installDom({ els: [] });
  globalThis.document.body = { innerText: "A".repeat(3000) };
  const r = readVisibleText(1000);
  assert.equal(r.text.length, 1000);
  assert.equal(r.truncated, true);
  assert.equal(r.url, "https://example.com/");
  const r2 = readVisibleText();
  assert.equal(r2.text.length, 3000); // 缺省 12000 截不到 3000 字符的正文
});
