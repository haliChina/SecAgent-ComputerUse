// 本地设置控制台：仅绑定 127.0.0.1 的 HTTP 服务。
// 随机端口 + 一次性 token + Host 校验，防止本机其他网页（CSRF / DNS rebinding）调用。

import http from "node:http";
import crypto from "node:crypto";
import { spawn as defaultSpawn, spawnSync as defaultSpawnSync } from "node:child_process";
import { mergeConfig, describeSettings, DEFAULT_CONFIG } from "./config-schema.mjs";

const MAX_BODY = 128 * 1024;

/** 0.8.5：找本机 Chromium 系浏览器（Chrome 优先，Edge 兜底——Windows 必装）。
 * chrome:// 这类内部协议只有 Chromium 内核认：交给系统默认浏览器时，
 * 若默认是 Firefox 等就会弹「选择打开方式的软件」——必须显式指定浏览器。 */
function findChromiumExe() {
  if (process.platform !== "win32") return null;
  for (const name of ["chrome", "msedge"]) {
    try {
      const r = defaultSpawnSync("where", [name], { windowsHide: true, timeout: 4000 });
      if (r?.status === 0) {
        const exe = String(r.stdout || "").trim().split(/\r?\n/)[0];
        if (exe) return { name, exe };
      }
    } catch { /* 继续 */ }
  }
  return null;
}

/** 0.8.5：用 Chromium 系打开内部协议页；找不到返回 null（调用方回退默认浏览器）。 */
function openInChromium(url) {
  const hit = findChromiumExe();
  if (!hit) return null;
  try {
    const child = defaultSpawn(hit.exe, [url], { detached: true, stdio: "ignore", windowsHide: true });
    child?.unref?.();
    return hit.name;
  } catch { return null; }
}

function defaultOpenBrowser(url) {
  const platform = process.platform;
  // 无浏览器 opener 的环境（无头/精简系统）spawn 会发异步 'error' 事件，
  // 未监听就是 uncaughtException；控制台 URL 会随工具结果返回，可手动打开。
  let child;
  try {
    if (platform === "win32") {
      // start 的标题参数留空，URL 加引号以容纳 & 与 ?
      child = defaultSpawn("cmd", ["/c", "start", "", url], { windowsHide: true });
    } else if (platform === "darwin") {
      child = defaultSpawn("open", [url], { windowsHide: true });
    } else {
      child = defaultSpawn("xdg-open", [url], { windowsHide: true });
    }
  } catch { return; }
  child?.on?.("error", () => {});
}

