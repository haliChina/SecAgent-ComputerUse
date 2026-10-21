// Windows GUI 驱动：屏幕截图 + 元素侦察 + 鼠标 + 键盘。
//
// 架构：driver 只负责“编排”，真正的系统调用收敛到 native 原语层。
//   - 生产：createKoffiNative() 经 koffi FFI 调 user32/gdi32（文件底部）。
//   - 测试：注入 fake native / uiaRunner / fetchImpl，即可在非 Windows 验证全部逻辑。
//
// 坐标约定（对外契约，唯一一套）：
//   - 模型看到的截图可能被缩放（长边上限 maxSidePixels），因此所有工具的 x,y
//     一律是“相对截图左上角、单位与模型看到的截图像素一致”的 display 坐标；
//   - 内部一律换算回物理绝对坐标（display / scale + 虚拟原点）再调系统 API；
//   - inspect 列出的元素 bbox 同样是 display 坐标，按 elementId 点击时直接用
//     内部保存的绝对中心点，模型全程不接触物理坐标。
import { createRequire } from "node:module";
import { encodePNG } from "./png.mjs";
import { computeScale, scaleImage } from "./scale.mjs";
import { parseChord, isModifier } from "./keycodes.mjs";
import { inspectViaUia } from "./uia-inspect.mjs";
import { elementToPhysical, withinVirtualScreen } from "./ext-coords.mjs";
import { buildElementMap, describeElements, findElement, toDisplayMap, DEFAULT_CAP } from "./element-map.mjs";
import { parseWithOmniParser } from "./omniparser.mjs";
import { drawSom } from "./draw-som.mjs";

// ---- Win32 常量 ----
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const SRCCOPY = 0x00cc0020;
const DIB_RGB_COLORS = 0;

const MOUSEEVENTF = {
  leftDown: 0x0002, leftUp: 0x0004,
  rightDown: 0x0008, rightUp: 0x0010,
  middleDown: 0x0020, middleUp: 0x0040,
  wheel: 0x0800
};
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const WHEEL_DELTA = 120;

const EXTENDED_VKS = new Set([
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
  0x2d, 0x2e, 0x90, 0x2c, 0xa3, 0xa5, 0x6f,
  // 左/右 Win 键与 Apps 键按 Win32 规范也是扩展键，win+d / win+e 不带标志会不生效
  0x5b, 0x5c, 0x5d
]);

const BUTTONS = {
  left: { down: MOUSEEVENTF.leftDown, up: MOUSEEVENTF.leftUp },
  right: { down: MOUSEEVENTF.rightDown, up: MOUSEEVENTF.rightUp },
  middle: { down: MOUSEEVENTF.middleDown, up: MOUSEEVENTF.middleUp }
};

function toImageContent(pngBuffer, name, width, height) {
  return {
    type: "image",
    data: pngBuffer.toString("base64"),
    mimeType: "image/png",
    name, width, height
  };
}

export class WindowsDriver {
  /**
   * @param {object} opts
   * @param {ReturnType<typeof createKoffiNative>} [opts.native]
   * @param {Function} [opts.uiaRunner] 注入的 UIA PowerShell runner（测试用）
   * @param {string} [opts.omniEndpoint] OmniParser 服务地址（固定值，无 configProvider 时用）
   * @param {Function} [opts.fetchImpl] 注入 fetch（测试用）
   * @param {number} [opts.maxElements] 元素地图最多列出的数量
   * @param {number} [opts.minElements=3] auto 模式下 UIA 少于该数则尝试 OmniParser
   * @param {number} [opts.uiaTimeoutMs=15000] UIA 查询超时
   * @param {boolean} [opts.clickableOnly=true] OmniParser 是否只保留可点元素
   * @param {number} [opts.maxSidePixels=0] 截图长边上限（0 = 不缩放），模型可见坐标空间
   * @param {() => object} [opts.configProvider] 返回当前合并后设置；提供后每次调用动态读取，优先级高于固定字段
   */
  constructor({
    native, uiaRunner, omniEndpoint, fetchImpl,
    maxElements, minElements = 3,
    uiaTimeoutMs = 15000, clickableOnly = true,
    maxSidePixels = 0,
    configProvider,
    extBridge = null
  } = {}) {
    this.native = native;
    this.origin = { x: 0, y: 0 };
    this.scale = 1;
    this.uiaRunner = uiaRunner;
    this.omniEndpoint = omniEndpoint;
    this.fetchImpl = fetchImpl;
    this.extBridge = extBridge;
    this.maxElements = maxElements ?? DEFAULT_CAP;
    this.minElements = minElements;
    this.uiaTimeoutMs = uiaTimeoutMs;
    this.clickableOnly = clickableOnly;
    this.maxSidePixels = maxSidePixels;
    this.configProvider = typeof configProvider === "function" ? configProvider : null;
    this.#lastMap = { elements: [], total: 0, truncated: false, source: "uia" };
  }

  #lastMap;

