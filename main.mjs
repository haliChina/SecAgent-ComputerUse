// SecAgent Computer Use 插件入口。
// 由宿主动态 import 并调用 activate(api)。
import { WindowsDriver } from "./driver/win-driver.mjs";
import { createKoffiNative } from "./driver/win-driver.mjs";
import { runDoctor, formatDoctorReport } from "./driver/doctor.mjs";
import { listWindows, focusWindow, readClipboard, writeClipboard, launchApp } from "./driver/system-ops.mjs";
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
    x: { type: "integer", description: "相对本次截图左上角的 X 像素（坐标契约见 screenshot 返回）" },
    y: { type: "integer", description: "相对本次截图左上角的 Y 像素（坐标契约见 screenshot 返回）" },
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
- 坐标只有一套：所有 x,y 一律相对**本次截图**左上角，单位与模型看到的截图一致；系统已处理缩放与多显示器偏移，不要自己乘除或使用绝对屏幕坐标。
- 优先“元素地图”而非裸坐标：操作前先 inspect 获取可交互元素清单（编号/名称/角色），点击时给 click 传 elementId，坐标由系统给出，不要自行估计像素。
- 标准节奏：screenshot 观察整体 → inspect 拿到元素编号 → click(elementId) 或 type/key → 需要时 wait 等待界面响应 → 再 screenshot 验证，逐步推进。
- 需要视觉核对时用 inspect(annotate=true) 查看带编号框的标注图；界面一旦变化，元素地图即过期，需重新 inspect。
- 需要输入文字时，先按 elementId 点击输入框使其聚焦，再 type；需要快捷键时用 key。
- 要打开别的程序：优先 launch(command) 或 focus(title 窗口标题正则)，不要靠盲点任务栏图标。
- 若 UIA 元素过少（自绘界面、游戏、Canvas），在已启用 OmniParser 时用 inspect(backend="omniparser")；要看任务栏/桌面图标用 inspect(scope="desktop")。
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
        "截取当前整个屏幕（含多显示器）并把图片直接提供给模型，同时返回坐标契约说明（截图尺寸/物理分辨率/缩放系数/虚拟屏原点）。用于观察整体布局，动作后再次调用以验证结果。",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      hidden: false
    },
    guarded("screenshot", async () => await driver.screenshot())
  );

  // 2.1) 等待：动作之间给界面渲染留时间，避免“点了没反应就接着输入”
  api.registerTool(
    {
      name: "wait",
      description:
        "等待指定的毫秒数后再继续，用于界面加载/弹窗/网络请求。上限 10 秒。连续动作之间建议先 wait 300-800 毫秒。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ms: { type: "integer", description: "等待毫秒数，50-10000，默认 500" }
        }
      },
      hidden: false
    },
    guarded("wait", async (a) => {
      const ms = a.ms == null ? 500 : asInt(a.ms, "ms");
      const clamped = Math.min(10000, Math.max(50, ms));
      await new Promise((resolve) => setTimeout(resolve, clamped));
      return { waited: clamped };
    })
  );

  // 2.2) 读取鼠标位置：判断上一次点击是否真的落在目标上
  api.registerTool(
    {
      name: "cursor_position",
      description:
        "读取当前鼠标指针位置，返回本次截图坐标系下的 x,y 以及物理屏幕坐标。用于核对上一次点击/移动是否落在预期位置。",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      hidden: false
    },
    guarded("cursor_position", async () => await driver.cursorPosition())
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
          clickableOnly: { type: "boolean", description: "OmniParser 下是否只保留可点元素" },
          scope: {
            type: "string",
            enum: ["foreground", "desktop"],
            description:
              "UIA 侦察范围：foreground 只看前台窗口（默认，快）；desktop 从桌面根节点出发，可覆盖任务栏/桌面图标/后台窗口（慢、元素多）"
          }
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
          clickableOnly: a.clickableOnly,
          scope: a.scope
        })
    )
  );

  // 3.1) 窗口列表 / 聚焦 / 启动 / 剪贴板
  api.registerTool(
    {
      name: "windows",
      description: "列出当前所有可见顶层窗口（标题 + 进程号），用于定位目标程序。",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      hidden: false
    },
    guarded("windows", async () => {
      const list = await listWindows({ timeout: readConfig().uiaTimeoutMs });
      return { windows: list, count: list.length };
    })
  );

  api.registerTool(
    {
      name: "focus",
      description:
        "把焦点切到标题匹配正则的窗口（不区分大小写）。比盲点任务栏可靠；匹配不到会报错并附当前窗口列表。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: { title: { type: "string", description: "窗口标题正则，如 notepad|记事本" } }
      },
      hidden: false
    },
    guarded("focus", async (a) => {
      if (typeof a.title !== "string" || !a.title.trim())
        throw new Error("focus 需要非空 title（窗口标题正则）");
      return await focusWindow({ title: a.title, timeout: readConfig().uiaTimeoutMs });
    })
  );

  api.registerTool(
    {
      name: "launch",
      description:
        "启动应用（detached，不阻塞）。仅支持可执行文件（如 notepad、cmd、explorer）；打开文档/文件夹可用 explorer <路径>。例如 launch('notepad')。启动后建议 wait 再 screenshot。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: { type: "string", description: "可执行文件名或文件路径" },
          args: { type: "array", items: { type: "string" }, description: "可选参数" }
        }
      },
      hidden: false
    },
    guarded("launch", async (a) => {
      if (typeof a.command !== "string" || !a.command.trim())
        throw new Error("launch 需要非空 command");
      if (a.args != null && !Array.isArray(a.args))
        throw new Error("launch 的 args 必须是字符串数组");
      return launchApp({ command: a.command, args: a.args ?? [] });
    })
  );

  api.registerTool(
    {
      name: "clipboard",
      description:
        "读写剪贴板文本。action=read 读取，action=write 需带 text。默认在设置中禁用（剪贴板可能含密码等敏感信息），需用户显式开启。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["read", "write"] },
          text: { type: "string", description: "action=write 时必填" }
        }
      },
      hidden: false
    },
    guarded("clipboard", async (a) => {
      if (!readConfig().clipboardEnabled)
        throw new Error(
          "剪贴板功能当前关闭。如确需使用，请让用户在设置控制台开启「允许剪贴板读写」。"
        );
      if (a.action === "read") {
        const text = await readClipboard({ timeout: readConfig().uiaTimeoutMs });
        return { clipboard: text, length: text.length };
      }
      if (a.action === "write") {
        if (typeof a.text !== "string") throw new Error("clipboard write 需要 text 字符串");
        return await writeClipboard({ text: a.text, timeout: readConfig().uiaTimeoutMs });
      }
      throw new Error("clipboard 的 action 必须是 read 或 write");
    })
  );

  // 4) 点击
  api.registerTool(
    {
      name: "click",
      description:
        "点击目标。优先传 elementId（来自 inspect 的元素编号，坐标由系统给出，最准）；也可传 x,y 兜底（相对本次截图左上角）。可指定左右中键与双击。",
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
