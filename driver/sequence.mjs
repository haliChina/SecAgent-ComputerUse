/**
 * sequence：批动作编排（0.9.1，学习 dsh-pilot 的批处理设计）。
 *
 * 目标：把「点击→输入→回车→再点击」这类已确认的多步操作合成一次工具
 * 调用——模型与电脑的往返从 N 次降到 1 次，末尾统一回拍一张。适合
 * 「已经看清屏幕、剩下全是机械步骤」的场景；每步之间不需要新观察。
 *
 * 设计（对齐 dsh-pilot 的安全模型，适配我们的动作面）：
 * - 步骤只收核心动作：click/move/drag/scroll/act/type/key/wait(ms)。
 *   focus/launch/inspect 这类需要观察或本身就是观察的，不进批。
 * - 风险声明：risk low(默认)/medium/high；medium/high 必须带 confirm:true
 *   才会执行。自动升级：act 的 setValue/clear 会把批次升到 medium
 *   （覆写内容=不可逆一类）。
 * - dryRun:true 只校验并列出计划，不碰桌面。
 * - stopOnError 默认 true：一步失败立即停（宁可少做，不做错位动作）。
 * - settleMs 每步可选（默认 0），批末回拍前另有 settleMs（默认 750）。
 * - 上限：maxSequenceSteps 默认 24（配置可调）。
 *
 * 本模块纯逻辑（exec 由调用方注入），tests/sequence.test.mjs 不依赖驱动。
 */

export const SEQUENCE_ACTIONS = ["click", "move", "drag", "scroll", "act", "type", "key", "wait"];

/** act 里会覆写内容的 action——自动升 medium。 */
const ACT_DESTRUCTIVE = new Set(["setValue", "clear"]);

const RISK_LEVEL = { low: 0, medium: 1, high: 2 };

function clampInt(value, name, min, max, fallback) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`sequence 步骤字段 ${name} 需为 ${min}-${max} 的整数`);
  return n;
}

/**
 * 校验并规整 sequence 请求。
 * @returns {{ steps: Array<object>, risk: "low"|"medium"|"high", autoUpgraded: string|null,
 *            stopOnError: boolean, capture: "end"|"none", endSettleMs: number }}
 * @throws {Error} 任何校验失败（工具层转 structuredError INVALID_SEQUENCE）
 */