  /** 当前生效设置：优先 configProvider，否则回退构造时的固定字段。 */
  #cfg() {
    if (this.configProvider) return this.configProvider();
    return {
      backend: "auto",
      maxElements: this.maxElements,
      minElements: this.minElements,
      clickableOnly: this.clickableOnly,
      uiaTimeoutMs: this.uiaTimeoutMs,
      omniEnabled: !!this.omniEndpoint,
      omniEndpoint: this.omniEndpoint,
      maxSidePixels: this.maxSidePixels,
      defaultScrollSteps: 3
    };
  }

  /** 按设置把物理截图缩放到模型友好尺寸，并记录换算系数。 */
  #prepareImage(capture) {
    const cfg = this.#cfg();
    this.scale = computeScale(capture.width, capture.height, Number(cfg.maxSidePixels) || 0);
    return scaleImage(capture, this.scale);
  }

  /** 几何说明文本：模型据此知道该用哪套坐标系。 */
  #geometryText(image, physical) {
    const s = this.scale;
    const parts = [
      `截图（模型所见）${image.width}x${image.height}`,
      `物理分辨率 ${physical.width}x${physical.height}`
    ];
    if (s !== 1) parts.push(`缩放系数 scale=${s.toFixed(4)}（系统自动换算，不要自己乘除）`);
    if (this.origin.x || this.origin.y)
      parts.push(`虚拟屏原点 ${this.origin.x},${this.origin.y}（多显示器，已归一到截图内）`);
    return `坐标契约：所有 x,y 一律相对本截图左上角 (0,0)，单位与上面这张图一致。${parts.join("；")}。`;
  }

  async #ensureNative() {
    if (!this.native) this.native = createKoffiNative();
    return this.native;
  }

  // 线程级 DPI 上下文（PER_MONITOR_AWARE_V2），截图与动作同一上下文、坐标自洽。
  async #withThreadDpi(fn) {
    const n = await this.#ensureNative();
    if (!n.supportsThreadDpi) return await fn();
    const previous = n.setThreadDpi(n.dpiV2Handle());
    try {
      return await fn();
    } finally {
      // 返回 0/NULL 表示 V2 上下文设置失败，线程 DPI 未变，无需恢复
      if (previous) n.setThreadDpi(previous);
    }
  }

  /** 捕获整个虚拟屏幕，返回原始 RGBA（含多显示器）。 */
  async #capture() {
    return await this.#withThreadDpi(async () => {
      const n = this.native;
      const originX = n.metrics(SM_XVIRTUALSCREEN);
      const originY = n.metrics(SM_YVIRTUALSCREEN);
      const width = n.metrics(SM_CXVIRTUALSCREEN);
      const height = n.metrics(SM_CYVIRTUALSCREEN);
      if (width <= 0 || height <= 0) throw new Error("无法获取屏幕尺寸");
      this.origin = { x: originX, y: originY };

      const screenDC = n.getDC(null);
      if (!screenDC) throw new Error("GetDC 失败");
      let memDC = null, bitmap = null, oldBitmap = null;
      try {
        memDC = n.createMemDC(screenDC);
        bitmap = n.createBitmap(screenDC, width, height);
        oldBitmap = n.selectObject(memDC, bitmap);
        const ok = n.bitBlt(memDC, width, height, screenDC, originX, originY);
        if (!ok) throw new Error("BitBlt 失败");

        const rgba = Buffer.alloc(width * height * 4);
        const bi = n.allocBitmapInfo(width, height);
        const scanned = n.getDIBits(memDC, bitmap, height, rgba, bi);
        if (scanned === 0) throw new Error("GetDIBits 未返回扫描行");

        // 32bpp 内存布局 BGRA，交换 B/R 得 RGBA（就地转换）。
        for (let i = 0; i < rgba.length; i += 4) {
          const b = rgba[i];
          rgba[i] = rgba[i + 2];
          rgba[i + 2] = b;
        }
        return { width, height, rgba, origin: { x: originX, y: originY } };
      } finally {
        if (memDC && oldBitmap) n.selectObject(memDC, oldBitmap);
        if (bitmap) n.deleteObject(bitmap);
        if (memDC) n.deleteDC(memDC);
        n.releaseDC(null, screenDC);
      }
    });
  }

  /** 截取整个虚拟屏幕，返回图片 + 坐标契约说明。 */
  async screenshot() {
    const c = await this.#capture();
    const image = this.#prepareImage(c);
    return [
      toImageContent(encodePNG(image), "screen.png", image.width, image.height),
      { type: "text", text: this.#geometryText(image, c) }
    ];
  }

  /** 读取当前鼠标指针位置（display 坐标 + 物理屏幕坐标）。 */
  async cursorPosition() {
    return await this.#withThreadDpi(async () => {
      const n = await this.#ensureNative();
      if (typeof n.cursorPos !== "function")
        throw new Error("当前系统库不支持读取光标位置（缺少 GetCursorPos）。");
      const p = n.cursorPos();
      const s = this.scale === 1 ? 1 : this.scale;
      return {
        x: Math.round((p.x - this.origin.x) * s),
        y: Math.round((p.y - this.origin.y) * s),
        screenX: p.x,
        screenY: p.y
      };
    });
  }

  #toAbsolute(x, y) {
    const s = this.scale === 1 ? 1 : this.scale;
    return { x: x / s + this.origin.x, y: y / s + this.origin.y };
  }

  /**
   * 侦察当前屏幕的可交互元素（UIA 优先，浏览器扩展 / OmniParser 兜底）。
   * @param {object} [opts]
   * @param {"auto"|"uia"|"omniparser"|"extension"} [opts.backend] 缺省取设置 backend
   * @param {boolean} [opts.annotate=false] true 返回带编号框的 SoM 标注图，否则返回文本清单
   * @param {boolean} [opts.clickableOnly] 缺省取设置 clickableOnly
   * @param {number} [opts.tabId] 目标标签页（仅 extension 后端；缺省取最近聚焦的浏览器标签页）
   */
  async inspect({ backend, annotate = false, clickableOnly, scope, tabId } = {}) {
    const cfg = this.#cfg();
    const useBackend = backend ?? cfg.backend ?? "auto";
    const useClickable = clickableOnly ?? cfg.clickableOnly ?? true;
    const useScope = scope ?? cfg.uiaScope ?? "foreground";
    const capture = await this.#capture();
    const image = this.#prepareImage(capture);

    let map = null;
    let uiaError = null;
    let uiaFgPid = 0;
    if (useBackend === "uia" || useBackend === "auto") {
      let uiaRaw = [];
      try {
        const uia = await inspectViaUia({
          runner: this.uiaRunner,
          timeout: cfg.uiaTimeoutMs,
          scope: useScope
        });
        uiaRaw = uia.elements;
        uiaFgPid = uia.foregroundPid;
      } catch (error) {
        // 静默降级保持 auto 流程，但记下原因：最终空结果时要让模型知道
        // 「没检测到元素」是因为 UIA 挂了，而不是界面真没有可交互元素。
        uiaError = error;
        uiaRaw = [];
      }
      map = buildElementMap(uiaRaw, "uia", { cap: cfg.maxElements });
    }

    // 浏览器扩展（DOM）：显式点名直接用；auto 且 UIA 元素稀疏时先于
    // OmniParser 尝试（本地毫秒级 vs 视觉模型 20s+，网页场景 DOM 即真值）。
    let extError = null;
    let extTabInfo = null;
    const extConnected = !!this.extBridge && this.extBridge.status().connected;
    if (useBackend === "extension" && !this.extBridge)
      throw new Error("浏览器扩展桥未启用：请在设置控制台开启「浏览器扩展桥」并完成配对（见 docs/EXTENSION.md）。");
    const needExt =
      useBackend === "extension" || (useBackend === "auto" && map && map.total < cfg.minElements && extConnected);
    if (needExt) {
      try {
        const ext = await this.extBridge.collectElements({
          ...(tabId != null ? { tabId } : {}),
          max: cfg.extMaxElements ?? cfg.maxElements
        });
        extTabInfo = ext.tab ?? null;
        const viewport = { ...(ext.viewport ?? {}), zoom: ext.zoom ?? 1 };
        const virtual = { x: capture.origin.x, y: capture.origin.y, w: capture.width, h: capture.height };
        // DOM 元素 → 物理屏幕坐标；混合 DPI / 怪异窗口形态可能算飞，兜底过滤。
        const rawList = (ext.elements ?? [])
          .map((el) => ({ ...el, bbox: elementToPhysical(el, viewport) }))
          .filter((el) => withinVirtualScreen(el.bbox, virtual));
        const extMap = buildElementMap(rawList, "extension", { cap: cfg.maxElements });
        if (useBackend === "extension" || (extMap.total > 0 && (!map || extMap.total > map.total)))
          map = extMap;
      } catch (error) {
        // 与 OmniParser 同策略：auto 降级继续（UIA 结果还在），显式 extension 才抛。
        if (useBackend === "extension") throw error;
        extError = error;
      }
    }
    if (useBackend === "extension" && !extConnected && this.extBridge)
      throw new Error("浏览器扩展未连接：请确认扩展已安装并在配对页填入端口与配对码（设置控制台「浏览器扩展桥」卡片），或改用 backend=\"auto\"。");

    // 仅在显式启用 OmniParser 时提供该后端地址。
    const omniEndpoint = cfg.omniEnabled ? cfg.omniEndpoint : undefined;
    const needOmni =
      useBackend === "omniparser" ||
      (useBackend === "auto" && map && map.total < cfg.minElements && omniEndpoint);
    let omniError = null;
    if (needOmni) {
      const imageBase64 = encodePNG(capture).toString("base64");
      try {
        const detections = await parseWithOmniParser({
          endpoint: omniEndpoint,
          imageBase64,
          fetchImpl: this.fetchImpl,
          timeout: cfg.omniTimeoutMs
        });
        const om = buildElementMap(detections, "omniparser", {
          cap: cfg.maxElements,
          clickableOnly: useClickable
        });
        if (useBackend === "omniparser" || (om.total > 0 && (!map || om.total > map.total)))
          map = om;
      } catch (error) {
        // 0.5.x 实机：auto 模式下 OmniParser 超时会把 UIA 已拿到的结果一起丢掉，
        // 整个 inspect 抛错，模型退化成纯目测坐标、20 轮耗尽任务。
        // 现在：auto 降级用 UIA 结果继续；显式 omniparser 才抛（模型点名要它，静默换后端反而误导）。
        if (useBackend === "omniparser") throw error;
        omniError = error;
      }
    }

    if (!map) map = buildElementMap([], "uia", { cap: cfg.maxElements });
    this.#lastMap = map;

    // 对模型一律输出 display 坐标；点击仍用 map 里保存的物理绝对坐标。
    const displayMap = toDisplayMap(map, { origin: capture.origin, scale: this.scale });
    const geometry = {
      origin: capture.origin,
      scale: this.scale,
      displayWidth: image.width,
      displayHeight: image.height
    };
    // UIA 挂了且最终没有元素：明确告知原因与出路，别让模型猜「界面没有元素」
    const warning =
      (uiaError && map.total === 0 && useBackend !== "omniparser" && useBackend !== "extension"
        ? `\n⚠ UIA 侦察失败：${uiaError?.message ?? String(uiaError)}。` +
          `目标可能是自绘 UI/游戏，或权限不足（管理员窗口需提权）。` +
          `可运行 doctor 自检，或在设置控制台启用 OmniParser 后用 backend="omniparser" 重试。`
        : "") +
      (extError
        ? `\n⚠ 浏览器扩展兜底未生效（auto 模式已降级为 UIA 结果）：${extError.message}。`
        : "") +
      (omniError
        ? `\n⚠ OmniParser 兜底未生效（auto 模式已降级为 UIA 结果）：${omniError.message}。` +
          `界面为自绘 UI 时元素可能偏少，坐标请配合 screenshot 目测交叉核对。`
        : "");
    // 扩展元素来自某个标签页：把标签页上下文写给模型（点错窗口/标签是高频翻车点）。
    const tabLine =
      extTabInfo && map.source === "extension"
        ? `\n📎 元素来自标签页「${(extTabInfo.title || "").slice(0, 60)}」（${(extTabInfo.url || "").slice(0, 100)}）。` +
          `若这不是你想操作的页面，先用 tabs 工具切换标签页再重新 inspect。`
        : "";
    // 前台是宿主自身（0.5.4 实机踩坑：模型 focus 不到动态标题窗口，
    // 对着 SecAgent 自己的活动流点了 20+ 次）。此时仍返回元素（兼容
    // 自测场景），但醒目提示先 focus 目标窗口。
    const hostPids = new Set([process.pid, process.ppid].filter(Boolean));
    const selfWarning =
      uiaFgPid && hostPids.has(uiaFgPid)
        ? "\n⚠ 前台窗口是 SecAgent 宿主自身——你几乎一定是想操作别的应用。" +
          "请先用 focus 切换目标窗口（支持进程名正则，如 title:\"QQMusic\"，" +
          "适用于标题是动态内容的播放器等），成功后再重新 inspect；请勿点击本应用自身界面。"
        : "";

    if (annotate) {
      const marked = drawSom(image, displayMap.elements, { x: 0, y: 0 }, {
        scale: this.scale === 1 ? 2 : Math.max(1, Math.round(2 * this.scale))
      });
      return [
        toImageContent(encodePNG(marked), "elements.png", marked.width, marked.height),
        {
          type: "text",
          text:
            selfWarning +
            tabLine +
            "\n" +
            this.#geometryText(image, capture) +
            "\n框内数字即元素编号，点击时用 click(elementId)。元素清单：\n" +
            describeElements(displayMap, geometry) +
            warning
        }
      ];
    }
    const text = selfWarning + tabLine + describeElements(displayMap, geometry);
    return warning || tabLine ? text + (warning || "") : text;
  }

  async move(x, y) {
    return await this.#withThreadDpi(() => {
      const p = this.#toAbsolute(x, y);
      this.native.setCursorPos(p.x, p.y);
      return { moved: { x, y } };
    });
  }

  /**
   * 点击：优先按 elementId（坐标取自元素 bbox 中心），否则用相对坐标 x,y。
   * @param {object} target
   * @param {number} [target.elementId]
   * @param {number} [target.x]
   * @param {number} [target.y]
   * @param {"left"|"right"|"middle"} [target.button="left"]
   * @param {boolean} [target.double=false]
   */
  async clickTarget({ elementId, x, y, button = "left", double = false } = {}) {
    const b = BUTTONS[button];
    if (!b) throw new Error(`不支持的按键：${button}`);

    let abs, label;
    if (elementId != null) {
      const el = findElement(this.#lastMap.elements, elementId);
      if (!el)
        throw new Error(`元素 #${elementId} 不存在或地图已过期，请先调用 inspect。`);
      abs = { x: el.cx, y: el.cy };
      label = { elementId, name: el.name };
    } else {
      if (x == null || y == null)
        throw new Error("click 需要提供 elementId，或相对坐标 x,y");
      abs = this.#toAbsolute(x, y);
      label = { x, y };
    }

    await this.#withThreadDpi(() => {
      this.native.setCursorPos(abs.x, abs.y);
      const clicks = double ? 2 : 1;
      for (let i = 0; i < clicks; i++) {
        this.native.mouseEvent(b.down, 0);
        this.native.mouseEvent(b.up, 0);
      }
    });
    // 落点视觉标记（#12）：默认开，设置可关；旧 native/测试桩无此方法时跳过。
    if (this.#cfg().clickFlash !== false && typeof this.native.flashMarker === "function") {
      try { this.native.flashMarker(abs.x, abs.y); } catch { /* 无碍 */ }
    }
    return { clicked: { ...label, button, double } };
  }

  /** 兼容接口：在相对坐标 (x,y) 点击。 */
  async click(x, y, button = "left", double = false) {
    return this.clickTarget({ x, y, button, double });
  }

  /** 从一个点拖拽到另一个点。 */
  async drag(fromX, fromY, toX, toY, button = "left") {
    const b = BUTTONS[button];
    if (!b) throw new Error(`不支持的按键：${button}`);
    return await this.#withThreadDpi(async () => {
      const from = this.#toAbsolute(fromX, fromY);
      const to = this.#toAbsolute(toX, toY);
      this.native.setCursorPos(from.x, from.y);
      this.native.mouseEvent(b.down, 0);
      // 分步移动：SetCursorPos 一步跳转不产生 mouse-move 事件流，
      // Web 拖放（dragover/drop）与依赖轨迹的窗口会丢事件导致拖拽失败。
      // 短距离（<80px）保持单步，与旧行为一致。
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      const steps = Math.max(1, Math.min(15, Math.ceil(dist / 80)));
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        this.native.setCursorPos(
          Math.round(from.x + (to.x - from.x) * t),
          Math.round(from.y + (to.y - from.y) * t)
        );
        if (i < steps) await new Promise((resolve) => setTimeout(resolve, 8));
      }
      this.native.mouseEvent(b.up, 0);
      return { dragged: { from: { x: fromX, y: fromY }, to: { x: toX, y: toY } } };
    });
  }

  /** 在 (x,y) 处垂直滚动；amount 正=向上，负=向下，单位滚轮格。 */
  async scroll(x, y, amount) {
    const n = amount | 0;
    if (!n) throw new Error("滚动量不能为 0");
    return await this.#withThreadDpi(() => {
      const p = this.#toAbsolute(x, y);
      this.native.setCursorPos(p.x, p.y);
      this.native.mouseEvent(MOUSEEVENTF.wheel, n * WHEEL_DELTA);
      return { scrolled: { x, y, amount: n } };
    });
  }

  /**
   * 输入文本（支持中文等全部 Unicode，逐 UTF-16 code unit 发送，含代理对两半）。
   *
   * 0.7.1 根因修复（#12）：旧实现走 keybd_event，其 bScan 参数是 **8 位**，
   * ≥0x100 的 code unit（全部中文）被截断成低 8 位 → 应用收到乱码。
   * 现改走 SendInput（wScan 16 位），一次调用原子提交全部事件；
   * 注入被拒（UIPI，目标为管理员窗口）时给出明确报错而不是静默丢字。
   */
  async type(text) {
    if (typeof text !== "string") throw new Error("type 需要字符串");
    return await this.#withThreadDpi(() => {
      if (!text.length) return { typed: { length: 0 }, mode: "none" };

      if (typeof this.native.sendInputKeyboard === "function") {
        const events = [];
        for (let i = 0; i < text.length; i++) {
          const code = text.charCodeAt(i);
          events.push({ vk: 0, scan: code, flags: KEYEVENTF_UNICODE });
          events.push({ vk: 0, scan: code, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP });
        }
        const accepted = this.native.sendInputKeyboard(events);
        if (accepted < events.length)
          throw new Error(
            `SendInput 只接受了 ${accepted}/${events.length} 个事件——目标很可能是管理员权限窗口（UIPI 拦截）。` +
              `请用管理员身份重启 SecAgent，或改在普通权限窗口输入。`
          );
        return { typed: { length: text.length }, mode: "sendinput" };
      }

      // 兼容路径：旧 native（测试桩/极端环境）退回 keybd_event。
      // 注意该路径 ≥0x100 的字符会被 8 位 bScan 截断（历史已知限制）。
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        this.native.keybdEvent(0, code, KEYEVENTF_UNICODE);
        this.native.keybdEvent(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
      }
      return { typed: { length: text.length }, mode: "legacy" };
    });
  }

  /** 按组合键，如 "ctrl+c"、"alt+tab"、"enter"。 */
  async chord(text) {
    const vks = parseChord(text);
    return await this.#withThreadDpi(() => {
      const modifiers = vks.filter(isModifier);
      const mains = vks.filter((vk) => !isModifier(vk));
      if (!mains.length) throw new Error("组合键缺少主键（不能只有修饰键）");

      const press = (vk, flags = 0) => {
        const scan = this.native.mapVirtualKey(vk);
        const ext = EXTENDED_VKS.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0;
        this.native.keybdEvent(vk, scan, ext | flags);
      };
      // 中途异常也要释放修饰键，否则 ctrl 会一直卡在按下状态
      try {
        for (const vk of modifiers) press(vk);
        for (const vk of mains) press(vk);
        for (let i = mains.length - 1; i >= 0; i--)
          press(mains[i], KEYEVENTF_KEYUP);
      } finally {
        for (let i = modifiers.length - 1; i >= 0; i--)
          press(modifiers[i], KEYEVENTF_KEYUP);
      }
      return { pressed: text };
    });
  }
}

