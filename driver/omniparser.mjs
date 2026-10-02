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
 * @param {number} [opts.timeout=20000]
 * @returns {Promise<Array<object>>} 原始检测项（交给 buildElementMap 归一化）
 */
export async function parseWithOmniParser({
  endpoint = DEFAULT_OMNI_ENDPOINT,
  imageBase64,
  fetchImpl,
  timeout = 20000
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
    throw new Error(
      `OmniParser 服务调用失败（${endpoint}）：${error?.message ?? error}。请确认已在本地启动 OmniParser 服务。`
    );
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`OmniParser 返回 HTTP ${res.status}`);
  const data = await res.json();
  return extractDetections(data);
}
