// OmniParser 可选 HTTP 后端。
// 本地 OmniParser（Python + YOLO/Florence 权重）不随插件分发，用户自行启动服务后，
// 插件按 endpoint 调用，用于 UIA 覆盖不到的自绘 UI / 游戏 / Canvas 等场景。
export const DEFAULT_OMNI_ENDPOINT = "http://127.0.0.1:8000";

/** 从多种 OmniParser 服务响应里取出检测数组。 */
export function extractDetections(data) {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.parsed_content_list)) return data.parsed_content_list;
  if (Array.isArray(data.elements)) return data.elements;
  if (Array.isArray(data.detections)) return data.detections;
  if (Array.isArray(data.results)) return data.results;
  return [];
}

/**
 * 调用 OmniParser HTTP 服务解析截图。
 * @param {object} opts
 * @param {string} [opts.endpoint]
 * @param {string} opts.imageBase64 原始截图 base64（不含 data: 前缀）
 * @param {Function} [opts.fetchImpl] 可注入 fetch（测试用）
 * @param {number} [opts.timeout=90000] 本地 CPU 推理 Florence-2 逐元素 caption，
 *   一屏几十个元素属正常慢，20 秒必炸（0.5.x 实机：auto 模式整个 inspect 抛错，
 *   模型退化成纯目测坐标，20 轮耗尽任务失败）。
 * @returns {Promise<Array<object>>} 原始检测项（交给 buildElementMap 归一化）
 */
export async function parseWithOmniParser({
  endpoint = DEFAULT_OMNI_ENDPOINT,
  imageBase64,
  fetchImpl,
  timeout = 90000
} = {}) {
  if (!imageBase64) throw new Error("OmniParser 缺少截图");
  const fetchFn = fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("当前环境没有可用的 fetch");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetchFn(`${endpoint.replace(/\/$/, "")}/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ image_base64: imageBase64 }),
      signal: ctrl.signal
    });
  } catch (error) {
    clearTimeout(timer);
    // 分诊：连接被拒=服务没起；aborted=服务在跑但推理慢。两者给模型/用户的
    // 出路完全不同，混在一句「调用失败」里只会误导。
    const msg = error?.message ?? String(error);
    if (/abort/i.test(error?.name ?? "") || /aborted|timed?\s?out/i.test(msg)) {
      throw new Error(
        `OmniParser 响应超时（${endpoint}，等待 ${Math.round(timeout / 1000)} 秒）。` +
          "服务正在运行但推理较慢（CPU 上 Florence-2 逐元素识别属正常），" +
          "可在设置控制台调大「OmniParser 响应超时」后重试；" +
          "若频繁超时建议安装 GPU 版 PyTorch 或改用 backend=\"uia\"。"
      );
    }
    const refused = /ECONNREFUSED|Failed to fetch|NetworkError|fetch failed/i.test(msg);
    throw new Error(
      `OmniParser 服务连接失败（${endpoint}）：${msg}。` +
        (refused
          ? "服务大概率没有运行：请打开 Computer Use 设置控制台，一键安装并启动 OmniParser（或运行 doctor 自检）。"
          : "请确认服务地址正确、服务正在运行。")
    );
  }
  clearTimeout(timer);
  if (!res.ok) {
    // 服务端 500 的响应体带 {error}（推理失败的原始 Python 异常），透传给模型才有诊断价值
    let detail = "";
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") detail = `：${body.error.slice(0, 400)}`;
    } catch { /* 响应体不是 json 就不透传 */ }
    throw new Error(`OmniParser 返回 HTTP ${res.status}${detail}`);
  }
  const data = await res.json();
  return extractDetections(data);
}
