# SecAgent · Computer Use 插件

让 SecAgent 像真人一样看 Windows 屏幕并用鼠标键盘操作：**截屏、点击、移动、拖拽、滚动、输入文本、组合键**。

- 格式：SecAgent 自有插件（`secagent-plugin.json` + `main.mjs`）
- 系统：仅 Windows（依赖 user32/gdi32）
- 运行时依赖：[koffi](https://koffi.dev/)（FFI，随发布包打包，无需用户安装）
- 模型要求：主模型必须是**视觉多模态模型**（如 GPT-4o/5、Qwen-VL、GLM-4.5V、Gemini、豆包 Vision、Claude）

## 提供的工具

| 工具 | 作用 |
|---|---|
| `computer-use__screenshot` | 截取整个屏幕（含多显示器），返回图片 |
| `computer-use__click` | 坐标点击 / 双击 / 右键 / 中键 |
| `computer-use__move` | 移动指针 |
| `computer-use__drag` | 从一点拖拽到另一点 |
| `computer-use__scroll` | 垂直滚动 |
| `computer-use__type` | 输入文本（支持中文） |
| `computer-use__key` | 组合键，如 `ctrl+c`、`alt+tab`、`f5` |

## 安装

1. SecAgent → 设置 → 插件 → **从 ZIP 安装**，选择发布包 `computer-use-<version>.zip`；
2. 启用插件，确认主模型为视觉模型；
3. 直接对话，例如：
   - “截屏看看我桌面上有什么”
   - “打开记事本，输入‘你好世界’，然后保存到桌面”
   - “把浏览器里这个表单填一下”

## 工作原理（简述）

标准“截图 ↔ 动作”循环：截图给视觉模型 → 模型输出一个动作 → 插件用 Win32 执行 → 再截图回灌，直到任务完成。

- 截图：GDI `BitBlt` + `GetDIBits` 取 BGRA，内置零依赖 PNG 编码器；
- 鼠标：`SetCursorPos` + `mouse_event`；
- 键盘：`keybd_event`（文本走 `KEYEVENTF_UNICODE`，组合键走虚拟键码）；
- DPI：在线程级 `PER_MONITOR_AWARE_V2` 上下文中截图与操作，坐标空间天然自洽，结束即恢复，不污染宿主进程。

## 开发

```bash
npm install        # 安装 koffi（含各平台预编译二进制）
npm test           # 运行单元测试（注入 fake native，无需 Windows）
npm run check      # 语法检查
npm run pack       # 生成 release/computer-use-<version>.zip
```

> 单元测试在任意平台可跑：驱动把系统调用收敛为可注入的 native 原语，测试用 fake 验证资源释放顺序、坐标偏移、按键序列、DPI 恢复等全部编排逻辑。真实 Win32 行为请在 Windows 真机按下方清单自测。

## 真机自测清单（发布前）

- [ ] 从 ZIP 安装并启用，插件状态为“已就绪”；
- [ ] 截屏返回清晰图片，尺寸与当前分辨率一致；
- [ ] 在 100% 与 150% 缩放下分别点击，落点准确无偏移；
- [ ] 输入中文与英文均正确；
- [ ] `ctrl+c` / `alt+tab` / `f5` 等组合键生效；
- [ ] 滚动、拖拽正常；多显示器（如有）坐标正确；
- [ ] 停用/卸载插件后无残留进程或指针异常。

## 如何发布

推荐通过 **GitHub Releases** 分发（SecAgent 支持 zip 直装）：

1. **更新版本号**：同步修改 `secagent-plugin.json` 与 `package.json` 的 `version`（语义化版本，如 `0.1.1`）；在 `README`/变更说明记录改动。
2. **打包**：
   ```bash
   npm install
   npm test && npm run check
   npm run pack          # 产出 release/computer-use-<version>.zip
   ```
3. **计算校验和**（供使用者核对）：
   ```bash
   sha256sum release/computer-use-<version>.zip
   ```
4. **打 tag 并发布 Release**：
   ```bash
   git add -A && git commit -m "release: computer-use plugin v<version>"
   git tag computer-use-v<version>
   git push origin computer-use-v<version>
   ```
   在 GitHub 对应仓库 → Releases → Draft a new release → 选择该 tag → 上传 `computer-use-<version>.zip`，在说明中粘贴 SHA-256 与变更内容 → Publish。
5. 用户从 Release 下载 zip，在 SecAgent 中“从 ZIP 安装”即可。

> 若后续 SecAgent 开放官方插件市场/清单，再按其市场规范提交 `secagent-plugin.json` 与 zip；在此之前 GitHub Releases 是最简单可靠的分发渠道。

## 安全说明

- 该插件能操控整个桌面并键入任意内容，能力较大。建议配合 SecAgent 的敏感操作确认使用，初次体验可在虚拟机或测试账户中进行。
- 插件在 Electron 主进程内运行；请勿安装来源不明的插件包，安装前核对 SHA-256。
- 未来若需要进程级隔离，可把执行器改写为独立 stdio MCP 进程（SecAgent 已支持插件携带 stdio MCP）。

## 故障排查

- **提示缺少 koffi**：发布包未包含 `node_modules/koffi`，重新 `npm install` 后再 `npm run pack`。
- **点击位置偏移**：确认截图与动作在同一 DPI 上下文（插件已自动处理）；若仍偏移，在 Windows 真机核对显示缩放设置并反馈。
- **模型不调用工具/看不到图**：主模型不是视觉模型，请在设置中切换为多模态模型。
