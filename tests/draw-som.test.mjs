import { test } from "node:test";
import assert from "node:assert/strict";
import { drawSom } from "../driver/draw-som.mjs";

const GREEN = [57, 255, 20];
const BLACK = [0, 0, 0];

function blank(w, h) {
  return { width: w, height: h, rgba: Buffer.alloc(w * h * 4, 255) };
}
function px(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]];
}

// 元素放在 y=30，标签能落在框上方（y=10），不会盖住框边。
test("在元素框位置画荧光绿矩形", () => {
  const src = blank(40, 60);
  const out = drawSom(src, [{ id: 0, bbox: { x: 10, y: 30, w: 8, h: 6 } }]);
  assert.deepEqual(px(out, 12, 30), GREEN); // 上边
  assert.deepEqual(px(out, 12, 35), GREEN); // 下边
  assert.deepEqual(px(out, 10, 32), GREEN); // 左边
});

test("框外有一圈黑色描边", () => {
  const src = blank(40, 60);
  const out = drawSom(src, [{ id: 1, bbox: { x: 10, y: 30, w: 8, h: 6 } }]);
  assert.deepEqual(px(out, 12, 29), BLACK); // 上方外扩
  assert.deepEqual(px(out, 9, 32), BLACK); // 左侧外扩
});

test("绝对坐标减去截图原点后落到正确位置", () => {
  const src = blank(40, 60);
  const out = drawSom(
    src,
    [{ id: 2, bbox: { x: 110, y: 130, w: 8, h: 6 } }],
    { x: 100, y: 100 }
  );
  assert.deepEqual(px(out, 12, 30), GREEN);
});

test("不修改原图，返回新缓冲", () => {
  const src = blank(40, 60);
  drawSom(src, [{ id: 0, bbox: { x: 10, y: 30, w: 8, h: 6 } }]);
  assert.deepEqual(px(src, 12, 30), [255, 255, 255]);
});
