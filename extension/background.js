// SecAgent 浏览器桥 · 后台 Service Worker（MV3, ES module）
// 职责：维持与本地插件桥的 WebSocket 连接、响应插件命令、保持 SW 存活。

import { collectElements, readVisibleText } from "./collector.js";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

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

function setState(on, err) {
  connected = on;
  lastError = err || "";
  chrome.runtime.sendMessage({ type: "state", connected, lastError }).catch(() => {});
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

async function connect() {
  const cfg = await saved();
  if (!cfg.enabled || !cfg.port || !cfg.token) { setState(false, "未配对：请打开配对页填写端口与配对码"); return; }
  if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
  const url = `ws://127.0.0.1:${cfg.port}/?token=${encodeURIComponent(cfg.token)}`;
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (e) {
    setState(false, "无法创建连接：" + (e && e.message ? e.message : String(e)));
    scheduleReconnect();
    return;
  }
  ws = socket;
  socket.onopen = () => {
    delay = RECONNECT_MIN_MS; // 连上后重置退避
    setState(true, "");
    send({ type: "hello", browser: navigator.userAgent });
  };
  socket.onmessage = (ev) => { handle(String(ev.data)).catch((e) => log("handler error", e)); };
  socket.onclose = () => {
    if (ws === socket) ws = null;
    setState(false, "连接已断开（插件未运行或配对码已变更）");
    scheduleReconnect();
  };
  socket.onerror = () => { /* onclose 会跟随触发 */ };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/** 插件命令处理：{id, cmd, args} → 回 {id, ok, result|error}。 */
async function handle(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ping") { send({ type: "pong" }); return; }
  if (msg.id == null || !msg.cmd) return;
  try {
    const result = await dispatch(msg.cmd, msg.args || {});
    send({ id: msg.id, ok: true, result });
  } catch (e) {
    send({ id: msg.id, ok: false, error: humanize(e) });
  }
}

function humanize(e) {
  const s = e && e.message ? e.message : String(e);
  if (/cannot access|无法访问/i.test(s)) return "无法读取该页面（浏览器内部页面或未授权的站点）";
  if (/Failed to fetch|network/i.test(s)) return "操作发送失败";
  return s;
}

async function resolveTab(tabId) {
  if (tabId != null) {
    const tab = await chrome.tabs.get(Number(tabId));
    if (!tab) throw new Error("标签页不存在：" + tabId);
    return tab;
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length) throw new Error("没有活动标签页");
  return tabs[0];
}

async function dispatch(cmd, args) {
  switch (cmd) {
    case "ping":
      return {};
    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id, index: t.index, windowId: t.windowId, active: !!t.active,
        title: String(t.title || "").slice(0, 100),
        url: String(t.url || "").slice(0, 200)
      }));
    }
    case "tabs.focus": {
      const tab = await resolveTab(args.tabId);
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      return { focused: tab.id };
    }
    case "dom.collect": {
      const tab = await resolveTab(args.tabId);
      const max = Number(args.max) || 80;
      const [zoom, inj] = await Promise.all([
        chrome.tabs.getZoom(tab.id),
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectElements, args: [max] })
      ]);
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
    // popup 打开时主动查询状态：直接回推。
    chrome.runtime.sendMessage({ type: "state", connected, lastError }).catch(() => {});
    if (msg.reconnect) { if (reconnectTimer) clearTimeout(reconnectTimer); connect(); }
  }
});

connect();
