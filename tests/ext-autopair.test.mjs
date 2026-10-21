// 0.7.1：小白自动发现配对（固定端口段 + 信任列表 + 待允许流）。
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

const EXT_ID = "abcdefghijklmnopqrstuvwx";

/** 以「自动发现」方式连接（URL 不带 token，hello 自报 extId）。 */
async function connectAuto(bridge, extId = EXT_ID) {
  const st = bridge.status();
  const client = new WebSocket(`ws://127.0.0.1:${st.port}`);
  await waitOpen(client);
  const welcomeOrNotice = nextMessage(client);
  client.send(JSON.stringify({ type: "hello", extId, extName: "SecAgent 浏览器桥", browser: "Chrome/test" }));
  return { client, notice: welcomeOrNotice };
}

function makeState() {
  const store = { extTrustedIds: "" };
  return {
    store,
    getConfig: () => ({ ...store }),
    setConfig: (c) => { store.extTrustedIds = c.extTrustedIds; }
  };
}

test("自动发现：未知扩展进入待允许，命令面保持拒绝", async () => {
  const state = makeState();
  const bridge = createExtensionBridge({ ...state, ports: [39751] });
  await bridge.start();
  let client;
  try {
    assert.equal(bridge.status().port, 39751, "优先监听指定固定端口");
    const { client: c, notice } = await connectAuto(bridge);
    client = c;
    assert.deepEqual(await notice, { type: "need-approval" });
    const st = bridge.status();
    assert.equal(st.connected, false);
    assert.equal(st.pendingApproval.extId, EXT_ID);
    assert.equal(st.pendingApproval.extName, "SecAgent 浏览器桥");
    await assert.rejects(() => bridge.listTabs(), /未连接/);
  } finally {
    client?.close();
    await bridge.stop();
  }
});

test("自动发现：允许后连接生效并落信任列表；重连免确认", async () => {
  const state = makeState();
  const bridge = createExtensionBridge({ ...state, ports: [39752] });
  await bridge.start();
  let client;
  try {
    const { client: c, notice } = await connectAuto(bridge);
    client = c;
    await notice;
    const st = bridge.approvePending();
    assert.equal(st.connected, true);
    assert.equal(st.client.extId, EXT_ID);
    assert.equal(state.store.extTrustedIds, EXT_ID, "信任列表经 setConfig 持久化");
    assert.deepEqual(await nextMessage(client), { type: "approved" });

    // 命令面恢复：roundtrip
    const reply = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.cmd) client.send(JSON.stringify({ id: msg.id, ok: true, result: [{ id: 1, title: "页" }] }));
    };
    client.addEventListener("message", reply);
    const tabs = await bridge.listTabs();
    assert.deepEqual(tabs, [{ id: 1, title: "页" }]);
    client.removeEventListener("message", reply);

    // 断开后重连：已在信任列表 → 直接 welcome（paired=auto），无需再允许
    client.close();
    for (let i = 0; i < 100 && bridge.status().connected; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const again = await connectAuto(bridge);
    client = again.client;
    assert.deepEqual(await again.notice, { type: "welcome", paired: "auto" });
    assert.equal(bridge.status().connected, true);
  } finally {
    client?.close();
    await bridge.stop();
  }
});

test("自动发现：拒绝后连接被断开、不落信任列表", async () => {
  const state = makeState();
  const bridge = createExtensionBridge({ ...state, ports: [39753] });
  await bridge.start();
  let client;
  try {
    const { client: c, notice } = await connectAuto(bridge);
    client = c;
    await notice;
    const closed = new Promise((resolve) => client.addEventListener("close", resolve, { once: true }));
    const st = bridge.rejectPending();
    assert.equal(st.connected, false);
    assert.equal(st.pendingApproval, null);
    assert.equal(state.store.extTrustedIds, "");
    await closed; // 扩展侧连接被服务端关闭
  } finally {
    client?.close();
    await bridge.stop();
  }
});

test("自动发现：清除信任列表断开 auto 连接；token 连接不受影响", async () => {
  const state = makeState();
  const bridge = createExtensionBridge({ ...state, ports: [39754] });
  await bridge.start();
  let client;
  try {
    const { client: c, notice } = await connectAuto(bridge);
    client = c;
    await notice;
    bridge.approvePending();
    assert.equal(bridge.status().connected, true);
    bridge.clearTrusted();
    assert.equal(bridge.status().connected, false, "清除信任立即断开 auto 连接");
    assert.equal(state.store.extTrustedIds, "");
  } finally {
    client?.close();
    await bridge.stop();
  }
});

test("token 路径（手动配对）：welcome 标记 paired=token", async () => {
  const state = makeState();
  const bridge = createExtensionBridge({ ...state, ports: [39755] });
  await bridge.start();
  let client;
  try {
    const st = bridge.status();
    client = new WebSocket(`ws://127.0.0.1:${st.port}/?token=${st.token}`);
    await waitOpen(client);
    const welcome = nextMessage(client);
    client.send(JSON.stringify({ type: "hello", extId: "zzz", browser: "Chrome/manual" }));
    assert.deepEqual(await welcome, { type: "welcome", paired: "token" });
    assert.equal(bridge.status().connected, true);
    assert.equal(bridge.status().client.paired, "token");
  } finally {
    client?.close();
    await bridge.stop();
  }
});

test("端口占用回退：固定端口被占时自动换下一个", async () => {
  // 先占住 39756
  const blocker = createExtensionBridge({ ports: [39756] });
  await blocker.start();
  const bridge = createExtensionBridge({ ports: [39756, 39757] });
  try {
    await bridge.start();
    assert.equal(bridge.status().port, 39757, "39756 被占应回退 39757");
  } finally {
    await bridge.stop();
    await blocker.stop();
  }
});