export function createSettingsServer(options = {}) {
  const getConfig = options.getConfig || (() => ({}));
  const setConfig = options.setConfig || (() => {});
  const manager = options.manager || null;
  const extBridge = options.extBridge || null;
  const pageHtml = options.pageHtml || "<!doctype html><meta charset=utf-8>console";
  const openBrowser = options.openBrowser || defaultOpenBrowser;
  const openDir = options.openDir || null; // 0.8.5：资源管理器打开扩展目录（main 注入路径）
  const runCommand = options.runCommand || null; // 0.8.5：执行注册表命令（关 Edge 开发者警告）

  let token = "";
  let server = null;
  let boundPort = 0;

  function send(res, status, body, headers = {}) {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    });
    res.end(data);
  }

  const json = (res, status, obj) => send(res, status, obj);

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error("请求体过大"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("请求体不是合法 JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  async function handle(req, res, url) {
    const path = url.pathname;
    const method = req.method;

    if (path === "/" && method === "GET") {
      return send(res, 200, pageHtml);
    }
    if (!path.startsWith("/api/")) return json(res, 404, { error: "not found" });

    // —— 配置 ——
    if (path === "/api/meta" && method === "GET") {
      return json(res, 200, { groups: describeSettings() });
    }
    if (path === "/api/config" && method === "GET") {
      const { config } = mergeConfig(getConfig());
      return json(res, 200, config);
    }
    if (path === "/api/config" && method === "POST") {
      const body = await readBody(req);
      const { config, dropped } = mergeConfig({ ...getConfig(), ...body });
      setConfig(config);
      if (manager && body.omniEndpoint) manager.setEndpoint(config.omniEndpoint);
      return json(res, 200, { config, dropped });
    }
    if (path === "/api/reset" && method === "POST") {
      setConfig({ ...DEFAULT_CONFIG });
      return json(res, 200, { config: { ...DEFAULT_CONFIG } });
    }

    // —— 浏览器扩展桥 ——
    if (extBridge) {
      if (path === "/api/ext/status" && method === "GET") {
        return json(res, 200, extBridge.status());
      }
      if (path === "/api/ext/reset" && method === "POST") {
        const token = extBridge.resetToken();
        return json(res, 200, { ...extBridge.status(), token });
      }
      if (path === "/api/ext/approve" && method === "POST") {
        return json(res, 200, extBridge.approvePending());
      }
      if (path === "/api/ext/reject" && method === "POST") {
        return json(res, 200, extBridge.rejectPending());
      }
      if (path === "/api/ext/untrust" && method === "POST") {
        extBridge.clearTrusted();
        return json(res, 200, extBridge.status());
      }
    }

    // 小白引导：直接打开浏览器的扩展管理页。
    // 0.8.5：chrome:// 内部协议必须用 Chromium 系打开（Chrome 优先、Edge 兜底）——
    // 交给系统默认浏览器时，默认若非 Chromium（如 Firefox）会弹
    // 「选择打开方式的软件」选择框（用户实测报告的问题）。
    if (path === "/api/ext/open-browser" && method === "POST") {
      let used = null;
      try {
        used = openInChromium("chrome://extensions/");
      } catch { /* 探测失败回退 */ }
      if (!used) {
        try {
          openBrowser("chrome://extensions/");
        } catch { /* 打不开就返回 URL 让用户自己点 */ }
      }
      return json(res, 200, { opened: true, url: "chrome://extensions/", usedBrowser: used });
    }
    // 0.8.5：资源管理器打开 extension/ 目录（用户不知道插件目录装在哪）。
    if (path === "/api/ext/open-dir" && method === "POST") {
      if (typeof openDir !== "function") return json(res, 404, { error: "not available" });
      try {
        const dir = openDir();
        return json(res, 200, { opened: true, dir: String(dir || "") });
      } catch (error) {
        return json(res, 500, { error: String(error?.message ?? error) });
      }
    }
    // 0.8.5：写入 Edge/Chrome 的「开发者模式扩展警告关闭」策略（HKCU 免管理员）。
    // Edge/Chrome 对解压加载的扩展每隔一两天弹「请关闭开发者模式扩展」，
    // 唯一根治法是浏览器策略 ExtensionDeveloperModeWarning=0。
    if (path === "/api/ext/silence-warning" && method === "POST") {
      const body = await readBody(req);
      const browser = String(body?.browser || "edge").toLowerCase();
      if (browser !== "edge" && browser !== "chrome")
        return json(res, 400, { error: "browser 仅支持 edge/chrome" });
      if (typeof runCommand !== "function") return json(res, 404, { error: "not available" });
      try {
        const root =
          browser === "edge"
            ? "HKCU\\Software\\Policies\\Microsoft\\Edge"
            : "HKCU\\Software\\Policies\\Google\\Chrome"
        const cmd = `reg add "${root}" /v ExtensionDeveloperModeWarning /t REG_DWORD /d 0 /f`;
        const out = runCommand(cmd);
        return json(res, 200, { ok: true, browser, command: cmd, output: String(out || "").slice(0, 400) });
      } catch (error) {
        return json(res, 500, { error: String(error?.message ?? error) });
      }
    }

    // —— OmniParser ——
    if (!manager) return json(res, 404, { error: "manager unavailable" });
    if (path === "/api/omni/status" && method === "GET") {
      return json(res, 200, manager.status());
    }
    if (path === "/api/omni/install" && method === "POST") {
      // 后台执行；前端轮询 status 获取阶段与进度。
      manager.install().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 200));
      return json(res, 202, { started: true, status: manager.status() });
    }
    if (path === "/api/omni/start" && method === "POST") {
      await manager.start();
      return json(res, 200, manager.status());
    }
    if (path === "/api/omni/stop" && method === "POST") {
      await manager.stop();
      return json(res, 200, manager.status());
    }
    if (path === "/api/omni/uninstall" && method === "POST") {
      await manager.uninstall();
      return json(res, 200, manager.status());
    }
    return json(res, 404, { error: "unknown api" });
  }

  function start() {
    token = crypto.randomBytes(24).toString("hex");
    server = http.createServer((req, res) => {
      try {
        const host = req.headers.host || "";
        if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
          return json(res, 403, { error: "forbidden host" });
        }
        const url = new URL(req.url, `http://${host}`);
        const key = url.searchParams.get("key") || req.headers["x-key"];
        if (key !== token) return json(res, 401, { error: "bad key" });
        handle(req, res, url).catch((error) => json(res, 500, {
          error: error instanceof Error ? error.message : String(error)
        }));
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        boundPort = server.address().port;
        resolve({ port: boundPort, url: consoleUrl() });
      });
    });
  }

  function consoleUrl() {
    return `http://127.0.0.1:${boundPort}/?key=${token}`;
  }

  function openConsole() {
    if (!boundPort) throw new Error("服务未启动");
    openBrowser(consoleUrl());
    return consoleUrl();
  }

  function stop() {
    return new Promise((resolve) => {
      if (server) server.close(() => resolve()); else resolve();
    });
  }

  return { start, stop, openConsole, consoleUrl, get port() { return boundPort; } };
}
