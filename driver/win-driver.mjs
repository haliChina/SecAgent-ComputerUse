// Windows GUI 驱动：屏幕截图 + 鼠标 + 键盘。
//
// 架构：driver 只负责“编排”，所有真正的系统调用收敛到 native 原语层。
//   - 生产环境：createKoffiNative() 通过 koffi FFI 调 user32/gdi32（见文件底部）。
//   - 测试环境：注入 fake native，即可在非 Windows 上验证全部编排逻辑。
//
// 坐标约定：工具对外坐标一律是“相对截图左上角的物理像素”，driver 内部加上
// 多显示器虚拟原点，模型无需感知负坐标。
import { createRequire } from "node:module";
import { encodePNG } from "./png.mjs";
import { parseChord, isModifier } from "./keycodes.mjs";

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

// 需要扩展键标志的虚拟键码（方向键、导航簇、右 Ctrl/Alt 等）。
const EXTENDED_VKS = new Set([
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
  0x2d, 0x2e, 0x90, 0x2c, 0xa3, 0xa5, 0x6f
]);

const BUTTONS = {
  left: { down: MOUSEEVENTF.leftDown, up: MOUSEEVENTF.leftUp },
  right: { down: MOUSEEVENTF.rightDown, up: MOUSEEVENTF.rightUp },
  middle: { down: MOUSEEVENTF.middleDown, up: MOUSEEVENTF.middleUp }
};

export class WindowsDriver {
  /**
   * @param {object} opts
   * @param {ReturnType<typeof createKoffiNative>} [opts.native] 可注入的系统原语（测试用）
   */
  constructor({ native } = {}) {
    this.native = native; // 懒加载：首次使用时若为空则 createKoffiNative()
    this.origin = { x: 0, y: 0 };
  }

  async #ensureNative() {
    if (!this.native) this.native = createKoffiNative();
    return this.native;
  }

  // 在线程级 DPI 上下文中执行（PER_MONITOR_AWARE_V2，拿物理像素），结束恢复。
  // 关键：截图与鼠标动作处于同一上下文，坐标空间天然自洽，无需 DPI 换算。
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

  /** 截取整个虚拟屏幕（含多显示器）。 */
  async screenshot() {
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
      let memDC = null;
      let bitmap = null;
      let oldBitmap = null;
      try {
        memDC = n.createMemDC(screenDC);
        bitmap = n.createBitmap(screenDC, width, height);
        oldBitmap = n.selectObject(memDC, bitmap);
        const ok = n.bitBlt(memDC, width, height, screenDC, originX, originY);
        if (!ok) throw new Error("BitBlt 失败");

        const bits = Buffer.alloc(width * height * 4);
        const bi = n.allocBitmapInfo(width, height);
        const scanned = n.getDIBits(memDC, bitmap, height, bits, bi);
        if (scanned === 0) throw new Error("GetDIBits 未返回任何扫描行");

        // GetDIBits 32bpp 内存布局为 BGRA，交换 B/R 得到 RGBA（就地转换后再编码）。
        for (let i = 0; i < bits.length; i += 4) {
          const b = bits[i];
          bits[i] = bits[i + 2]; // B 位置 <- R
          bits[i + 2] = b; // R 位置 <- B
        }
        const png = encodePNG({ width, height, rgba: bits });
        return {
          type: "image",
          data: png.toString("base64"),
          mimeType: "image/png",
          name: "screen.png",
          width,
          height
        };
      } finally {
        if (memDC && oldBitmap) n.selectObject(memDC, oldBitmap);
        if (bitmap) n.deleteObject(bitmap);
        if (memDC) n.deleteDC(memDC);
        n.releaseDC(null, screenDC);
      }
    });
  }

  #toAbsolute(x, y) {
    return { x: x + this.origin.x, y: y + this.origin.y };
  }

  async move(x, y) {
    return await this.#withThreadDpi(() => {
      const p = this.#toAbsolute(x, y);
      this.native.setCursorPos(p.x, p.y);
      return { moved: { x, y } };
    });
  }

  /** 在 (x,y) 点击；double=true 时双击。 */
  async click(x, y, button = "left", double = false) {
    const b = BUTTONS[button];
    if (!b) throw new Error(`不支持的按键：${button}`);
    return await this.#withThreadDpi(() => {
      const p = this.#toAbsolute(x, y);
      this.native.setCursorPos(p.x, p.y);
      const clicks = double ? 2 : 1;
      for (let i = 0; i < clicks; i++) {
        this.native.mouseEvent(b.down, 0);
        this.native.mouseEvent(b.up, 0);
      }
      return { clicked: { x, y, button, double } };
    });
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

  /** 在 (x,y) 处垂直滚动；amount 正=向上，负=向下，单位为滚轮格。 */
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
      // 按下：修饰键（书写顺序）→ 主键；抬起：主键先抬，修饰键逆序抬。
      for (const vk of modifiers) press(vk);
      for (const vk of mains) press(vk);
      for (let i = mains.length - 1; i >= 0; i--) {
        const vk = mains[i];
        const ext = EXTENDED_VKS.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0;
        press(vk, KEYEVENTF_KEYUP);
      }
      for (let i = modifiers.length - 1; i >= 0; i--) {
        const vk = modifiers[i];
        press(vk, KEYEVENTF_KEYUP);
      }
      return { pressed: text };
    });
  }
}

// ---------------------------------------------------------------------------
// 生产实现：koffi FFI。仅在 Windows 真正调用系统 API 时加载。
// ---------------------------------------------------------------------------
export function createKoffiNative() {
  let koffi;
  try {
    koffi = createRequire(import.meta.url)("koffi");
  } catch {
    throw new Error(
      "缺少依赖 koffi。请重新安装本插件（发布包应包含 node_modules/koffi），或在插件目录执行 npm install。"
    );
  }
  const user32 = koffi.load("user32.dll");
  const gdi32 = koffi.load("gdi32.dll");

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

  // BITMAPINFOHEADER（top-down, 32bpp BI_RGB -> 内存布局 BGRA）。
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

  // 可选：线程级 DPI（Win10 1607+）。不可用时降级为继承进程上下文。
  let SetThreadDpiAwarenessContext = null;
  try {
    SetThreadDpiAwarenessContext = user32.func(
      "void* SetThreadDpiAwarenessContext(void* dpiContext)"
    );
  } catch {
    SetThreadDpiAwarenessContext = null;
  }
  const supportsThreadDpi = typeof SetThreadDpiAwarenessContext === "function";
  // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 是值为 -4 的伪句柄。
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
        biHeight: -h, // top-down
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
