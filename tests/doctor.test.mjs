import { test } from "node:test";
import assert from "node:assert/strict";
import { runDoctor, formatDoctorReport } from "../driver/doctor.mjs";

const okNative = () => ({
  metrics: (i) => (i === 78 ? 1920 : 1080)
});
const okUiaRunner = async () => ({ stdout: "[]", stderr: "" });
const okPython = async () => ({ prefix: ["py", "-3.11"], version: "3.11" });
const okOmni = () => ({ phase: "running", endpoint: "http://127.0.0.1:8000" });

function baseDeps(overrides = {}) {
  return {
    platform: "win32",
    loadNative: okNative,
    uiaRunner: okUiaRunner,
    detectPython: okPython,
    getOmniStatus: okOmni,
    ...overrides
  };
}

test("全绿：自检通过", async () => {
  const r = await runDoctor(baseDeps());
  assert.equal(r.ok, true);
  assert.deepEqual(r.failed, []);
  assert.equal(r.checks.length, 6);
  assert.ok(r.checks.every((c) => c.ok));
  const report = formatDoctorReport(r);
  assert.match(report, /自检全部通过/);
});

test("系统库加载失败：给出修复建议", async () => {
  const r = await runDoctor(baseDeps({
    loadNative: () => { throw new Error("koffi boom"); }
  }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, ["native", "screen"]);
  const native = r.checks.find((c) => c.id === "native");
  assert.ok(native.fix.includes("重装插件"));
  const report = formatDoctorReport(r);
  assert.match(report, /❌ 系统库加载/);
  assert.match(report, /↳/);
});

test("非 Windows：平台项失败但不崩", async () => {
  const r = await runDoctor(baseDeps({ platform: "linux" }));
  assert.equal(r.ok, false);
  assert.ok(r.failed.includes("platform"));
  const platform = r.checks.find((c) => c.id === "platform");
  assert.ok(platform.fix.includes("Windows"));
});

test("UIA 探针失败：区分缺 PowerShell 与执行失败", async () => {
  const missing = await runDoctor(baseDeps({
    uiaRunner: async () => { throw new Error("spawn pwsh ENOENT"); }
  }));
  const uia1 = missing.checks.find((c) => c.id === "uia");
  assert.equal(uia1.ok, false);
  assert.ok(uia1.fix.includes("Windows"));

  const failed = await runDoctor(baseDeps({
    uiaRunner: async () => { throw new Error("timeout"); }
  }));
  const uia2 = failed.checks.find((c) => c.id === "uia");
  assert.equal(uia2.ok, false);
  assert.ok(uia2.fix.length > 0);
});

test("Python 缺失是警告，不阻塞自检通过", async () => {
  const r = await runDoctor(baseDeps({ detectPython: async () => null }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, ["python"]);
  const py = r.checks.find((c) => c.id === "python");
  assert.equal(py.optional, true);
  assert.ok(py.fix.includes("winget"));
  const report = formatDoctorReport(r);
  assert.match(report, /⚠️ Python/);
});

test("OmniParser 未安装是警告", async () => {
  const r = await runDoctor(baseDeps({ getOmniStatus: () => ({ phase: "not-installed" }) }));
  assert.equal(r.ok, true);
  const omni = r.checks.find((c) => c.id === "omniparser");
  assert.equal(omni.ok, false);
  assert.equal(omni.optional, true);
});

test("屏幕探针读到非法尺寸则失败", async () => {
  const r = await runDoctor(baseDeps({
    loadNative: () => ({ metrics: () => 0 })
  }));
  const screen = r.checks.find((c) => c.id === "screen");
  assert.equal(screen.ok, false);
  assert.equal(r.ok, false);
});

test("issue #18 问题 3：doctor 报告无 CUDA 机器不建议启用 OmniParser", async () => {
  const { runDoctor } = await import("../driver/doctor.mjs");
  const r = await runDoctor({
    platform: "win32",
    loadNative: () => ({}),
    getOmniStatus: () => ({ phase: "running", endpoint: "http://127.0.0.1:8000" }),
    probeCuda: async () => false
  });
  const omni = r.checks.find((c) => c.id === "omniparser");
  assert.ok(omni, "omniparser 检查项存在");
  assert.match(omni.detail, /无 CUDA/, "detail 标注无 CUDA");
  assert.match(omni.fix, /不建议启用/, "fix 给出建议");
  // 有 CUDA 时报告可用
  const r2 = await runDoctor({
    platform: "win32",
    loadNative: () => ({}),
    getOmniStatus: () => ({ phase: "running", endpoint: "http://127.0.0.1:8000" }),
    probeCuda: async () => true
  });
  assert.match(r2.checks.find((c) => c.id === "omniparser").detail, /CUDA 可用/);
});

test("0.8.2 五形态实测：flashShapes 依次闪五种并报告序列（doctor 肉眼对照）", async () => {
  const { runDoctor } = await import("../driver/doctor.mjs");
  const flashed = [];
  const r = await runDoctor({
    platform: "win32",
    loadNative: () => ({}),
    flashProbe: async () => ({ via: "host", ok: true }),
    flashShapes: async () => {
      for (const k of ["click", "type", "chord", "scroll", "focus"]) flashed.push(k);
      return flashed.map((kind) => ({ kind, via: "host", ok: true }));
    }
  });
  assert.deepEqual(flashed, ["click", "type", "chord", "scroll", "focus"], "依次五形态");
  const item = r.checks.find((c) => c.id === "flash");
  assert.match(item.detail, /五形态实测/, "报告含五形态说明");
  assert.match(item.detail, /蓝胶囊|键帽|紫箭头/, "含对照提示");
});

test("0.8.2 flashAt 透传 extra（chord label / scroll direction）", async () => {
  const { WindowsDriver } = await import("../driver/win-driver.mjs");
  const seen = [];
  const native = { cursorPos: () => ({ x: 10, y: 10 }) };
  const driver = new WindowsDriver({
    native,
    configProvider: () => ({}),
    hostFlash: (x, y, opts) => seen.push({ x, y, opts })
  });
  await driver.flashAt(10, 10, "chord", 12, { label: "Ctrl+S" });
  await driver.flashAt(10, 10, "scroll", 10, { direction: -1 });
  // 0.8.3：#flash 统一解析 ms（extra>每类默认>设置项）并显式下发宿主
  assert.deepEqual(seen[0].opts, { kind: "chord", radius: 12, label: "Ctrl+S", ms: 1500 });
  assert.deepEqual(seen[1].opts, { kind: "scroll", radius: 10, direction: -1, ms: 900 });
});
