import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG, mergeConfig, normalizeField, fieldFor, describeSettings, SETTING_FIELDS
} from "../settings/config-schema.mjs";

test("默认配置完整且字段默认值一致", () => {
  assert.equal(DEFAULT_CONFIG.backend, "auto");
  assert.equal(DEFAULT_CONFIG.maxElements, 60);
  assert.equal(DEFAULT_CONFIG.omniEnabled, false);
  assert.equal(DEFAULT_CONFIG.nudgeEnabled, true);
  for (const field of SETTING_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, field.key));
  }
  // 五个分组
  assert.deepEqual(describeSettings().map((g) => g.id),
    ["perception", "omniparser", "reasoning", "actions", "safety"]);
});

test("空配置合并后得到全部默认值", () => {
  const { config, dropped } = mergeConfig({});
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.deepEqual(dropped, []);
});

test("数值越界被裁剪并记录 dropped", () => {
  const { config, dropped } = mergeConfig({ maxElements: 99999, uiaTimeoutMs: 10 });
  assert.equal(config.maxElements, 200);
  assert.equal(config.uiaTimeoutMs, 3000);
  assert.ok(dropped.includes("maxElements"));
  assert.ok(dropped.includes("uiaTimeoutMs"));
});

test("合法值保留", () => {
  const { config } = mergeConfig({ maxElements: 25, backend: "uia", defaultScrollSteps: 5 });
  assert.equal(config.maxElements, 25);
  assert.equal(config.backend, "uia");
  assert.equal(config.defaultScrollSteps, 5);
});

test("未知键被静默丢弃", () => {
  const { config } = mergeConfig({ totallyUnknown: 1, backend: "omniparser" });
  assert.equal(config.totallyUnknown, undefined);
  assert.equal(config.backend, "omniparser");
});

test("非法 select 值回退默认", () => {
  assert.equal(normalizeField("backend", "nonsense"), "auto");
  assert.equal(normalizeField("backend", "uia"), "uia");
});

test("OmniParser endpoint 必须是合法 http URL", () => {
  assert.equal(normalizeField("omniEndpoint", "not-a-url"), DEFAULT_CONFIG.omniEndpoint);
  assert.equal(normalizeField("omniEndpoint", "http://127.0.0.1:9000"), "http://127.0.0.1:9000");
  assert.equal(normalizeField("omniEndpoint", "ftp://x"), DEFAULT_CONFIG.omniEndpoint);
});

test("布尔字符串可归一化", () => {
  assert.equal(normalizeField("omniEnabled", "true"), true);
  assert.equal(normalizeField("omniEnabled", "false"), false);
  assert.equal(normalizeField("omniEnabled", true), true);
});

test("非对象输入安全回退默认", () => {
  assert.deepEqual(mergeConfig(null).config, DEFAULT_CONFIG);
  assert.deepEqual(mergeConfig([1, 2]).config, DEFAULT_CONFIG);
});

test("fieldFor 能查到字段", () => {
  assert.equal(fieldFor("maxRounds").group, "reasoning");
  assert.equal(fieldFor("nope"), undefined);
});
