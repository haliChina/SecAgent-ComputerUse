// 极简 RFC 6455 WebSocket 服务端：只为本插件的「浏览器扩展桥」服务。
// 设计取舍：
//   - 只支持 text 帧（协议是 JSON），客户端帧必须掩码（RFC 规定，未掩码直接断开）；
//   - 支持分片（continuation）、ping/pong、close 握手；
//   - 单消息上限 16 MiB（页面全文提取足够）；
//   - 不引入 `ws` 依赖：插件包目前只有 koffi 一个依赖，桥保持零新增。
// 客户端用 Node 内置 WHATWG WebSocket（node >= 22）或浏览器原生 WebSocket 测试。

import http from "node:http";
import crypto from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** 计算握手 Accept 头。 */
export function acceptKey(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

/**
 * 帧解析器：喂入 Buffer，产出事件。
 * 事件：{type:"message", text} | {type:"ping", payload:Buffer} |
 *       {type:"close", code} | {type:"error", message}
 * 不做掩码/长度合法性之外的业务判断；消息超限产出 error。
 */
export function createFrameParser({ maxMessageBytes = MAX_MESSAGE_BYTES } = {}) {
  let buffer = Buffer.alloc(0);
  let fragments = null; // { opcode, parts: Buffer[] , size }
  let closed = false;

  const emitMessage = (opcode, chunks) => {
    const text = Buffer.concat(chunks).toString("utf8");
    return { type: "message", opcode, text };
  };

  const handleFrame = (fin, opcode, masked, payload) => {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      return { type: "close", code };
    }
    if (opcode === 0x9) return { type: "ping", payload };
    if (opcode === 0xA) return { type: "pong", payload };
    if (opcode !== 0x1 && opcode !== 0x2 && opcode !== 0x0) {
      return { type: "error", message: `不支持的 opcode ${opcode}` };
    }
    // 数据帧：处理分片
    if (opcode !== 0) {
      if (fragments) return { type: "error", message: "新数据帧打断未完成的分片序列" };
      if (fin) return emitMessage(opcode, [payload]);
      fragments = { opcode, parts: [payload], size: payload.length };
      return null;
    }
    // continuation
    if (!fragments) return { type: "error", message: " continuation 帧没有起始帧" };
    fragments.parts.push(payload);
    fragments.size += payload.length;
    if (fragments.size > maxMessageBytes) {
      fragments = null;
      return { type: "error", message: "消息超过大小上限" };
    }
    if (fin) {
      const done = emitMessage(fragments.opcode, fragments.parts);
      fragments = null;
      return done;
    }
    return null;
  };

  return {
    /** 喂入字节，返回事件数组（可能为空）。遇到 error 后停止解析。 */
    push(chunk) {
      if (closed) return [];
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      const events = [];
      for (;;) {
        if (buffer.length < 2) break;
        const b0 = buffer[0];
        const b1 = buffer[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const hasMask = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) break;
          len = buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buffer.length < 10) break;
          const big = buffer.readBigUInt64BE(2);
          if (big > BigInt(maxMessageBytes)) {
            closed = true;
            return [...events, { type: "error", message: "帧长度超过上限" }];
          }
          len = Number(big);
          offset = 10;
        }
        if (len > maxMessageBytes) {
          closed = true;
          return [...events, { type: "error", message: "帧长度超过上限" }];
        }
        const maskLen = hasMask ? 4 : 0;
        if (buffer.length < offset + maskLen + len) break;
        if (!hasMask) {
          // RFC：客户端到服务端的帧必须掩码；视为协议违规。
          closed = true;
          return [...events, { type: "error", message: "客户端帧未掩码（协议违规）" }];
        }
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buffer = buffer.subarray(offset + 4 + len);
        const ev = handleFrame(fin, opcode, true, payload);
        if (ev) {
          events.push(ev);
          if (ev.type === "error" || ev.type === "close") {
            closed = true;
            return events;
          }
        }
      }
      return events;
    }
  };
}

/** 编码一个服务端 text 帧（不掩码，长度按需扩展）。 */
export function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 编码 close 帧（带状态码）。 */
export function encodeCloseFrame(code = 1000) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return Buffer.concat([Buffer.from([0x88, 2]), payload]);
}

/**
 * 创建 WebSocket 服务。
 * @param {object} opts
 * @param {(req:http.IncomingMessage)=>boolean} opts.authorize 升级前鉴权（Origin/token 校验），
 *   返回 false 时以 403 拒绝握手。
 * @param {(socket)=>void} [opts.onOpen] 连接建立（握手完成）
 * @param {(text:string, conn)=>void} opts.onMessage 文本消息
 * @param {(conn, reason:string)=>void} [opts.onClose]
 * @returns {{start:()=>Promise<{port,url:string}>, stop:()=>Promise<void>, port:number,
 *   send:(conn, text:string)=>void, closeConn:(conn, code?:number)=>void}}
 */
export function createWsServer(opts) {
  const { authorize, onOpen, onMessage, onClose } = opts;
  const server = http.createServer((req, res) => {
    // 普通请求一律 426：本端口只服务 WebSocket 升级。
    res.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("WebSocket only");
  });
  server.on("upgrade", (req, socket) => {
    let allowed = false;
    try {
      allowed = !!authorize(req);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key || typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
        "\r\n"
    );
    socket.setNoDelay(true);

    const conn = { socket, alive: true, meta: {} };
    const parser = createFrameParser();
    socket.on("data", (chunk) => {
      for (const ev of parser.push(chunk)) {
        if (ev.type === "message") {
          try {
            onMessage(ev.text, conn);
          } catch (error) {
            sendClose(1011);
            socket.destroy();
          }
        } else if (ev.type === "ping") {
          socket.write(Buffer.concat([Buffer.from([0x8A, ev.payload.length]), ev.payload]));
        } else if (ev.type === "close") {
          socket.write(encodeCloseFrame(ev.code || 1000));
          socket.end();
        } else if (ev.type === "error") {
          sendClose(1002);
          socket.destroy();
        }
      }
    });
    const sendClose = (code) => {
      try { socket.write(encodeCloseFrame(code)); } catch { /* 已断开 */ }
    };
    socket.on("close", () => {
      conn.alive = false;
      onClose?.(conn, "closed");
    });
    socket.on("error", () => {
      conn.alive = false;
      socket.destroy();
    });
    onOpen?.(conn);
  });

  let boundPort = 0;
  return {
    start() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          boundPort = server.address().port;
          resolve({ port: boundPort });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        server.closeAllSockets?.();
        server.close(() => resolve());
      });
    },
    get port() { return boundPort; },
    send(conn, text) {
      if (conn.alive) conn.socket.write(encodeTextFrame(text));
    },
    closeConn(conn, code = 1000) {
      if (conn.alive) {
        try {
          conn.socket.write(encodeCloseFrame(code));
          conn.socket.end();
        } catch { /* 已断开 */ }
      }
    }
  };
}
