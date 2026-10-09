// 快捷键录入：KeyboardEvent → Tauri 加速器字符串（global-hotkey 语法，如 "F1" / "Ctrl+Shift+S"）。
// 用 e.code 而不是 e.key：不受键盘布局影响（中文输入法下 e.key 可能是"中"）。
// 只接受 F 键 / 字母 / 数字：空格、Esc、Enter 这类键做全局热键会把整台电脑的日常操作偷走，
// 前端直接拒绝，输入框里连显示都不显示。

const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;
const LETTER_KEY = /^Key[A-Z]$/;
const DIGIT_KEY = /^Digit[0-9]$/;
const NUMPAD_KEY = /^Numpad[0-9]$/;

/** 归一化主键；不是可绑定的键返回 "" */
export function normalizeMainKey(code) {
  const value = String(code || "");
  if (FUNCTION_KEY.test(value)) return value;
  if (LETTER_KEY.test(value)) return value.slice(3);
  if (DIGIT_KEY.test(value)) return value.slice(5);
  if (NUMPAD_KEY.test(value)) return `Num${value.slice(6)}`;
  return "";
}

/** 事件 → 加速器；返回 "" 表示这组按键不可绑定（含纯修饰键） */
export function acceleratorFromEvent(event) {
  const main = normalizeMainKey(event && event.code);
  if (!main) return "";
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  parts.push(main);
  return parts.join("+");
}

/** 展示用：把加速器拆成片段，UI 可分片渲染（不需要拆分时直接显示原串即可） */
export function acceleratorParts(accelerator) {
  return String(accelerator || "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
}
