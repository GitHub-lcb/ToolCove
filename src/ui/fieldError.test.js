// v-field-error 的接线测试：不引 jsdom（本仓单测只跑 node），用只实现用到的那几个方法的最小 DOM 替身。
// 测的是**这条关联到底接没接对**——写错的表现是读屏里"这个框无效"却听不到错在哪，界面上完全看不出来。
import { describe, it, expect } from "vitest";
import { vFieldError } from "./fieldError.js";

/** 造一个 `<label>` 宿主：control 与 note 都按选择器规则可查；sibling 用于"错误句子在 label 外面紧跟一行"的写法 */
function stubField({ control = null, notes = [], sibling = null } = {}) {
  const el = {
    nextElementSibling: sibling,
    querySelector(sel) {
      for (const part of sel.split(",").map((s) => s.trim())) {
        if (control && matches(control, part)) return control;
        for (const n of notes) if (matches(n, part)) return n;
      }
      return null;
    },
  };
  return el;
}

function matches(node, sel) {
  if (sel.startsWith(".")) return (node.classes || []).includes(sel.slice(1));
  if (sel.startsWith("[")) return node.attrs?.has(sel.slice(1, -1));
  if (sel.includes(":not(")) {
    const [tag, neg] = [sel.slice(0, sel.indexOf(":")), /:not\(\[([^\]]+)\]\)/.exec(sel)[1]];
    if (node.tag !== tag) return false;
    const [k, v] = neg.includes("=") ? neg.split("=") : [neg, null];
    return !(String(node.attrs?.get(k) ?? "") === String(v ?? "").replace(/^"|"$/g, ""));
  }
  return node.tag === sel;
}

function stubNode({ tag, classes = [], id = "", attrs = new Map() }) {
  return {
    tag,
    classes,
    id,
    attrs,
    setAttribute(k, v) { attrs.set(k, v); },
    getAttribute(k) { return attrs.get(k) ?? null; },
    removeAttribute(k) { attrs.delete(k); },
    matches(sel) {
      return sel.split(",").some((part) => matches(this, part.trim()));
    },
  };
}

describe("v-field-error", () => {
  it("有错误句时：控件标上 aria-invalid，并把 describedby 指到那句自己的 id", () => {
    const control = stubNode({ tag: "input" });
    const note = stubNode({ tag: "span", classes: ["field-err"] });
    const el = stubField({ control, notes: [note] });

    vFieldError.mounted(el, { value: "必须填集合名" });

    expect(control.getAttribute("aria-invalid")).toBe("true");
    expect(note.id).toMatch(/^tc-field-err-\d+$/);
    expect(control.getAttribute("aria-describedby")).toBe(note.id);
  });

  it("错误句已有 id 时不覆盖，直接复用（视图可能自己钉过锚点）", () => {
    const control = stubNode({ tag: "input" });
    const note = stubNode({ tag: "span", classes: ["m-field-err"], id: "err-key" });
    vFieldError.mounted(stubField({ control, notes: [note] }), { value: "错" });
    expect(note.id).toBe("err-key");
    expect(control.getAttribute("aria-describedby")).toBe("err-key");
  });

  it("错误消失（msg 变空）必须把两个属性摘掉，否则读屏一直报无效", () => {
    const control = stubNode({ tag: "textarea" });
    const note = stubNode({ tag: "p", classes: ["field-err"] });
    const el = stubField({ control, notes: [note] });
    vFieldError.mounted(el, { value: "错了" });
    expect(control.getAttribute("aria-invalid")).toBe("true");

    vFieldError.updated(el, { value: "" });
    expect(control.getAttribute("aria-invalid")).toBe(null);
    expect(control.getAttribute("aria-describedby")).toBe(null);
  });

  it("找不到错误句时只写 aria-invalid，不指向一个不存在的 id", () => {
    const control = stubNode({ tag: "select" });
    const el = stubField({ control, notes: [] });
    vFieldError.mounted(el, { value: "错了但没有可见句子" });
    expect(control.getAttribute("aria-invalid")).toBe("true");
    expect(control.getAttribute("aria-describedby")).toBe(null);
  });

  it("宿主里没有控件时什么都不做（纯提示条也挂了指令属于误用）", () => {
    const note = stubNode({ tag: "span", classes: ["field-err"] });
    vFieldError.mounted(stubField({ control: null, notes: [note] }), { value: "x" });
    expect(note.id).toBe("");
  });

  it("hidden 输入框不是可关联的控件（避免把 aria 挂在它身上）", () => {
    const control = stubNode({ tag: "input", attrs: new Map([["type", "hidden"]]) });
    const note = stubNode({ tag: "span", classes: ["field-err"] });
    vFieldError.mounted(stubField({ control, notes: [note] }), { value: "x" });
    expect(control.getAttribute("aria-invalid")).toBe(null);
  });

  it("两个字段各自的 id 不重复（复制粘贴是这类实现最常见的错）", () => {
    const a = stubNode({ tag: "input" });
    const b = stubNode({ tag: "input" });
    const na = stubNode({ tag: "span", classes: ["field-err"] });
    const nb = stubNode({ tag: "span", classes: ["field-err"] });
    vFieldError.mounted(stubField({ control: a, notes: [na] }), { value: "A 错" });
    vFieldError.mounted(stubField({ control: b, notes: [nb] }), { value: "B 错" });
    expect(na.id).not.toBe(nb.id);
    expect(a.getAttribute("aria-describedby")).toBe(na.id);
    expect(b.getAttribute("aria-describedby")).toBe(nb.id);
  });

  it("错误句子紧跟在 label 之后（手机照片配置的写法）也认，但只认紧邻的下一个兄弟", () => {
    const control = stubNode({ tag: "input" });
    const note = stubNode({ tag: "p", classes: ["m-field-err"] });
    vFieldError.mounted(stubField({ control, notes: [], sibling: note }), { value: "AccessKey 必填" });
    expect(control.getAttribute("aria-describedby")).toBe(note.id);
    expect(note.id).toMatch(/^tc-field-err-\d+$/);

    // 紧邻兄弟不是错误句时，不许越过它去找远处的那句：宁可不关联，也不指错句子
    const other = stubNode({ tag: "input" });
    const hint = stubNode({ tag: "p", classes: ["m-hint-sm"] });
    vFieldError.mounted(stubField({ control: other, notes: [], sibling: hint }), { value: "x" });
    expect(other.getAttribute("aria-invalid")).toBe("true");
    expect(other.getAttribute("aria-describedby")).toBe(null);
    expect(hint.id).toBe("");
  });

  it("卸载时摘掉关联，不给后来复用的节点留下指向已删 id 的 describedby", () => {
    const control = stubNode({ tag: "input" });
    const note = stubNode({ tag: "span", classes: ["field-err"] });
    const el = stubField({ control, notes: [note] });
    vFieldError.mounted(el, { value: "错" });
    vFieldError.unmounted(el);
    expect(control.getAttribute("aria-describedby")).toBe(null);
    expect(control.getAttribute("aria-invalid")).toBe(null);
  });
});
