// 零依赖 PNG 编码器（RGBA, 8-bit, color type 6）。
// 仅使用 Node 内置 zlib；自带 CRC32，避免依赖第三方包，便于随插件单包分发。
import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 标准 CRC-32（与 PNG/zlib 约定一致，多项式 0xEDB88320）。
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * @param {{width:number,height:number,rgba:Buffer}} image 逐行 RGBA，长度需 = width*height*4
 * @returns {Buffer} 完整 PNG 文件字节
 */
export function encodePNG({ width, height, rgba }) {
  if (!Number.isInteger(width) || width <= 0) throw new Error("PNG width 非法");
  if (!Number.isInteger(height) || height <= 0) throw new Error("PNG height 非法");
  const expected = width * height * 4;
  if (!Buffer.isBuffer(rgba) || rgba.length !== expected) {
    throw new Error(`RGBA 数据长度应为 ${expected}，实际 ${rgba?.length}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前加 filter type 0（None）。
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND")
  ]);
}
