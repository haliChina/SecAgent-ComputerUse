// 环境自检（doctor）：安装后第一时间运行，逐项验证动作链路，
// 失败项直接给出修复建议。所有外部依赖均可注入，单元测试无需 Windows。
import { inspectViaUia } from "./uia-inspect.mjs";

// GetSystemMetrics 索引：虚拟屏幕宽高
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

/**
 * @param {object} deps
 * @param {string} [deps.platform] 默认 process.platform（测试可注入）
 * @param {() => object} [deps.loadNative] 加载 koffi native（生产用 createKoffiNative）
 * @param {(encoded:string,timeout:number)=>Promise} [deps.uiaRunner] UIA 探针 runner（缺省走真实 PowerShell）
 * @param {number} [deps.uiaTimeoutMs=8000] UIA 探针超时
 * @param {() => Promise<{prefix:string[],version:string}|null>} [deps.detectPython]
 * @param {() => object} [deps.getOmniStatus]
 * @returns {Promise<{ok:boolean, checks:Array, failed:Array<string>}>}
 */
export async function runDoctor(deps = {}) {
  const {
    platform = process.platform,
    loadNative = null,
    uiaRunner = undefined,
    uiaTimeoutMs = 8000,
    detectPython = null,
    getOmniStatus = null
  } = deps;

  const checks = [];
  const push = (id, label, ok, detail = "", fix = "", optional = false) =>
    checks.push({ id, label, ok: !!ok, detail, fix, optional: !!optional });

  // 1) 操作系统
  const isWin = platform === "win32";
  push(
    "platform",
    "操作系统",
    isWin,
    isWin ? "Windows，动作链路可用" : `当前平台为 ${platform}：截屏 / 点击 / 键盘等动作仅 Windows 可执行`,
    isWin ? "" : "请在 Windows 电脑上安装使用；设置控制台在任意平台均可打开。"
  );

  // 2) 系统库加载（koffi FFI）
  let native = null;
  if (typeof loadNative === "function") {
    try {
      native = loadNative();
      push("native", "系统库加载", true, "已加载 user32.dll / gdi32.dll（koffi FFI）");
    } catch (error) {
      push(
        "native",
        "系统库加载",
        false,
        error?.message ?? String(error),
        "请确认：1）在 Windows 上运行；2）使用官方发布包安装（内含 node_modules/koffi）。仍失败请重装插件。"
      );
    }
  } else {
    push("native", "系统库加载", false, "未注入 loadNative", "");
  }

  // 3) FFI 端到端探针：读虚拟屏幕尺寸（不动鼠标、不截屏，最轻量）
  if (native && typeof native.metrics === "function") {
    try {
      const w = native.metrics(SM_CXVIRTUALSCREEN);
      const h = native.metrics(SM_CYVIRTUALSCREEN);
      const ok = Number(w) > 0 && Number(h) > 0;
      push(
        "screen",
        "屏幕探针（FFI 端到端）",
        ok,
        ok ? `虚拟屏幕 ${w}×${h}` : `读取到非法尺寸 ${w}×${h}`,
        ok ? "" : "FFI 调用返回异常，请重装插件或检查系统库是否被拦截。"
      );
    } catch (error) {
      push(
        "screen",
        "屏幕探针（FFI 端到端）",
        false,
        error?.message ?? String(error),
        "FFI 调用异常：请重装插件；若有杀毒软件，请将其加入白名单后重试。"
      );
    }
  } else {
    push("screen", "屏幕探针（FFI 端到端）", false, "系统库未加载，跳过", "");
  }

  // 4) UIA / PowerShell 探针
  try {
    const { elements } = await inspectViaUia({ runner: uiaRunner, timeout: uiaTimeoutMs });
    push(
      "uia",
      "UIA 元素侦察",
      true,
      `PowerShell 可用，前台窗口找到 ${elements.length} 个元素`
    );
  } catch (error) {
    const msg = error?.message ?? String(error);
    const missing = /not recognized|not found|ENOENT|spawn/i.test(msg);
    push(
      "uia",
      "UIA 元素侦察",
      false,
      msg,
      missing
        ? "未找到 PowerShell：请确认在 Windows 上运行。"
        : "PowerShell 执行失败：请确认未被杀毒软件拦截，必要时以管理员身份重试一次。"
    );
  }

  // 5) Python（OmniParser 可选）
  if (typeof detectPython === "function") {
    try {
      const py = await detectPython();
      push(
        "python",
        "Python（OmniParser 可选）",
        !!py && !py.tooNew && !!py.prefix,
        py ? (py.tooNew ? `检测到 Python ${py.version}（依赖只支持到 3.12）` : `检测到 Python ${py.version}`) : "未检测到 Python 3.10~3.12",
        py ? (py.tooNew ? "OmniParser 依赖（numpy==1.26.4）只有 3.9~3.12 的预编译包：winget install Python.Python.3.11 后重试。" : "") : "如需 OmniParser 视觉兜底：在设置控制台一键安装，或先运行 winget install Python.Python.3.11。",
        true
      );
    } catch (error) {
      push("python", "Python（OmniParser 可选）", false, error?.message ?? String(error), "");
    }
  }

  // 6) OmniParser 服务状态
  if (typeof getOmniStatus === "function") {
    try {
      const st = getOmniStatus() || {};
      const ok = st.phase === "running" || st.phase === "installed";
      push(
        "omniparser",
        "OmniParser 服务",
        ok,
        `状态：${st.phase ?? "unknown"}${st.endpoint ? `（${st.endpoint}）` : ""}`,
        ok ? "" : "在设置控制台一键安装并启动，或填写你自建服务的地址。",
        true
      );
    } catch (error) {
      push("omniparser", "OmniParser 服务", false, error?.message ?? String(error), "");
    }
  }

  const requiredFailed = checks.filter((c) => !c.ok && !c.optional).map((c) => c.id);
  const optionalFailed = checks.filter((c) => !c.ok && c.optional).map((c) => c.id);
  return { ok: requiredFailed.length === 0, checks, failed: requiredFailed, warnings: optionalFailed };
}

/** 供模型阅读的文本报告：逐项结果 + 失败项修复建议。 */
export function formatDoctorReport(result) {
  const lines = result.checks.map((c) => {
    const icon = c.ok ? "✅" : c.optional ? "⚠️" : "❌";
    return `${icon} ${c.label}：${c.detail}${!c.ok && c.fix ? `\n   ↳ ${c.fix}` : ""}`;
  });
  const head = result.ok
    ? result.warnings.length
      ? "自检通过（核心链路正常），以下为可选组件提醒："
      : "自检全部通过，可以开始干活。"
    : `自检发现 ${result.failed.length} 项问题，按 ↳ 提示修复后重新运行 doctor。`;
  lines.unshift(head);
  return lines.join("\n");
}
