// 浏览器扩展桥：插件内的本地 WebSocket 服务，与「SecAgent 浏览器桥」扩展配对。
//
// 安全模型（与设置控制台同级）：
//   - 只绑 127.0.0.1 随机端口；
//   - 配对 token：crypto.randomBytes(24) 十六进制，进程内存持有、不落盘；
//     升级请求必须带 ?token=<配对码>，错误直接 403（不进 WS 层）；
//   - Origin 校验：必须是 chrome-extension://（Edge 同 scheme）或不带 Origin
//     （Node 测试客户端）。普通网页 http(s) Origin 一律拒绝——防止本机
//     浏览器页面里的脚本直连本地桥；
//   - 命令白名单：只接受 ping / tabs.list / tabs.focus / dom.collect /
//     dom.read / bye，绝不提供任意脚本执行；
//   - 主动断开与超时：扩展 20s 无 ping 响应即判离线；重置配对码会断开现有连接。
//
// 生命周期：随插件激活启动（可被设置关闭）；token 在进程存活期内稳定，
// 便于用户配对一次长期使用；插件重启或手动「重置配对码」后需重新配对。

import crypto from "node:crypto";
import { createWsServer } from "./ws-server.mjs";

const PING_INTERVAL_MS = 20000;
const REQUEST_TIMEOUT_MS = 15000;

/** 生成配对码。 */
export function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * @param {object} opts
 * @param {() => {extCollectTimeoutMs?:number}} [opts.getConfig] 动态读设置（超时）
 * @param {() => boolean} [opts.isEnabled] 动态判断桥是否应运行（设置开关）
 */
export function createExtensionBridge(opts = {}) {
  const { getConfig } = opts;

  let token = generateToken();
  let ws = null;
  let started = false;
  let conn = null; // 当前扩展连接（单客户端模型）
  let clientInfo = null; // {browser, ua, since}
  let pingTimer = null;
  let pingId = 0;
  let alive = false; // 最近一次 ping 是否有响应
  const pending = new Map(); // id -> {resolve, reject, timer}

  const timeoutMs = () => Math.max(2000, Math.min(60000, getConfig?.()?.extCollectTimeoutMs || REQUEST_TIMEOUT_MS));

  function authorize(req) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.searchParams.get("token") !== token) return false;
    const origin = req.headers.origin;
    if (origin === undefined || origin === null || origin === "") return true; // 非浏览器客户端（测试）
    return /^chrome-extension:\/\//i.test(origin) || /^ms-browser-extension:\/\//i.test(origin);
  }

  function dropConn(reason) {
    if (conn) {
      ws?.closeConn(conn, 1000);
      conn = null;
    }
    clientInfo = null;
    alive = false;
    rejectAll(new Error(`浏览器扩展已断开（${reason}）`));
  }

  function rejectAll(error) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(error);
      pending.delete(id);
    }
  }

  function handleJson(text, from) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // 非 JSON 忽略
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "hello") {
      clientInfo = {
        browser: String(msg.browser || "").slice(0, 200),
        ua: String(msg.ua || "").slice(0, 300),
        since: Date.now()
      };
      alive = true;
      return;
    }
    if (msg.type === "bye") {
      ws?.closeConn(from, 1000);
      return;
    }
    if (typeof msg.id === "number" || typeof msg.id === "string") {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(String(msg.error || "扩展命令失败")));
      }
    }
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(async () => {
      if (!conn || !clientInfo) return;
      if (!alive) {
        dropConn("心跳超时");
        return;
      }
      alive = false;
      try {
        await request("ping", {});
        alive = true; // 回包即活着
      } catch {
        /* 超时由下一轮 !alive 兜底 */
      }
    }, PING_INTERVAL_MS);
    if (pingTimer.unref) pingTimer.unref();
  }

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  /** 向扩展发命令并等待回包。 */
  function request(cmd, args) {
    if (!conn || !clientInfo) {
      return Promise.reject(new Error(
        "浏览器扩展未连接。请在设置控制台「浏览器扩展桥」查看配对码，并按 EXTENSION.md 安装扩展后配对。"
      ));
    }
    const id = ++pingId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`扩展命令超时（${cmd}，${timeoutMs()}ms）`));
      }, timeoutMs());
      pending.set(id, { resolve, reject, timer });
      ws.send(conn, JSON.stringify({ id, cmd, args }));
    });
  }

  async function start() {
    if (started) return;
    ws = createWsServer({
      authorize,
      onOpen: (c) => {
        // 单客户端模型：新连接顶替旧连接（旧连接可能来自浏览器重启后的重连）。
        if (conn && conn !== c) ws.closeConn(conn, 1000);
        conn = c;
        clientInfo = null; // 等 hello
      },
      onMessage: handleJson,
      onClose: (c, reason) => {
        if (c === conn) dropConn(reason);
      }
    });
    await ws.start();
    startPing();
    started = true;
  }

  async function stop() {
    stopPing();
    dropConn("插件停用");
    await ws?.stop();
    started = false;
  }

  /** 重新生成配对码：现有连接立即失效。 */
  function resetToken() {
    token = generateToken();
    dropConn("配对码已重置");
    return token;
  }

  function status() {
    return {
      running: started,
      port: started ? ws.port : null,
      token: started ? token : null,
      connected: !!(conn && clientInfo),
      client: clientInfo ? { browser: clientInfo.browser } : null
    };
  }

  return {
    start,
    stop,
    resetToken,
    status,
    /** 供 main.mjs 在设置变化时启停。 */
    async setEnabled(on) {
      if (on && !started) await start();
      else if (!on && started) await stop();
    },
    // —— 对 driver 暴露的受控命令面 ——
    listTabs: () => request("tabs.list", {}),
    focusTab: (tabId) => request("tabs.focus", { tabId }),
    collectElements: ({ tabId, max } = {}) => request("dom.collect", {
      ...(tabId != null ? { tabId } : {}),
      ...(max != null ? { max } : {})
    }),
    readPage: ({ tabId, maxChars } = {}) => request("dom.read", {
      ...(tabId != null ? { tabId } : {}),
      ...(maxChars != null ? { maxChars } : {})
    })
  };
}
