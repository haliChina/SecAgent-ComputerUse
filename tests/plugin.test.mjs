import { test } from "node:test";
import assert from "node:assert/strict";
import { activate } from "../main.mjs";

function fakeApi() {
  const tools = [];
  const prompts = [];
  const skills = [];
  const statuses = [];
  return {
    tools,
    prompts,
    skills,
    statuses,
    registerTool: (def, call) => tools.push({ ...def, call }),
    registerPrompt: (name, provider) => prompts.push({ name, provider }),
    registerSkill: (relativePath, pattern) => {
      skills.push({ relativePath, pattern });
      return "skill-file";
    },
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

test("Windows 下注册 7 个可见工具、1 个 prompt、1 个 skill", async () => {
  await withPlatform("win32", async () => {
    const api = fakeApi();
    await activate(api);
    const names = api.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["click", "drag", "key", "move", "screenshot", "scroll", "type"]);
    // 所有工具默认可见
    assert.ok(api.tools.every((t) => t.hidden === false));
    // 每个工具都带 JSON Schema
    assert.ok(api.tools.every((t) => typeof t.inputSchema === "object"));
    assert.equal(api.prompts.length, 1);
    assert.ok(api.prompts[0].provider.includes("坐标原点"));
    assert.equal(api.skills.length, 1);
    assert.equal(api.skills[0].relativePath, "skills/computer-use");
    assert.equal(api.statuses.at(-1).message, "已就绪");
  });
});

test("非 Windows 平台不注册工具并上报 error 状态", async () => {
  await withPlatform("darwin", async () => {
    const api = fakeApi();
    await activate(api);
    assert.equal(api.tools.length, 0);
    assert.equal(api.statuses[0].state, "error");
  });
});

test("注册的工具回调会驱动 WindowsDriver（screenshot）", async () => {
  await withPlatform("win32", async () => {
    const api = fakeApi();
    await activate(api);
    const screenshot = api.tools.find((t) => t.name === "screenshot");
    // 无 koffi/非真实 Windows 时应抛出友好错误，而非返回伪造图片
    await assert.rejects(() => screenshot.call({}), /koffi|user32|Cannot|find/i);
  });
});
