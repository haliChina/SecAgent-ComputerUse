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

test("parseWithOmniParser：连接被拒给出「服务没运行」分诊", async () => {
  const boom = async () => { const e = new Error("connect ECONNREFUSED 127.0.0.1:8000"); throw e; };
  await assert.rejects(
    () => parseWithOmniParser({ imageBase64: "A", fetchImpl: boom }),
    /服务大概率没有运行/
  );
});

test("parseWithOmniParser：超时区分「服务在跑但推理慢」并提示调超时", async () => {
  // 0.5.x 实机：CPU 推理 >20s 客户端 abort，错误文案误导向「服务未启动」
  const boom = async (_url, init) => {
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("This operation was aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  };
  await assert.rejects(
    () => parseWithOmniParser({ imageBase64: "A", fetchImpl: boom, timeout: 50 }),
    /响应超时[\s\S]*调大/
  );
});

test("parseWithOmniParser：HTTP 500 透传服务端 error 字段", async () => {
  const fn = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: "CUDA out of memory" })
  });
  await assert.rejects(
    () => parseWithOmniParser({ imageBase64: "A", fetchImpl: fn }),
    /HTTP 500：CUDA out of memory/
  );
});

test("parseWithOmniParser：缺少截图抛错", async () => {
  await assert.rejects(
    () => parseWithOmniParser({ fetchImpl: fakeFetch(200, {}).fn }),
    /缺少截图/
  );
});

test("issue #18：server 模板——YOLO 拿权重文件、token 鉴权、文本块不 caption、启动自检", async () => {
  const { SERVER_PY } = await import("../omniparser/server-template.mjs");
  // 问题 1（致命）：YOLO 必须拿文件路径，不拿目录（惰性构造=启动假成功）
  assert.match(SERVER_PY, /_detect = YOLO\(detect_pt\)/, "YOLO 拿权重文件");
  assert.doesNotMatch(SERVER_PY, /YOLO\(detect_path\)/, "不再传目录");
  // 启动自检：最小图 predict，把惰性错误当场暴露
  assert.match(SERVER_PY, /SELF-CHECK FAILED/, "自检失败标记");
  assert.match(SERVER_PY, /selfcheck/, "/health 报自检结果");
  // 附带建议：/parse token 鉴权
  assert.match(SERVER_PY, /--token/, "命令行 token");
  assert.match(SERVER_PY, /x-secagent-token/, "header 校验");
  assert.match(SERVER_PY, /unauthorized/, "401 响应");
  // 附带建议：文本块不再跑 Florence caption（笔误修复+CPU 提速）
  assert.match(SERVER_PY, /content = _caption\(crop\) if is_icon else ""/, "文本块 content 为空");
});
