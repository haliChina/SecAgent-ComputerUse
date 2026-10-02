# SecAgent · Computer Use 插件

让 SecAgent 像真人一样操控 Windows：**元素侦察、按编号点击、截屏、移动、拖拽、滚动、输入文本、组合键**。

v0.2 起加入“元素地图”：模型不再裸猜像素坐标，而是由系统列出可交互元素并编号，模型只选编号，坐标由系统给出。

- 格式：SecAgent 自有插件（`secagent-plugin.json` + `main.mjs`）
- 系统：仅 Windows（依赖 user32/gdi32）
- 运行时依赖：[koffi](https://koffi.dev/)（FFI，随发布包打包，无需用户安装）
- 模型要求：主模型必须是**视觉多模态模型**（如 GPT-4o/5、Qwen-VL、GLM-4.5V、Gemini、豆包 Vision、Claude）

## 提供的工具

| 工具 | 作用 |
|---|---|
| `computer-use__screenshot` | 截取整个屏幕（含多显示器），返回图片 |
| `computer-use__inspect` | 侦察可交互元素，返回编号清单；`annotate=true` 返回带编号框的标注图 |
| `computer-use__click` | **按 elementId 点击**（坐标系统给）；也支持 x,y 兜底、双击/右键/中键 |
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

标准循环：**截图 → 元素侦察 → 模型选编号 → 系统坐标执行 → 再截图验证**。

- 元素地图（Set-of-Mark）：`inspect` 先把可交互元素框出并编号，模型只回答“点 #几”，点击坐标取该元素 bbox 中心（系统给，非模型给），显著提升小按钮/密集界面的命中率；
- 截图：GDI `BitBlt` + `GetDIBits` 取 BGRA，内置零依赖 PNG 编码器；
- 鼠标：`SetCursorPos` + `mouse_event`；
- 键盘：`keybd_event`（文本走 `KEYEVENTF_UNICODE`，组合键走虚拟键码）；
- DPI：在线程级 `PER_MONITOR_AWARE_V2` 上下文中截图与操作，坐标空间自洽，结束即恢复，不污染宿主。

## 感知后端与 OmniParser（可选）

| 场景 | 后端 | 说明 |
|---|---|---|
| 桌面原生软件 | **Windows UI Automation（默认）** | 免费精确，覆盖 Win32/WPF/WinForms/多数 Qt/Electron |
| UIA 覆盖不到（自绘 UI、游戏、Canvas） | **OmniParser** | 本地视觉模型（YOLO 检测 + Florence 描述），需自行起 HTTP 服务 |
| 都不可用 | 纯视觉 x,y | 最后兜底 |

OmniParser **不随插件分发**（本地 Python + 权重体积大）。需要时：

1. 按官方仓库 [microsoft/OmniParser](https://github.com/microsoft/OmniParser) 部署，或使用社区封装，启动一个接受 `POST /parse`（请求体 `{"image_base64": "..."}`，返回含 `parsed_content_list` 或 `elements` 的 JSON）的 HTTP 服务；
2. 在宿主配置中提供服务地址（插件读取配置项 `omniEndpoint`，如 `http://127.0.0.1:8000`）；
3. `inspect` 在 auto 模式下若 UIA 元素过少会自动回退，也可显式 `inspect(backend="omniparser")`。

> UIA 已知盲区：自绘界面、游戏、远程桌面内、管理员窗口（UIPI 权限隔离，需提权或虚拟机）。

## 开发

```bash
npm install        # 安装 koffi（含各平台预编译二进制）
npm test           # 运行单元测试（注入 fake native/runner/fetch，无需 Windows）
npm run check      # 语法检查
npm run pack       # 生成 release/computer-use-<version>.zip
```

> 单元测试在任意平台可跑：系统调用收敛为可注入的 native 原语，UIA/OmniParser 也可注入 runner/fetch。真实 Win32 行为请在 Windows 真机按下方清单自测。

## 真机自测清单（发布前）

- [ ] 从 ZIP 安装并启用，插件状态为“已就绪”；
- [ ] 截屏返回清晰图片，尺寸与当前分辨率一致；
- [ ] `inspect` 能列出目标软件的按钮/输入框；`annotate` 标注图编号与界面对应；
- [ ] 按 elementId 点击，在 100% 与 150% 缩放下落点均准确；
- [ ] 输入中文与英文均正确；
- [ ] `ctrl+c` / `alt+tab` / `f5` 等组合键生效；
- [ ] 滚动、拖拽正常；多显示器（如有）坐标正确；
- [ ] （可选）自绘界面下 OmniParser 回退生效；
- [ ] 停用/卸载插件后无残留进程或指针异常。

## 如何发布

推荐通过 **GitHub Releases** 分发（SecAgent 支持 zip 直装）：

1. **更新版本号**：同步修改 `secagent-plugin.json` 与 `package.json` 的 `version`（语义化版本，如 `0.2.1`）；记录变更；
2. **打包**：
   ```bash
   npm install
   npm test && npm run check
   npm run pack          # 产出 release/computer-use-<version>.zip
   ```
3. **计算校验和**：
   ```bash
   sha256sum release/computer-use-<version>.zip
   ```
4. **提交、打 tag、发布**：
   ```bash
   git add -A && git commit -m "release: computer-use plugin v<version>"
   git tag computer-use-v<version>
   git push origin main --tags
   ```
   GitHub 仓库 → Releases → 选该 tag → 上传 zip，说明中粘贴 SHA-256 与变更 → Publish。
5. 用户从 Release 下载 zip，在 SecAgent 中“从 ZIP 安装”即可。

## 安全说明

- 该插件能操控整个桌面并键入任意内容，能力较大。建议配合 SecAgent 的敏感操作确认使用，初次体验可在虚拟机或测试账户中进行。
- 插件在 Electron 主进程内运行；请勿安装来源不明的插件包，安装前核对 SHA-256。
- 未来若需要进程级隔离，可把执行器改写为独立 stdio MCP 进程（SecAgent 支持插件携带 stdio MCP）。

## 故障排查

- **缺少 koffi**：发布包未含 `node_modules/koffi`，重新 `npm install` 后 `npm run pack`。
- **inspect 列不出元素**：目标软件可能是自绘 UI/游戏，改用 OmniParser；管理员窗口需提权。
- **点击位置偏移**：确认截图与动作在同一 DPI 上下文（插件已自动处理），必要时核对显示缩放并反馈。
- **模型不调用工具/看不到图**：主模型不是视觉模型，请切换为多模态模型。
