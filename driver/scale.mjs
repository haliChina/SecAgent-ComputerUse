// 截图缩放：把物理像素分辨率降到模型友好的上限（默认长边 1568，
// 与 Claude computer-use 的 display 空间一致），并给出坐标换算因子。
//
// 为什么需要：模型侧 CUA 训练时看到的是缩放后的图，输出坐标也在该图坐标系里；
// 2K/4K 屏直接送全分辨率 PNG 既浪费上下文，也让坐标语义与模型预期错位。

/** 依据长边上限计算缩放系数（<=1，永不放大）。maxSide<=0 表示不缩放。 */
export function computeScale(width, height, maxSide) {
  const longest = Math.max(width, height);
  if (!Number.isFinite(maxSide) || maxSide <= 0) return 1;
  if (longest <= maxSide) return 1;
  return maxSide / longest;
}

/** 缩放后的尺寸（至少 1px，且不超过原图）。 */
export function scaledSize(width, height, scale) {
  if (scale === 1) return { width, height };
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/**
 * 盒式降采样（缩小时对每个目标像素取源矩形均值，避免摩尔纹/丢细线文字）。
 * scale===1 时原样返回。
 * @param {{width:number,height:number,rgba:Buffer}} image
 * @param {number} scale
 */
export function scaleImage({ width, height, rgba }, scale) {
  if (!(scale > 0) || scale === 1) return { width, height, rgba };
  const { width: dw, height: dh } = scaledSize(width, height, scale);
  if (dw === width && dh === height) return { width, height, rgba };
  const out = Buffer.allocUnsafe(dw * dh * 4);
  const xRatio = width / dw;
  const yRatio = height / dh;
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor(dy * yRatio);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.ceil((dy + 1) * yRatio)));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor(dx * xRatio);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil((dx + 1) * xRatio)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, i += 4) {
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]; n++;
        }
      }
      const o = (dy * dw + dx) * 4;
      out[o] = (r / n) | 0; out[o + 1] = (g / n) | 0; out[o + 2] = (b / n) | 0; out[o + 3] = (a / n) | 0;
    }
  }
  return { width: dw, height: dh, rgba: out };
}

/**
 * 把物理绝对坐标换算到 display（缩放后截图）坐标。
 * @param {{x:number,y:number}} p 物理绝对坐标
 * @param {{x:number,y:number}} origin 虚拟屏原点
 * @param {number} scale
 */
export function toDisplay(p, origin, scale) {
  const s = scale === 1 ? 1 : scale;
  return {
    x: Math.round((p.x - origin.x) * s),
    y: Math.round((p.y - origin.y) * s)
  };
}

/** 把矩形从物理绝对坐标换算到 display 坐标（宽高各自取整，至少 1px）。 */
export function boxToDisplay(bbox, origin, scale) {
  const p = toDisplay({ x: bbox.x, y: bbox.y }, origin, scale);
  const q = toDisplay({ x: bbox.x + bbox.w, y: bbox.y + bbox.h }, origin, scale);
  return { x: p.x, y: p.y, w: Math.max(1, q.x - p.x), h: Math.max(1, q.y - p.y) };
}