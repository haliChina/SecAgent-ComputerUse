// 本地设置控制台：仅绑定 127.0.0.1 的 HTTP 服务。
// 随机端口 + 一次性 token + Host 校验，防止本机其他网页（CSRF / DNS rebinding）调用。

import http from "node:http";
import crypto from "node:crypto";
import { spawn as defaultSpawn } from "node:child_process";
import { mergeConfig, describeSettings, DEFAULT_CONFIG } from "./config-schema.mjs";

const MAX_BODY = 128 * 1024;

function defaultOpenBrowser(url) {
  const platform = process.platform;
  if (platform === "win32") {
    // start 的标题参数留空，URL 加引号以容纳 & 与 ?
    defaultSpawn("cmd", ["/c", "start", "", url], { windowsHide: true });
  } else if (platform === "darwin") {
    defaultSpawn("open", [url], { windowsHide: true });
  } else {
    defaultSpawn("xdg-open", [url], { windowsHide: true });
  }
}

export function createSettingsServer(options = {}) {
  const getConfig = options.getConfig || (() => ({}));
  const setConfig = options.setConfig || (() => {});
  const manager = options.manager || null;
  const pageHtml = options.pageHtml || "<!doctype html><meta charset=utf-8>console";
  const openBrowser = options.openBrowser || defaultOpenBrowser;

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
