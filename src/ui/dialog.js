// 弹窗语义与焦点：一个指令，全应用 38 个对话框共用。
//
// ## 为什么不是每个视图自己写 role
// 实测 31 个遮罩实例里只有 4 个写过 `role="dialog"`。逐个模板补 `role` + `aria-label`
// 会变成"第 32 个弹窗忘了写"的经典结局，而且 `aria-label` 得把可见标题的 `t()` 表达式
// 再抄一遍——标题改了，读屏里还是旧的（与本仓反复出问题的"抄写值"是同一类缺陷）。
//
// ## 所以这里做的是
//   1. 挂 `role="dialog"` + `aria-modal="true"`；
//   2. **取盒子里第一个标题元素**（h2/h3/[data-dialog-title]）补一个 id，
//      再用 `aria-labelledby` 指过去——可访问名与可见标题永远是同一段文字；
//      没有标题的（如纯图片预览）退化成 `aria-label`，由调用方传入；
//   3. 打开时把焦点送进对话框（优先 `[data-dialog-focus]`，其次第一个可聚焦控件），
//      关闭时**还给触发它的那个控件**——否则键盘用户每次关弹窗都回到页面顶部；
//   4. 只声明式地做这三件事：不做焦点陷阱、不拦 Escape（各遮罩自己已实现）。
//
// ⚠️ 指令在 SSR 里不执行，所以守卫判的是"模板有没有挂 v-dialog"（uiSpec.test.js），
//    语义接线本身由 src/ui/dialog.test.js 用 DOM 替身覆盖，浏览器行为由 e2e 覆盖。

let seq = 0;

// 第一个可聚焦的元素：隐藏 input 与 tabindex="-1" 都要排除
const FOCUSABLE = 'input:not([type=hidden]), textarea, select, button, a[href], [tabindex]:not([tabindex="-1"])';

export const vDialog = {
  mounted(el, binding = {}) {
    const uid = `tc-dialog-${++seq}`;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");

    // 标题元素的三种写法：真 h2/h3、显式标了 data-dialog-title 的（纯 <b> 当标题的那种）、
    // 以及 .save-title / .cf-title / .curl-title 这类自带 title 字样的元素。按文档顺序取第一个。
    const heading = el.querySelector('h2, h3, [data-dialog-title], [class*="title"]');
    if (heading) {
      if (!heading.id) heading.id = `${uid}-title`;
      el.setAttribute("aria-labelledby", heading.id);
    } else if (binding.value?.label) {
      el.setAttribute("aria-label", binding.value.label);
    }

    el.__tcPrevFocus = document.activeElement ?? null;
    const target = el.querySelector("[data-dialog-focus]") || el.querySelector(FOCUSABLE);
    if (target && typeof target.focus === "function") target.focus({ preventScroll: true });
  },
  unmounted(el) {
    const prev = el.__tcPrevFocus;
    // 只还给还在文档里的元素：条件渲染下触发按钮可能先被卸载
    if (prev && document.contains(prev) && typeof prev.focus === "function") prev.focus({ preventScroll: true });
    el.__tcPrevFocus = null;
  },
};
