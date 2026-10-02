// 思考软提醒（纯插件层可实现的最大程度）：
//   1) 任务开始时通过提示词注入“思考预算”（预防性）；
//   2) 动作轮次超限、或两次动作间隔过长（疑似卡思考）时，在工具结果里温和提醒。
// 真正“思考中硬中断 / 自动降档 / 切换模型”需要宿主核心层支持（见 nudgeMode 的 escalate/switch）。

export function createNudge({ getConfig, now } = {}) {
  const cfg = () => (typeof getConfig === "function" ? getConfig() : {});
  const nowMs = typeof now === "function" ? now : Date.now;

  let rounds = 0;
  let lastAt = 0;
  let slow = false;

  /** 新的用户消息 = 新任务，重置计数。 */
  function beginTask() {
    rounds = 0;
    slow = false;
    lastAt = nowMs();
  }

  /** 一次工具动作完成后调用。 */
  function observe() {
    const now = nowMs();
    const c = cfg();
    // 间隔含模型思考 + 上一个动作耗时，故阈值放宽到预算的 1.5 倍，减少误判。
    const budgetMs = (Number(c.thinkBudgetSec) || 90) * 1000;
    if (lastAt && now - lastAt > budgetMs * 1.5) slow = true;
    rounds += 1;
    lastAt = now;
  }

  /** 任务开始注入的思考预算提示；未启用时返回空串。 */
  function prompt() {
    const c = cfg();
    if (!c.nudgeEnabled) return "";
    const budget = Number(c.thinkBudgetSec) || 90;
    const maxR = Number(c.maxRounds) || 12;
    const text = c.nudgeText || "请尽快结束推理，直接给出下一步动作或结论，不要反复权衡。";
    return [
      "## 思考预算",
      `- 请把单次思考控制在约 ${budget} 秒内，单个任务的动作不超过 ${maxR} 轮。`,
      `- ${text}`,
      "- 信息足够就立即行动；不要在两个位置或方案之间反复横跳。"
    ].join("\n");
  }

  /**
   * 触发循环内提醒。
   * @returns {string|null} 提醒文本；返回 null 表示不提醒。
   */
  function maybeNotice() {
    const c = cfg();
    if (!c.nudgeEnabled) return null;
    const text = c.nudgeText || "请尽快结束推理，直接给出下一步动作或结论，不要反复权衡。";
    const maxR = Number(c.maxRounds) || 12;
    if (rounds >= maxR) {
      return `[思考提醒] 已进行 ${rounds} 个动作，达到设定的 ${maxR} 轮上限。${text} 若确实无法继续，请直接向用户说明卡点，不要继续反复权衡。`;
    }
    if (slow) {
      slow = false; // 仅提醒一次，避免刷屏
      return `[思考提醒] 刚才的思考耗时较长。${text}`;
    }
    return null;
  }

  function status() {
    return { rounds, slow };
  }

  return { beginTask, observe, prompt, maybeNotice, status };
}
