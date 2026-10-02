import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChord, isModifier } from "../driver/keycodes.mjs";

test("解析组合键为虚拟键码", () => {
  assert.deepEqual(parseChord("ctrl+c"), [0x11, 0x43]);
  assert.deepEqual(parseChord("alt+tab"), [0x12, 0x09]);
  assert.deepEqual(parseChord("ctrl+shift+esc"), [0x11, 0x10, 0x1b]);
  assert.deepEqual(parseChord("enter"), [0x0d]);
});

test("字母/数字/功能键映射", () => {
  assert.deepEqual(parseChord("a"), [0x41]);
  assert.deepEqual(parseChord("z"), [0x5a]);
  assert.deepEqual(parseChord("5"), [0x35]);
  assert.deepEqual(parseChord("f5"), [0x74]);
  assert.deepEqual(parseChord("f12"), [0x7b]);
});

test("大小写与空格不影响解析", () => {
  assert.deepEqual(parseChord("  Ctrl + C "), [0x11, 0x43]);
});

test("修饰键判定", () => {
  assert.equal(isModifier(0x11), true);
  assert.equal(isModifier(0x43), false);
});

test("非法/空组合键抛错", () => {
  assert.throws(() => parseChord(""));
  assert.throws(() => parseChord("ctrl+notakey"));
  assert.throws(() => parseChord("+++"));
});
