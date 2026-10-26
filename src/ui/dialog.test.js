// v-dialog 的语义接线：不引 jsdom（本仓单测刻意只跑 node），
// 用一个只实现用到的那几个方法的最小 DOM 替身。
// 目的不是测浏览器行为，而是测**这段逻辑有没有把可访问名接到可见标题上**——
// 那是这条实现唯一容易写错的地方（写错的表现是读屏里弹窗没有名字，界面上完全看不出来）。
import { describe, it, expect, vi } from "vitest";
import { vDialog } from "./dialog.js";

function stubEl({ heading, focusables = [], prevFocus }) {
  const attrs = new Map();
  const el = {
    attrs,
    setAttribute(k, v) { attrs.set(k, v); },
    getAttribute(k) { return attrs.get(k) ?? null; },
    querySelector(sel) {
      if (sel.includes("h2") || sel.includes("h3")) return heading;
        return focusables[0] ?? null;
    },
  };
  globalThis.document = { activeElement: prevFocus ?? null, contains: (n) => n === prevFocus };
  return el;
}

describe("v-dialog", () => {
  it("有可见标题时：role/aria-modal 到位，可访问名指向那个标题自己", () => {
    const heading = { id: "", textContent: "删除 3 条提示词？", focus: vi.fn() };
    const el = stubEl({ heading, focusables: [], prevFocus: null });

    vDialog.mounted(el, { value: {} });

    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("aria-modal")).toBe("true");
    // 关键：不是抄一份 t() 文案，而是给可见标题补 id 再指过去——标题改了名字也跟着改
    expect(heading.id).toMatch(/-title$/);
    expect(el.getAttribute("aria-labelledby")).toBe(heading.id);
  });

  it("标题已有 id 时不覆盖它，直接复用", () => {
    const heading = { id: "keep-me" };
    const el = stubEl({ heading, focusables: [], prevFocus: null });
    vDialog.mounted(el, { value: {} });
    expect(heading.id).toBe("keep-me");
    expect(el.getAttribute("aria-labelledby")).toBe("keep-me");
  });

  it("没有标题时（纯图片预览）退回调用方传入的 aria-label", () => {
    const el = stubEl({ heading: null, focusables: [], prevFocus: null });
    vDialog.mounted(el, { value: { label: "图片预览" } });
    expect(el.getAttribute("aria-label")).toBe("图片预览");
    expect(el.getAttribute("aria-labelledby")).toBe(null);
  });

  it("打开时焦点进入对话框，关闭时还给触发它的元素", () => {
    const first = { focus: vi.fn() };
    const trigger = { focus: vi.fn() };
    const el = stubEl({ heading: null, focusables: [first], prevFocus: trigger });

    vDialog.mounted(el, { value: {} });
    expect(first.focus).toHaveBeenCalledTimes(1);

    vDialog.unmounted(el);
    expect(trigger.focus).toHaveBeenCalledTimes(1);
  });

  it("触发元素已经被卸载时不把焦点还给它（条件渲染下会这样）", () => {
    const el = stubEl({ heading: null, focusables: [{ focus: vi.fn() }], prevFocus: { focus: vi.fn() } });
    globalThis.document.contains = () => false;
    vDialog.mounted(el, { value: {} });
    expect(() => vDialog.unmounted(el)).not.toThrow();
  });
});
