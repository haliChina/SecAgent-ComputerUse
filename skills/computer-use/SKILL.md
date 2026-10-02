---
name: computer-use
description: 让 Agent 通过截图与鼠标键盘操控 Windows 桌面：截屏、点击、移动、拖拽、滚动、输入文本、按组合键。
---

# Computer Use（Windows 桌面操控）

当用户要求操作屏幕、桌面软件、点击界面、填写表单或打开某个程序时使用本技能。

## 前置条件

- 仅支持 **Windows**。
- 主模型必须是**视觉多模态模型**（能查看截图），否则无法定位界面元素。

## 坐标约定

- 截图左上角为原点 `(0,0)`，单位为**物理像素**。
- 所有工具坐标都相对截图左上角；多显示器的虚拟原点由插件内部处理，无需关心负坐标。
- 截图返回的 `width`/`height` 即合法坐标范围，不要超出。

## 工具契约

完整 key 前缀为 `computer-use__`：

| 工具 key | 参数 | 作用 |
|---|---|---|
| `computer-use__screenshot` | 无 | 截屏，返回图片，直接查看 |
| `computer-use__click` | `x,y`；可选 `button`(left/right/middle，默认 left)、`double`(布尔) | 在坐标点击/双击 |
| `computer-use__move` | `x,y` | 移动指针，不点击 |
| `computer-use__drag` | `from:{x,y}`、`to:{x,y}`；可选 `button` | 按住拖拽 |
| `computer-use__scroll` | `x,y,amount` | amount 正向上、负向下 |
| `computer-use__type` | `text` | 在聚焦处输入文本（支持中文） |
| `computer-use__key` | `keys` | 组合键，如 `ctrl+c`、`alt+tab`、`enter`、`f5` |

## 标准流程

1. 先 `screenshot` 观察当前界面；
2. 决定**一个**下一步动作并执行；
3. 再次 `screenshot` 验证结果，逐步推进直到完成；
4. 输入文字前先点击目标输入框使其聚焦，再 `type`。

## 约束

- 点击前确认目标准确落在可交互元素上；界面与预期不符时重新截图判读。
- 不盲点、不重复同一无效动作；连续 2 次无进展就换思路或向用户说明卡点。
- 每个方案最多自我反驳一轮，禁止反复横跳；优先可逆、下行风险小的动作。
