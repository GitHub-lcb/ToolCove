// 错误对象 → 可读文案。
//
// 单独一个文件是因为它被 8 个界面引用（catch 块里 `showToast(t("x", { err: errText(e) }))`），
// 以前埋在 564 行的 shared.js 里，让人以为"通用工具"就该往里塞东西。
import { i18n } from "../i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

export function errText(e) {
  if (e == null) return t("common.unknownError");
  if (typeof e === "string") return e;
  if (e.message) return e.message;
  try {
    return JSON.stringify(e).slice(0, 300);
  } catch {
    return String(e);
  }
}
