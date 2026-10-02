// 元素地图：把不同感知来源（UIA / OmniParser）归一化成统一 ElementRecord，
// 并提供给模型阅读的紧凑清单、按编号查找。
//
// 所有 bbox / cx / cy 均为“绝对物理屏幕坐标”（UIA 与 OmniParser 都输出绝对坐标），
// driver 点击时直接使用，无需再加虚拟原点。
export const DEFAULT_CAP = 60;

const intv = (v) => Number(v) | 0;

/** 归一化一条 UIA 记录。 */
export function normalizeUia(raw, index) {
  const b = raw.bbox ?? {};
  const x = intv(b.x), y = intv(b.y), w = intv(b.w), h = intv(b.h);
  return {
    id: index,
    name: typeof raw.name === "string" ? raw.name : "",
    role: raw.role ?? "Unknown",
    automationId: raw.automationId ?? "",
    bbox: { x, y, w, h },
    cx: raw.cx != null ? intv(raw.cx) : x + (w >> 1),
    cy: raw.cy != null ? intv(raw.cy) : y + (h >> 1),
    enabled: raw.enabled !== false,
    clickable: true,
    source: "uia"
  };
}

/** 归一化一条 OmniParser 检测（官方 bbox 为 [x1,y1,x2,y2]，也兼容 xywh / 对象）。 */
export function normalizeOmniParser(item, index) {
  let x, y, w, h;
  const bb = item.bbox ?? item.box ?? item.bounds;
  if (Array.isArray(bb) && bb.length === 4) {
    if (item.bbox_format === "xywh" || item.format === "xywh") {
      x = intv(bb[0]); y = intv(bb[1]); w = intv(bb[2]); h = intv(bb[3]);
    } else {
      x = intv(bb[0]); y = intv(bb[1]); w = intv(bb[2]) - x; h = intv(bb[3]) - y;
    }
  } else if (bb && typeof bb === "object") {
    x = intv(bb.x); y = intv(bb.y); w = intv(bb.w); h = intv(bb.h);
  } else {
    x = intv(item.x); y = intv(item.y); w = intv(item.w); h = intv(item.h);
  }
  if (w <= 0 || h <= 0) return null;

  const interactive =
    item.interactivity === true || item.interactivity === 1 ||
    item.clickable === true || item.type === "icon";
  const name = item.content ?? item.caption ?? item.description ?? item.name ?? "";
  const rec = {
    id: index,
    name: String(name),
    role: item.role ?? (item.type === "text" ? "Text" : "Icon"),
    automationId: item.automationId ?? "",
    bbox: { x, y, w, h },
    cx: item.cx != null ? intv(item.cx) : x + (w >> 1),
    cy: item.cy != null ? intv(item.cy) : y + (h >> 1),
    enabled: item.enabled !== false,
    clickable: !!interactive,
    source: "omniparser"
  };
  if (item.confidence != null) rec.confidence = Number(item.confidence);
  return rec;
}

/**
 * 构建元素地图：归一化 → 过滤 → 截断 → 连续编号。
 * @returns {{elements:Array,total:number,truncated:boolean,source:string}}
 */
export function buildElementMap(rawList, source, { cap = DEFAULT_CAP, clickableOnly = false } = {}) {
  const normalizer = source === "uia" ? normalizeUia : normalizeOmniParser;
  let recs = (rawList ?? []).map((r, i) => normalizer(r, i)).filter(Boolean);
  if (source === "omniparser" && clickableOnly) recs = recs.filter((r) => r.clickable);
  const total = recs.length;
  const elements = recs.slice(0, cap).map((r, i) => ({ ...r, id: i }));
  return { elements, total, truncated: total > elements.length, source };
}

/** 生成给模型阅读的元素清单文本（模型据此选编号，不自行估坐标）。 */
export function describeElements(map) {
  const { elements, total, truncated, source } = map;
  const lines = elements.map((e) => {
    const nm = e.name ? e.name.replace(/\s+/g, " ").trim() : "(无名称)";
    const state = e.enabled ? "" : " (禁用)";
    return `#${e.id} [${e.role}] "${nm}" bbox=(${e.bbox.x},${e.bbox.y},${e.bbox.w},${e.bbox.h})${state}`;
  });
  let head = `检测到 ${total} 个元素（来源：${source === "uia" ? "Windows UI Automation" : "OmniParser"}）`;
  if (truncated) head += `，仅列出前 ${elements.length} 个`;
  head += "。请回复要操作的元素编号（如 #3），坐标由系统给出，不要自行估计像素。";
  return head + "\n" + lines.join("\n");
}

/** 按编号查找元素。 */
export function findElement(elements, id) {
  const n = Number(id);
  return elements.find((e) => e.id === n) ?? null;
}
