// SecAgent Computer Use 插件入口。
// 由宿主动态 import 并调用 activate(api)。
import { WindowsDriver } from "./driver/win-driver.mjs";
import { createKoffiNative } from "./driver/win-driver.mjs";
import { runDoctor, formatDoctorReport } from "./driver/doctor.mjs";
import { mergeConfig, describeSettings, DEFAULT_CONFIG } from "./settings/config-schema.mjs";
import { createSettingsServer } from "./settings/settings-server.mjs";
import { CONSOLE_HTML } from "./settings/console-page.mjs";
import { createOmniParserManager } from "./omniparser/omniparser-manager.mjs";
import { SERVER_PY } from "./omniparser/server-template.mjs";
import { createNudge } from "./reasoning/nudge.mjs";

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

const STATIC_RULES = `## 电脑操作规则（Computer Use）
- 首次使用或动作失败时，先运行 doctor 自检：逐项验证环境并按修复建议处理，通过后再干活。
- 优先“元素地图”而非裸坐标：操作前先 inspect 获取可交互元素清单（编号/名称/角色），点击时给 click 传 elementId，坐标由系统给出，不要自行估计像素。
- 标准节奏：screenshot 观察整体 → inspect 拿到元素编号 → click(elementId) 或 type/key → 再 screenshot 验证，逐步推进。
- 需要视觉核对时用 inspect(annotate=true) 查看带编号框的标注图；界面一旦变化，元素地图即过期，需重新 inspect。
- 需要输入文字时，先按 elementId 点击输入框使其聚焦，再 type；需要快捷键时用 key。
- 若 UIA 元素过少（自绘界面、游戏、Canvas），在已启用 OmniParser 时用 inspect(backend="omniparser")。
- 每个方案最多自我反驳一轮，禁止在两个位置或方案间反复横跳；连续 2 次动作无进展就换思路或向用户说明卡点。
- 信息无法再获取时，选择可逆、下行风险小的动作，并明确标注不确定之处；不要为求最优而无限权衡。`;

