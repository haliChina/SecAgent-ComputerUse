# SecAgent · Computer Use 插件

让 SecAgent 像真人一样操控 Windows：**元素侦察、按编号点击、截屏、移动、拖拽、滚动、输入文本、组合键**，并内置**设置控制台**。

- **v0.2 起**加入“元素地图”：系统列出可交互元素并编号，模型只选编号，坐标由系统给出，不再裸猜像素；
- **v0.3 起**加入**设置控制台**：各种参数可调、**OmniParser 一键安装并启动**、**卡思考时温和提醒**。

- 格式：SecAgent 自有插件（`secagent-plugin.json` + `main.mjs`）
- 系统：动作仅 Windows（依赖 user32/gdi32）；设置控制台在任意平台可打开
- 运行时依赖：[koffi](https://koffi.dev/)（FFI，随发布包打包，无需用户安装）
- 模型要求：主模型必须是**视觉多模态模型**（如 GPT-4o/5、Qwen-VL、GLM-4.5V、Gemini、豆包 Vision、Claude）

## 提供的工具

| 工具 | 作用 |
|---|---|
| `computer-use__settings` | 在系统浏览器打开**设置控制台** |
| `computer-use__screenshot` | 截取整个屏幕（含多显示器），返回图片 |
| `computer-use__inspect` | 侦察可交互元素，返回编号清单；`annotate=true` 返回带编号框的标注图 |
| `computer-use__click` | **按 elementId 点击**（坐标系统给）；也支持 x,y 兜底、双击/右键/中键 |
| `computer-use__move` | 移动指针 |
| `computer-use__drag` | 从一点拖拽到另一点 |
| `computer-use__scroll` | 垂直滚动（amount 缺省用设置默认值） |
| `computer-use__type` | 输入文本（支持中文） |
| `computer-use__key` | 组合键，如 `ctrl+c`、`alt+tab`、`f5` |

## 安装

1. SecAgent → 设置 → 插件 → **从 ZIP 安装**，选择发布包 `computer-use-<version>.zip`；
2. 启用插件，确认主模型为视觉模型；
3. 直接对话，例如：
   - “截屏看看我桌面上有什么”
   - “打开记事本，输入‘你好世界’，然后保存到桌面”
   - “把浏览器里这个表单填一下”
   - “打开设置，把元素上限调到 40”

## 设置控制台

对 Agent 说“打开设置”，或调用 `computer-use__settings`，会在**系统浏览器**打开本地控制台（仅 `127.0.0.1`，带一次性 token 与 Host 校验）。

可调参数（分组）：

| 分组 | 参数 |
|---|---|
| 感知 | 感知后端（auto/uia/omniparser）、元素数量上限、是否只列可交互元素、UIA 超时、自动回退阈值 |
| OmniParser | 启用兜底、服务地址、开机自启、**一键安装/启动/停止/卸载** |
| 思考提醒 | 启用、思考时间预算（秒）、单任务最大动作轮次、卡住后处理、提醒文案 |
| 动作 | 点击前先 inspect、动作后截图验证、默认滚动格数 |
| 安全 | 高风险动作先确认 |

> 标注“立即生效”的参数由后端真正读取；标注“行为引导”的参数通过提示词 / Skill 引导模型（纯插件无法在引擎层强制）。

## OmniParser：一键安装（推荐）

UIA 覆盖不到自绘 UI、游戏、Canvas 时使用。控制台 → “本地视觉服务” → **一键安装并启动**，插件会自动：

1. 检测 Python（3.10/3.11，缺省时提示 `winget install Python.Python.3.10`）；
2. 在用户目录建立虚拟环境（`~/.secagent/computer-use/omniparser`）；
3. 下载 OmniParser 源码、安装依赖（torch/transformers/ultralytics 等）；
4. 从 HuggingFace 下载模型权重（`microsoft/OmniParser-v2.0`，约数百 MB）；
5. 写入并后台拉起 `/parse` 服务，健康检查通过后开关生效。

安装耗时取决于网络，控制台会显示阶段与进度；可勾选“开机自启”。卸载会删除虚拟环境与权重。

### 手动部署（可选）

也可指向你自己部署的服务：在控制台填写“OmniParser 服务地址”。服务需接受 `POST /parse`（multipart 图片或表单字段 `base64`），返回：

```json
{ "parsed_content_list": [ { "type": "icon", "bbox": [x1,y1,x2,y2], "interactivity": true, "content": "..." } ],
  "image_size": { "width": 1920, "height": 1080 } }
```

> UIA 已知盲区：自绘界面、游戏、远程桌面内、管理员窗口（UIPI 隔离，需提权或虚拟机）。

## 思考提醒（卡思考 / 左右脑互博）

- **任务开始**：提示词注入“思考时间预算 + 最大动作轮次”，引导模型控制思考；
- **循环内**：动作轮次达到上限、或两次动作间隔过长（疑似卡思考）时，在工具结果中**温和提醒**尽快收敛；
- 收到提醒后应立即给出下一步或结论；确实无法继续就向用户说明卡点；
- “自动降低思考力度 / 自动切换模型 / 思考中硬中断”属**宿主核心层**能力（`ModelToolAgent` 主循环），当前插件仅做温和提醒，需后续在 SecAgent 核心实现。

## 工作原理（简述）

标准循环：**截图 → 元素侦察 → 模型选编号 → 系统坐标执行 → 再截图验证**。

- 元素地图（Set-of-Mark）：`inspect` 先把可交互元素框出并编号，模型只回答“点 #几”，点击坐标取该元素 bbox 中心（系统给）；
- 截图：GDI `BitBlt` + `GetDIBits` 取 BGRA，内置零依赖 PNG 编码器；
- 鼠标：`SetCursorPos` + `mouse_event`；键盘：`keybd_event`（文本 `KEYEVENTF_UNICODE`，组合键虚拟键码）；
- DPI：线程级 `PER_MONITOR_AWARE_V2` 上下文截图与操作，坐标自洽，结束恢复；
- 设置控制台：主进程起 `127.0.0.1` HTTP，随机端口 + token + Host 校验。

## 开发

```bash
npm install        # 安装 koffi（含各平台预编译二进制）
npm test           # 单元测试（注入 fake native/runner/fetch，无需 Windows）
npm run check      # 语法检查
npm run pack       # 生成 release/computer-use-<version>.zip
```

> 单元测试任意平台可跑（系统调用收敛为可注入原语；设置服务用真实本地 HTTP）。真实 Win32 行为请在 Windows 真机按下方清单自测。

## 真机自测清单（发布前）

- [ ] 从 ZIP 安装并启用，插件状态为“已就绪”；
- [ ] `settings` 能打开控制台，改参数后保存生效；
- [ ] 截屏返回清晰图片，尺寸与当前分辨率一致；
- [ ] `inspect` 能列出目标软件的按钮/输入框；`annotate` 编号与界面对应；
- [ ] 按 elementId 点击，在 100% 与 150% 缩放下落点均准确；
- [ ] 输入中文与英文均正确；`ctrl+c`/`alt+tab`/`f5` 等组合键生效；
- [ ] 滚动、拖拽正常；多显示器（如有）坐标正确；
- [ ] （可选）控制台一键安装 OmniParser 成功并运行，自绘界面回退生效；停用/卸载无残留。

## 如何发布

推荐通过 **GitHub Releases** 分发（SecAgent 支持 zip 直装）：

1. **更新版本号**：同步 `secagent-plugin.json` 与 `package.json` 的 `version`；记录变更；
2. **打包**：
   ```bash
   npm install
   npm test && npm run check
   npm run pack          # 产出 release/computer-use-<version>.zip
   ```
3. **校验和**：`sha256sum release/computer-use-<version>.zip`
4. **提交、打 tag、发布**：
   ```bash
   git add -A && git commit -m "release: computer-use plugin v<version>"
   git tag computer-use-v<version>
   git push origin main --tags
   ```
   GitHub → Releases → 选该 tag → 上传 zip，粘贴 SHA-256 与变更 → Publish。

## 安全说明

- 该插件能操控整个桌面并键入任意内容，能力较大。建议配合敏感操作确认，初次体验可在虚拟机或测试账户中进行。
- 设置控制台仅监听 `127.0.0.1`，带 token 与 Host 校验；请勿安装来源不明的插件包，安装前核对 SHA-256。
- 未来若需进程级隔离，可把执行器改写为独立 stdio MCP 进程（SecAgent 支持插件携带 stdio MCP）。

## 故障排查

- **缺少 koffi**：发布包未含 `node_modules/koffi`，重新 `npm install` 后 `npm run pack`。
- **一键安装失败**：确认已装 Python 3.10/3.11 且网络可访问 GitHub/HuggingFace；可重试，已完成的步骤会跳过。
- **inspect 列不出元素**：目标软件可能是自绘 UI/游戏，改用 OmniParser；管理员窗口需提权。
- **点击位置偏移**：确认截图与动作在同一 DPI 上下文（插件已自动处理）。
- **模型不调用工具/看不到图**：主模型不是视觉模型，请切换为多模态模型。
