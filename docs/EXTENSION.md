# SecAgent 浏览器桥 · 扩展安装与配对指南

「SecAgent 浏览器桥」是一个 Chrome/Edge 扩展（本仓库 `extension/` 目录），与 computer-use 插件内的**本地扩展桥**配对后，Agent 操作网页时直读页面 DOM：毫秒级拿到真实元素结构（按钮/链接/输入框 + 屏幕坐标），不再依赖截图目测或 20 秒起步的视觉模型。

```
浏览器扩展（DOM 传感器/执行器）
   │ WebSocket（chrome-extension:// Origin）
   ▼
插件扩展桥（127.0.0.1 随机端口 + 配对码）
   ▼
element-map 编号地图 → click(elementId) 照常点击
```

## 能力与边界

| 能力 | 说明 |
|---|---|
| `inspect(backend="extension")` | 页面可交互元素清单（编号/角色/名称/bbox），坐标已换算到屏幕物理像素 |
| `tabs` 工具 | 列出/切换所有标签页（跨窗口） |
| `read_page` 工具 | 读页面可见文本（innerText，含截断上限设置） |
| auto 兜底 | UIA 元素稀疏时自动尝试扩展（在 OmniParser 之前，因为快几个数量级） |

边界：**点击/输入仍走系统级鼠标键盘**（复用现有动作链路，页面看到的是真实用户输入）；浏览器内部页面（`chrome://`、Chrome 应用商店）无法注入脚本；扩展不读取历史/密码/表单自动填充数据。

## 安装（小白三步，0.7.1 起零输入）

扩展装好后会**自动扫描**本机固定端口段（39700-39705）找到 SecAgent 并连接，全程不需要配对码：

1. 在 SecAgent 设置控制台「浏览器扩展桥」卡片点「**打开扩展管理页**」（或手动访问 `chrome://extensions`，Edge 为 `edge://extensions`）；
2. 开启右上角**开发者模式** → 点「**加载已解压的扩展程序**」→ 选择本插件安装目录下的 `extension` 文件夹；
3. 回到设置控制台——几秒内会出现「**待允许的浏览器扩展**」卡片，点「**允许**」，状态变「已连接」即完成。之后对 Agent 说「用浏览器扩展 inspect」即可。

新装扩展会再次出现「待允许」，点一次允许即长期信任（信任列表可一键清除）。

### 手动配对（高级，可选）

端口被占导致桥回退随机端口时才需要：配对页填入控制台显示的端口与配对码（「复制端口/复制配对码」按钮）。正常情况下无需此步。

## 配对码与安全

- 桥只绑 `127.0.0.1` 随机端口；升级请求必须带配对码（48 位十六进制，进程内存持有、不落盘）；
- Origin 白名单：仅接受 `chrome-extension://` 来源，普通网页（`http(s)://`）一律拒绝——本机恶意页面无法直连；
- 命令白名单：只有 `ping` / `tabs.list` / `tabs.focus` / `dom.collect` / `dom.read` / `bye`，无脚本执行通道；
- 配对码在插件进程存活期内稳定；重启插件或点「重置配对码」后需在扩展配对页重新填入。

## 排障

| 症状 | 处置 |
|---|---|
| 扩展页显示「未连接：port/token 无效」 | 设置控制台重新复制粘贴；确认没混入空格 |
| 状态「监听中·未配对」但扩展填了码 | 配对码是进程级随机值：插件重启过就变了，重填 |
| inspect(extension) 报「浏览器内部页面」 | 目标是 `chrome://` 等受限页，切到普通网页或改用 backend="auto" |
| 元素坐标整体偏移 | 页面缩放不是 100% 时属正常近似误差；混合 DPI 多显示器下个别元素可能被过滤（防点飞） |
| MV3 Service Worker 休眠断连 | 扩展自动重连（1s~30s 退避）；若长期断开点配对页「立即重连」 |

## 从源码构建（可选）

`extension/` 是免构建的纯静态 MV3 项目（无第三方依赖、无打包步骤），直接加载即可。改完 `collector.js` / `background.js` 后在 `chrome://extensions` 点扩展卡片上的刷新按钮。


## 常见问题：浏览器弹「请关闭开发者模式扩展」警告

Edge/Chrome 对「加载已解压的扩展程序」装的扩展，每隔一两天会弹一次
「请关闭开发者模式扩展」的警告。这是浏览器内置策略，唯一根治法是写入
浏览器策略 `ExtensionDeveloperModeWarning=0`（HKCU 用户级即可，无需管理员）。

**最简单**：设置控制台（`settings` 工具）→「扩展配对」卡片 →
点「关闭 Edge 警告弹窗」（或 Chrome 版）按钮，一键写入。

**手动执行**（cmd）：

```bat
:: Edge
reg add "HKCU\Software\Policies\Microsoft\Edge" /v ExtensionDeveloperModeWarning /t REG_DWORD /d 0 /f
:: Chrome
reg add "HKCU\Software\Policies\Google\Chrome" /v ExtensionDeveloperModeWarning /t REG_DWORD /d 0 /f
```

写入后重启浏览器生效。

## 常见问题：点「打开扩展管理页」弹「选择打开方式的软件」

chrome:// 是 Chromium 内核私有协议。若系统默认浏览器不是 Chrome/Edge
（如 Firefox），把 chrome:// 链接交给默认浏览器就会弹「选择打开方式的软件」
选择框。0.8.5 起「打开扩展管理页」会**显式探测本机 Chrome/Edge 并用其打开**
（Chrome 优先、Edge 兜底），不再经过系统默认浏览器。

`launch` 工具同样智能：说 chrome 但机器没装 Chrome 时自动换 Edge 打开，
chrome:// 链接自动转换为 edge:// 等价协议，并在返回里说明。
