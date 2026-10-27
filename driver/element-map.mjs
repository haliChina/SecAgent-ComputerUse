// 元素地图：把不同感知来源（UIA / OmniParser）归一化成统一 ElementRecord，
// 并提供给模型阅读的紧凑清单、按编号查找。
//
// 坐标约定（对外契约）：
//   - 内部存储：bbox / cx / cy 一律是“绝对物理屏幕坐标”，driver 点击时直接使用；
//   - 对模型输出：统一换算到 display 空间（相对截图左上角、按 scale 缩放后），
//     与模型看到的截图像素一一对应，杜绝“绝对 / 相对”混用导致点飞。
import { boxToDisplay, toDisplay } from "./scale.mjs";

export const DEFAULT_CAP = 60;

const intv = (v) => Number(v) | 0;

/** 归一化一条 UIA 记录。 */
export function normalizeUia(raw, index) {
  const b = raw.bbox ?? {};
  const x = intv(b.x), y = intv(b.y), w = intv(b.w), h = intv(b.h);
  const rec = {
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
  // 0.8.4：语义状态透传（inspect 采集；缺失时无该键 = 未知，不臆造）。
  if (Array.isArray(raw.runtimeId) && raw.runtimeId.length) rec.runtimeId = raw.runtimeId.map((n) => intv(n));
  if (typeof raw.value === "string" && raw.value !== "") rec.value = raw.value;
  if (raw.toggleState != null) rec.toggleState = String(raw.toggleState);
  if (raw.expandState != null) rec.expandState = String(raw.expandState);
  if (raw.selected != null) rec.selected = raw.selected === true || raw.selected === "true";
  return rec;
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
 * 归一化一条浏览器扩展元素记录。
 * 入参约定：bbox 已是**物理屏幕坐标**（由 extension-bridge 用 ext-coords 换算好），
 * name/role/tag 来自页面 DOM。url（链接目标，截断）作为补充上下文保留。
 */
export function normalizeExtension(raw, index) {
  const b = raw.bbox;
  if (!b || !(b.w > 0) || !(b.h > 0)) return null;
  return {
    id: index,
    name: typeof raw.name === "string" ? raw.name : "",
    role: raw.role || raw.tag || "custom",
    automationId: raw.automationId ?? "",
    bbox: { x: intv(b.x), y: intv(b.y), w: intv(b.w), h: intv(b.h) },
    cx: intv(b.x + b.w / 2),
    cy: intv(b.y + b.h / 2),
    enabled: raw.enabled !== false,
    clickable: true,
    source: "extension"
  };
}

/**
 * 构建元素地图：归一化 → 过滤 → 截断 → 连续编号。
 * @returns {{elements:Array,total:number,truncated:boolean,source:string}}
 */
export function buildElementMap(rawList, source, { cap = DEFAULT_CAP, clickableOnly = false } = {}) {
  const normalizer =
    source === "uia" ? normalizeUia :
    source === "extension" ? normalizeExtension :
    normalizeOmniParser;
  let recs = (rawList ?? []).map((r, i) => normalizer(r, i)).filter(Boolean);
  if (source === "omniparser" && clickableOnly) recs = recs.filter((r) => r.clickable);
  const total = recs.length;
  const elements = recs.slice(0, cap).map((r, i) => ({ ...r, id: i }));
  return { elements, total, truncated: total > elements.length, source };
}

/**
 * 生成 display 空间的元素地图副本（给模型看 / 画 SoM 用）。
 * 物理绝对坐标保留在 absBBox/absCx/absCy，点击仍走绝对坐标。
 * @param {{elements:Array,total:number,truncated:boolean,source:string}} map
 * @param {{origin?:{x:number,y:number}, scale?:number}} [geometry]
 */
export function toDisplayMap(map, geometry = {}) {
  const origin = geometry.origin ?? { x: 0, y: 0 };
  const scale = geometry.scale ?? 1;
  if (origin.x === 0 && origin.y === 0 && scale === 1) return map;
  const elements = map.elements.map((e) => {
    const abs = { bbox: e.bbox, cx: e.cx, cy: e.cy };
    return {
      ...e,
      absBBox: abs.bbox,
      absCx: e.cx,
      absCy: e.cy,
      bbox: boxToDisplay(e.bbox, origin, scale),
      cx: toDisplay({ x: e.cx, y: e.cy }, origin, scale).x,
      cy: toDisplay({ x: e.cx, y: e.cy }, origin, scale).y
    };
  });
  return { ...map, elements };
}

/** 生成给模型阅读的元素清单文本（模型据此选编号，不自行估坐标）。 */
export function describeElements(map, geometry = {}) {
  const { elements, total, truncated, source } = map;
  const lines = elements.map((e) => {
    const nm = e.name ? e.name.replace(/\s+/g, " ").trim() : "(无名称)";
    const state = e.enabled ? "" : " (禁用)";
    // 0.8.4：语义状态标注——勾选/展开/选中态与输入框现值（UIA 才有）。
    let sem = "";
    if (e.toggleState) sem += e.toggleState === "On" ? " ☑" : e.toggleState === "Off" ? " ☐" : ` (${e.toggleState})`;
    if (e.expandState) sem += e.expandState === "Expanded" ? " ▾已展开" : e.expandState === "Collapsed" ? " ▸未展开" : ` (${e.expandState})`;
    if (e.selected === true) sem += " ★已选中";
    if (typeof e.value === "string") {
      const v = e.value.length > 60 ? e.value.slice(0, 60) + "…" : e.value;
      sem += ` 值="${v.replace(/\s+/g, " ")}"`;
    }
    return `#${e.id} [${e.role}] "${nm}"${sem} bbox=(${e.bbox.x},${e.bbox.y},${e.bbox.w},${e.bbox.h})${state}`;
  });
  const SOURCE_LABELS = {
    uia: "Windows UI Automation",
    extension: "浏览器扩展（页面 DOM，坐标即屏幕位置）",
    omniparser: "OmniParser"
  };
  let head = `检测到 ${total} 个元素（来源：${SOURCE_LABELS[source] ?? source}）`;
  if (truncated) head += `，仅列出前 ${elements.length} 个`;
  head += "。bbox 为截图内相对坐标（左上角为 0,0，单位与截图像素一致）。";
  if (geometry.displayWidth && geometry.displayHeight)
    head += `截图尺寸 ${geometry.displayWidth}x${geometry.displayHeight}`;
  if (geometry.origin && (geometry.origin.x || geometry.origin.y))
    head += `（多显示器：虚拟屏原点 ${geometry.origin.x},${geometry.origin.y}，截图已归一，无需自行换算）`;
  head += "请回复要操作的元素编号（如 #3），坐标由系统给出，不要自行估计像素。";
  return head + "\n" + lines.join("\n");
}

/** 按编号查找元素。 */
export function findElement(elements, id) {
  const n = Number(id);
  return elements.find((e) => e.id === n) ?? null;
}
