import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createSettingsServer } from "../settings/settings-server.mjs";

function fakeManager() {
  let st = {
    phase: "not-installed", progress: 0, message: "",
    endpoint: "http://127.0.0.1:8000", pid: null,
    hasVenv: false, hasWeights: false, hasSource: false
  };
  const calls = [];
  return {
    calls,
    status: () => st,
    install: async () => {
      calls.push("install");
      st.phase = "installed"; st.progress = 100; st.message = "安装完成";
    },
    start: async () => { calls.push("start"); st.phase = "running"; },
    stop: async () => { calls.push("stop"); st.phase = "installed"; },
    uninstall: async () => {
      calls.push("uninstall");
      st.phase = "not-installed"; st.progress = 0;
    },
    setEndpoint: (e) => { st.endpoint = e; }
  };
}

async function boot() {
  const manager = fakeManager();
  let stored = {};
  const server = createSettingsServer({
    getConfig: () => stored,
    setConfig: (c) => { stored = c; },
    manager,
    pageHtml: "<html>CONSOLE</html>"
  });
  const { url } = await server.start();
  const parsed = new URL(url);
  const token = parsed.searchParams.get("key");
  const api = (p) => `${parsed.origin}${p}?key=${token}`;
  const post = (p, body) => fetch(api(p), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  return { manager, server, parsed, token, api, post };
}

test("GET / 带正确 key 返回控制台页面", async () => {
  const { server, api } = await boot();
  try {
    const res = await fetch(api("/"));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /CONSOLE/);
  } finally {
    await server.stop();
  }
});

test("无 key 访问返回 401", async () => {
  const { server, parsed } = await boot();
  try {
    const res = await fetch(`${parsed.origin}/`);
    assert.equal(res.status, 401);
  } finally {
    await server.stop();
  }
});

test("伪造 Host 头返回 403（防 DNS rebinding）", async () => {
  const { server, parsed, token } = await boot();
  try {
    const status = await new Promise((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port: parsed.port,
        path: `/?key=${token}`,
        headers: { Host: "evil.com" }
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    await server.stop();
  }
});

test("GET /api/config 返回默认配置", async () => {
  const { server, api } = await boot();
  try {
    const res = await fetch(api("/api/config"));
    const config = await res.json();
    assert.equal(config.backend, "auto");
    assert.equal(config.maxElements, 60);
  } finally {
    await server.stop();
  }
});

test("POST /api/config 更新并持久化", async () => {
  const { server, post } = await boot();
  try {
    const res = await post("/api/config", { maxElements: 10, backend: "uia" });
    const data = await res.json();
    assert.equal(data.config.maxElements, 10);
    assert.equal(data.config.backend, "uia");
  } finally {
    await server.stop();
  }
});

test("POST /api/reset 恢复默认", async () => {
  const { server, post } = await boot();
  try {
    await post("/api/config", { backend: "omniparser" });
    const res = await post("/api/reset");
    const data = await res.json();
    assert.equal(data.config.backend, "auto");
  } finally {
    await server.stop();
  }
});

test("OmniParser install/start/stop/uninstall 路由", async () => {
  const { server, manager, api, post } = await boot();
  try {
    assert.equal((await (await fetch(api("/api/omni/status"))).json()).phase, "not-installed");

    const installing = await post("/api/omni/install");
    assert.equal(installing.status, 202);
    assert.ok(manager.calls.includes("install"));

    const started = await post("/api/omni/start");
    assert.equal((await started.json()).phase, "running");

    const stopped = await post("/api/omni/stop");
    assert.equal((await stopped.json()).phase, "installed");

    const removed = await post("/api/omni/uninstall");
    assert.equal((await removed.json()).phase, "not-installed");
  } finally {
    await server.stop();
  }
});

test("未知 API 返回 404", async () => {
  const { server, api } = await boot();
  try {
    const res = await fetch(api("/api/nope"));
    assert.equal(res.status, 404);
  } finally {
    await server.stop();
  }
});

test("0.8.5 /api/ext/open-dir：openDir 注入时返回目录并调用（资源管理器入口）", async () => {
  const opened = [];
  const manager = fakeManager();
  const server = createSettingsServer({
    getConfig: () => ({}),
    setConfig: () => {},
    manager,
    pageHtml: "<html></html>",
    openDir: () => { opened.push(1); return "/plugins/computer-use/extension"; }
  });
  const { url } = await server.start();
  const parsed = new URL(url);
  const token = parsed.searchParams.get("key");
  try {
    const res = await fetch(`${parsed.origin}/api/ext/open-dir?key=${token}`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.opened, true);
    assert.match(body.dir, /extension/);
    assert.equal(opened.length, 1);
  } finally {
    await server.stop();
  }
});

test("0.8.5 /api/ext/silence-warning：写入浏览器策略（reg add 命令经 runCommand）", async () => {
  const commands = [];
  const manager = fakeManager();
  const server = createSettingsServer({
    getConfig: () => ({}),
    setConfig: () => {},
    manager,
    pageHtml: "<html></html>",
    runCommand: (cmd) => { commands.push(cmd); return "OK 操作成功完成。"; }
  });
  const { url } = await server.start();
  const parsed = new URL(url);
  const token = parsed.searchParams.get("key");
  const post = (p, b) => fetch(`${parsed.origin}${p}?key=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(b)
  });
  try {
    const res = await post("/api/ext/silence-warning", { browser: "edge" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.command, /Policies\\Microsoft\\Edge/);
    assert.match(body.command, /ExtensionDeveloperModeWarning/);
    const res2 = await post("/api/ext/silence-warning", { browser: "chrome" });
    assert.match((await res2.json()).command, /Policies\\Google\\Chrome/);
    // 非法浏览器名拒绝
    const res3 = await post("/api/ext/silence-warning", { browser: "safari" });
    assert.equal(res3.status, 400);
    assert.equal(commands.length, 2);
  } finally {
    await server.stop();
  }
});

test("0.8.5 /api/ext/open-browser：返回 usedBrowser 字段（Chromium 探测在非 win32 为 null）", async () => {
  const manager = fakeManager();
  const server = createSettingsServer({
    getConfig: () => ({}),
    setConfig: () => {},
    manager,
    pageHtml: "<html></html>"
  });
  const { url } = await server.start();
  const parsed = new URL(url);
  const token = parsed.searchParams.get("key");
  try {
    const res = await fetch(`${parsed.origin}/api/ext/open-browser?key=${token}`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.opened, true);
    // Linux 测试环境无 Chromium 探测：usedBrowser=null，URL 仍返回
    assert.equal(body.usedBrowser, null);
    assert.equal(body.url, "chrome://extensions/");
  } finally {
    await server.stop();
  }
});
