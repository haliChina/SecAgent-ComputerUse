// 回归测试：koffi 2.16 封送契约（0.5.3，实机 0.5.2 暴露的第三弹）。
//
// 教训：注入 fake koffi 的单测无法暴露封送 API 误用——三处错误用法
// （koffi.as(-4,"void*") / alloc(结构体,{初始值}) / alloc(8)+pointer 解码）
// 在 fake 下全部"通过"，实机全炸。koffi 的 JS 封送层本身跨平台，
// 所以这里直接对**真实 koffi** 验证 win-driver.mjs 依赖的全部 API 用法，
// Linux 开发机即可运行，不需要 Windows。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require2 = createRequire(import.meta.url);
const koffi = require2("koffi");

// 与 win-driver.mjs 相同的字段布局
const BIH = koffi.struct("T_BIH", {
  biSize: "uint32", biWidth: "int32", biHeight: "int32", biPlanes: "uint16",
  biBitCount: "uint16", biCompression: "uint32", biSizeImage: "uint32",
  biXPelsPerMeter: "int32", biYPelsPerMeter: "int32", biClrUsed: "uint32", biClrImportant: "uint32"
});
const PT = koffi.struct("T_PT", { x: "int32", y: "int32" });

function loadCLib() {
  const names = process.platform === "win32" ? ["msvcrt.dll"] : ["libc.so.6", "libc.so"];
  for (const name of names) {
    try { return koffi.load(name); } catch { /* 尝试下一个 */ }
  }
  return null;
}

test("DPI 伪句柄封送：int64 参数直接接受 -4（0.5.2 实机 Invalid argument 根因）", () => {
  const libc = loadCLib();
  assert.ok(libc, "应有可加载的 C 运行库");
  // SetThreadDpiAwarenessContext 同型：int64 入参、int64 返回。
  // koffi.as(-4, "void*") 会抛 "Invalid argument"，必须走 int64 封送。
  const labs = libc.func("int64 labs(int64 x)");
  assert.equal(labs(-4), 4, "int64 参数应接受负数伪句柄");
  // 返回值（前一个 DPI 上下文）应能原样回传
  assert.equal(labs(labs(-4)), 4);
});

test("BITMAPINFOHEADER 封送：alloc(type, 1) + encode 整结构体 + decode 回读", () => {
  // 旧写法 koffi.alloc(BIH, {对象}) 在 koffi 2.16 抛
  // "Unexpected Object value for length, expected number"（第二参是元素个数）
  const bi = koffi.alloc(BIH, 1);
  koffi.encode(bi, BIH, {
    biSize: 40, biWidth: 1920, biHeight: -1080, biPlanes: 1, biBitCount: 32,
    biCompression: 0, biSizeImage: 1920 * 1080 * 4, biXPelsPerMeter: 0,
    biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0
  });
  const back = koffi.decode(bi, BIH);
  assert.equal(back.biSize, 40);
  assert.equal(back.biWidth, 1920);
  assert.equal(back.biHeight, -1080, "自顶向下位图 biHeight 应为负");
  assert.equal(back.biBitCount, 32);
});

test("POINT 封送：按偏移 decode 标量（GetCursorPos 结果读取）", () => {
  const pt = koffi.alloc(PT, 1);
  koffi.encode(pt, PT, { x: 123, y: 456 });
  assert.equal(koffi.decode(pt, 0, "int32"), 123);
  assert.equal(koffi.decode(pt, 4, "int32"), 456);
});

test("结构体指针可作 void* 实参传给真实 C 函数（GetDIBits/GetCursorPos 同型）", () => {
  const libc = loadCLib();
  if (!libc) return; // 无 C 库环境跳过（发布与开发环境均有）
  const memset = libc.func("void* memset(void* dst, int c, size_t n)");
  const pt = koffi.alloc(PT, 1);
  koffi.encode(pt, PT, { x: -1, y: -1 });
  memset(pt, 0, 8); // 往结构体内存写零——验证指针封送真实生效
  assert.equal(koffi.decode(pt, 0, "int32"), 0);
  assert.equal(koffi.decode(pt, 4, "int32"), 0);
});

test("Node Buffer 可作 void* 实参（GetDIBits 的 lpBits 像素缓冲）", () => {
  const libc = loadCLib();
  if (!libc) return;
  const memset = libc.func("void* memset(void* dst, int c, size_t n)");
  const bits = Buffer.alloc(16, 0xff);
  memset(bits, 0, 16);
  assert.ok(bits.every((b) => b === 0), "C 函数应能写入 Buffer 内存");
});

// ---- 0.7.1 SendInput / INPUT 布局（#12 中文乱码根因修复）----
// keybd_event 的 bScan 是 uint8：'你'(U+4F60) 被截断成 0x60 → 乱码。
// 修复走 SendInput：INPUT.wScan 是 uint16。这里对真实 koffi 逐偏移验证
// 显式 padding 的 SA_INPUT 与 WinUser.h Win64 布局逐字节一致。
const INPUT_T = koffi.struct("T_INPUT", {
  type: "uint32", pad0: "uint32",
  wVk: "uint16", wScan: "uint16",
  dwFlags: "uint32", time: "uint32", pad1: "uint32",
  dwExtraInfo: "uintptr", tail: "uint32"
});

