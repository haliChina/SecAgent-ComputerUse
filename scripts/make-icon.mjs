// 生成插件图标 assets/icon.png（256x256，蓝色准星/点击图案）。零依赖。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePNG } from "../driver/png.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const S = 256;
const C = 128;
const rgba = Buffer.alloc(S * S * 4);

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const dx = x - C;
    const dy = y - C;
    const r = Math.hypot(dx, dy);
    let R = 37;
    let G = 99;
    let B = 235; // #2563eb
    const inRing = r > 66 && r < 76;
    const inDot = r < 22;
    const inCrossV = Math.abs(dx) < 7 && Math.abs(dy) > 34 && Math.abs(dy) < 104;
    const inCrossH = Math.abs(dy) < 7 && Math.abs(dx) > 34 && Math.abs(dx) < 104;
    if (inRing || inDot || inCrossV || inCrossH) {
      R = 255; G = 255; B = 255;
    }
    const i = (y * S + x) * 4;
    rgba[i] = R; rgba[i + 1] = G; rgba[i + 2] = B; rgba[i + 3] = 255;
  }
}

const png = encodePNG({ width: S, height: S, rgba });
const assetsDir = path.join(root, "assets");
fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, "icon.png"), png);
console.log("已生成 assets/icon.png", png.length, "bytes");
