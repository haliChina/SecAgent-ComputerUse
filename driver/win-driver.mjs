// Windows GUI 驱动：屏幕截图 + 元素侦察 + 鼠标 + 键盘。
//
// 架构：driver 只负责“编排”，真正的系统调用收敛到 native 原语层。
//   - 生产：createKoffiNative() 经 koffi FFI 调 user32/gdi32（文件底部）。
//   - 测试：注入 fake native / uiaRunner / fetchImpl，即可在非 Windows 验证全部逻辑。
//
// 坐标约定：
//   - 对外的 x,y 一律是“相对截图左上角的物理像素”，内部加虚拟原点；
//   - inspect 返回的元素 bbox/cx/cy 是“绝对物理坐标”，按 elementId 点击时直接使用。
import { createRequire } from "node:module";
import { encodePNG } from "./png.mjs";
import { parseChord, isModifier } from "./keycodes.mjs";
import { inspectViaUia } from "./uia-inspect.mjs";
import { buildElementMap, describeElements, findElement, DEFAULT_CAP } from "./element-map.mjs";
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
  0x2d, 0x2e, 0x90, 0x2c, 0xa3, 0xa5, 0x6f
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
   * @param {() => object} [opts.configProvider] 返回当前合并后设置；提供后每次调用动态读取，优先级高于固定字段
   */
  constructor({
    native, uiaRunner, omniEndpoint, fetchImpl,
    maxElements, minElements = 3,
    uiaTimeoutMs = 15000, clickableOnly = true,
    configProvider
  } = {}) {
    this.native = native;
    this.origin = { x: 0, y: 0 };
    this.uiaRunner = uiaRunner;
    this.omniEndpoint = omniEndpoint;
    this.fetchImpl = fetchImpl;
    this.maxElements = maxElements ?? DEFAULT_CAP;
    this.minElements = minElements;
    this.uiaTimeoutMs = uiaTimeoutMs;
    this.clickableOnly = clickableOnly;
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
      defaultScrollSteps: 3
    };
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
      n.setThreadDpi(previous);
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

  /** 截取整个虚拟屏幕，返回图片内容。 */
  async screenshot() {
    const c = await this.#capture();
    return toImageContent(encodePNG(c), "screen.png", c.width, c.height);
  }

  #toAbsolute(x, y) {
    return { x: x + this.origin.x, y: y + this.origin.y };
  }

  /**
   * 侦察当前屏幕的可交互元素（UIA 优先，OmniParser 兜底）。
   * @param {object} [opts]
   * @param {"auto"|"uia"|"omniparser"} [opts.backend] 缺省取设置 backend
   * @param {boolean} [opts.annotate=false] true 返回带编号框的 SoM 标注图，否则返回文本清单
   * @param {boolean} [opts.clickableOnly] 缺省取设置 clickableOnly
   */
  async inspect({ backend, annotate = false, clickableOnly } = {}) {
    const cfg = this.#cfg();
    const useBackend = backend ?? cfg.backend ?? "auto";
    const useClickable = clickableOnly ?? cfg.clickableOnly ?? true;
    const capture = await this.#capture();

    let map = null;
    if (useBackend === "uia" || useBackend === "auto") {
      let uiaRaw = [];
      try {
        uiaRaw = await inspectViaUia({
          runner: this.uiaRunner,
          timeout: cfg.uiaTimeoutMs
        });
      } catch {
        uiaRaw = [];
      }
      map = buildElementMap(uiaRaw, "uia", { cap: cfg.maxElements });
    }

    // 仅在显式启用 OmniParser 时提供该后端地址。
    const omniEndpoint = cfg.omniEnabled ? cfg.omniEndpoint : undefined;
    const needOmni =
      useBackend === "omniparser" ||
      (useBackend === "auto" && map && map.total < cfg.minElements && omniEndpoint);
    if (needOmni) {
      const imageBase64 = encodePNG(capture).toString("base64");
      const detections = await parseWithOmniParser({
        endpoint: omniEndpoint,
        imageBase64,
        fetchImpl: this.fetchImpl
      });
      const om = buildElementMap(detections, "omniparser", {
        cap: cfg.maxElements,
        clickableOnly: useClickable
      });
      if (useBackend === "omniparser" || (om.total > 0 && (!map || om.total > map.total)))
        map = om;
    }

    if (!map) map = buildElementMap([], "uia", { cap: cfg.maxElements });
    this.#lastMap = map;

    if (annotate) {
      const marked = drawSom(capture, map.elements, capture.origin);
      return toImageContent(encodePNG(marked), "elements.png", capture.width, capture.height);
    }
    return describeElements(map);
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
    return await this.#withThreadDpi(() => {
      const from = this.#toAbsolute(fromX, fromY);
      const to = this.#toAbsolute(toX, toY);
      this.native.setCursorPos(from.x, from.y);
      this.native.mouseEvent(b.down, 0);
      this.native.setCursorPos(to.x, to.y);
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

  /** 输入文本（支持中文等 Unicode，逐 UTF-16 code unit 发送）。 */
  async type(text) {
    if (typeof text !== "string") throw new Error("type 需要字符串");
    return await this.#withThreadDpi(() => {
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        this.native.keybdEvent(0, code, KEYEVENTF_UNICODE);
        this.native.keybdEvent(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
      }
      return { typed: { length: text.length } };
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
      for (const vk of modifiers) press(vk);
      for (const vk of mains) press(vk);
      for (let i = mains.length - 1; i >= 0; i--)
        press(mains[i], KEYEVENTF_KEYUP);
      for (let i = modifiers.length - 1; i >= 0; i--)
        press(modifiers[i], KEYEVENTF_KEYUP);
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

export function createKoffiNative() {
  let koffi;
  try {
    koffi = createRequire(import.meta.url)("koffi");
  } catch {
    throw new Error(
      "缺少依赖 koffi。请重新安装本插件（发布包应包含 node_modules/koffi），或在插件目录执行 npm install。"
    );
  }
  const user32 = loadSystemLib(koffi, "user32.dll");
  const gdi32 = loadSystemLib(koffi, "gdi32.dll");

  const GetDC = user32.func("void* GetDC(void* hWnd)");
  const ReleaseDC = user32.func("int ReleaseDC(void* hWnd, void* hDC)");
  const GetSystemMetrics = user32.func("int GetSystemMetrics(int nIndex)");
  const SetCursorPos = user32.func("bool SetCursorPos(int X, int Y)");
  const mouse_event = user32.func("void mouse_event(uint32 dwFlags, int dx, int dy, uint32 dwData, uintptr dwExtraInfo)");
  const keybd_event = user32.func("void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)");
  const MapVirtualKeyW = user32.func("uint32 MapVirtualKeyW(uint32 uCode, uint32 uMapType)");

  const CreateCompatibleDC = gdi32.func("void* CreateCompatibleDC(void* hdc)");
  const DeleteDC = gdi32.func("int DeleteDC(void* hdc)");
  const CreateCompatibleBitmap = gdi32.func("void* CreateCompatibleBitmap(void* hdc, int cx, int cy)");
  const SelectObject = gdi32.func("void* SelectObject(void* hdc, void* h)");
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

  let SetThreadDpiAwarenessContext = null;
  try {
    SetThreadDpiAwarenessContext = user32.func(
      "void* SetThreadDpiAwarenessContext(void* dpiContext)"
    );
  } catch {
    SetThreadDpiAwarenessContext = null;
  }
  const supportsThreadDpi = typeof SetThreadDpiAwarenessContext === "function";
  const dpiV2Handle = () => koffi.as(-4, "void*");

  return {
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
    allocBitmapInfo: (w, h) =>
      koffi.alloc(BitmapInfoHeader, {
        biSize: 40,
        biWidth: w,
        biHeight: -h,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0,
        biSizeImage: w * h * 4
      }),
    getDIBits: (dc, bmp, h, bits, bi) =>
      GetDIBits(dc, bmp, 0, h, bits, bi, DIB_RGB_COLORS),
    setCursorPos: (x, y) => SetCursorPos(x, y),
    mouseEvent: (flags, data) => mouse_event(flags, 0, 0, data, 0),
    keybdEvent: (vk, scan, flags) => keybd_event(vk, scan, flags, 0),
    mapVirtualKey: (vk) => MapVirtualKeyW(vk, 0)
  };
}
