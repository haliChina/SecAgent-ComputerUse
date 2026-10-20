// 配对页逻辑：保存端口/配对码到 storage.local，通知后台重连。
const $ = (id) => document.getElementById(id);

function load() {
  chrome.storage.local.get(["port", "token"], (r) => {
    if (r.port) $("port").value = String(r.port);
    if (r.token) $("token").value = String(r.token);
    refreshState();
  });
}

function setState(text, cls) {
  const el = $("state");
  el.textContent = text;
  el.className = "state " + (cls || "");
}

function refreshState() {
  chrome.runtime.sendMessage({ type: "getState" }, () => void chrome.runtime.lastError);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "state") {
    if (msg.connected) setState("已连接", "ok");
    else setState(msg.lastError ? "未连接：" + msg.lastError : "未连接", "err");
  }
});

$("save").addEventListener("click", () => {
  const port = Number($("port").value.trim());
  const token = $("token").value.trim();
  if (!Number.isInteger(port) || port <= 0 || port > 65535) { setState("端口无效", "err"); return; }
  if (!/^[0-9a-f]{16,}$/i.test(token)) { setState("配对码格式无效", "err"); return; }
  chrome.storage.local.set({ port, token, enabled: true }, () => {
    setState("已保存，连接中…", "");
    chrome.runtime.sendMessage({ type: "getState", reconnect: true }, () => void chrome.runtime.lastError);
  });
});

$("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "getState", reconnect: true }, () => void chrome.runtime.lastError);
  setState("连接中…", "");
});

load();
