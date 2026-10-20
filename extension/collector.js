// 页面元素收集器：被 chrome.scripting.executeScript 注入到目标标签页执行。
// 铁律：函数必须**完全自包含**——executeScript 只序列化函数源码本身，
// 闭包与外部 import 一律带不进去。本文件同时是 ES module（background.js
// import 使用、Node 单测直接跑），因此导出但内部零外部引用。

/** 角色推断：aria role 优先，否则按标签映射到 UIA 风格的语义角色。 */
function saRoleOf(el) {
  const aria = el.getAttribute("role");
  if (aria) return aria.split(/\s+/)[0];
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "input") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    if (t === "checkbox" || t === "radio") return t;
    if (t === "submit" || t === "button" || t === "reset") return "button";
    return "edit";
  }
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "edit";
  if (tag === "option") return "listitem";
  return "custom";
}

/** 名称：aria-label / 文本 / placeholder / title / value / alt 的取用次序。 */
function saNameOf(el) {
  const pick = (s) => (s && s.trim() ? s.trim().replace(/\s+/g, " ").slice(0, 80) : "");
  const aria = pick(el.getAttribute("aria-label"));
  if (aria) return aria;
  let text = "";
  try { text = pick(el.innerText || el.textContent || ""); } catch { /* 罕见 */ }
  if (text) return text;
  const ph = pick(el.getAttribute("placeholder"));
  if (ph) return ph;
  const title = pick(el.getAttribute("title"));
  if (title) return title;
  const tag = el.tagName.toLowerCase();
  if (tag === "img") { const alt = pick(el.getAttribute("alt")); if (alt) return alt; }
  if ((tag === "input" || tag === "textarea") && (el.type || "") !== "password") {
    const v = pick(el.value);
    if (v) return v;
  }
  return "";
}

/**
 * 收集当前文档里可视区域内可交互的元素。
 * @param {number} [max=80] 最多返回数量（收集上限 400 再排序截断）
 * @returns {{elements:Array, viewport:object, title:string, url:string}}
 */
export function collectElements(max) {
  const cap = Math.max(1, Math.min(400, Number(max) || 80));
  const d = globalThis.document;
  const w = globalThis.window;
  const vw = Math.max(0, Math.floor(w.innerWidth || d.documentElement.clientWidth || 0));
  const vh = Math.max(0, Math.floor(w.innerHeight || d.documentElement.clientHeight || 0));
  const margin = 32; // 视口外一定范围内的元素保留（点击会先滚动到可见处则更好，v1 从严）
  const SEL = [
    "a[href]", "button", "input", "select", "textarea", "summary",
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="checkbox"]',
    '[role="radio"]', '[role="switch"]', '[role="menuitem"]', '[role="option"]',
    '[role="combobox"]', '[role="searchbox"]', '[role="textbox"]',
    '[contenteditable="true"]', '[contenteditable=""]', "[onclick]", '[tabindex]:not([tabindex="-1"])'
  ].join(",");

  const out = [];
  const seen = new Set();
  let nodes;
  try { nodes = d.querySelectorAll(SEL); } catch { nodes = []; }
  for (const el of nodes) {
    let r;
    try { r = el.getBoundingClientRect(); } catch { continue; }
    if (!r || r.width < 2 || r.height < 2) continue;
    // 可视性：display:none 的 rect 为 0，已过滤；再挡 visibility:hidden
    let st = null;
    try { st = w.getComputedStyle ? w.getComputedStyle(el) : null; } catch { /* ignore */ }
    if (st && st.visibility === "hidden") continue;
    if (r.bottom < -margin || r.top > vh + margin || r.right < -margin || r.left > vw + margin) continue;

    const role = saRoleOf(el);
    // 无名元素兜底：角色+位置（模型至少能对上编号与坐标）。
    const name = saNameOf(el) || `${role} @${Math.round(r.x)},${Math.round(r.y)}`;
    const key = `${role}|${name}|${Math.round(r.x)},${Math.round(r.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const tag = el.tagName.toLowerCase();
    let href = "";
    if (tag === "a") { try { href = String(el.getAttribute("href") || "").slice(0, 120); } catch { /* ignore */ } }
    let value = "";
    if ((tag === "input" || tag === "textarea") && (el.type || "") !== "password") {
      try { value = String(el.value || "").slice(0, 60); } catch { /* ignore */ }
    }
    let disabled = false;
    try { disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true"; } catch { /* ignore */ }

    out.push({
      tag,
      role,
      name,
      value,
      href,
      disabled,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height }
    });
  }
  // 视觉顺序排序（近似行分组）：编号清单与页面视觉布局一致，便于模型对照截图。
  out.sort((a, b) =>
    (Math.round(a.rect.y / 24) - Math.round(b.rect.y / 24)) ||
    (Math.round(a.rect.x / 8) - Math.round(b.rect.x / 8))
  );

  return {
    elements: out.slice(0, cap),
    total: out.length,
    viewport: {
      vw, vh,
      screenX: w.screenX || 0, screenY: w.screenY || 0,
      outerW: w.outerWidth || 0, outerH: w.outerHeight || 0,
      innerW: w.innerWidth || 0, innerH: w.innerHeight || 0,
      dpr: w.devicePixelRatio || 1
    },
    title: String(d.title || ""),
    url: String(w.location && w.location.href ? w.location.href : "")
  };
}

/**
 * 提取页面可见文本（innerText 保留布局、跳过 display:none 内容）。
 * @param {number} [maxChars=12000]
 */
export function readVisibleText(maxChars) {
  const cap = Math.max(500, Math.min(200000, Number(maxChars) || 12000));
  const d = globalThis.document;
  let text = "";
  try { text = String((d.body && d.body.innerText) || d.body?.textContent || ""); } catch { text = ""; }
  return {
    title: String(d.title || ""),
    url: String(globalThis.window.location && globalThis.window.location.href || ""),
    text: text.slice(0, cap),
    truncated: text.length > cap
  };
}
