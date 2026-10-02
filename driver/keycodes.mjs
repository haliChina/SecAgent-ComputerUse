// Windows 虚拟键码（Virtual-Key Codes）与组合键解析。
// 供 keybd_event 使用。键名统一转小写匹配。

export const VK = {
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  shift: 0x10,
  control: 0x11,
  ctrl: 0x11,
  alt: 0x12,
  menu: 0x12,
  pause: 0x13,
  capslock: 0x14,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  printscreen: 0x2c,
  insert: 0x2d,
  delete: 0x2e,
  del: 0x2e,
  win: 0x5b,
  meta: 0x5b,
  super: 0x5b,
  cmd: 0x5b,
  numlock: 0x90,
  scrolllock: 0x91,
  lshift: 0xa0,
  rshift: 0xa1,
  lcontrol: 0xa2,
  lctrl: 0xa2,
  rcontrol: 0xa3,
  rctrl: 0xa3,
  lalt: 0xa4,
  ralt: 0xa5
};

for (let i = 1; i <= 12; i++) VK[`f${i}`] = 0x6f + i; // F1=0x70 ... F12=0x7B

// 修饰键虚拟键码集合（用于判断按下/抬起顺序）。
const MODIFIER_VKS = new Set([
  VK.shift, VK.control, VK.alt, VK.win,
  VK.lshift, VK.rshift, VK.lcontrol, VK.rcontrol, VK.lalt, VK.alt
]);

export function isModifier(vk) {
  return MODIFIER_VKS.has(vk);
}

function singleKey(name) {
  if (VK[name] !== undefined) return VK[name];
  if (name.length === 1) {
    const code = name.charCodeAt(0);
    // 0-9 -> 0x30..0x39；a-z -> 0x41..0x5A（大写 ASCII 即 VK）
    if (code >= 48 && code <= 57) return code;
    const upper = name.toUpperCase().charCodeAt(0);
    if (upper >= 65 && upper <= 90) return upper;
  }
  throw new Error(`未知按键：${name}`);
}

/**
 * 解析组合键字符串，如 "ctrl+c"、"alt+tab"、"ctrl+shift+esc"、"enter"。
 * @param {string} text
 * @returns {number[]} 虚拟键码数组（保持用户书写顺序）
 */
export function parseChord(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("组合键不能为空");
  const parts = text.split("+").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) throw new Error("组合键格式非法");
  return parts.map(singleKey);
}
