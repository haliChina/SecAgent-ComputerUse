import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUia,
  normalizeOmniParser,
  buildElementMap,
  describeElements,
  findElement
} from "../driver/element-map.mjs";

test("normalizeUia：cx/cy 缺省时取 bbox 中心", () => {
  const r = normalizeUia(
    { name: "OK", role: "Button", bbox: { x: 10, y: 20, w: 30, h: 40 } },
    2
  );
  assert.equal(r.id, 2);
  assert.equal(r.cx, 25);
  assert.equal(r.cy, 40);
  assert.equal(r.source, "uia");
  assert.equal(r.clickable, true);
});

test("normalizeOmniParser：官方 x1y1x2y2 数组换算宽高", () => {
  const r = normalizeOmniParser(
    { type: "icon", bbox: [100, 200, 180, 230], interactivity: true, content: "关闭窗口" },
    0
  );
  assert.deepEqual(r.bbox, { x: 100, y: 200, w: 80, h: 30 });
  assert.equal(r.cx, 140);
  assert.equal(r.cy, 215);
  assert.equal(r.name, "关闭窗口");
  assert.equal(r.clickable, true);
});

test("normalizeOmniParser：xywh 格式与对象 bbox", () => {
  const a = normalizeOmniParser(
    { bbox: [10, 20, 30, 40], bbox_format: "xywh", type: "icon" }, 0
  );
  assert.deepEqual(a.bbox, { x: 10, y: 20, w: 30, h: 40 });

  const b = normalizeOmniParser(
    { bbox: { x: 1, y: 2, w: 3, h: 4 }, interactivity: 1, caption: "设置" }, 1
  );
  assert.equal(b.name, "设置");
  assert.equal(b.clickable, true);
});

test("normalizeOmniParser：不可点文本与无效矩形", () => {
  const text = normalizeOmniParser(
    { type: "text", bbox: [0, 0, 10, 10], interactivity: false, content: "标题" }, 0
  );
  assert.equal(text.clickable, false);
  assert.equal(text.role, "Text");

  const bad = normalizeOmniParser({ bbox: [5, 5, 5, 5] }, 0); // x2==x1 -> w 0
  assert.equal(bad, null);
});

test("buildElementMap：截断并重新连续编号", () => {
  const raw = Array.from({ length: 5 }, (_, i) => ({
    name: "b" + i, role: "Button",
    bbox: { x: i, y: 0, w: 10, h: 10 }, cx: i + 5, cy: 5
  }));
  const map = buildElementMap(raw, "uia", { cap: 3 });
  assert.equal(map.total, 5);
  assert.equal(map.truncated, true);
  assert.deepEqual(map.elements.map((e) => e.id), [0, 1, 2]);
});

test("buildElementMap：OmniParser clickableOnly 过滤不可点项", () => {
  const raw = [
    { type: "icon", bbox: [0, 0, 10, 10], interactivity: true, content: "可点" },
    { type: "text", bbox: [20, 20, 30, 30], interactivity: false, content: "文字" }
  ];
  const map = buildElementMap(raw, "omniparser", { clickableOnly: true });
  assert.equal(map.total, 1);
  assert.equal(map.elements[0].name, "可点");
});

test("describeElements：含编号、名称、角色与选择提示", () => {
  const map = buildElementMap(
    [{ name: "确定", role: "Button", bbox: { x: 0, y: 0, w: 10, h: 10 }, cx: 5, cy: 5 }],
    "uia"
  );
  const text = describeElements(map);
  assert.match(text, /#0/);
  assert.match(text, /确定/);
  assert.match(text, /Button/);
  assert.match(text, /不要自行估计/);
});

test("findElement：命中与未命中", () => {
  const map = buildElementMap(
    [{ name: "x", role: "Button", bbox: { x: 0, y: 0, w: 1, h: 1 }, cx: 0, cy: 0 }],
    "uia"
  );
  assert.equal(findElement(map.elements, 0)?.name, "x");
  assert.equal(findElement(map.elements, 99), null);
});
