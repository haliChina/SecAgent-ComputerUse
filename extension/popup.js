// 弹窗：状态指示 + 打开配对页。
const $ = (id) => document.getElementById(id);

function apply(msg) {
  if (!msg || msg.type !== "state") return;
  $("dot").classList.toggle("on", !!msg.connected);
  $("state").textContent = msg.connected
    ? "已连接到 SecAgent 插件。"
    : (msg.lastError || "未连接。请打开配对页完成配对。");
}

chrome.runtime.onMessage.addListener(apply);
chrome.runtime.sendMessage({ type: "getState" }, () => void chrome.runtime.lastError);
$("open").addEventListener("click", () => chrome.runtime.openOptionsPage());
