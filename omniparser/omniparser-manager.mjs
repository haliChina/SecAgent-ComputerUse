// OmniParser 一键安装与进程管理。
// 真实下载 / 推理只在 Windows（或装有 Python 的机器）发生；测试通过注入 exec/spawn/fetch 验证编排。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn as defaultSpawn } from "node:child_process";

const OMNI_REPO = "https://github.com/microsoft/OmniParser.git";
const OMNI_ZIP = "https://github.com/microsoft/OmniParser/archive/refs/heads/master.zip";
const OMNI_HF_REPO = "microsoft/OmniParser-v2.0";

const SNAPSHOT_SNIPPET = [
  "import os",
  "from huggingface_hub import snapshot_download",
  "snapshot_download(repo_id=%r, local_dir=os.environ['OMNI_W_TARGET'])"
].join("\n");

function defaultExec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const ch = defaultSpawn(cmd, args, { windowsHide: true, ...opts });
    let out = "";
    let err = "";
    ch.stdout?.on("data", (d) => { out += d; });
    ch.stderr?.on("data", (d) => { err += d; });
    ch.on("error", reject);
    ch.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createOmniParserManager(options = {}) {
  const baseDir = options.baseDir || path.join(os.homedir(), ".secagent", "computer-use", "omniparser");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const execImpl = options.execImpl ?? defaultExec;
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const serverTemplate = options.serverTemplate || "";
  const log = options.log || (() => {});
  // 镜像配置：安装时动态读取（设置控制台可随时修改）
  const getHfMirror = typeof options.getHfMirror === "function" ? options.getHfMirror : () => "";
  const getPipIndexUrl = typeof options.getPipIndexUrl === "function" ? options.getPipIndexUrl : () => "";

  const isWin = process.platform === "win32";
  const venvDir = path.join(baseDir, "venv");
  const srcDir = path.join(baseDir, "src");
  const weightsDir = path.join(baseDir, "weights");
  const serverFile = path.join(baseDir, "server.py");
  const markerFile = path.join(baseDir, "installed.json");

  let endpoint = options.endpoint || "http://127.0.0.1:8000";
  let phase = fs.existsSync(markerFile) ? "installed" : "not-installed";
  let message = "";
  let progress = 0;
  let child = null;
  let intentionalStop = false;

  function venvPython() {
    return isWin
      ? path.join(venvDir, "Scripts", "python.exe")
      : path.join(venvDir, "bin", "python");
  }

  function setPhase(next, msg = "", pct = progress) {
    phase = next;
    message = msg;
    progress = pct;
    log(`[omniparser] ${next} ${msg}`);
  }

  // 返回解释器启动前缀，如 ["py","-3.10"] 或 ["python3"]。
  async function detectPython() {
    const candidates = isWin
      ? [["py", "-3.11"], ["py", "-3.10"], ["python"], ["python3"]]
      : [["python3.11"], ["python3.10"], ["python3"], ["python"]];
    for (const prefix of candidates) {
      try {
        const r = await execImpl(prefix[0], [...prefix.slice(1), "-c",
          "import sys;print('%d.%d'%sys.version_info[:2])"]);
        if (r.code === 0) {
          const version = (r.stdout || "").trim();
          const minor = Number(version.split(".")[1]);
          if (!Number.isNaN(minor) && minor >= 9) return { prefix, version };
        }
      } catch { /* try next */ }
    }
    return null;
  }

  async function run(cmd, args, opts) {
    const r = await execImpl(cmd, args, opts);
    if (r.code !== 0) {
      throw new Error(`${path.basename(cmd)} 退出码 ${r.code}：${(r.stderr || r.stdout || "").slice(-600)}`);
    }
    return r;
  }

  async function fetchSource() {
    if (fs.existsSync(path.join(srcDir, "requirements.txt"))) return;
    fs.mkdirSync(baseDir, { recursive: true });
    try {
      await run("git", ["clone", "--depth", "1", OMNI_REPO, srcDir]);
      return;
    } catch { /* fall back to zip */ }
    const zipFile = path.join(baseDir, "omni-src.zip");
    const res = await fetchImpl(OMNI_ZIP);
    if (!res.ok) throw new Error(`下载 OmniParser 源码失败：HTTP ${res.status}`);
    fs.writeFileSync(zipFile, Buffer.from(await res.arrayBuffer()));
    if (isWin) {
      await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass",
        "-Command", `Expand-Archive -Force -LiteralPath '${zipFile}' -DestinationPath '${baseDir}'`]);
    } else {
      await run("unzip", ["-q", "-o", zipFile, "-d", baseDir]);
    }
    const extracted = path.join(baseDir, "OmniParser-master");
    if (fs.existsSync(extracted)) {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.renameSync(extracted, srcDir);
    }
    fs.rmSync(zipFile, { force: true });
  }

  async function install(onProgress = () => {}) {
    if (phase === "installing") throw new Error("正在安装中");
    const hfMirror = String(getHfMirror() || "").trim();
    const pipIndexUrl = String(getPipIndexUrl() || "").trim();
    setPhase("installing", "检测 Python…", 2);
    onProgress({ phase, message, progress });
    try {
      const py = await detectPython();
      if (!py) {
        throw new Error("未检测到 Python 3.10/3.11。可先运行：winget install Python.Python.3.10，然后重试。");
      }
      fs.mkdirSync(baseDir, { recursive: true });

      setPhase("installing", "创建虚拟环境…", 8); onProgress({ phase, message, progress });
      if (!fs.existsSync(venvPython())) {
        await run(py.prefix[0], [...py.prefix.slice(1), "-m", "venv", venvDir]);
      }
      const vpy = venvPython();

      setPhase("installing", "升级 pip…", 12); onProgress({ phase, message, progress });
      const pipIndexArgs = pipIndexUrl ? ["-i", pipIndexUrl] : [];
      try {
        await run(vpy, ["-m", "pip", "install", "--upgrade", "pip", ...pipIndexArgs]);
      } catch (error) {
        throw new Error(`pip 升级失败：${error.message}。国内网络可在设置中填写 pip 镜像源后重试。`);
      }

      setPhase("installing", "下载 OmniParser 源码…", 18); onProgress({ phase, message, progress });
      await fetchSource();

      setPhase("installing", "安装依赖（torch / transformers / ultralytics，较慢）…", 30);
      onProgress({ phase, message, progress });
      const requirements = path.join(srcDir, "requirements.txt");
      try {
        if (fs.existsSync(requirements)) {
          await run(vpy, ["-m", "pip", "install", "-r", requirements, ...pipIndexArgs], { maxBuffer: undefined });
        }
        await run(vpy, ["-m", "pip", "install", "huggingface_hub", "fastapi", "uvicorn", "python-multipart", ...pipIndexArgs]);
      } catch (error) {
        throw new Error(`依赖安装失败：${error.message}。国内网络可在设置中填写 pip 镜像源（如 https://pypi.tuna.tsinghua.edu.cn/simple）后重试。`);
      }

      setPhase("installing", "下载模型权重（约数百 MB）…", 70); onProgress({ phase, message, progress });
      if (!fs.existsSync(path.join(weightsDir, "icon_detect"))) {
        fs.mkdirSync(weightsDir, { recursive: true });
        const hfEnv = hfMirror ? { HF_ENDPOINT: hfMirror } : {};
        try {
          await run(vpy, ["-c", SNAPSHOT_SNIPPET.replace("%r", JSON.stringify(OMNI_HF_REPO))],
            { env: { ...process.env, OMNI_W_TARGET: weightsDir, ...hfEnv } });
        } catch (error) {
          throw new Error(
            `权重下载失败：${error.message}` +
            (hfMirror ? "。请检查镜像地址是否可用。" : "。国内网络可在设置中填写 HuggingFace 镜像（如 https://hf-mirror.com）后重试。")
          );
        }
      }

      setPhase("installing", "写入启动脚本…", 92); onProgress({ phase, message, progress });
      fs.writeFileSync(serverFile, serverTemplate, "utf8");
      fs.writeFileSync(markerFile, JSON.stringify({ installedAt: new Date().toISOString() }), "utf8");

      setPhase("installed", "安装完成", 100); onProgress({ phase, message, progress });
    } catch (error) {
      setPhase("error", error instanceof Error ? error.message : String(error), progress);
      onProgress({ phase, message, progress });
      throw error;
    }
  }

  async function healthOnce() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetchImpl(`${endpoint}/health`, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  async function start() {
    if (phase === "running" && child) return;
    if (!fs.existsSync(markerFile)) throw new Error("尚未安装 OmniParser");
    const url = new URL(endpoint);
    setPhase("starting", "启动本地服务（首次加载模型较慢）…");
    intentionalStop = false;
    const vpy = venvPython();
    const hfMirror = String(getHfMirror() || "").trim();
    child = spawnImpl(vpy,
      [serverFile, "--host", url.hostname, "--port", url.port || "8000"],
      {
        cwd: baseDir,
        env: {
          ...process.env,
          OMNI_WEIGHTS_DIR: weightsDir,
          OMNI_SRC_DIR: srcDir,
          ...(hfMirror ? { HF_ENDPOINT: hfMirror } : {})
        },
        detached: true,
        windowsHide: true
      });
    let served = "";
    child.stdout?.on("data", (d) => { served += d; });
    child.stderr?.on("data", (d) => { served += d; });
    child.on?.("exit", () => {
      child = null;
      if (!intentionalStop) setPhase("error", "服务进程退出");
    });
    // 模型加载可能很久，最多等 120 秒。
    for (let i = 0; i < 60; i += 1) {
      if (await healthOnce()) {
        setPhase("running", `服务运行中：${endpoint}`);
        return;
      }
      await sleep(2000);
    }
    setPhase("error", `服务未在超时内就绪：${served.slice(-400)}`);
    throw new Error(message);
  }

  async function stop() {
    intentionalStop = true;
    if (child?.pid) {
      if (isWin) {
        await execImpl("taskkill", ["/PID", String(child.pid), "/T", "/F"]).catch(() => {});
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill(); } catch {} }
      }
    }
    child = null;
    setPhase(fs.existsSync(markerFile) ? "installed" : "not-installed", "已停止");
  }

  async function uninstall() {
    await stop().catch(() => {});
    fs.rmSync(baseDir, { recursive: true, force: true });
    phase = "not-installed"; progress = 0; message = "";
  }

  function setEndpoint(next) {
    endpoint = next;
    if (phase === "running") phase = "installed";
    child = null;
  }

  function status() {
    return {
      phase, message, progress, endpoint,
      pid: child?.pid ?? null,
      hasVenv: fs.existsSync(venvPython()),
      hasWeights: fs.existsSync(path.join(weightsDir, "icon_detect")),
      hasSource: fs.existsSync(path.join(srcDir, "requirements.txt"))
    };
  }

  return {
    install, start, stop, uninstall, status,
    detectPython, healthOnce, setEndpoint,
    get phase() { return phase; }
  };
}
