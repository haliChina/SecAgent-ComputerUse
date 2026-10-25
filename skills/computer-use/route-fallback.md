# 路线：自绘 UI / 游戏 / Canvas 兜底

UIA 元素过少（自绘界面、游戏、Canvas、QQ音乐类自绘播放器）时：

## OmniParser 视觉兜底

- 已启用时 `inspect(backend="omniparser")`：截图跑 YOLO+Florence，返回识别出的可点元素（图标/文本块）。
- **无 GPU 行为（0.7.6 起）**：`auto` 模式下探测到无 CUDA（纯 CPU 一屏约 8~13 分钟）会**自动跳过** OmniParser 兜底并在结果里说明；显式 `backend="omniparser"` 不拦（你点名要它时尊重选择）。有 CUDA 时 auto 正常走。
- doctor 的 OmniParser 项会标「无 CUDA 不建议启用」——建议用户以 `backend="uia"` 为主。

## 目测交叉核对（兜底中的兜底）

- `screenshot` 拿整屏 → 从图上目测目标坐标（x,y 只取自**这张**截图）→ `click(x,y)` → `cursor_position` 核对落点 → 再 `screenshot` 验证效果。
- `inspect(scope="desktop")` 连任务栏/桌面图标一起侦察（要操作 Dock/桌面图标时用）。
- 判成败看**预期效果**出现与否，不看「调工具没报错」。

## 坐标纪律（兜底模式尤其要守）

- 转用 x,y 时**丢弃**此前 inspect 文本里的 bbox 数值——坐标只能取自最新截图，绝不能从元素清单/可访问性数据里复制。
- 快照已证明的文本目标（按钮文字、标题、链接文字）可直接点，不要因为「看起来不像按钮」而另猜 role 或坐标。
