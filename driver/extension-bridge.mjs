// 浏览器扩展桥：插件内的本地 WebSocket 服务，与「SecAgent 浏览器桥」扩展配对。
//
// 0.7.1 起支持两种配对方式（小白优先，#12）：
//
//   A. 自动发现（推荐）：桥固定优先监听 39700-39705（被占则随机端口并
//      回退手动模式）。扩展安装后无需任何输入——后台自动扫描该端口段，
//      连接并发 hello（自报名称）。未在信任列表的扩展进入「待允许」
//      状态，用户在设置控制台点一次「允许」即完成配对；信任列表存
//      插件设置（extTrustedIds），之后自动放行。
//
//   B. 手动配对码（高级/随机端口回退）：升级请求带 ?token=<配对码>。
//
// 安全模型（与设置控制台同级）：
//   - 只绑 127.0.0.1；固定端口段仅为发现便利，不降低强度；
//   - Origin 校验：必须是 chrome-extension://（Edge 同 scheme）或不带
//     Origin（Node 测试客户端）。普通网页 http(s) Origin 一律拒绝——
//     本机浏览器页面里的脚本无法伪造该 Origin；
//   - 双闸门：Origin 合法 + （配对码 或 用户已允许的扩展 ID）；
//   - 命令白名单：只接受 ping / tabs.list / tabs.focus / dom.collect /
//     dom.read / bye，绝不提供任意脚本执行；
//   - 主动断开与超时：扩展 20s 无 ping 响应即判离线；重置配对码会
//     断开现有连接；「清除信任」清空白名单并断开自动配对的连接。
//
// 配对码与信任列表生命周期：配对码进程内存持有不落盘；信任列表经
// setConfig 持久化（扩展 ID + 首次允许时间），用户可一键清除。

import crypto from "node:crypto";
import { createWsServer } from "./ws-server.mjs";

const PING_INTERVAL_MS = 20000;
const REQUEST_TIMEOUT_MS = 15000;

/** 小白自动发现端口段（扩展侧 extension/ports.js 保持同值）。 */
export const PREFERRED_PORTS = [39700, 39701, 39702, 39703, 39704, 39705];

/** 生成配对码。 */
export function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

/** 从 Origin 头解析扩展 ID（chrome-extension://<id>/…）。 */
export function extIdFromOrigin(origin) {
  const m = /^chrome-extension:\/\/([a-p]{32})/i.exec(String(origin || ""));
  return m ? m[1].toLowerCase() : "";
}

/**
 * @param {object} opts
 * @param {() => object} [opts.getConfig] 动态读设置（超时/信任列表）
 * @param {(config:object) => void} [opts.setConfig] 持久化信任列表
 * @param {number[]} [opts.ports] 覆盖优先端口段（测试注入 [] 走随机端口）
 */
