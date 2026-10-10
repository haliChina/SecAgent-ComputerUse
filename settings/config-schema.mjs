// 设置参数的单一事实源：字段定义、默认值、校验、合并。
// 控制台页面、设置服务、WindowsDriver 与思考软提醒都从这里取参数。

export const SETTING_GROUPS = [
  { id: "perception", title: "感知（元素地图）", description: "inspect 如何列出界面元素。" },
  { id: "omniparser", title: "本地视觉兜底（OmniParser）", description: "UIA 覆盖不到时的本地视觉模型，可一键安装。" },
  { id: "reasoning", title: "思考提醒", description: "模型思考过久或反复横跳时，温和提醒其收敛。" },
  { id: "actions", title: "动作", description: "点击、滚动等操作的默认行为。" },
  { id: "safety", title: "安全", description: "高风险动作的行为约束。" }
];

// effect:
//   immediate = driver / 后端真正读取并立即生效
//   guidance = 通过提示词 / Skill 引导模型行为（纯插件无法在引擎层强制）
export const SETTING_FIELDS = [
  // —— 感知 ——
  { key: "backend", group: "perception", type: "select", default: "auto",
    options: [
      { value: "auto", label: "自动（UIA 优先，不足回退 OmniParser）" },
      { value: "uia", label: "仅 UIA（Windows 系统控件）" },
      { value: "omniparser", label: "仅 OmniParser（视觉模型）" }
    ],
    label: "感知后端", effect: "immediate" },
  { key: "maxElements", group: "perception", type: "number", default: 60, min: 5, max: 200, step: 1,
    label: "元素数量上限", hint: "超过后截断，避免一次塞入过多元素。", effect: "immediate" },
  { key: "clickableOnly", group: "perception", type: "boolean", default: true,
    label: "只列出可交互元素", hint: "关闭后会包含文本/容器等更多节点。", effect: "immediate" },
  { key: "uiaTimeoutMs", group: "perception", type: "number", default: 15000, min: 3000, max: 60000, step: 1000,
    label: "UIA 查询超时（毫秒）", effect: "immediate" },
  { key: "minElements", group: "perception", type: "number", default: 3, min: 0, max: 20, step: 1,
    label: "自动回退阈值", hint: "UIA 元素少于该数量时回退 OmniParser。", effect: "immediate" },
  { key: "maxSidePixels", group: "perception", type: "number", default: 1568, min: 0, max: 4096, step: 8,
    label: "截图长边上限 / 模型坐标分辨率（像素）",
    hint: "0 = 不缩放。默认值 1568 与 Claude computer-use 一致。若主模型是坐标接地模型（UI-TARS、OSWorld 系 grounding 模型等），请把它设成该模型输出的坐标分辨率（如 1920×1080），落点最稳。系统会在执行前自动换算回物理像素。",
    effect: "immediate" },
  { key: "uiaScope", group: "perception", type: "select", default: "foreground",
    options: [
      { value: "foreground", label: "仅前台窗口（快、准）" },
      { value: "desktop", label: "整个桌面（含任务栏/桌面图标，慢）" }
    ],
    label: "UIA 侦察范围", effect: "immediate" },

  // —— OmniParser ——
  { key: "omniEnabled", group: "omniparser", type: "boolean", default: false,
    label: "启用 OmniParser 兜底", hint: "需要先在下方一键安装，或填写已运行的服务地址。", effect: "immediate" },
  { key: "omniEndpoint", group: "omniparser", type: "string", default: "http://127.0.0.1:8000",
    label: "OmniParser 服务地址", hint: "一键安装会自动填写；也可指向你自己部署的服务。", effect: "immediate" },
  { key: "omniAutoStart", group: "omniparser", type: "boolean", default: false,
    label: "SecAgent 启动时自动拉起服务", hint: "已安装后生效，会在后台启动本地服务。", effect: "immediate" },
  { key: "hfMirror", group: "omniparser", type: "string", default: "",
    label: "HuggingFace 镜像", hint: "可选。权重默认先走魔搭（modelscope.cn，国内直连），失败再试此处镜像，最后官方源；部分网络 hf-mirror.com 不可达，留空即可。", effect: "immediate" },
  { key: "pipIndexUrl", group: "omniparser", type: "string", default: "",
    label: "pip 镜像源", hint: "国内安装依赖缓慢时填写，如 https://pypi.tuna.tsinghua.edu.cn/simple；留空使用官方源。", effect: "immediate" },

  // —— 思考提醒 ——
  { key: "nudgeEnabled", group: "reasoning", type: "boolean", default: true,
    label: "启用思考提醒", hint: "通过提示词引导模型控制思考预算；属温和提醒，不强制中断。", effect: "immediate" },
  { key: "thinkBudgetSec", group: "reasoning", type: "number", default: 90, min: 10, max: 600, step: 5,
    label: "思考时间预算（秒）", hint: "超过后在下一轮加强提醒。", effect: "guidance" },
  { key: "maxRounds", group: "reasoning", type: "number", default: 12, min: 3, max: 40, step: 1,
    label: "单任务最大动作轮次", hint: "超过后提醒收敛或向用户说明卡点。", effect: "immediate" },
  { key: "nudgeMode", group: "reasoning", type: "select", default: "remind",
    options: [
      { value: "remind", label: "仅温和提醒（当前可用）" },
      { value: "escalate", label: "提醒并自动降低思考力度（需宿主更新）" },
      { value: "switch", label: "仍卡住则切换模型（需宿主更新）" }
    ],
    label: "卡住后的处理", effect: "guidance" },
  { key: "nudgeText", group: "reasoning", type: "string", default: "请尽快结束推理，直接给出下一步动作或结论，不要反复权衡。",
    label: "提醒文案", effect: "immediate" },

  // —— 动作 ——
  { key: "autoInspect", group: "actions", type: "boolean", default: true,
    label: "点击前先 inspect 定位", effect: "guidance" },
  { key: "verifyAfterAction", group: "actions", type: "boolean", default: true,
    label: "动作后截图验证", effect: "guidance" },
  { key: "defaultScrollSteps", group: "actions", type: "number", default: 3, min: 1, max: 10, step: 1,
    label: "默认滚动格数", effect: "immediate" },

  // —— 安全 ——
  { key: "confirmDestructive", group: "safety", type: "boolean", default: true,
    label: "对不可逆/高风险动作先确认", hint: "如删除、提交、支付、发送等。宿主侧工具守卫会对高风险输入键入/组合键做硬拦截，本项是提示词层面的补充。", effect: "guidance" },
  { key: "clipboardEnabled", group: "safety", type: "boolean", default: false,
    label: "允许剪贴板读写",
    hint: "默认关闭。剪贴板可能含密码、验证码、令牌，开启后模型可读取，属于敏感能力，请确认环境可控再打开。",
    effect: "immediate" }
];

