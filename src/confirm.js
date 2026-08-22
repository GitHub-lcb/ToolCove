import { reactive } from "vue";

// 全局确认弹窗状态：askConfirm() 返回 Promise<boolean>，由 ConfirmDialog.vue 渲染
export const confirmState = reactive({
  open: false,
  title: "",
  message: "",
  okText: "确定",
  cancelText: "取消",
  danger: true,
});

let resolver = null;

export function askConfirm(opts = {}) {
  return new Promise((resolve) => {
    // 若已有未决弹窗，先按取消处理
    if (resolver) resolver(false);
    resolver = resolve;
    Object.assign(confirmState, {
      open: true,
      title: opts.title || "确认操作",
      message: opts.message || "",
      okText: opts.okText || "确定",
      cancelText: opts.cancelText || "取消",
      danger: opts.danger !== false,
    });
  });
}

export function settleConfirm(value) {
  confirmState.open = false;
  const r = resolver;
  resolver = null;
  if (r) r(value);
}
