// 跨平台打包：收集发布文件到 release/stage，再压缩为 release/computer-use-<version>.zip。
// - Windows：PowerShell Compress-Archive
// - macOS/Linux：zip
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "secagent-plugin.json"), "utf8"));
const version = manifest.version;

const releaseDir = path.join(root, "release");
const stage = path.join(releaseDir, "stage");
const outZip = path.join(releaseDir, `computer-use-${version}.zip`);

const FILES = ["secagent-plugin.json", "package.json", "main.mjs", "README.md"];
const DIRS = ["driver", "skills", "assets", "node_modules"];

if (!fs.existsSync(path.join(root, "node_modules", "koffi"))) {
  throw new Error("未找到 node_modules/koffi，请先运行 npm install 再打包。");
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

for (const f of FILES) {
  fs.cpSync(path.join(root, f), path.join(stage, f));
}
for (const d of DIRS) {
  const src = path.join(root, d);
  if (!fs.existsSync(src)) throw new Error(`缺少目录：${d}`);
  fs.cpSync(src, path.join(stage, d), { recursive: true });
}

// 裁剪 koffi：发布仅面向 Windows x64，只保留 win32_x64/koffi.node，
// 删除其他平台二进制（整包 28MB 会超过插件 25 MiB 限制）。
const koffiBuilds = path.join(stage, "node_modules", "koffi", "build", "koffi");
if (fs.existsSync(koffiBuilds)) {
  for (const entry of fs.readdirSync(koffiBuilds)) {
    const entryDir = path.join(koffiBuilds, entry);
    if (entry !== "win32_x64") {
      fs.rmSync(entryDir, { recursive: true, force: true });
    } else {
      for (const f of fs.readdirSync(entryDir)) {
        if (f !== "koffi.node") fs.rmSync(path.join(entryDir, f), { force: true });
      }
    }
  }
}

fs.rmSync(outZip, { force: true });

if (process.platform === "win32") {
  // Compress-Archive -Path stage\* 使 zip 内直接是插件文件（无 stage 顶层）。
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${path.join(stage, "*")}' -DestinationPath '${outZip}' -Force"`,
    { stdio: "inherit" }
  );
} else {
  execSync(`zip -r -X "${outZip}" .`, { cwd: stage, stdio: "inherit" });
}

fs.rmSync(stage, { recursive: true, force: true });

const bytes = fs.statSync(outZip).size;
console.log(`\n打包完成：${path.relative(root, outZip)}（${(bytes / 1024).toFixed(0)} KiB）`);
console.log(`SHA-256 计算命令：sha256sum "${outZip}"`);
