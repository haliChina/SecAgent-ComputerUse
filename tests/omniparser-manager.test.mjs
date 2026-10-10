import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { createOmniParserManager } from "../omniparser/omniparser-manager.mjs";

function tmpDir() {
  const dir = path.join(os.tmpdir(), "cu-mgr-" + crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 权重下载的 fetch 桩：魔搭 URL 返回 16 字节内容；200 给 content-length，206 给 content-range
function weightResponse({ status = 200, total = 16, chunk = null } = {}) {
  const body = chunk ?? Buffer.alloc(total, 0x61);
  return {
    ok: status === 200 || status === 206,
    status,
    headers: {
      get: (k) => {
        const key = String(k).toLowerCase();
        if (key === "content-length" && status !== 206) return String(body.length);
        if (key === "content-range" && status === 206) return `bytes 0-${body.length - 1}/${total}`;
        return null;
      }
    },
    body: Readable.from([body])
  };
}

// 默认 fetch 桩：魔搭可用（权重直连成功），其它源 404；health 由参数控制
function modelScopeFetch(healthOk = true) {
  return async (url) => {
    if (String(url).endsWith("/health")) return healthOk ? { ok: true } : { ok: false };
    if (String(url).includes("modelscope.cn")) return weightResponse();
    return { ok: false, status: 404 };
  };
}

function dummySpawn() {
  return { pid: 1, on() {}, stdout: null, stderr: null, kill() {} };
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
  const fetchImpl = modelScopeFetch(healthOk);

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
  // transformers 钉版：4.53+ 的 tokenizers 新后端与 Florence-2 remote code 不兼容
  // （实机：AttributeError: TokenizersBackend has no attribute additional_special_tokens）
  assert.ok(pipText.includes("transformers==4.49.0"), "必须钉 transformers==4.49.0");
  const pinnedAt = pipCalls.findIndex((c) => c.args.includes("transformers==4.49.0"));
  const reqAt = pipCalls.findIndex((c) => c.args.includes("-r"));
  assert.ok(reqAt === -1 || pinnedAt > reqAt, "钉版必须发生在 -r requirements 之后（强制收敛版本）");
  // 权重：13 个文件全部从魔搭直连下载就位（含 Florence tokenizer 合并文件）
  assert.ok(fs.existsSync(path.join(baseDir, "weights", "icon_detect", "model.pt")));
  assert.ok(fs.existsSync(path.join(baseDir, "weights", "icon_caption_florence", "model.safetensors")));
  assert.ok(fs.existsSync(path.join(baseDir, "weights", "icon_caption_florence", "tokenizer.json")));
  assert.ok(fs.existsSync(path.join(baseDir, "weights", "icon_caption_florence", "processing_florence2.py")));
  assert.equal(st.hasWeights, true, "hasWeights 应为真（全部文件就位）");
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

function makeMirrorHarness({ baseDir, hfMirror = "", pipIndexUrl = "", modelScopeOk = true } = {}) {
  const execCalls = [];
  const fetchedUrls = [];
  const execImpl = (cmd, args, opts) => {
    execCalls.push({ cmd, args, opts });
    const list = args || [];
    if (list.some((x) => String(x).includes("import sys"))) {
      return Promise.resolve({ code: 0, stdout: "3.11\n", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const fetchImpl = async (url) => {
    fetchedUrls.push(String(url));
    if (String(url).includes("modelscope.cn")) {
      return modelScopeOk ? weightResponse() : { ok: false, status: 404 };
    }
    if (hfMirror && String(url).startsWith(hfMirror)) return weightResponse();
    return { ok: false, status: 404 };
  };
  const manager = createOmniParserManager({
    baseDir,
    execImpl,
    spawnImpl: (cmd, args, opts) => ({ pid: 1, on() {}, stdout: null, stderr: null, kill() {}, _opts: opts }),
    fetchImpl,
    serverTemplate: "PYCODE",
    getHfMirror: () => hfMirror,
    getPipIndexUrl: () => pipIndexUrl,
    log() {}
  });
  return { manager, execCalls, fetchedUrls };
}

test("配置镜像后：pip 走 -i；魔搭缺文件时权重回退到镜像源", async () => {
  const baseDir = tmpDir();
  const { manager, execCalls, fetchedUrls } = makeMirrorHarness({
    baseDir,
    hfMirror: "https://hf-mirror.com",
    pipIndexUrl: "https://pypi.tuna.tsinghua.edu.cn/simple",
    modelScopeOk: false // 魔搭 404 → 逐文件跳到镜像源
  });
  await manager.install();

  const pipCalls = execCalls.filter((c) => c.args && c.args[0] === "-m" && c.args[1] === "pip");
  assert.ok(pipCalls.length > 0);
  for (const c of pipCalls) {
    const i = c.args.indexOf("-i");
    assert.ok(i !== -1 && c.args[i + 1] === "https://pypi.tuna.tsinghua.edu.cn/simple");
  }
  const weightUrls = fetchedUrls.filter((u) => u.includes("/resolve/"));
  assert.ok(weightUrls.some((u) => u.startsWith("https://hf-mirror.com/")), "魔搭缺文件时应经镜像下载");
  assert.ok(weightUrls.every((u) => !u.startsWith("https://huggingface.co/")), "镜像可用时不应再走官方源");
  assert.ok(fs.existsSync(path.join(baseDir, "weights", "icon_detect", "model.pt")), "权重应就位");
  assert.equal(manager.status().phase, "installed");
});

test("不配镜像：权重默认走魔搭，pip 不带 -i", async () => {
  const baseDir = tmpDir();
  const { manager, execCalls, fetchedUrls } = makeMirrorHarness({ baseDir });
  await manager.install();
  const weightUrls = fetchedUrls.filter((u) => u.includes("/resolve/"));
  assert.ok(weightUrls.length >= 13, "应逐文件下载权重（13 个）");
  assert.ok(weightUrls.every((u) => u.startsWith("https://modelscope.cn/")), "默认应从魔搭直连");
  const pipCalls = execCalls.filter((c) => c.args && c.args[0] === "-m" && c.args[1] === "pip");
  assert.ok(pipCalls.every((c) => !c.args.includes("-i")));
  assert.ok(fs.existsSync(path.join(baseDir, "weights", "icon_caption_florence", "model.safetensors")));
});

test("权重全源失败：报错列出各源原因并提示重试续传，不再推荐 hf-mirror", async () => {
  const baseDir = tmpDir();
  const execImpl = (cmd, args) => {
    const list = args || [];
    if (list.some((x) => String(x).includes("import sys"))) {
      return Promise.resolve({ code: 0, stdout: "3.11\n", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const manager = createOmniParserManager({
    baseDir, execImpl,
    spawnImpl: dummySpawn,
    fetchImpl: async () => ({ ok: false, status: 502 }),
    serverTemplate: "PYCODE",
    log() {}
  });
  await assert.rejects(() => manager.install(), (error) => {
    assert.match(error.message, /modelscope\.cn|魔搭/);
    assert.match(error.message, /不会重复下载/);
    assert.doesNotMatch(error.message, /hf-mirror\.com/, "不应再推荐不可达的 hf-mirror");
    return true;
  });
  assert.equal(manager.status().phase, "error");
});

test("断点续传：.part 已存在时带 Range 请求，206 追加后按总长校验就位", async () => {
  const baseDir = tmpDir();
  // 预置只下了一半的 .part（8/16 字节）
  const partPath = path.join(baseDir, "weights", "icon_caption_florence", "model.safetensors.part");
  fs.mkdirSync(path.dirname(partPath), { recursive: true });
  fs.writeFileSync(partPath, Buffer.alloc(8, 0x62));
  const execImpl = (cmd, args) => {
    const list = args || [];
    if (list.some((x) => String(x).includes("import sys"))) {
      return Promise.resolve({ code: 0, stdout: "3.11\n", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const fetchImpl = async (url, opts) => {
    if (String(url).includes("modelscope.cn")) {
      if (String(url).endsWith("model.safetensors")) {
        assert.equal(opts.headers.Range, "bytes=8-", "续传应带 Range 头");
        return weightResponse({ status: 206, total: 16, chunk: Buffer.alloc(8, 0x63) });
      }
      return weightResponse();
    }
    return { ok: false, status: 404 };
  };
  const manager = createOmniParserManager({
    baseDir, execImpl, spawnImpl: dummySpawn, fetchImpl, serverTemplate: "PYCODE", log() {}
  });
  await manager.install();
  const final = path.join(baseDir, "weights", "icon_caption_florence", "model.safetensors");
  const content = fs.readFileSync(final);
  assert.equal(content.length, 16);
  assert.ok(content.subarray(0, 8).every((b) => b === 0x62), "前 8 字节应为原 .part 内容");
  assert.ok(content.subarray(8).every((b) => b === 0x63), "后 8 字节应为续传内容");
  assert.equal(fs.existsSync(`${final}.part`), false, "完成后 .part 应消失");
});

test("权重源瞬态失败（502）：同源自动重试一次后成功，不换源", async () => {
  const baseDir = tmpDir();
  let failNext = true;
  const execImpl = (cmd, args) => {
    const list = args || [];
    if (list.some((x) => String(x).includes("import sys"))) {
      return Promise.resolve({ code: 0, stdout: "3.11\n", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const fetchImpl = async (url) => {
    if (String(url).includes("modelscope.cn")) {
      if (failNext) { failNext = false; return { ok: false, status: 502 }; }
      return weightResponse();
    }
    return { ok: false, status: 404 };
  };
  const manager = createOmniParserManager({
    baseDir, execImpl, spawnImpl: dummySpawn, fetchImpl, serverTemplate: "PYCODE", log() {}
  });
  await manager.install();
  assert.equal(manager.status().phase, "installed");
  assert.ok(fs.existsSync(path.join(baseDir, "weights", "icon_detect", "model.pt")));
});

// ---- 实机反馈：Python 3.13+ 一键安装 numpy 源码编译失败（无 C 编译器）----
// 根因：上游 OmniParser 钉死 numpy==1.26.4，只有 3.9~3.12 的预编译包。

function makeVersionHarness(baseDir, probe) {
  const execCalls = [];
  const execImpl = (cmd, args) => {
    execCalls.push({ cmd, args });
    const list = args || [];
    if (list.some((x) => String(x).includes("import sys"))) {
      const version = probe(cmd);
      return version
        ? Promise.resolve({ code: 0, stdout: version + "\n", stderr: "" })
        : Promise.resolve({ code: 1, stdout: "", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const manager = createOmniParserManager({
    baseDir, execImpl,
    spawnImpl: () => ({ pid: 1, on() {}, stdout: null, stderr: null, kill() {} }),
    fetchImpl: modelScopeFetch(),
    serverTemplate: "PYCODE",
    log() {}
  });
  return { manager, execCalls };
}

test("只有 Python 3.13：拒绝安装并说明预编译包范围，不再误指镜像", async () => {
  const baseDir = tmpDir();
  const { manager } = makeVersionHarness(baseDir, () => "3.13");
  await assert.rejects(() => manager.install(), /3\.9~3\.12|预编译|winget install Python\.Python\.3\.11/);
  assert.equal(manager.status().phase, "error");
  assert.equal(fs.existsSync(path.join(baseDir, "venv")), false);
});

test("3.13 与 3.11 并存时优先选 3.11，不用 3.13 建 venv", async () => {
  const baseDir = tmpDir();
  const { manager, execCalls } = makeVersionHarness(baseDir, (cmd) => {
    // 第一个候选（win: py -3.11 / linux: python3.11）返回 3.11，其余版本探测一律 3.13
    const isFirst = cmd === "py" || cmd === "python3.11";
    return isFirst ? "3.11" : "3.13";
  });
  await manager.install();
  assert.equal(manager.status().phase, "installed");
  const venvCall = execCalls.find((c) => c.args && c.args.includes("venv") && c.args.includes("-m"));
  assert.ok(venvCall, "应执行 venv 创建");
  // venv 创建用的必须是首个 3.11 候选，而不是裸 python（3.13）
  const firstProbe = execCalls.find((c) => c.args && c.args.some((x) => String(x).includes("import sys")));
  assert.ok(firstProbe, "应有版本探测");
  assert.equal(venvCall.cmd, firstProbe.cmd, "venv 应使用首个 3.11 候选");
  assert.notEqual(venvCall.cmd, "python");
  assert.notEqual(venvCall.cmd, "python3");
});

test("残留的 3.13 venv：自动删除并按检测到的 3.11 重建", async () => {
  const baseDir = tmpDir();
  const venvPy = path.join(baseDir, "venv", process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python");
  fs.mkdirSync(path.dirname(venvPy), { recursive: true });
  fs.writeFileSync(venvPy, "");
  let venvProbed = false;
  const execCalls = [];
  const execImpl = (cmd, args) => {
    execCalls.push({ cmd, args });
    const list = args || [];
    if (list.some((x) => String(x).includes("import sys"))) {
      if (String(cmd).includes(path.join("venv"))) { venvProbed = true; return Promise.resolve({ code: 0, stdout: "3.13\n", stderr: "" }); }
      return Promise.resolve({ code: 0, stdout: "3.11\n", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const manager = createOmniParserManager({
    baseDir, execImpl,
    spawnImpl: () => ({ pid: 1, on() {}, stdout: null, stderr: null, kill() {} }),
    fetchImpl: modelScopeFetch(),
    serverTemplate: "PYCODE",
    log() {}
  });
  await manager.install();
  assert.equal(manager.status().phase, "installed");
  assert.equal(venvProbed, true, "应探测残留 venv 的版本");
  assert.ok(execCalls.some((c) => c.args && c.args.includes("venv") && c.args.includes("-m")), "应重建 venv");
});

test("依赖编译失败（无 C 编译器）：提示 Python 版本问题而不是镜像源", async () => {
  const baseDir = tmpDir();
  fs.mkdirSync(path.join(baseDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(baseDir, "src", "requirements.txt"), "numpy==1.26.4\ntorch\n");
  const execImpl = (cmd, args) => {
    const list = args || [];
    if (list.some((x) => String(x).includes("import sys"))) {
      return Promise.resolve({ code: 0, stdout: "3.11\n", stderr: "" });
    }
    if (list.some((x) => String(x) === "install") && list.some((x) => String(x) === "-r")) {
      return Promise.resolve({
        code: 1, stdout: "",
        stderr: "clang-cl /? gave [WinError 2] ... metadata-generation-failed ... meson-log.txt"
      });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const manager = createOmniParserManager({
    baseDir, execImpl,
    spawnImpl: () => ({ pid: 1, on() {}, stdout: null, stderr: null, kill() {} }),
    fetchImpl: modelScopeFetch(),
    serverTemplate: "PYCODE",
    log() {}
  });
  await assert.rejects(() => manager.install(), /不是网络问题|预编译|3\.10~3\.12/);
  assert.equal(manager.status().phase, "error");
});

// ---- 实机反馈：镜像断连 RemoteDisconnected + pip 临时文件被杀毒锁 WinError 32 ----

function makePipHarness({ baseDir, pipIndexUrl = "", failTwiceWith = null, failOnceWith = null } = {}) {
  fs.mkdirSync(path.join(baseDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(baseDir, "src", "requirements.txt"), "numpy==1.26.4\ntorch\nopencv-python-headless\n");
  const execCalls = [];
  let pipInstallAttempts = 0;
  const execImpl = (cmd, args, opts) => {
    execCalls.push({ cmd, args, opts });
    const list = args || [];
    if (list.some((x) => String(x).includes("import sys"))) {
      return Promise.resolve({ code: 0, stdout: "3.11\n", stderr: "" });
    }
    if (list.some((x) => String(x) === "install")) {
      const isRequirements = list.some((x) => String(x) === "-r");
      if (isRequirements) pipInstallAttempts += 1;
      const shouldFailOnce = isRequirements && failOnceWith && pipInstallAttempts === 1;
      const shouldFailTwice = isRequirements && failTwiceWith;
      if (shouldFailOnce || shouldFailTwice) {
        return Promise.resolve({ code: 1, stdout: "", stderr: failOnceWith || failTwiceWith });
      }
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const manager = createOmniParserManager({
    baseDir, execImpl,
    getPipIndexUrl: () => pipIndexUrl,
    spawnImpl: () => ({ pid: 1, on() {}, stdout: null, stderr: null, kill() {} }),
    fetchImpl: modelScopeFetch(),
    serverTemplate: "PYCODE",
    log() {}
  });
  return { manager, execCalls };
}

test("镜像断连：自动重试一次并从缓存续传成功，pip 使用独立缓存/临时目录", async () => {
  const baseDir = tmpDir();
  const { manager, execCalls } = makePipHarness({
    baseDir,
    failOnceWith: "WARNING: Retrying ... connection broken by 'RemoteDisconnected('Remote end closed connection without response')' ... opencv_python_headless-5.0.0.93-cp37-abi3-win_amd64.whl"
  });
  await manager.install();
  assert.equal(manager.status().phase, "installed");
  // -r 安装恰好两次（首败 + 重试）
  const reqCalls = execCalls.filter((c) => c.args && c.args.includes("-r"));
  assert.equal(reqCalls.length, 2);
  // 固定缓存目录 + 独立临时目录
  const pipCall = reqCalls[0];
  assert.ok(pipCall.args.includes("--cache-dir"));
  assert.equal(pipCall.args[pipCall.args.indexOf("--cache-dir") + 1], path.join(baseDir, "pip-cache"));
  assert.equal(pipCall.opts.env.TMP, path.join(baseDir, "pip-tmp"));
  assert.equal(pipCall.opts.env.TEMP, path.join(baseDir, "pip-tmp"));
});

test("文件被杀毒锁定（WinError 32）重试仍失败：报白名单指引，不再误推镜像源", async () => {
  const baseDir = tmpDir();
  const { manager } = makePipHarness({
    baseDir,
    failTwiceWith: "ERROR: Could not install packages due to an OSError: [WinError 32] 另一个程序正在使用此文件，进程无法访问。: 'C:\\\\Temp\\\\pip-unpack-x\\\\opencv.whl' Check the permissions."
  });
  await assert.rejects(() => manager.install(), (error) => {
    assert.match(error.message, /杀毒|白名单/);
    assert.doesNotMatch(error.message, /可在设置中填写 pip 镜像源/);
    return true;
  });
  assert.equal(manager.status().phase, "error");
});

test("已配置镜像仍断连：提示换源与续传，而不是让用户再配镜像", async () => {
  const baseDir = tmpDir();
  const { manager } = makePipHarness({
    baseDir,
    pipIndexUrl: "https://mirrors.aliyun.com/pypi/web/simple",
    failTwiceWith: "WARNING: Retrying ... connection broken by 'RemoteDisconnected('Remote end closed connection without response')'"
  });
  await assert.rejects(() => manager.install(), (error) => {
    assert.match(error.message, /mirrors\.aliyun\.com/);
    assert.match(error.message, /换一个镜像源/);
    assert.match(error.message, /缓存续传/);
    assert.doesNotMatch(error.message, /可在设置中填写 pip 镜像源/);
    return true;
  });
});
