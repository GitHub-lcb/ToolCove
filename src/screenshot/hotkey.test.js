import { describe, expect, it } from "vitest";
import { acceleratorFromEvent, acceleratorParts, normalizeMainKey } from "./hotkey.js";

const event = (code, modifiers = {}) => ({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...modifiers });

describe("normalizeMainKey", () => {
  it("接受 F1-F24、字母、主键盘与数字小键盘", () => {
    expect(normalizeMainKey("F1")).toBe("F1");
    expect(normalizeMainKey("F24")).toBe("F24");
    expect(normalizeMainKey("KeyS")).toBe("S");
    expect(normalizeMainKey("Digit5")).toBe("5");
    expect(normalizeMainKey("Numpad7")).toBe("Num7");
  });

  it("拒绝 F25 与不可绑定的键（空格/Esc/Enter）", () => {
    expect(normalizeMainKey("F25")).toBe("");
    expect(normalizeMainKey("Space")).toBe("");
    expect(normalizeMainKey("Escape")).toBe("");
    expect(normalizeMainKey("Enter")).toBe("");
    expect(normalizeMainKey("ControlLeft")).toBe("");
  });
});

describe("acceleratorFromEvent", () => {
  it("裸功能键不带修饰前缀", () => {
    expect(acceleratorFromEvent(event("F1"))).toBe("F1");
    expect(acceleratorFromEvent(event("F3"))).toBe("F3");
  });

  it("修饰键顺序固定为 Ctrl+Shift+Alt", () => {
    expect(acceleratorFromEvent(event("KeyS", { shiftKey: true, ctrlKey: true }))).toBe("Ctrl+Shift+S");
    expect(acceleratorFromEvent(event("Digit1", { altKey: true }))).toBe("Alt+1");
  });

  it("Meta（Win 键）与 Ctrl 视为同一路", () => {
    expect(acceleratorFromEvent(event("KeyA", { metaKey: true }))).toBe("Ctrl+A");
  });

  it("纯修饰键 / 不可绑定键返回空串（继续等待）", () => {
    expect(acceleratorFromEvent(event("ControlLeft", { ctrlKey: true }))).toBe("");
    expect(acceleratorFromEvent(event("Space"))).toBe("");
  });
});

describe("acceleratorParts", () => {
  it("按 + 拆分并去空", () => {
    expect(acceleratorParts("Ctrl+Shift+S")).toEqual(["Ctrl", "Shift", "S"]);
    expect(acceleratorParts("F1")).toEqual(["F1"]);
    expect(acceleratorParts("")).toEqual([]);
    expect(acceleratorParts(null)).toEqual([]);
  });
});