export async function activate(api) {
  // —— 配置：始终合并默认值，driver / 管理器 / 软提醒共用 ——
  const readConfig = () => {
    try {
      const raw = typeof api.getConfig === "function" ? api.getConfig() : {};
      return mergeConfig(raw).config;
    } catch {
      return mergeConfig({}).config;
    }
  };
  const persistConfig = (config) => {
    try {
      api.setConfig(config);
    } catch { /* 持久化失败不阻断动作 */ }
  };

  const initial = readConfig();

  // driver 通过 configProvider 动态读取设置（含 OmniParser 开关）。
  const driver = new WindowsDriver({ configProvider: readConfig });

  // OmniParser 一键安装管理器（数据在用户主目录，不随插件包分发）。
  // 镜像地址从设置动态读取，安装/启动时生效。
  const manager = createOmniParserManager({
    endpoint: initial.omniEndpoint,
    serverTemplate: SERVER_PY,
    getHfMirror: () => readConfig().hfMirror,
    getPipIndexUrl: () => readConfig().pipIndexUrl
  });

  // 本地设置控制台。
  const settingsServer = createSettingsServer({
    getConfig: readConfig,
    setConfig: persistConfig,
    manager,
    pageHtml: CONSOLE_HTML
  });
  await settingsServer.start();

  // 原生设置 handler（宿主未来在设置页渲染表单时使用；当前用 HTTP 控制台）。
  if (typeof api.registerSettingsHandler === "function") {
    api.registerSettingsHandler("computer-use-console", async (action, args = {}) => {
      switch (action) {
        case "meta":
          return describeSettings();
        case "config":
          return readConfig();
        case "set": {
          const merged = mergeConfig({ ...readConfig(), ...(args || {}) }).config;
          persistConfig(merged);
          if (args.omniEndpoint) manager.setEndpoint(merged.omniEndpoint);
          return merged;
        }
        case "reset":
          persistConfig({ ...DEFAULT_CONFIG });
          return { ...DEFAULT_CONFIG };
        case "omni-status":
          return manager.status();
        case "omni-install":
          manager.install().catch(() => {});
          return manager.status();
        case "omni-start":
          await manager.start();
          return manager.status();
        case "omni-stop":
          await manager.stop();
          return manager.status();
        case "omni-uninstall":
          await manager.uninstall();
          return manager.status();
        default:
          throw new Error(`未知设置动作：${action}`);
      }
    });
  }

  // 思考软提醒。
  const nudge = createNudge({ getConfig: readConfig });

  // 给工具结果附加循环内提醒（高轮次 / 长间隔）。
  const guarded = (toolName, fn) => async (args) => {
    const result = await fn(args);
    nudge.observe(toolName);
    const notice = nudge.maybeNotice();
    if (notice) {
      if (typeof result === "string") return `${result}\n\n${notice}`;
      if (result && typeof result === "object" && result.type !== "image")
        result.notice = notice;
    }
    return result;
  };

  // 0) 打开设置控制台
  api.registerTool(
    {
      name: "settings",
      description:
        "在系统浏览器中打开本插件的设置控制台：调整感知后端与元素上限、一键安装并启动 OmniParser、设置思考提醒与各种默认参数。用户要求修改本插件配置/参数时调用。",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      hidden: false
    },
    async () => {
      const url = settingsServer.openConsole();
      return { opened: true, url };
    }
  );

  // 1) 环境自检：安装后先运行，失败项会给出修复建议
  api.registerTool(
    {
      name: "doctor",
      description:
        "安装后先运行本工具做环境自检：逐项验证操作系统、系统库加载、屏幕探针、UIA/PowerShell、Python、OmniParser 状态。首次使用或动作失败时先调用，失败项会给出修复建议。",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      hidden: false
    },
    guarded("doctor", async () => {
      const result = await runDoctor({
        loadNative: () => createKoffiNative(),
        detectPython: () => manager.detectPython(),
        getOmniStatus: () => manager.status()
      });
      return {
        ok: result.ok,
        report: formatDoctorReport(result),
        checks: result.checks
      };
    })
  );

  // 2) 截屏
  api.registerTool(
    {
      name: "screenshot",
      description:
        "截取当前整个屏幕并把图片直接提供给模型。用于观察整体布局，动作后再次调用以验证结果。",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      hidden: false
    },
    guarded("screenshot", async () => await driver.screenshot())
  );

  // 3) 元素侦察
  api.registerTool(
    {
      name: "inspect",
      description:
        "侦察当前屏幕的可交互元素，返回元素清单（编号/名称/角色/包围矩形）。点击前先调用本工具，再用 click 的 elementId 选择目标，坐标由系统给出，不要裸猜像素。需要视觉核对时令 annotate=true 获取带编号框的标注图。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          backend: {
            type: "string",
            enum: ["auto", "uia", "omniparser"],
            description: "缺省取设置；auto=UIA 优先、元素过少时回退 OmniParser"
          },
          annotate: { type: "boolean", description: "true 返回带编号框的标注图" },
          clickableOnly: { type: "boolean", description: "OmniParser 下是否只保留可点元素" }
        }
      },
      hidden: false
    },
    guarded(
      "inspect",
      async (a) =>
        await driver.inspect({
          backend: a.backend,
          annotate: a.annotate === true,
          clickableOnly: a.clickableOnly
        })
    )
  );

  // 4) 点击
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
    guarded("click", async (a) => {
      const opts = { button: a.button ?? "left", double: a.double === true };
      if (a.elementId != null) opts.elementId = asInt(a.elementId, "elementId");
      else {
        opts.x = asInt(a.x, "x");
        opts.y = asInt(a.y, "y");
      }
      return await driver.clickTarget(opts);
    })
  );

  // 5) 移动
  api.registerTool(
    {
      name: "move",
      description: "把鼠标指针移动到屏幕坐标 (x,y)，不点击。",
      inputSchema: pointSchema(),
      hidden: false
    },
    guarded("move", async (a) => await driver.move(asInt(a.x, "x"), asInt(a.y, "y")))
  );

  // 6) 拖拽
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
    guarded(
      "drag",
      async (a) =>
        await driver.drag(
          asInt(a.from?.x, "from.x"),
          asInt(a.from?.y, "from.y"),
          asInt(a.to?.x, "to.x"),
          asInt(a.to?.y, "to.y"),
          a.button ?? "left"
        )
    )
  );

  // 7) 滚动（amount 缺省取设置 defaultScrollSteps）
  api.registerTool(
    {
      name: "scroll",
      description:
        "在坐标 (x,y) 处垂直滚动滚轮；amount 正向上、负向下，例如 3 或 -3。不传 amount 时使用设置中的默认滚动格数。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y"],
        properties: {
          x: { type: "integer" },
          y: { type: "integer" },
          amount: { type: "integer" }
        }
      },
      hidden: false
    },
    guarded(
      "scroll",
      async (a) => {
        const amount =
          a.amount != null ? asInt(a.amount, "amount") : readConfig().defaultScrollSteps;
        return await driver.scroll(asInt(a.x, "x"), asInt(a.y, "y"), amount);
      }
    )
  );

  // 8) 输入文本
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
    guarded("type", async (a) => {
      if (typeof a.text !== "string") throw new Error("type 需要 text 字符串");
      return await driver.type(a.text);
    })
  );

  // 9) 组合键
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
    guarded("key", async (a) => {
      if (typeof a.keys !== "string" || !a.keys.trim())
        throw new Error("key 需要 keys，例如 ctrl+c");
      return await driver.chord(a.keys);
    })
  );

  // 规则提示：每次用户消息求值，重置任务计数并注入思考预算。
  api.registerPrompt("computer_rules", () => {
    nudge.beginTask();
    const budget = nudge.prompt();
    return budget ? `${STATIC_RULES}\n\n${budget}` : STATIC_RULES;
  });

  // Skill：命中相关话题时自动加载。
  api.registerSkill(
    "skills/computer-use",
    /截屏|屏幕|桌面|点击|鼠标|键盘|打开软件|操作电脑|元素|设置|参数|computer/i
  );

  // 状态提示（动作仅 Windows 可真正执行）。
  if (process.platform !== "win32") {
    api.setStatus("已加载：动作仅可在 Windows 执行，设置控制台可用", "ready");
  } else {
    api.setStatus("已就绪");
  }

  // 若设置了开机自启且已安装，则后台拉起 OmniParser（不阻塞、失败静默）。
  if (initial.omniAutoStart && manager.status().hasWeights) {
    manager.start().catch(() => {});
  }

  return async () => {
    await settingsServer.stop().catch(() => {});
    await manager.stop().catch(() => {});
  };
}
