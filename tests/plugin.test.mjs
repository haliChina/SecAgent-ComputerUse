import { test } from "node:test";
import assert from "node:assert/strict";
import { activate } from "../main.mjs";

function fakeApi(initialConfig = {}) {
  const tools = [];
  const prompts = [];
  const skills = [];
  const statuses = [];
  const settingsHandlers = [];
  let config = { ...initialConfig };
  return {
    tools, prompts, skills, statuses, settingsHandlers, config,
    registerTool: (def, call) => tools.push({ ...def, call }),
    registerPrompt: (name, provider) => prompts.push({ name, provider }),
    registerSkill: (relativePath, pattern) => {
      skills.push({ relativePath, pattern });
      return "skill-file";
    },
    registerSettingsHandler: (id, handler) => settingsHandlers.push({ id, handler }),
    getConfig: () => config,
    setConfig: (next) => { config = next; },
    setStatus: (message, state) => statuses.push({ message, state })
  };
}

async function withPlatform(platform, fn) {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

const EXPECTED_TOOLS = ["click", "clipboard", "cursor_position", "doctor", "drag", "focus", "inspect", "key", "launch", "move", "screenshot", "scroll", "settings", "type", "wait", "windows"];

test("Windows 下注册 16 个可见工具、1 个 prompt、1 个 skill、1 个设置 handler", async () => {
  await withPlatform("win32", async () => {
    const api = fakeApi();
    const dispose = await activate(api);
    try {
      const names = api.tools.map((t) => t.name).sort();
      assert.deepEqual(names, EXPECTED_TOOLS);
      assert.ok(api.tools.every((t) => t.hidden === false));
      assert.ok(api.tools.every((t) => typeof t.inputSchema === "object"));
      assert.equal(api.prompts.length, 1);
      assert.equal(typeof api.prompts[0].provider, "function");
      assert.equal(api.skills.length, 1);
      assert.equal(api.skills[0].relativePath, "skills/computer-use");
      assert.equal(api.settingsHandlers.length, 1);
      assert.equal(api.settingsHandlers[0].id, "computer-use-console");
      assert.equal(api.statuses.at(-1).message, "已就绪");
    } finally {
      await dispose();
    }
  });
});

test("prompt 提供器每次求值包含元素地图规则与思考预算", async () => {
  await withPlatform("win32", async () => {
    const api = fakeApi();
    const dispose = await activate(api);
    try {
      const text = api.prompts[0].provider();
      assert.match(text, /元素地图/);
      assert.match(text, /思考预算/);
      assert.match(text, /思考控制在约 90 秒/);
    } finally {
      await dispose();
    }
  });
});

test("非 Windows 平台仍注册工具，但状态提示动作仅可在 Windows 执行", async () => {
  await withPlatform("darwin", async () => {
    const api = fakeApi();
    const dispose = await activate(api);
    try {
      assert.equal(api.tools.length, 16);
      assert.equal(api.statuses.at(-1).state, "ready");
      assert.match(api.statuses.at(-1).message, /仅可在 Windows/);
    } finally {
      await dispose();
    }
  });
});

test("screenshot 回调在无真实 Win32 时拒绝，而非返回伪造图片", async () => {
  await withPlatform("win32", async () => {
    const api = fakeApi();
    const dispose = await activate(api);
    try {
      const screenshot = api.tools.find((t) => t.name === "screenshot");
      await assert.rejects(() => screenshot.call({}));
    } finally {
      await dispose();
    }
  });
});

test("剪贴板默认关闭：未开启时工具拒绝执行", async () => {
  await withPlatform("win32", async () => {
    const api = fakeApi();
    const dispose = await activate(api);
    try {
      const clipboard = api.tools.find((t) => t.name === "clipboard");
      await assert.rejects(() => clipboard.call({ action: "read" }), /剪贴板功能当前关闭/);
    } finally {
      await dispose();
    }
  });
});

test("原生设置 handler 支持 config / set / reset / meta", async () => {
  await withPlatform("win32", async () => {
    const api = fakeApi();
    const dispose = await activate(api);
    try {
      const handler = api.settingsHandlers[0].handler;
      const config = await handler("config");
      assert.equal(config.backend, "auto");
      const meta = await handler("meta");
      assert.ok(Array.isArray(meta) && meta.length === 5);
      const next = await handler("set", { maxElements: 25, backend: "uia" });
      assert.equal(next.maxElements, 25);
      assert.equal(next.backend, "uia");
      const reset = await handler("reset");
      assert.equal(reset.backend, "auto");
    } finally {
      await dispose();
    }
  });
});