export function createExtensionBridge(opts = {}) {
  const { getConfig, setConfig } = opts;
  const preferredPorts = Array.isArray(opts.ports) ? opts.ports : PREFERRED_PORTS;

  let token = generateToken();
  let ws = null;
  let started = false;
  let conn = null; // 当前扩展连接（单客户端模型）
  let clientInfo = null; // {browser, ua, since, extId, paired: "token"|"auto"}
  let pendingApproval = null; // {extId, name, browser, since, conn}
  let pingTimer = null;
  let pingId = 0;
  let alive = false; // 最近一次 ping 是否有响应
  const pending = new Map(); // id -> {resolve, reject, timer}

  const timeoutMs = () => Math.max(2000, Math.min(60000, getConfig?.()?.extCollectTimeoutMs || REQUEST_TIMEOUT_MS));

  const trustedIds = () => {
    const raw = String(getConfig?.()?.extTrustedIds ?? "");
    return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  };
  const saveTrustedIds = (ids) => {
    const merged = { ...(getConfig?.() ?? {}) };
    merged.extTrustedIds = [...ids].join(",");
    setConfig?.(merged);
  };

  function authorize(req) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const hasToken = url.searchParams.has("token");
    if (hasToken && url.searchParams.get("token") !== token) return false;
    const origin = req.headers.origin;
    // 非浏览器客户端（Node 测试）：无 Origin 一律放行到下一层（token/确认闸门把关）。
    if (origin === undefined || origin === null || origin === "") return true;
    if (!/^chrome-extension:\/\//i.test(origin) && !/^ms-browser-extension:\/\//i.test(origin)) return false;
    // 自动发现路径：无 token 的扩展连接——放行握手，进 hello 后按信任列表分诊。
    return true;
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
      const extId = String(msg.extId || extIdFromOrigin(from.origin) || "").slice(0, 64);
      const info = {
        browser: String(msg.browser || "").slice(0, 200),
        ua: String(msg.ua || "").slice(0, 300),
        extName: String(msg.extName || "SecAgent 浏览器桥").slice(0, 80),
        extId,
        since: Date.now(),
        paired: from.pairedVia || "token"
      };
      // 自动发现连接：信任列表分诊
      if (from.pairedVia === "auto" && !trustedIds().has(extId)) {
        // 未信任：进入待允许（顶替旧的待允许连接），不进入工作态。
        if (pendingApproval) ws?.closeConn(pendingApproval.conn, 1000);
        pendingApproval = { ...info, conn: from };
        ws?.send(from, JSON.stringify({ type: "need-approval" }));
        return;
      }
      if (pendingApproval && pendingApproval.conn === from) pendingApproval = null;
      if (conn && conn !== from) ws?.closeConn(conn, 1000);
      conn = from;
      clientInfo = info;
      alive = true;
      // 扩展用它确认连的是 SecAgent 桥（扫描时可能撞上本机其他 WS 服务）
      ws.send(from, JSON.stringify({ type: "welcome", paired: info.paired }));
      return;
    }
    if (msg.type === "bye") {
      ws?.closeConn(from, 1000);
      return;
    }
    if (typeof msg.id === "number" || typeof msg.id === "string") {
      const p = pending.get(id2key(msg.id));
      if (p) {
        pending.delete(id2key(msg.id));
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(String(msg.error || "扩展命令失败")));
      }
    }
  }

  function id2key(id) {
    return typeof id === "number" ? `n${id}` : `s${id}`;
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
        "浏览器扩展未连接。请在设置控制台「浏览器扩展桥」按引导安装并允许扩展（小白三步），或按 EXTENSION.md 手动配对。"
      ));
    }
    const id = ++pingId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id2key(id));
        reject(new Error(`扩展命令超时（${cmd}，${timeoutMs()}ms）`));
      }, timeoutMs());
      pending.set(id2key(id), { resolve, reject, timer });
      ws.send(conn, JSON.stringify({ id, cmd, args }));
    });
  }

  async function start() {
    if (started) return;
    ws = createWsServer({
      authorize,
      onOpen: (c) => {
        // 标记配对方式：token=带配对码；auto=无 token（自动发现，待信任分诊）
        const url = new URL(c.req?.url || "/", "http://127.0.0.1");
        c.pairedVia = url.searchParams.has("token") ? "token" : "auto";
        c.origin = c.req?.headers?.origin || "";
      },
      onMessage: handleJson,
      onClose: (c, reason) => {
        if (c === conn) dropConn(reason);
        else if (pendingApproval && pendingApproval.conn === c) pendingApproval = null;
      }
    });
    await ws.start(preferredPorts);
    startPing();
    started = true;
  }

  async function stop() {
    stopPing();
    dropConn("插件停用");
    if (pendingApproval) {
      ws?.closeConn(pendingApproval.conn, 1000);
      pendingApproval = null;
    }
    await ws?.stop();
    started = false;
  }

  function resetToken() {
    token = generateToken();
    // 配对码连接立即失效；自动发现连接不受影响。
    if (conn && conn.pairedVia === "token") dropConn("配对码已重置");
    return token;
  }

  /** 允许待确认的扩展（小白流程的核心一步）。 */
  function approvePending() {
    if (!pendingApproval) return status();
    const info = pendingApproval;
    pendingApproval = null;
    const ids = trustedIds();
    ids.add(info.extId);
    saveTrustedIds(ids);
    if (conn && conn !== info.conn) ws.closeConn(conn, 1000);
    conn = info.conn;
    clientInfo = { ...info, since: Date.now() };
    alive = true;
    ws.send(conn, JSON.stringify({ type: "approved" }));
    return status();
  }

  function rejectPending() {
    if (!pendingApproval) return status();
    ws.closeConn(pendingApproval.conn, 1008);
    pendingApproval = null;
    return status();
  }

  /** 清除信任列表并断开自动配对连接（下次连接需重新允许）。 */
  function clearTrusted() {
    saveTrustedIds(new Set());
    if (conn && conn.pairedVia === "auto") dropConn("信任列表已清除");
    return status();
  }

  function status() {
    const usedPreferred = started && ws && preferredPorts.includes(ws.port);
    return {
      running: started,
      port: started ? ws.port : null,
      token: started ? token : null,
      discovery: usedPreferred,
      connected: !!(conn && clientInfo),
      client: clientInfo
        ? { browser: clientInfo.browser, extName: clientInfo.extName, extId: clientInfo.extId, paired: clientInfo.paired }
        : null,
      pendingApproval: pendingApproval
        ? { extName: pendingApproval.extName, extId: pendingApproval.extId, browser: pendingApproval.browser }
        : null
    };
  }

  return {
    start,
    stop,
    resetToken,
    approvePending,
    rejectPending,
    clearTrusted,
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
