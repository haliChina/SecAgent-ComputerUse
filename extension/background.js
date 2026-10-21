// SecAgent 浏览器桥 · 后台 Service Worker（MV3, ES module）
// 职责：与本地 SecAgent 插件桥建立 WebSocket 连接、响应插件命令、保持 SW 存活。
//
// 连接策略（0.7.1 起两档）：
//   1. 存过手动配对码 → 直连 ws://127.0.0.1:<port>/?token=<token>；
//   2. 无凭据 → 自动发现：逐个扫 DISCOVERY_PORTS 端口，连上后发 hello
//      （自报扩展 ID/名称）。桥回 welcome（已信任）或 need-approval（等待
//      用户在设置控制台点「允许」）。全程零输入——小白装完即用。
// 非 SecAgent 的本机 WS 服务不会回 welcome/need-approval，扫描自动跳过。

import { collectElements, readVisibleText } from "./collector.js";
import { DISCOVERY_PORTS } from "./ports.js";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const SCAN_REPLY_TIMEOUT_MS = 800;

let ws = null;
let connected = false;
let reconnectTimer = null;
let lastError = "";

function log(...a) { console.log("[secagent-bridge]", ...a); }

function saved() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["port", "token", "enabled"], (r) => {
      resolve({
        port: Number(r.port) || 0,
        token: String(r.token || ""),
        enabled: r.enabled !== false // 默认启用
      });
    });
  });
}

function setState(on, err, note) {
  connected = !!on;
  lastError = err || "";
  chrome.runtime.sendMessage({
    type: "state",
    connected: connected,
    pending: !!note,
    note: note || "",
    lastError: lastError
  }).catch(() => {});
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, nextDelay());
}

let delay = RECONNECT_MIN_MS;
function nextDelay() {
  const d = delay;
  delay = Math.min(RECONNECT_MAX_MS, delay * 2);
  return d;
}

/** 建立正式连接（已确定是 SecAgent 桥的 URL）。 */
function openWs(url) {
  const client = new WebSocket(url);
  ws = client;
  client.addEventListener("open", () => {
    delay = RECONNECT_MIN_MS;
    client.send(JSON.stringify({
      type: "hello",
      extId: chrome.runtime.id,
      extName: chrome.name || "SecAgent 浏览器桥",
      browser: navigator.userAgent
    }));
  });
  client.addEventListener("message", (ev) => {
    let msg = null;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "welcome") {
      setState(true);
    } else if (msg.type === "need-approval") {
      setState(false, "", "已连接，等待在 SecAgent 设置控制台点「允许」完成配对");
    } else if (typeof msg.id !== "undefined" && msg.cmd) {
      handleCommand(msg);
    }
  });
  client.addEventListener("close", () => {
    if (ws === client) {
      ws = null;
      setState(false);
      scheduleReconnect();
    }
  });
  client.addEventListener("error", () => { /* close 会跟着来 */ });
}

/** 无凭据时的自动发现扫描。 */
function scanNext(i) {
  if (i >= DISCOVERY_PORTS.length) {
    lastError = "未发现 SecAgent 插件（桥未启动或端口被占）";
    setState(false, lastError);
    scheduleReconnect();
    return;
  }
  const port = DISCOVERY_PORTS[i];
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  let settled = false;
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (ok) {
      ws = client;
      delay = RECONNECT_MIN_MS;
      client.addEventListener("close", () => {
        if (ws === client) {
          ws = null;
          setState(false);
          scheduleReconnect();
        }
      });
      client.addEventListener("error", () => { /* close 跟进 */ });
    } else {
      try { client.close(); } catch { /* ignore */ }
      scanNext(i + 1);
    }
  };
  const timer = setTimeout(() => finish(false), SCAN_REPLY_TIMEOUT_MS + 400);
  client.addEventListener("open", () => {
    client.send(JSON.stringify({
      type: "hello",
      extId: chrome.runtime.id,
      extName: chrome.name || "SecAgent 浏览器桥",
      browser: navigator.userAgent
    }));
  });
  client.addEventListener("message", (ev) => {
    let msg = null;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg && (msg.type === "welcome" || msg.type === "need-approval")) {
      finish(true);
      if (msg.type === "welcome") setState(true);
      else setState(false, "", "已连接，等待在 SecAgent 设置控制台点「允许」完成配对");
    }
  });
  client.addEventListener("close", () => finish(false));
  client.addEventListener("error", () => { /* close 跟进 */ });
}

async function connect() {
  const cfg = await saved();
  if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
  if (cfg.token && cfg.port) {
    openWs(`ws://127.0.0.1:${cfg.port}/?token=${cfg.token}`);
  } else if (cfg.enabled) {
    scanNext(0);
  }
}

/** 响应插件命令（与旧协议一致：{id, cmd, args} → {id, ok, result|error}）。 */
async function handleCommand(msg) {
  const reply = (ok, result) => {
    try {
      ws && ws.send(JSON.stringify({ id: msg.id, ok, ...(ok ? { result } : { error: String(result) }) }));
    } catch { /* ignore */ }
  };
  try {
    reply(true, await dispatch(msg.cmd, msg.args || {}));
  } catch (error) {
    reply(false, error && error.message ? error.message : String(error));
  }
}

async function resolveTab(tabId) {
  let tab = null;
  if (tabId != null) {
    tab = await chrome.tabs.get(Number(tabId));
  } else {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs.length) throw new Error("没有可用的活动标签页");
    tab = tabs[0];
  }
  if (!tab || typeof tab.id !== "number") throw new Error("找不到目标标签页");
  return tab;
}

async function dispatch(cmd, args) {
  switch (cmd) {
    case "ping":
      return { pong: Date.now() };
    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs.map((t) => ({
          id: t.id, title: t.title || "", url: t.url || "",
          active: !!t.active, windowId: t.windowId, index: t.index
        }))
      };
    }
    case "tabs.focus": {
      const tab = await chrome.tabs.get(Number(args.tabId));
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { focused: tab.id };
    }
    case "dom.collect": {
      const tab = await resolveTab(args.tabId);
      const max = Math.max(1, Math.min(200, Number(args.max) || 80));
      const zoom = await chrome.tabs.getZoom(tab.id);
      const inj = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: collectElements, args: [max]
      });
      const res = inj && inj[0] && inj[0].result;
      if (!res) throw new Error("页面未返回元素（可能是受限页面）");
      return {
        tab: { id: tab.id, title: tab.title, url: tab.url, windowId: tab.windowId },
        zoom,
        ...res
      };
    }
    case "dom.read": {
      const tab = await resolveTab(args.tabId);
      const maxChars = Number(args.maxChars) || 12000;
      const inj = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: readVisibleText, args: [maxChars]
      });
      const res = inj && inj[0] && inj[0].result;
      if (!res) throw new Error("页面未返回文本（可能是受限页面）");
      return { tab: { id: tab.id, title: tab.title, url: tab.url }, ...res };
    }
    default:
      throw new Error("未知命令：" + cmd);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "getState") {
    // popup / 配对页查询状态：回推当前值；可选 reconnect 立即重连。
    chrome.runtime.sendMessage({
      type: "state",
      connected: connected,
      lastError: lastError
    }).catch(() => {});
    if (msg.reconnect) { if (reconnectTimer) clearTimeout(reconnectTimer); connect(); }
  }
});

connect();