test("INPUT 结构：sizeof=40 且关键字段偏移与 WinUser.h 一致", () => {
  assert.equal(koffi.sizeof(INPUT_T), 40, "sizeof(INPUT) x64 = 40（MOUSEINPUT 是联合体最大成员）");
  assert.equal(koffi.offsetof(INPUT_T, "type"), 0);
  assert.equal(koffi.offsetof(INPUT_T, "wVk"), 8, "联合体 8 字节对齐：type(4)+pad(4) 后起");
  assert.equal(koffi.offsetof(INPUT_T, "wScan"), 10);
  assert.equal(koffi.offsetof(INPUT_T, "dwFlags"), 12);
  assert.equal(koffi.offsetof(INPUT_T, "time"), 16);
  assert.equal(koffi.offsetof(INPUT_T, "dwExtraInfo"), 24, "time 后填充 4 字节对齐 uintptr");
});

test("SendInput 封送：koffi.array 匿名数组 + 整段 encode + 按偏移 decode 回读", () => {
  const mk = (scan, flags) => ({
    type: 1 /* INPUT_KEYBOARD */, pad0: 0, wVk: 0, wScan: scan,
    dwFlags: flags, time: 0, pad1: 0, dwExtraInfo: 0, tail: 0
  });
  const n = 2;
  const arr = koffi.array(INPUT_T, n);
  const p = koffi.alloc(arr, 1);
  koffi.encode(p, arr, [mk(0x4f60, 0x04), mk(0x4f60, 0x06)]);
  const sz = koffi.sizeof(INPUT_T);
  // 逐偏移回读：中文 0x4F60 完整保留（旧 keybd_event 路径此处只会剩 0x60）
  assert.equal(koffi.decode(p, 0 * sz + koffi.offsetof(INPUT_T, "wScan"), "uint16"), 0x4f60);
  assert.equal(koffi.decode(p, 0 * sz + koffi.offsetof(INPUT_T, "dwFlags"), "uint32"), 0x04);
  assert.equal(koffi.decode(p, 1 * sz + koffi.offsetof(INPUT_T, "wScan"), "uint16"), 0x4f60);
  assert.equal(koffi.decode(p, 1 * sz + koffi.offsetof(INPUT_T, "dwFlags"), "uint32"), 0x06);
  assert.equal(koffi.decode(p, 1 * sz, "uint32"), 1, "INPUT_KEYBOARD");
  // 数组总大小
  assert.equal(koffi.sizeof(arr), n * sz);
});

test("koffi.array 类型按长度可重复创建（匿名类型，无 Duplicate type name）", () => {
  const a1 = koffi.array(INPUT_T, 3);
  const a2 = koffi.array(INPUT_T, 3);
  assert.equal(koffi.sizeof(a1), koffi.sizeof(a2));
});

// ---- 0.7.2 点击标记分层窗口（DWM 修复）----
const WC_T = koffi.struct("T_WC", {
  cbSize: "uint32", style: "uint32", lpfnWndProc: "uintptr",
  cbClsExtra: "int32", cbWndExtra: "int32", hInstance: "void*",
  hIcon: "void*", hCursor: "void*", hbrBackground: "void*",
  lpszMenuName: "str16", lpszClassName: "str16", hIconSm: "void*"
});

test("WNDCLASSEXW 布局：sizeof=80，与 WinUser.h 逐偏移一致（str16 字段可用）", () => {
  assert.equal(koffi.sizeof(WC_T), 80);
  assert.equal(koffi.offsetof(WC_T, "cbSize"), 0);
  assert.equal(koffi.offsetof(WC_T, "lpfnWndProc"), 8, "4+4 对齐填充后函数指针 @8");
  assert.equal(koffi.offsetof(WC_T, "cbClsExtra"), 16);
  assert.equal(koffi.offsetof(WC_T, "hInstance"), 24);
  assert.equal(koffi.offsetof(WC_T, "lpszMenuName"), 56);
  assert.equal(koffi.offsetof(WC_T, "lpszClassName"), 64);
  assert.equal(koffi.offsetof(WC_T, "hIconSm"), 72);
  const p = koffi.alloc(WC_T, 1);
  koffi.encode(p, WC_T, {
    cbSize: 80, style: 0, lpfnWndProc: 0x7ffb12345678, cbClsExtra: 0, cbWndExtra: 0,
    hInstance: 0x7ffb00000000, hIcon: null, hCursor: null, hbrBackground: null,
    lpszMenuName: "", lpszClassName: "SecAgentFlash", hIconSm: null
  });
  const procAddr = koffi.decode(p, koffi.offsetof(WC_T, "lpfnWndProc"), "uintptr");
  assert.equal(Number(procAddr), 0x7ffb12345678, "函数指针（GetProcAddress 返回的 DefWindowProcW 地址）无损往返");
});

test("BLENDFUNCTION/SIZE 封送 + uint32 预乘像素数组", () => {
  const BF = koffi.struct("T_BF2", { blendOp: "uint8", blendFlags: "uint8", sourceConstantAlpha: "uint8", alphaFormat: "uint8" });
  assert.equal(koffi.sizeof(BF), 4);
  const SZ = koffi.struct("T_SZ2", { cx: "int32", cy: "int32" });
  assert.equal(koffi.sizeof(SZ), 8);
  // 预乘 BGRA：alpha=200 → 0xC8 C8 1F 1F（JS 位运算结果必须 >>> 0 转 unsigned）
  const px = ((200 << 24) | (200 << 16) | (31 << 8) | 31) >>> 0;
  const arr = koffi.array("uint32", 3);
  const a = koffi.alloc(arr, 1);
  koffi.encode(a, arr, [0, px, 0xff]);
  assert.equal(koffi.decode(a, 4, "uint32"), 0xc8c81f1f);
});