export const DEFAULT_CONFIG = Object.freeze(
  SETTING_FIELDS.reduce((acc, field) => {
    acc[field.key] = field.default;
    return acc;
  }, {})
);

const FIELD_BY_KEY = new Map(SETTING_FIELDS.map((field) => [field.key, field]));

function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function coerceNumber(field, value) {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return undefined;
  const clamped = Math.min(field.max ?? num, Math.max(field.min ?? num, num));
  return field.step === 1 ? Math.round(clamped) : clamped;
}

function coerceString(field, value) {
  if (typeof value !== "string") return undefined;
  const isUrlField = field.key === "omniEndpoint" || field.key === "hfMirror" || field.key === "pipIndexUrl";
  const text = isUrlField ? value.trim().replace(/\/+$/, "") : value.trim();
  if (isUrlField && text !== "") {
    try {
      const url = new URL(text);
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    } catch {
      return undefined;
    }
  }
  return text;
}

/** 校验并归一化单个字段；非法值回退到提供的 fallback（默认字段默认值）。 */
export function normalizeField(key, value, fallback) {
  const field = FIELD_BY_KEY.get(key);
  if (!field) return undefined;
  const fallbackValue = fallback ?? field.default;
  if (value === undefined || value === null || value === "") return fallbackValue;
  let normalized;
  if (field.type === "boolean") normalized = coerceBoolean(value);
  else if (field.type === "number") normalized = coerceNumber(field, value);
  else if (field.type === "select") {
    normalized = field.options.some((option) => option.value === value) ? value : undefined;
  } else normalized = coerceString(field, value);
  return normalized === undefined ? fallbackValue : normalized;
}

/**
 * 合并用户配置与默认值，丢弃未知键、裁剪非法值。
 * 返回 { config, dropped: [被修正的 key] }。
 */
export function mergeConfig(userConfig) {
  const config = { ...DEFAULT_CONFIG };
  const dropped = [];
  if (userConfig && typeof userConfig === "object" && !Array.isArray(userConfig)) {
    for (const [key, value] of Object.entries(userConfig)) {
      if (!FIELD_BY_KEY.has(key)) continue;
      const normalized = normalizeField(key, value);
      if (normalized !== config[key] && (value !== normalized)) dropped.push(key);
      config[key] = normalized;
    }
  }
  return { config, dropped };
}

export function fieldFor(key) {
  return FIELD_BY_KEY.get(key);
}

/** 供设置页一次性渲染的字段描述（含分组）。 */
export function describeSettings() {
  return SETTING_GROUPS.map((group) => ({
    ...group,
    fields: SETTING_FIELDS.filter((field) => field.group === group.id)
  }));
}