// ---------------------------------------------------------------------------
// 生产实现：koffi FFI。仅在 Windows 真正调用系统 API 时加载。
// ---------------------------------------------------------------------------
/** 加载 user32/gdi32 等系统库，失败时给出可操作的中文报错（而非 koffi 原始异常）。 */
function loadSystemLib(koffi, name) {
  try {
    return koffi.load(name);
  } catch (error) {
    throw new Error(
      `加载 Windows 系统库失败（${name}）：${error?.message ?? error}。请确认在 Windows 上运行，且插件为官方发布包（内含 node_modules/koffi/win32_x64）。`
    );
  }
}

/**
 * koffi 原生层工厂。**同进程必须幂等**：koffi 的具名类型（如 BITMAPINFOHEADER）
 * 在模块全局注册，第二次调用会抛 “Duplicate type name” —— doctor 与 driver
 * 是两条独立加载路径（doctor 每次 loadNative，driver 惰性 #ensureNative），
 * 无缓存时真实时序是：第一次 doctor 全绿，随后 screenshot/key/inspect 全部失败。
 * 因此缓存单例；koffiImpl 仅供测试注入 fake。
 */
let cachedKoffiNative = null;

export function createKoffiNative(koffiImpl) {
  if (cachedKoffiNative) return cachedKoffiNative;
  let koffi;
  if (koffiImpl) {
    koffi = koffiImpl;
  } else {
    try {
      koffi = createRequire(import.meta.url)("koffi");
    } catch {
      throw new Error(
        "缺少依赖 koffi。请重新安装本插件（发布包应包含 node_modules/koffi），或在插件目录执行 npm install。"
      );
    }
  }
  const user32 = loadSystemLib(koffi, "user32.dll");
  const gdi32 = loadSystemLib(koffi, "gdi32.dll");

  const GetDC = user32.func("void* GetDC(void* hWnd)");
  const ReleaseDC = user32.func("int ReleaseDC(void* hWnd, void* hDC)");
  const GetSystemMetrics = user32.func("int GetSystemMetrics(int nIndex)");
  const SetCursorPos = user32.func("bool SetCursorPos(int X, int Y)");
  const GetCursorPos = user32.func("bool GetCursorPos(void* lpPoint)");
  const mouse_event = user32.func("void mouse_event(uint32 dwFlags, int dx, int dy, uint32 dwData, uintptr dwExtraInfo)");
  const keybd_event = user32.func("void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)");
  const SendInput = user32.func("uint32 SendInput(uint32 cInputs, void* pInputs, int cbSize)");
  const MapVirtualKeyW = user32.func("uint32 MapVirtualKeyW(uint32 uCode, uint32 uMapType)");
  // 点击落点标记（#12）：画环 → 300ms 后只失效标记矩形让其自然消失。
  const InvalidateRect = user32.func("bool InvalidateRect(void* hWnd, void* lpRect, bool bErase)");

  const CreateCompatibleDC = gdi32.func("void* CreateCompatibleDC(void* hdc)");
  const DeleteDC = gdi32.func("int DeleteDC(void* hdc)");
  const CreateCompatibleBitmap = gdi32.func("void* CreateCompatibleBitmap(void* hdc, int cx, int cy)");
  const SelectObject = gdi32.func("void* SelectObject(void* hdc, void* h)");
  const CreatePen = gdi32.func("void* CreatePen(int iPenStyle, int cWidth, uint32 color)");
  const CreateSolidBrush = gdi32.func("void* CreateSolidBrush(uint32 color)");
  const GetStockObject = gdi32.func("void* GetStockObject(int i)");
  const Ellipse = gdi32.func("bool Ellipse(void* hdc, int left, int top, int right, int bottom)");
  const BitBlt = gdi32.func(
    "bool BitBlt(void* hdcDest, int x, int y, int w, int h, void* hdcSrc, int x1, int y1, uint32 rop)"
  );
  const DeleteObject = gdi32.func("bool DeleteObject(void* ho)");
  const GetDIBits = gdi32.func(
    "int GetDIBits(void* hdc, void* hbm, uint32 start, uint32 cLines, void* lpBits, void* lpbi, uint32 usage)"
  );

  const BitmapInfoHeader = koffi.struct("BITMAPINFOHEADER", {
    biSize: "uint32",
    biWidth: "int32",
    biHeight: "int32",
    biPlanes: "uint16",
    biBitCount: "uint16",
    biCompression: "uint32",
    biSizeImage: "uint32",
    biXPelsPerMeter: "int32",
    biYPelsPerMeter: "int32",
    biClrUsed: "uint32",
    biClrImportant: "uint32"
  });

  const PointStruct = koffi.struct("SA_POINT", { x: "int32", y: "int32" });
  const RectStruct = koffi.struct("SA_RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });

  // INPUT（键盘形态，Win64）：显式排布到与 WinUser.h 完全一致的字节布局。
  //   type@0(4) + 联合体对齐填充@4 + wVk@8 + wScan@10 + dwFlags@12 + time@16
  //   + 填充@20 + dwExtraInfo@24 + 联合体尾部填充到 sizeof(INPUT)=40。
  // 不用 koffi.union：MOUSEINPUT 是联合体最大成员（32B），显式 padding 更直
  // 接可控，且可在封送测试里逐偏移验证（koffi.offsetof / decode 按偏移读）。
  const InputStruct = koffi.struct("SA_INPUT", {
    type: "uint32",
    pad0: "uint32",
    wVk: "uint16",
    wScan: "uint16",
    dwFlags: "uint32",
    time: "uint32",
    pad1: "uint32",
    dwExtraInfo: "uintptr",
    tail: "uint32"
  });
  // SendInput 数组类型按长度缓存（koffi.array 是匿名类型，重复创建无注册
  // 冲突，但避免高频 type() 时反复建类型）。
  const inputArrayTypeCache = new Map();
  const inputArrayTypes = (n) => {
    let t = inputArrayTypeCache.get(n);
    if (!t) { t = koffi.array(InputStruct, n); inputArrayTypeCache.set(n, t); }
    return t;
  };

  let SetThreadDpiAwarenessContext = null;
  try {
    // DPI_AWARENESS_CONTEXT 是指针大小的伪句柄（-4 = PER_MONITOR_AWARE_V2）。
    // 不能声明 void* 再 koffi.as(-4, "void*")：koffi 2.16 的 as() 不接受负数，
    // 抛 "Invalid argument"——0.5.2 实机即此症状（doctor 只读 metrics 全绿，
    // screenshot 第一步 #withThreadDpi 就炸）。按 int64 封送可直接传 -4。
    SetThreadDpiAwarenessContext = user32.func(
      "int64 SetThreadDpiAwarenessContext(int64 dpiContext)"
    );
  } catch {
    SetThreadDpiAwarenessContext = null;
  }
  const supportsThreadDpi = typeof SetThreadDpiAwarenessContext === "function";
  const dpiV2Handle = () => -4;

  const native = {
    supportsThreadDpi,
    dpiV2Handle,
    setThreadDpi: (ctx) => SetThreadDpiAwarenessContext(ctx),
    metrics: (i) => GetSystemMetrics(i),
    getDC: (h) => GetDC(h),
    releaseDC: (h, dc) => ReleaseDC(h, dc),
    createMemDC: (dc) => CreateCompatibleDC(dc),
    deleteDC: (dc) => DeleteDC(dc),
    createBitmap: (dc, w, h) => CreateCompatibleBitmap(dc, w, h),
    selectObject: (dc, obj) => SelectObject(dc, obj),
    bitBlt: (dc, w, h, src, ox, oy) => BitBlt(dc, 0, 0, w, h, src, ox, oy, SRCCOPY),
    deleteObject: (o) => DeleteObject(o),
    allocBitmapInfo: (w, h) => {
      // koffi 2.16 的 alloc(type, length) 第二参是元素个数，不是初始值——
      // 旧写法 alloc(结构体, {对象}) 抛 "Unexpected Object value for length"。
      // 先分配再 encode 整个结构体。
      const bi = koffi.alloc(BitmapInfoHeader, 1);
      koffi.encode(bi, BitmapInfoHeader, {
        biSize: 40,
        biWidth: w,
        biHeight: -h,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0,
        biSizeImage: w * h * 4,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0
      });
      return bi;
    },
    getDIBits: (dc, bmp, h, bits, bi) =>
      GetDIBits(dc, bmp, 0, h, bits, bi, DIB_RGB_COLORS),
    setCursorPos: (x, y) => SetCursorPos(x, y),
    cursorPos: () => {
      // POINT { LONG x; LONG y; }——koffi 2.16：alloc(type, length) 分配，
      // 读标量用 decode(ptr, offset, "int32")；旧写法 alloc(8) 参数数都不对，
      // decode(p, koffi.pointer("int32"), 8) 则是按 int32* 数组解引用，语义全错。
      const point = koffi.alloc(PointStruct, 1);
      if (!GetCursorPos(point)) throw new Error("GetCursorPos 失败");
      return { x: koffi.decode(point, 0, "int32"), y: koffi.decode(point, 4, "int32") };
    },
    mouseEvent: (flags, data) => mouse_event(flags, 0, 0, data, 0),
    keybdEvent: (vk, scan, flags) => keybd_event(vk, scan, flags, 0),
    mapVirtualKey: (vk) => MapVirtualKeyW(vk, 0),
    /**
     * 批量注入键盘事件（SendInput，一次调用原子提交）。
     * 0.7.1 起用于 type 的 Unicode 输入：keybd_event 的 bScan 只有 8 位，
     * 中文等 ≥0x100 的 code unit 被截断成乱码；SendInput 的 wScan 是 16 位。
     * 封送：koffi.array(InputStruct, n) 匿名数组类型按长度缓存，encode 一次
     * 写整段，decode 按偏移回读已在 koffi-marshaling 测试逐字节验证。
     * @param {{vk:number,scan:number,flags:number}[]} events
     * @returns {number} 实际接受的事件数（<events.length 说明被 UIPI 拦截，
     *   典型场景：目标是管理员权限窗口而插件是普通权限）
     */
    sendInputKeyboard: (events) => {
      if (!events.length) return 0;
      const n = events.length;
      const arrType = inputArrayTypes(n);
      const ptr = koffi.alloc(arrType, 1);
      koffi.encode(ptr, arrType, events.map((e) => ({
        type: 1 /* INPUT_KEYBOARD */,
        pad0: 0,
        wVk: e.vk,
        wScan: e.scan,
        dwFlags: e.flags,
        time: 0,
        pad1: 0,
        dwExtraInfo: 0,
        tail: 0
      })));
      return SendInput(n, ptr, koffi.sizeof(InputStruct));
    },
    /**
     * 点击落点视觉标记（#12：让用户肉眼可循 Agent 的操作轨迹）。
     * 在屏幕 DC 画红环+红点 → 300ms 后只失效标记矩形（目标区域自然重绘
     * 抹掉标记）。全程 best-effort：任何失败静默（绝不影响点击本身）。
     * @param {number} x 物理绝对坐标
     * @param {number} y
     * @param {number} [radius=12] 环半径（物理像素）
     */
    flashMarker: (x, y, radius = 12) => {
      const PS_SOLID = 0;
      const NULL_BRUSH = 5;
      const RED = 0x000000ff; // COLORREF 0x00BBGGRR
      let dc = null, pen = null, brush = null, oldPen = null, oldBrush = null;
      try {
        dc = GetDC(null);
        if (!dc) return;
        const r = Math.max(4, radius | 0);
        // 环（空刷只描边）
        pen = CreatePen(PS_SOLID, 3, RED);
        if (pen) {
          oldPen = SelectObject(dc, pen);
          const nb = GetStockObject(NULL_BRUSH);
          if (nb) oldBrush = SelectObject(dc, nb);
          Ellipse(dc, x - r, y - r, x + r, y + r);
          if (nb && oldBrush) SelectObject(dc, oldBrush);
        }
        // 中心点（实心红）
        brush = CreateSolidBrush(RED);
        if (brush) {
          const ob = SelectObject(dc, brush);
          Ellipse(dc, x - 3, y - 3, x + 3, y + 3);
          if (ob) SelectObject(dc, ob);
        }
      } catch { /* 标记失败无碍 */ } finally {
        try { if (oldPen) SelectObject(dc, oldPen); } catch { /* ignore */ }
        try { if (pen) DeleteObject(pen); } catch { /* ignore */ }
        try { if (brush) DeleteObject(brush); } catch { /* ignore */ }
        try { if (dc) ReleaseDC(null, dc); } catch { /* ignore */ }
      }
      // 300ms 后失效标记矩形：底层窗口收到 WM_PAINT 自然抹掉标记，
      // 不整屏失效（避免闪烁）。
      const t = setTimeout(() => {
        try {
          const pad = (radius | 0) + 8;
          const rect = koffi.alloc(RectStruct, 1);
          koffi.encode(rect, RectStruct, { left: x - pad, top: y - pad, right: x + pad, bottom: y + pad });
          InvalidateRect(null, rect, true);
        } catch { /* ignore */ }
      }, 300);
      if (t.unref) t.unref();
    }
  };
  cachedKoffiNative = native;
  return native;
}

/** 测试专用：重置 koffi 单例（生产代码不得调用）。 */
export function resetKoffiNativeForTest() {
  cachedKoffiNative = null;
}
