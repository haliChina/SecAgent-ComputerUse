import { test } from "node:test";
import assert from "node:assert/strict";
import { computeScale, scaledSize, scaleImage, toDisplay, boxToDisplay } from "../driver/scale.mjs";

const px = (img, x, y) => [...img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

test("computeScale：不超过上限不缩放，超过则按长边比例缩（长边口径，同 Claude CUA）", () => {
  assert.equal(computeScale(1568, 1000, 1568), 1);
  assert.equal(computeScale(1280, 720, 1568), 1);
  assert.equal(computeScale(1920, 1080, 1568), 1568 / 1920);
  assert.equal(computeScale(3840, 2160, 1568), 1568 / 3840);
  assert.equal(computeScale(2560, 1440, 0), 1); // 0 = 不缩放
});

test("scaledSize：取整且至少 1px，永不放大", () => {
  assert.deepEqual(scaledSize(3840, 2160, 0.5), { width: 1920, height: 1080 });
  assert.deepEqual(scaledSize(1920, 1080, 1), { width: 1920, height: 1080 });
  assert.deepEqual(scaledSize(10, 10, 0.01), { width: 1, height: 1 });
});

test("scaleImage：scale=1 原样返回同一缓冲", () => {
  const img = { width: 4, height: 2, rgba: Buffer.alloc(32, 7) };
  const out = scaleImage(img, 1);
  assert.equal(out.rgba, img.rgba);
});

test("scaleImage：2x2 黑白棋盘降为 1x1 时取均值", () => {
  const rgba = Buffer.from([
    0, 0, 0, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 0, 0, 0, 255
  ]);
  const out = scaleImage({ width: 2, height: 2, rgba }, 0.5);
  assert.equal(out.width, 1);
  assert.equal(out.height, 1);
  const [r, g, b, a] = px(out, 0, 0);
  assert.equal(r, 127);
  assert.equal(g, 127);
  assert.equal(b, 127);
  assert.equal(a, 255);
});

test("scaleImage：缩放后长边精确等于上限", () => {
  const img = { width: 3840, height: 2160, rgba: Buffer.alloc(3840 * 2160 * 4, 1) };
  const out = scaleImage(img, computeScale(3840, 2160, 1568));
  assert.equal(out.width, 1568);
  assert.equal(out.height, 882);
});

test("toDisplay / boxToDisplay：物理绝对 → 截图内相对", () => {
  const origin = { x: -1920, y: -100 };
  assert.deepEqual(toDisplay({ x: -1920, y: -100 }, origin, 1), { x: 0, y: 0 });
  assert.deepEqual(toDisplay({ x: -960, y: 300 }, origin, 0.5), { x: 480, y: 200 });
  assert.deepEqual(boxToDisplay({ x: -1920, y: -100, w: 200, h: 100 }, origin, 0.5), {
    x: 0, y: 0, w: 100, h: 50
  });
});

test("boxToDisplay：退化矩形宽高至少 1px，避免框消失", () => {
  const out = boxToDisplay({ x: 10, y: 10, w: 1, h: 1 }, { x: 0, y: 0 }, 0.1);
  assert.ok(out.w >= 1 && out.h >= 1);
});