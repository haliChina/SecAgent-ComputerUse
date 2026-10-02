import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWithOmniParser, extractDetections } from "../driver/omniparser.mjs";

test("extractDetections：兼容多种响应字段", () => {
  const a = [{ x: 1 }];
  assert.deepEqual(extractDetections(a), a);
  assert.deepEqual(extractDetections({ parsed_content_list: a }), a);
  assert.deepEqual(extractDetections({ elements: a }), a);
  assert.deepEqual(extractDetections({ detections: a }), a);
  assert.deepEqual(extractDetections({ results: a }), a);
  assert.deepEqual(extractDetections({}), []);
  assert.deepEqual(extractDetections(null), []);
});

function fakeFetch(status, payload) {
  const seen = {};
  const fn = async (url, init) => {
    seen.url = url;
    seen.init = init;
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return { fn, seen };
}

test("parseWithOmniParser：POST 到 /parse 并回传检测数组", async () => {
  const payload = { parsed_content_list: [{ type: "icon", bbox: [0, 0, 10, 10] }] };
  const { fn, seen } = fakeFetch(200, payload);
  const out = await parseWithOmniParser({
    endpoint: "http://127.0.0.1:8000/",
    imageBase64: "AAA",
    fetchImpl: fn
  });
  assert.equal(seen.url, "http://127.0.0.1:8000/parse");
  assert.equal(seen.init.method, "POST");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.image_base64, "AAA");
  assert.equal(out.length, 1);
});

test("parseWithOmniParser：非 200 状态抛错", async () => {
  const { fn } = fakeFetch(500, {});
  await assert.rejects(
    () => parseWithOmniParser({ imageBase64: "A", fetchImpl: fn }),
    /HTTP 500/
  );
});

test("parseWithOmniParser：服务不可达时提示启动服务", async () => {
  const boom = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(
    () => parseWithOmniParser({ imageBase64: "A", fetchImpl: boom }),
    /启动 OmniParser/
  );
});

test("parseWithOmniParser：缺少截图抛错", async () => {
  await assert.rejects(
    () => parseWithOmniParser({ fetchImpl: fakeFetch(200, {}).fn }),
    /缺少截图/
  );
});
