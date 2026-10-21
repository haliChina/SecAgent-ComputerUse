// extension-bridge：配对/安全模型/命令面。
// 用 Node 内置 WebSocket 客户端扮演「SecAgent 浏览器桥」扩展。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createExtensionBridge } from "../driver/extension-bridge.mjs";

function waitOpen(client) {
  return new Promise((resolve, reject) => {
    client.addEventListener("open", resolve, { once: true });
    client.addEventListener("error", reject, { once: true });
  });
}
function nextMessage(client) {
  return new Promise((resolve) => {
    const on = (ev) => { client.removeEventListener("message", on); resolve(JSON.parse(String(ev.data))); };
    client.addEventListener("message", on);
  });
}

async function connectAsExtension(bridge) {
  const st = bridge.status();
  const client = new WebSocket(`ws://127.0.0.1:${st.port}/?token=${st.token}`);
  await waitOpen(client);
  client.send(JSON.stringify({ type: "hello", browser: "Chrome/146 Test" }));
  // 等桥处理完 hello（status 变为 connected）
  for (let i = 0; i < 100 && !bridge.status().connected; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!bridge.status().connected) throw new Error("hello 未被桥确认");
  return client;
}

test("桥：错误配对码被拒绝握手", async () => {
  const bridge = createExtensionBridge();
  await bridge.start();
  try {
    const st = bridge.status();
    const client = new WebSocket(`ws://127.0.0.1:${st.port}/?token=wrong-token`);
    await assert.rejects(waitOpen(client));
  } finally {
    await bridge.stop();
  }
});

test("桥：无配对码连接（自动发现）不再拒绝握手，但未获准前不可用", async () => {
  // 0.7.1 语义变更：无 token 连接走自动发现路径——握手放行（Origin 闸门
  // 仍在），hello 后进入「待允许」，命令面保持关闭直到用户点「允许」。
  const bridge = createExtensionBridge();
  await bridge.start();
  let client;
  try {
    const st = bridge.status();
    client = new WebSocket(`ws://127.0.0.1:${st.port}/`);
    await waitOpen(client);
    client.send(JSON.stringify({ type: "hello", extId: "testauto123", extName: "T" }));
    for (let i = 0; i < 100 && !bridge.status().pendingApproval; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const s = bridge.status();
    assert.equal(s.connected, false, "未获准不应进入工作态");
    assert.ok(s.pendingApproval, "应进入待允许状态");
    assert.equal(s.pendingApproval.extId, "testauto123");
    await assert.rejects(() => bridge.collectElements({}), /未连接|允许/);
  } finally {
    client?.close();
    await bridge.stop();
  }
});

test("桥：配对成功后命令往返（dom.collect）与状态上报", async () => {
  const bridge = createExtensionBridge();
  await bridge.start();
  let client;
  try {
    client = await connectAsExtension(bridge);
    // 模拟扩展响应
    const reply = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.cmd) {
        client.send(JSON.stringify({ id: msg.id, ok: true, result: FAKE_DOM }));
      }
    };
    const FAKE_DOM = {
      tab: { id: 7, title: "示例页", url: "https://example.com/", windowId: 1 },
      zoom: 1,
      elements: [
        { tag: "a", role: "link", name: "更多", rect: { x: 10, y: 20, w: 100, h: 30 } },
        { tag: "input", role: "edit", name: "搜索", rect: { x: 10, y: 60, w: 200, h: 30 } }
      ],
      viewport: { vw: 1608, vh: 913, screenX: 100, screenY: 50, outerW: 1624, outerH: 1000, innerW: 1608, innerH: 913, dpr: 1 },
      title: "示例页",
      url: "https://example.com/",
      total: 2
    };
    client.addEventListener("message", reply);
    const got = await bridge.collectElements({ max: 80 });
    assert.equal(got.elements.length, 2);
    assert.equal(got.elements[0].name, "更多");
    assert.equal(got.viewport.innerW, 1608);
    assert.equal(got.tab.id, 7);
  } finally {
    client?.close();
    await bridge.stop();
  }
});

test("桥：未连接时命令报错信息可指导配对", async () => {
  const bridge = createExtensionBridge();
  await bridge.start();
  try {
    await assert.rejects(
      () => bridge.collectElements({}),
      /未连接/
    );
  } finally {
    await bridge.stop();
  }
});

test("桥：扩展侧错误回传（ok:false）映射为异常", async () => {
  const bridge = createExtensionBridge();
  await bridge.start();
  let client;
  try {
    client = await connectAsExtension(bridge);
    client.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.cmd) {
        client.send(JSON.stringify({ id: msg.id, ok: false, error: "无法读取该页面（浏览器内部页面）" }));
      }
    });
    await assert.rejects(
      () => bridge.collectElements({}),
      /浏览器内部页面/
    );
  } finally {
    client?.close();
    await bridge.stop();
  }
});

test("桥：stop 后端口关闭；resetToken 换新码", async () => {
  const bridge = createExtensionBridge();
  await bridge.start();
  const t1 = bridge.status().token;
  const port = bridge.status().port;
  const t2 = bridge.resetToken();
  assert.notEqual(t1, t2);
  assert.equal(bridge.status().port, port); // 端口不变，token 轮换
  await bridge.stop();
  assert.equal(bridge.status().running, false);
  assert.equal(bridge.status().token, null);
});

test("桥：重复 start 幂等；setEnabled(false) 停机", async () => {
  const bridge = createExtensionBridge();
  await bridge.start();
  await bridge.start(); // 幂等
  assert.equal(bridge.status().running, true);
  await bridge.setEnabled(false);
  assert.equal(bridge.status().running, false);
  await bridge.setEnabled(true);
  assert.equal(bridge.status().running, true);
  await bridge.stop();
});
