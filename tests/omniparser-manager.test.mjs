import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createOmniParserManager } from "../omniparser/omniparser-manager.mjs";

function tmpDir() {
  const dir = path.join(os.tmpdir(), "cu-mgr-" + crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeHarness({ baseDir, pythonOk = true, healthOk = true } = {}) {
  const execCalls = [];
  const spawnCalls = [];
  let versionFail = !pythonOk;

  const execImpl = (cmd, args) => {
    execCalls.push({ cmd, args });
    const list = args || [];
    if (list.some((x) => String(x).includes("import sys"))) {
      return Promise.resolve(versionFail
        ? { code: 1, stdout: "", stderr: "no python" }
        : { code: 0, stdout: "3.10\n", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const spawnImpl = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, opts });
    return { pid: 4321, on() {}, stdout: null, stderr: null, kill() {} };
  };
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/health")) {
      return healthOk ? { ok: true } : { ok: false };
    }
    return { ok: false };
  };

  const manager = createOmniParserManager({
    baseDir,
    execImpl, spawnImpl, fetchImpl,
    serverTemplate: "PYCODE",
    log() {}
  });
  return { manager, execCalls, spawnCalls };
}

test("一键安装：检测 Python→venv→源码→依赖→权重→写入脚本", async () => {
  const baseDir = tmpDir();
  const { manager, execCalls } = makeHarness({ baseDir });
  await manager.install();

  const st = manager.status();
  assert.equal(st.phase, "installed");
  assert.ok(fs.existsSync(path.join(baseDir, "server.py")));
  assert.ok(fs.existsSync(path.join(baseDir, "installed.json")));

  // 源码：git clone
  assert.ok(execCalls.some((c) => c.cmd === "git" && c.args.includes("clone")));
  // 依赖：安装 huggingface_hub / fastapi / uvicorn / python-multipart
  const pipCalls = execCalls.filter((c) => c.args && c.args[0] === "-m" && c.args[1] === "pip");
  const pipText = JSON.stringify(pipCalls);
  for (const pkg of ["huggingface_hub", "fastapi", "uvicorn", "python-multipart"]) {
    assert.ok(pipText.includes(pkg), "缺少依赖 " + pkg);
  }
  // 权重：snapshot_download
  assert.ok(execCalls.some((c) =>
    c.args && c.args.some((a) => String(a).includes("snapshot_download"))));
});

test("缺少 Python 时安装失败并给出 winget 提示", async () => {
  const baseDir = tmpDir();
  const { manager } = makeHarness({ baseDir, pythonOk: false });
  await assert.rejects(() => manager.install(), /Python|winget/);
  assert.equal(manager.status().phase, "error");
  assert.equal(fs.existsSync(path.join(baseDir, "installed.json")), false);
});

test("start：拉起子进程并通过健康检查 -> running", async () => {
  const baseDir = tmpDir();
  const { manager, spawnCalls } = makeHarness({ baseDir });
  await manager.install();
  await manager.start();
  assert.equal(manager.status().phase, "running");
  assert.equal(spawnCalls.length, 1);
  const call = spawnCalls[0];
  assert.equal(call.args[0], path.join(baseDir, "server.py"));
  assert.ok(call.args.includes("--port"));
  assert.equal(call.opts.env.OMNI_WEIGHTS_DIR, path.join(baseDir, "weights"));
});

test("stop：运行中停止后回到 installed", async () => {
  const baseDir = tmpDir();
  const { manager } = makeHarness({ baseDir });
  await manager.install();
  await manager.start();
  await manager.stop();
  assert.equal(manager.status().phase, "installed");
});

test("uninstall：删除整个目录并回到 not-installed", async () => {
  const baseDir = tmpDir();
  const { manager } = makeHarness({ baseDir });
  await manager.install();
  await manager.uninstall();
  assert.equal(manager.status().phase, "not-installed");
  assert.equal(fs.existsSync(baseDir), false);
});

test("未安装直接 start 报错", async () => {
  const baseDir = tmpDir();
  const { manager } = makeHarness({ baseDir });
  await assert.rejects(() => manager.start(), /尚未安装/);
});

function makeMirrorHarness({ baseDir, hfMirror = "", pipIndexUrl = "" } = {}) {
  const execCalls = [];
  const execImpl = (cmd, args, opts) => {
    execCalls.push({ cmd, args, opts });
    const list = args || [];
    if (list.some((x) => String(x).includes("import sys"))) {
      return Promise.resolve({ code: 0, stdout: "3.11\n", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const manager = createOmniParserManager({
    baseDir,
    execImpl,
    spawnImpl: (cmd, args, opts) => ({ pid: 1, on() {}, stdout: null, stderr: null, kill() {}, _opts: opts }),
    fetchImpl: async () => ({ ok: false }),
    serverTemplate: "PYCODE",
    getHfMirror: () => hfMirror,
    getPipIndexUrl: () => pipIndexUrl,
    log() {}
  });
  return { manager, execCalls };
}

test("配置镜像后：pip 走 -i，权重下载走 HF_ENDPOINT", async () => {
  const baseDir = tmpDir();
  const { manager, execCalls } = makeMirrorHarness({
    baseDir,
    hfMirror: "https://hf-mirror.com",
    pipIndexUrl: "https://pypi.tuna.tsinghua.edu.cn/simple"
  });
  await manager.install();

  const pipCalls = execCalls.filter((c) => c.args && c.args[0] === "-m" && c.args[1] === "pip");
  assert.ok(pipCalls.length > 0);
  for (const c of pipCalls) {
    const i = c.args.indexOf("-i");
    assert.ok(i !== -1 && c.args[i + 1] === "https://pypi.tuna.tsinghua.edu.cn/simple");
  }
  const weightCall = execCalls.find((c) =>
    c.args && c.args.some((a) => String(a).includes("snapshot_download")));
  assert.ok(weightCall, "应有权重下载调用");
  assert.equal(weightCall.opts.env.HF_ENDPOINT, "https://hf-mirror.com");
  assert.ok(weightCall.opts.env.OMNI_W_TARGET.endsWith("weights"));
});

test("不配镜像：不传 HF_ENDPOINT / -i", async () => {
  const baseDir = tmpDir();
  const { manager, execCalls } = makeMirrorHarness({ baseDir });
  await manager.install();
  const weightCall = execCalls.find((c) =>
    c.args && c.args.some((a) => String(a).includes("snapshot_download")));
  assert.ok(weightCall);
  assert.equal(weightCall.opts.env.HF_ENDPOINT, undefined);
  const pipCalls = execCalls.filter((c) => c.args && c.args[0] === "-m" && c.args[1] === "pip");
  assert.ok(pipCalls.every((c) => !c.args.includes("-i")));
});

test("权重下载失败且无镜像：提示填写 HuggingFace 镜像", async () => {
  const baseDir = tmpDir();
  const execImpl = (cmd, args) => {
    const list = args || [];
    if (list.some((x) => String(x).includes("import sys"))) {
      return Promise.resolve({ code: 0, stdout: "3.11\n", stderr: "" });
    }
    if (list.some((x) => String(x).includes("snapshot_download"))) {
      return Promise.resolve({ code: 1, stdout: "", stderr: "network unreachable" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const manager = createOmniParserManager({
    baseDir, execImpl,
    spawnImpl: () => ({ pid: 1, on() {}, stdout: null, stderr: null, kill() {} }),
    fetchImpl: async () => ({ ok: false }),
    serverTemplate: "PYCODE",
    log() {}
  });
  await assert.rejects(() => manager.install(), /HuggingFace 镜像/);
  assert.equal(manager.status().phase, "error");
});
