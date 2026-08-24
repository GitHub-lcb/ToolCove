import { reactive } from "vue";
import { i18n } from "./i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

// 全局确认弹窗状态：askConfirm() 返回 Promise<boolean>，由 ConfirmDialog.vue 渲染
export const confirmState = reactive({
  open: false,
  title: "",
  message: "",
  okText: "",
  cancelText: "",
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
      title: opts.title || t("common.confirmTitle"),
      message: opts.message || "",
      okText: opts.okText || t("common.confirm"),
      cancelText: opts.cancelText || t("common.cancel"),
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
