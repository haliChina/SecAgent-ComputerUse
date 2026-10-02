import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePNG } from "../driver/png.mjs";
import { decodePng } from "./decode-png.mjs";

test("编码 2x2 像素并可正确解码", () => {
  const rgba = Buffer.from([
    255, 0, 0, 255, // 红
    0, 255, 0, 255, // 绿
    0, 0, 255, 255, // 蓝
    10, 20, 30, 128 // 半透明
  ]);
  const png = encodePNG({ width: 2, height: 2, rgba });
  assert.ok(Buffer.isBuffer(png));
  const back = decodePng(png);
  assert.equal(back.width, 2);
  assert.equal(back.height, 2);
  assert.deepEqual([...back.rgba], [...rgba]);
});

test("PNG 以标准签名开头", () => {
  const png = encodePNG({ width: 1, height: 1, rgba: Buffer.alloc(4, 255) });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("非法尺寸或数据长度抛错", () => {
  assert.throws(() => encodePNG({ width: 0, height: 1, rgba: Buffer.alloc(0) }));
  assert.throws(() => encodePNG({ width: 2, height: 2, rgba: Buffer.alloc(3) }));
  assert.throws(() => encodePNG({ width: 2, height: 2, rgba: null }));
});
