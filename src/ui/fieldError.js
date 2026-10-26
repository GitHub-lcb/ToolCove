// 字段错误的读屏关联：把"这个控件错了"和"错在哪句话"接起来。
//
// ## 为什么不是一个视图各补一次 aria-describedby
// 本仓**真正的字段级错误**只有 3 个文件里的 17 处 `.field-err` / `.m-field-err`
// （桌面设置页、手机设置页、手机照片配置）。其余上百个带 err 字样的节点是**操作结果态**
// （转换失败、算不动、跑挂了），它们不对应任何一个输入框——
// 给它们批量补 `aria-describedby` 会把读屏指到不相干的句子上，比不补更坏。
// 而这 17 处如果逐处手写 `id` + `aria-describedby`，失败模式与 `v-dialog` 当初一模一样：
// 下一处忘了写，界面上完全看不出来，只有读屏用户遇到。
//
// ## 用法
//   <label class="field" :class="{ err: msg }" v-field-error="msg">
//     <span>标题</span>
//     <input … />
//     <span v-if="msg" class="field-err">{{ msg }}</span>
//   </label>
//
// ## 指令负责的事
//   1. 在宿主里找控件（`input`（不含 hidden）/ `textarea` / `select`）与**当前渲染出来的**
//      那条错误句子（`v-if` 为假时节点根本不在 DOM 里，所以取到的就是要播的那句）；
//   2. msg 为空 → 把 `aria-invalid` / `aria-describedby` 摘掉（错误消失了要能撤回，
//      否则读屏会一直报"无效"）；
//   3. msg 非空 → `aria-invalid="true"`，并给错误句补一个稳定 id（已有 id 不覆盖）、
//      把 `aria-describedby` 指过去——补 id 再指过去而不是抄一份文案，与本仓"可访问名与可见文字同源"的做法一致；
//   4. 找不到错误句时**只写 `aria-invalid`**，不指向一个不存在的 id。
//
// ⚠️ 与 v-dialog 相同的两条注意：
//   · 用了它必须在该组件里 `import { vFieldError }`（SSR 渲染测试不吃全局注册）；
//   · 指令在 SSR 里不执行，所以接线逻辑由 src/ui/fieldError.test.js 用 DOM 替身覆盖。
let seq = 0;

const CONTROL = "input:not([type=hidden]), textarea, select";
const NOTE = ".field-err, .m-field-err, .tc-note--fail, [data-field-error]";

/**
 * 错误句子优先在宿主**里面**；但手机照片配置的写法是
 * `<label class="m-field">…</label>` 后面紧跟一行 `<p class="m-field-err">`（兄弟节点）。
 * 那里把 `<p>` 挪进 label 会改到版式（`.m-field` 是 flex 纵向容器），
 * 所以指令两种位置都认——只在紧邻的下一个兄弟上认，避免指到远处的句子。
 */
function findNote(el) {
  const inside = el.querySelector(NOTE);
  if (inside) return inside;
  const next = el.nextElementSibling;
  return next && typeof next.matches === "function" && next.matches(NOTE) ? next : null;
}

function apply(el, msg) {
  const control = el.querySelector(CONTROL);
  if (!control) return;
  if (!msg) {
    control.removeAttribute("aria-invalid");
    control.removeAttribute("aria-describedby");
    return;
  }
  control.setAttribute("aria-invalid", "true");
  const note = findNote(el);
  if (!note) {
    control.removeAttribute("aria-describedby");
    return;
  }
  if (!note.id) note.id = `tc-field-err-${++seq}`;
  control.setAttribute("aria-describedby", note.id);
}

export const vFieldError = {
  mounted(el, binding = {}) {
    apply(el, binding.value);
  },
  updated(el, binding = {}) {
    apply(el, binding.value);
  },
  unmounted(el) {
    // 卸载时控件通常一起没了；仍摘一次，避免复用节点上留下指向已删 id 的关联
    const control = el.querySelector(CONTROL);
    if (control) {
      control.removeAttribute("aria-invalid");
      control.removeAttribute("aria-describedby");
    }
  },
};
