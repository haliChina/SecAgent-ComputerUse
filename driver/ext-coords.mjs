// 浏览器扩展元素坐标 → 物理屏幕坐标 的换算数学。
//
// 背景：content script 里的 getBoundingClientRect 是「视口内 CSS 像素」，
// 而 driver 的坐标契约是「绝对物理屏幕像素」。两者之间隔着三层：
//   1) 页面缩放 zoom（chrome.tabs.getZoom，1.0 = 100%）；
//   2) 浏览器窗口边框/工具栏（outerWidth - innerWidth 等，单位 DIP）；
//   3) 系统显示缩放 osScale（devicePixelRatio = osScale × zoom，可反解）。
//
// 推导（各量含义见函数注释）：
//   osScale        = dpr / zoom
//   viewportOriginDip = (screenX + (outerW - innerW*zoom)/2, screenY + (outerH - innerH*zoom))
//   elementPhysical  = (viewportOriginDip + rectCss * zoom) * osScale
//
// 该近似在 Win10/11 无边框（侧边框对称）窗口、最大化（含不可见边框补偿）
// 情况下均成立；已知局限：多显示器混合 DPI 时 screenX 空间可能与物理布局有
// 偏差，inspect 侧会做「落在虚拟屏幕内」的兜底过滤。

/**
 * 计算视口左上角的 DIP 坐标。
 * @param {{screenX:number,screenY:number,outerW:number,outerH:number,
 *          innerW:number,innerH:number,dpr:number,zoom?:number}} v
 */
export function computeViewportOriginDip(v) {
  const zoom = v.zoom && v.zoom > 0 ? v.zoom : 1;
  const dpr = v.dpr && v.dpr > 0 ? v.dpr : 1;
  // inner 缺省视为满窗口（无视口信息时退化为「窗口即视口」）。
  const innerW = Number.isFinite(v.innerW) && v.innerW > 0 ? v.innerW : v.outerW / zoom;
  const innerH = Number.isFinite(v.innerH) && v.innerH > 0 ? v.innerH : v.outerH / zoom;
  // 防御：极端值下 inner*zoom 可能大于 outer（例如全屏视频的怪异取值），
  // 此时按 0 边框处理（视口≈窗口）。
  const innerWdip = Math.min(innerW * zoom, v.outerW);
  const innerHdip = Math.min(innerH * zoom, v.outerH);
  const sideBorders = Math.max(0, v.outerW - innerWdip); // 左右合计
  const topChrome = Math.max(0, v.outerH - innerHdip); // 标题栏+标签+工具栏+上下边框
  return {
    x: v.screenX + sideBorders / 2,
    y: v.screenY + topChrome,
    osScale: Math.max(0.25, Math.min(6, dpr / zoom))
  };
}
/**
 * 把一个扩展元素（CSS rect）换算为物理屏幕 bbox。
 * @param {{rect:{x:number,y:number,w:number,h:number}}} el
 * @param {{screenX,screenY,outerW,outerH,innerW,innerH,dpr,zoom?}} v
 * @returns {{x:number,y:number,w:number,h:number}} 物理像素 bbox
 */
export function elementToPhysical(el, v) {
  const zoom = v.zoom && v.zoom > 0 ? v.zoom : 1;
  const origin = computeViewportOriginDip(v);
  const scale = origin.osScale;
  const r = el.rect || {};
  const x = (origin.x + (r.x || 0) * zoom) * scale;
  const y = (origin.y + (r.y || 0) * zoom) * scale;
  const w = (r.w || 0) * zoom * scale;
  const h = (r.h || 0) * zoom * scale;
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.max(1, Math.round(w)),
    h: Math.max(1, Math.round(h))
  };
}

/**
 * 校验换算结果是否落在合理范围内（虚拟屏幕 bbox ± 容差）。
 * 用于混合 DPI / 怪异窗口形态下的兜底：明显飞出屏幕的元素直接丢弃。
 */
export function withinVirtualScreen(bbox, virtual, tolerance = 64) {
  if (!virtual || !Number.isFinite(virtual.x) || !Number.isFinite(virtual.w)) return true;
  return (
    bbox.x >= virtual.x - tolerance &&
    bbox.y >= virtual.y - tolerance &&
    bbox.x + bbox.w <= virtual.x + virtual.w + tolerance &&
    bbox.y + bbox.h <= virtual.y + virtual.h + tolerance
  );
}
