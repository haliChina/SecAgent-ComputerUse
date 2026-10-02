// Set-of-Mark（SoM）标注图：在截图上为每个元素画包围框与编号，
// 让模型“看图选编号”。纯像素绘制，零外部依赖。
//
// 元素 bbox 是绝对物理坐标，绘制时减去截图原点 origin 得到图内坐标。
const GREEN = [57, 255, 20];
const BLACK = [0, 0, 0];

// 5x7 点阵数字（经典字体）。
const FONT = {
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00010", "01100"]
};

function setPixel(buf, W, H, x, y, color) {
  const px = x | 0, py = y | 0;
  if (px < 0 || py < 0 || px >= W || py >= H) return;
  const i = (py * W + px) * 4;
  buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]; buf[i + 3] = 255;
}

function fillRect(buf, W, H, x, y, w, h, color) {
  for (let py = y; py < y + h; py++)
    for (let px = x; px < x + w; px++) setPixel(buf, W, H, px, py, color);
}

function drawRect(buf, W, H, x, y, w, h, color, t = 1) {
  for (let i = 0; i < t; i++) {
    for (let px = x; px < x + w; px++) {
      setPixel(buf, W, H, px, y + i, color);
      setPixel(buf, W, H, px, y + h - 1 - i, color);
    }
    for (let py = y; py < y + h; py++) {
      setPixel(buf, W, H, x + i, py, color);
      setPixel(buf, W, H, x + w - 1 - i, py, color);
    }
  }
}

function drawDigit(buf, W, H, x, y, digit, color, scale) {
  const pat = FONT[digit];
  if (!pat) return;
  for (let row = 0; row < 7; row++)
    for (let col = 0; col < 5; col++)
      if (pat[row][col] === "1")
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++)
            setPixel(buf, W, H, x + col * scale + dx, y + row * scale + dy, color);
}

/**
 * 在截图上绘制 SoM 标注。
 * @param {{width:number,height:number,rgba:Buffer}} image
 * @param {Array<{id:number,bbox:{x,y,w,h}}>} elements 绝对坐标元素
 * @param {{x:number,y:number}} origin 截图虚拟原点
 * @param {{scale?:number}} [opts]
 * @returns {{width:number,height:number,rgba:Buffer}} 新图（不改原图）
 */
export function drawSom(image, elements, origin = { x: 0, y: 0 }, opts = {}) {
  const { width, height, rgba } = image;
  const scale = opts.scale ?? 2;
  const cw = 5 * scale, ch = 7 * scale, pad = 2;
  const out = Buffer.from(rgba);

  for (const e of elements) {
    const x = e.bbox.x - origin.x;
    const y = e.bbox.y - origin.y;
    const w = e.bbox.w, h = e.bbox.h;

    // 外黑边 + 荧光绿框，保证在任何背景上可见。
    drawRect(out, width, height, x - 1, y - 1, w + 2, h + 2, BLACK, 1);
    drawRect(out, width, height, x, y, w, h, GREEN, 1);

    // 编号标签（黑底绿字），默认在框上方，顶部空间不足则放框内。
    const digits = String(e.id);
    const lw = cw * digits.length + pad * 2;
    const lh = ch + pad * 2;
    const lx = x;
    let ly = y - lh - 2;
    if (ly < 0) ly = y + 2;
    fillRect(out, width, height, lx, ly, lw, lh, BLACK);
    drawRect(out, width, height, lx, ly, lw, lh, GREEN, 1);
    for (let i = 0; i < digits.length; i++)
      drawDigit(out, width, height, lx + pad + i * cw, ly + pad, digits[i], GREEN, scale);
  }
  return { width, height, rgba: out };
}
