// SecAgent Computer Use 插件入口。
// 由宿主动态 import 并调用 activate(api)。
import { WindowsDriver } from "./driver/win-driver.mjs";

const pointSchema = (extra = {}) => ({
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: {
    x: { type: "integer", description: "相对截图左上角的 X 像素" },
    y: { type: "integer", description: "相对截图左上角的 Y 像素" },
    ...extra
  }
});

function asInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${name} 必须是整数像素坐标`);
  return n;
}

export async function activate(api) {
  // 本插件只面向 Windows（依赖 user32/gdi32）。
  if (process.platform !== "win32") {
    api.setStatus("Computer Use 插件仅支持 Windows", "error");
    return () => {};
  }

  const driver = new WindowsDriver();

  // 1) 截屏（可见，返回图片 -> 宿主自动转多模态）
  api.registerTool(
    {
      name: "screenshot",
      description:
        "截取当前整个屏幕并把图片直接提供给模型。在执行任何点击/输入前先调用以观察界面，动作后再次调用以验证结果。",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      hidden: false
    },
    async () => await driver.screenshot()
  );

  // 2) 点击
  api.registerTool(
    {
      name: "click",
      description: "在屏幕坐标 (x,y) 点击鼠标；可指定左右中键与双击。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y"],
        properties: {
          x: { type: "integer" },
          y: { type: "integer" },
          button: { type: "string", enum: ["left", "right", "middle"] },
          double: { type: "boolean" }
        }
      },
      hidden: false
    },
    async (a) =>
      await driver.click(
        asInt(a.x, "x"),
        asInt(a.y, "y"),
        a.button ?? "left",
        a.double === true
      )
  );

  // 3) 移动
  api.registerTool(
    {
      name: "move",
      description: "把鼠标指针移动到屏幕坐标 (x,y)，不点击。",
      inputSchema: pointSchema(),
      hidden: false
    },
    async (a) => await driver.move(asInt(a.x, "x"), asInt(a.y, "y"))
  );

  // 4) 拖拽
  api.registerTool(
    {
      name: "drag",
      description: "从 from 坐标按住鼠标拖拽到 to 坐标后松开。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to"],
        properties: {
          from: pointSchema(),
          to: pointSchema(),
          button: { type: "string", enum: ["left", "right", "middle"] }
        }
      },
      hidden: false
    },
    async (a) =>
      await driver.drag(
        asInt(a.from?.x, "from.x"),
        asInt(a.from?.y, "from.y"),
        asInt(a.to?.x, "to.x"),
        asInt(a.to?.y, "to.y"),
        a.button ?? "left"
      )
  );

  // 5) 滚动
  api.registerTool(
    {
      name: "scroll",
      description:
        "在坐标 (x,y) 处垂直滚动滚轮；amount 为正向上、为负向下，例如 3 或 -3。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y", "amount"],
        properties: {
          x: { type: "integer" },
          y: { type: "integer" },
          amount: { type: "integer" }
        }
      },
      hidden: false
    },
    async (a) =>
      await driver.scroll(asInt(a.x, "x"), asInt(a.y, "y"), asInt(a.amount, "amount"))
  );

  // 6) 输入文本
  api.registerTool(
    {
      name: "type",
      description: "在当前获得焦点的位置输入文本（支持中文等任意 Unicode）。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string" } }
      },
      hidden: false
    },
    async (a) => {
      if (typeof a.text !== "string") throw new Error("type 需要 text 字符串");
      return await driver.type(a.text);
    }
  );

  // 7) 组合键
  api.registerTool(
    {
      name: "key",
      description:
        "按下组合键，如 ctrl+c、alt+tab、ctrl+shift+esc、enter、f5。多个键用 + 连接。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["keys"],
        properties: { keys: { type: "string" } }
      },
      hidden: false
    },
    async (a) => {
      if (typeof a.keys !== "string" || !a.keys.trim())
        throw new Error("key 需要 keys，例如 ctrl+c");
      return await driver.chord(a.keys);
    }
  );

  // 收敛与坐标规则：通过插件 prompt 注入，无需改动宿主核心。
  api.registerPrompt(
    "computer_rules",
    `## 电脑操作规则（Computer Use）
- 你看到的截图左上角为坐标原点 (0,0)，坐标单位为物理像素；先调用 screenshot 获取画面与可用坐标范围。
- 标准节奏：screenshot 观察 → 决定一个动作（click/type/key/scroll/drag）→ 再 screenshot 验证，逐步推进。
- 点击前确认目标准确落在按钮/输入框内；若截图后界面与预期不符，重新判读，绝不盲点或重复同一无效动作。
- 需要输入文字时，先点击目标输入框使其聚焦，再 type；需要快捷键时用 key。
- 每个方案最多自我反驳一轮，禁止在两个位置或方案间反复横跳；连续 2 次动作无进展就换思路或向用户说明卡点。
- 信息无法再获取时，选择可逆、下行风险小的动作，并明确标注不确定之处；不要为求最优而无限权衡。`
  );

  // Skill：提供完整动作契约，命中相关话题时自动加载。
  api.registerSkill("skills/computer-use", /截屏|屏幕|桌面|点击|鼠标|键盘|打开软件|操作电脑|computer/i);

  api.setStatus("已就绪");

  return () => {
    // 宿主卸载插件时会清理注册项；这里无需额外动作。
  };
}