export function validateSequenceRequest(request, config = {}) {
  if (!request || typeof request !== "object") throw new Error("sequence 需要 steps 数组");
  const raw = request.steps;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("sequence steps 不能为空");
  const maxSteps = clampInt(config.maxSequenceSteps, "maxSequenceSteps", 1, 64, 24);
  if (raw.length > maxSteps) throw new Error(`sequence 步骤数 ${raw.length} 超过上限 ${maxSteps}（可在设置调整）`);

  const declared = request.risk ?? "low";
  if (!(declared in RISK_LEVEL)) throw new Error(`risk 必须是 low|medium|high，收到 ${JSON.stringify(declared)}`);
  let risk = declared;
  let autoUpgraded = null;

  const steps = raw.map((step, index) => {
    if (!step || typeof step !== "object") throw new Error(`步骤 ${index + 1} 必须是对象`);
    const action = step.action;
    if (!SEQUENCE_ACTIONS.includes(action))
      throw new Error(`步骤 ${index + 1} 的 action 必须是 ${SEQUENCE_ACTIONS.join("/")} 之一，收到 ${JSON.stringify(action)}`);
    const out = { action, settleMs: clampInt(step.settleMs, "settleMs", 0, 5000, 0) };
    if (step.note != null) {
      if (typeof step.note !== "string" || step.note.length > 80)
        throw new Error(`步骤 ${index + 1} 的 note 需为不超过 80 字符的说明`);
      out.note = step.note;
    }
    // 每种动作的必填/透传字段校验（宽松：详细校验交给对应工具逻辑，这里挡明显错位）。
    if (action === "click") {
      if (step.elementId == null && (step.x == null || step.y == null))
        throw new Error(`步骤 ${index + 1} click 需要 elementId 或 x,y`);
      for (const key of ["elementId", "x", "y"]) if (step[key] != null) out[key] = step[key];
      if (step.button) out.button = step.button;
      if (step.double != null) out.double = step.double === true;
    } else if (action === "move" || action === "scroll") {
      if (step.x == null || step.y == null) throw new Error(`步骤 ${index + 1} ${action} 需要 x,y`);
      out.x = step.x; out.y = step.y;
      if (action === "scroll" && step.amount != null) out.amount = step.amount;
    } else if (action === "drag") {
      if (!step.from || !step.to) throw new Error(`步骤 ${index + 1} drag 需要 from{x,y} 与 to{x,y}`);
      out.from = step.from; out.to = step.to;
      if (step.button) out.button = step.button;
    } else if (action === "act") {
      /* 注意字段名：step.action 是步骤类型（"act"），act 的子动作在 actAction。 */
      if (step.elementId == null || !step.actAction)
        throw new Error(`步骤 ${index + 1} act 需要 elementId 与 actAction（invoke/toggle/expand/select/setValue）`);
      out.elementId = step.elementId; out.actAction = step.actAction;
      if (step.value != null) out.value = step.value;
      if (ACT_DESTRUCTIVE.has(step.actAction) && RISK_LEVEL[risk] < RISK_LEVEL.medium) {
        risk = "medium"; autoUpgraded = `步骤 ${index + 1} act ${step.actAction} 覆写内容`;
      }
    } else if (action === "type") {
      if (typeof step.text !== "string" || !step.text) throw new Error(`步骤 ${index + 1} type 需要非空 text`);
      out.text = step.text;
    } else if (action === "key") {
      if (typeof step.keys !== "string" || !step.keys.trim()) throw new Error(`步骤 ${index + 1} key 需要 keys，如 ctrl+s`);
      out.keys = step.keys;
    } else if (action === "wait") {
      out.ms = clampInt(step.ms, "ms", 50, 10000, 500);
    }
    return out;
  });

  if ((request.capture ?? "end") !== "end" && request.capture !== "none")
    throw new Error(`capture 必须是 end|none，收到 ${JSON.stringify(request.capture)}`);

  return {
    steps,
    risk,
    autoUpgraded,
    stopOnError: request.stopOnError !== false,
    capture: request.capture ?? "end",
    endSettleMs: clampInt(request.settleMs, "settleMs", 0, 5000, 750)
  };
}

/** 批次风险等级是否达到 medium/high（调用方据此要求 confirm:true）。 */
export function sequenceNeedsConfirm(plan) {
  return RISK_LEVEL[plan.risk] >= RISK_LEVEL.medium;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 执行已规整的计划。exec(action, step) 由调用方注入（映射到驱动各方法）。
 * 返回逐步结果；stopOnError 时失败即停，附 remainingSteps。
 */
export async function runSequence(plan, exec) {
  const results = [];
  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i];
    const started = Date.now();
    let outcome;
    try {
      outcome = { ok: true, detail: await exec(step.action, step) };
    } catch (error) {
      outcome = { ok: false, error: String(error?.message ?? error) };
    }
    const entry = {
      step: i + 1, action: step.action, note: step.note ?? null,
      ok: outcome.ok, durationMs: Date.now() - started
    };
    if (outcome.ok) {
      if (outcome.detail !== undefined && outcome.detail !== null) entry.detail = outcome.detail;
    } else entry.error = outcome.error;
    results.push(entry);
    if (step.settleMs > 0) await sleep(step.settleMs);
    if (!outcome.ok && plan.stopOnError) {
      entry.stoppedHere = true;
      entry.remainingSteps = plan.steps.length - (i + 1);
      break;
    }
  }
  return results;
}
