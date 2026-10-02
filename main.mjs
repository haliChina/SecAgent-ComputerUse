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
  if (!Number.isInteger(n)) throw new Error(`${name} 必须是整数`);
  return n;
}

export async function activate(api) {
  // 本插件只面向 Windows（依赖 user32/gdi32）。
  if (process.platform !== "win32") {
    api.setStatus("Computer Use 插件仅支持 Windows", "error");
    return () => {};
  }

  // OmniParser 为可选后端：从宿主配置读取服务地址（读取失败则不启用，仅用 UIA）。
  let omniEndpoint;
  try {
    const cfg = typeof api.getConfig === "function" ? await api.getConfig() : {};
    omniEndpoint =
      cfg?.omniEndpoint ?? cfg?.omniparserEndpoint ??
      cfg?.["computer-use"]?.omniEndpoint;
  } catch {
    omniEndpoint = undefined;
  }

  const driver = new WindowsDriver(omniEndpoint ? { omniEndpoint } : {});

  // 1) 截屏（返回图片 -> 宿主自动转多模态）
  api.registerTool(
    {
      name: "screenshot",
      description:
        "截取当前整个屏幕并把图片直接提供给模型。用于观察整体布局，动作后再次调用以验证结果。",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      hidden: false
    },
    async () => await driver.screenshot()
  );

  // 2) 元素侦察（元素地图）
  api.registerTool(
    {
      name: "inspect",
      description:
        "侦察当前屏幕的可交互元素，返回元素清单（编号/名称/角色/包围矩形）。优先用 Windows UI Automation。点击前先调用本工具，再用 click 的 elementId 选择目标，坐标由系统给出，不要裸猜像素。需要视觉核对时令 annotate=true 获取带编号框的标注图。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          backend: {
            type: "string",
            enum: ["auto", "uia", "omniparser"],
            description: "auto=UIA 优先、元素过少时回退 OmniParser"
          },
          annotate: { type: "boolean", description: "true 返回带编号框的标注图" },
          clickableOnly: { type: "boolean", description: "OmniParser 下是否只保留可点元素" }
        }
      },
      hidden: false
    },
    async (a) =>
      await driver.inspect({
        backend: a.backend ?? "auto",
        annotate: a.annotate === true,
        clickableOnly: a.clickableOnly ?? true
      })
  );

  // 3) 点击（elementId 优先，x,y 兜底）
  api.registerTool(
    {
      name: "click",
      description:
        "点击目标。优先传 elementId（来自 inspect 的元素编号，坐标由系统给出，最准）；也可传 x,y 坐标兜底。可指定左右中键与双击。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          elementId: { type: "integer", description: "inspect 返回的元素编号" },
          x: { type: "integer" },
          y: { type: "integer" },
          button: { type: "string", enum: ["left", "right", "middle"] },
          double: { type: "boolean" }
        }
      },
      hidden: false
    },
    async (a) => {
      const opts = { button: a.button ?? "left", double: a.double === true };
      if (a.elementId != null) {
        opts.elementId = asInt(a.elementId, "elementId");
      } else {
        opts.x = asInt(a.x, "x");
        opts.y = asInt(a.y, "y");
      }
      return await driver.clickTarget(opts);
    }
  );

  // 4) 移动
  api.registerTool(
    {
      name: "move",
      description: "把鼠标指针移动到屏幕坐标 (x,y)，不点击。",
      inputSchema: pointSchema(),
      hidden: false
    },
    async (a) => await driver.move(asInt(a.x, "x"), asInt(a.y, "y"))
  );

  // 5) 拖拽
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

  // 6) 滚动
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

  // 7) 输入文本
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

  // 8) 组合键
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
- 优先“元素地图”而非裸坐标：操作前先 inspect 获取可交互元素清单（编号/名称/角色），点击时给 click 传 elementId，坐标由系统给出，不要自行估计像素。
- 标准节奏：screenshot 观察整体 → inspect 拿到元素编号 → click(elementId) 或 type/key → 再 screenshot 验证，逐步推进。
- 需要视觉核对时用 inspect(annotate=true) 查看带编号框的标注图；界面一旦变化，元素地图即过期，需重新 inspect。
- 需要输入文字时，先按 elementId 点击输入框使其聚焦，再 type；需要快捷键时用 key。
- 若 UIA 元素过少（自绘界面、游戏、Canvas），在已启动 OmniParser 服务时用 inspect(backend="omniparser")。
- 每个方案最多自我反驳一轮，禁止在两个位置或方案间反复横跳；连续 2 次动作无进展就换思路或向用户说明卡点。
- 信息无法再获取时，选择可逆、下行风险小的动作，并明确标注不确定之处；不要为求最优而无限权衡。`
  );

  // Skill：提供完整动作契约，命中相关话题时自动加载。
  api.registerSkill("skills/computer-use", /截屏|屏幕|桌面|点击|鼠标|键盘|打开软件|操作电脑|元素|computer/i);

  api.setStatus("已就绪");

  return () => {
    // 宿主卸载插件时会清理注册项；这里无需额外动作。
  };
}
