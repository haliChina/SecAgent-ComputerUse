// 0.7.4：koffi 声明归属 + flash 懒防御（「Cannot find function 'GetModuleHandleW'」根因回归）。
// 0.7.2/0.7.3 把 GetModuleHandleW/GetProcAddress 错挂 user32（实为 kernel32 导出）、
// SetDIBits 错挂 user32（实为 gdi32 导出）——koffi 立即解析抛错导致整个 native
// 创建失败，截图/点击/输入全废（用户实机 Agent 卡死）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKoffiNative, resetKoffiNativeForTest } from "../driver/win-driver.mjs";

function fakeKoffiWithLibs({ declFailFor = null } = {}) {
  const libCalls = []; // [lib, signature]
  const mkLib = (lib) => ({
    func: (sig) => {
      libCalls.push([lib, sig]);
      const name = (sig.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/) || [])[1] || "";
      if (declFailFor && declFailFor.test(name)) throw new Error(`Cannot find function '${name}'`);
      return () => 0;
    }
  });
  const libs = { "user32.dll": mkLib("user32"), "gdi32.dll": mkLib("gdi32"), "kernel32.dll": mkLib("kernel32") };
  return {
    koffi: { load: (name) => libs[name], struct: () => ({}), as: (v) => v },
    libCalls
  };
}

test("声明归属：GetModuleHandleW/GetProcAddress→kernel32，SetDIBits→gdi32", () => {
  const { koffi, libCalls } = fakeKoffiWithLibs();
  resetKoffiNativeForTest();
  try {
    const n = createKoffiNative(koffi);
    assert.ok(n);
    const find = (fnName) => libCalls.filter(([lib, sig]) => sig.includes(fnName)).map(([lib]) => lib);
    assert.deepEqual(find("GetModuleHandleW"), ["kernel32"], "GetModuleHandleW 必须声明自 kernel32（user32 无此导出）");
    assert.deepEqual(find("GetProcAddress"), ["kernel32"], "GetProcAddress 必须声明自 kernel32");
    assert.deepEqual(find("SetDIBits"), ["gdi32"], "SetDIBits 必须声明自 gdi32");
    assert.ok(find("RegisterClassExW").includes("user32"));
    assert.ok(find("UpdateLayeredWindow").includes("user32"));
  } finally {
    resetKoffiNativeForTest();
  }
});

test("懒防御：flash 声明失败不连累动作链路（native 仍可用）", () => {
  const { koffi } = fakeKoffiWithLibs({ declFailFor: /^(GetModuleHandleW|SetDIBits)$/ });
  resetKoffiNativeForTest();
  try {
    // 不得抛——动作核心函数声明成功，native 必须创建成功
    const n = createKoffiNative(koffi);
    assert.ok(n);
    assert.ok(typeof n.screenshot === "function" || typeof n.flashMarker === "function");
    assert.ok(n.flashUnavailable, "记录了 flash 声明失败原因");
    // flashMarker 返回诊断而非抛错
    const r = n.flashMarker(10, 10, 12, "click");
    assert.equal(r.via, "native");
    assert.equal(r.ok, false);
    assert.equal(r.stage, "unavailable");
    assert.ok(r.error.includes("Cannot find function"), "透出底层原因");
  } finally {
    resetKoffiNativeForTest();
  }
});
