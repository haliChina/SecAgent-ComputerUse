---
name: computer-use
description: 让 Agent 操控 Windows 桌面：元素侦察（UI Automation/OmniParser）、按编号点击、截屏、移动、拖拽、滚动、输入文本、按组合键。
---

# Computer Use（Windows 桌面操控）

当用户要求操作屏幕、桌面软件、点击界面、填写表单或打开某个程序时使用本技能。

## 前置条件

- 仅支持 **Windows**。
- 主模型必须是**视觉多模态模型**（能查看截图），否则无法定位界面元素。

## 核心原则：用“元素地图”，不要裸猜坐标

- 先 `inspect` 让系统列出可交互元素（编号 / 名称 / 角色 / 包围矩形）；
- 点击时给 `click` 传 **elementId**，坐标由系统取该元素中心给出，模型不预测像素；
- 只有在元素地图不可用时，才退回 `x,y` 坐标。

## 坐标约定（唯一一套）

- 所有 `x,y` 一律是**相对本次截图左上角**的像素，单位与模型看到的那张图完全一致；
- 截图可能被缩放（长边默认 1568），也可能是多显示器拼接（虚拟原点为负）——系统已经全部归一，**不要自己乘除比例、不要使用绝对屏幕坐标**；
- `screenshot` 返回的图片下方带一行“坐标契约”文本，写明截图尺寸 / 物理分辨率 / scale / 虚拟原点，照它说的做；
- `inspect` 列出的 `bbox` 同样是截图内相对坐标，与标注图一一对应；
- 界面一变，元素地图立刻过期，必须重新 `inspect`。

## 工具契约

完整 key 前缀为 `computer-use__`：

| 工具 key | 参数 | 作用 |
|---|---|---|
| `computer-use__doctor` | 无 | **首次使用 / 动作失败时先调用**：环境自检，失败项给出修复建议 |
| `computer-use__settings` | 无 | 在系统浏览器打开设置控制台（参数 / OmniParser 一键安装 / 思考提醒） |
| `computer-use__screenshot` | 无 | 截屏返回图片 + 坐标契约说明，观察整体 / 验证结果 |
| `computer-use__wait` | `ms`（50-10000，默认 500） | 等待界面响应；连续动作之间建议 300-800ms |
| `computer-use__cursor_position` | 无 | 读取指针位置（截图坐标 + 物理坐标），核对点击是否落点 |
| `computer-use__inspect` | 可选 `backend`(auto/uia/omniparser)、`annotate`(布尔)、`clickableOnly`(布尔)、`scope`(foreground/desktop) | 返回元素清单文本；`annotate=true` 返回带编号框的标注图；`scope=desktop` 连任务栏/桌面图标一起侦察 |
| `computer-use__windows` | 无 | 列出可见顶层窗口（标题 + 进程号） |
| `computer-use__focus` | `title`（窗口标题正则） | 把焦点切到目标窗口，比盲点任务栏可靠 |
| `computer-use__launch` | `command`，可选 `args` | 启动应用 / 打开文件（detached） |
| `computer-use__clipboard` | `action`(read/write)，`write` 需 `text` | 剪贴板读写，**默认关闭**，需用户在设置里显式开启 |
| `computer-use__click` | **elementId**（优先）；或 `x,y` 兜底；可选 `button`、`double` | 点击 / 双击目标元素 |
| `computer-use__move` | `x,y` | 移动指针，不点击 |
| `computer-use__drag` | `from:{x,y}`、`to:{x,y}`；可选 `button` | 按住拖拽 |
| `computer-use__scroll` | `x,y`；可选 `amount`（缺省用设置默认值），正向上、负向下 | 滚动滚轮 |
| `computer-use__type` | `text` | 在聚焦处输入文本（支持中文） |
| `computer-use__key` | `keys` | 组合键，如 `ctrl+c`、`alt+tab`、`enter`、`f5` |

## 标准流程

0. 首次使用或动作失败时，先 `doctor` 自检：按修复建议处理，通过后再干活；
1. `screenshot` 观察整体布局（读一下坐标契约）；
2. `inspect` 获取可交互元素清单（视觉不确定时用 `inspect(annotate=true)` 看编号框）；
3. 用 `click({elementId})` 点击所选元素，或 `type` / `key`；
4. 界面需要时间响应就 `wait`，再用 `cursor_position` 或 `screenshot` 验证；
5. 逐步推进直到完成。输入文字前先按 elementId 点击输入框聚焦，再 `type`。

## 感知后端

- **UIA（默认）**：Windows UI Automation，免费精确，覆盖 Win32/WPF/WinForms/多数 Qt/Electron；
- **UIA 范围**：`scope=foreground`（默认，只看前台窗口）/`scope=desktop`（桌面根节点，含任务栏、桌面图标、后台窗口，更慢元素更多）；
- **OmniParser（可选）**：当 UIA 元素过少（自绘界面、游戏、Canvas），在已启动 OmniParser HTTP 服务时用 `inspect(backend="omniparser")`；
- UIA 已知盲区：自绘 UI、游戏、远程桌面内、管理员窗口（需提权或虚拟机）。

## 设置控制台与思考提醒

- 用户要求改配置、调参数、安装视觉模型、或觉得思考太久时，调用 `settings` 打开设置控制台；
- 控制台可一键安装并启动本地 OmniParser（自动建虚拟环境、装依赖、下权重、拉起服务），也可开关其兜底、设置开机自启；
- 思考提醒：系统会在任务开始时给出“思考时间预算 / 最大动作轮次”，当动作轮次达到上限、或两次动作间隔过长（疑似卡思考）时，在工具结果中温和提醒尽快收敛；
- 收到思考提醒后，立即给出下一步动作或结论；确实无法继续就直接向用户说明卡点，不要继续反复权衡；
- “自动降思考力度 / 自动切换模型”需宿主核心层支持，当前版本仅做温和提醒。

## 约束

- 界面一旦变化，元素地图即过期，需重新 `inspect`；不要凭旧编号盲点。
- 不重复同一无效动作；连续 2 次无进展就换思路或向用户说明卡点。
- 每个方案最多自我反驳一轮，禁止反复横跳；优先可逆、下行风险小的动作。
- 支付、删除、发送、提交等不可逆动作，先向用户确认再执行；宿主工具守卫也会对高风险键入与组合键做拦截，被拒绝时不要换招绕过，直接向用户说明。
