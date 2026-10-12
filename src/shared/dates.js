// 日期与星期的纯函数（原 shared.js 的「日期助手」段）。
//
// 拆出来的理由：`shared.js` 曾横跨五个无关领域（日期 / 工时 / Excel / Markdown 渲染 /
// 平台链接解析），564 行、26 个导出、17 个引用方——想知道"工作日判定在哪"只能通读整个文件。
// 按领域拆开后每个文件都能独立读懂，也方便将来只改一处（比如工作日规则要接节假日表）。
import { i18n } from "../i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

const pad = (n) => String(n).padStart(2, "0");

// 相对时间格式化（超过 30 天退回绝对日期，避免"1024 天前"这种没法读的输出）
export function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return t("common.timeJustNow");
  if (m < 60) return t("common.timeMinutesAgo", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("common.timeHoursAgo", { n: h });
  const d = Math.floor(h / 24);
  if (d < 30) return t("common.timeDaysAgo", { n: d });
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEKDAY_KEYS = ["common.weekSun", "common.weekMon", "common.weekTue", "common.weekWed", "common.weekThu", "common.weekFri", "common.weekSat"];
export function weekday(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return isNaN(d) ? "" : t(WEEKDAY_KEYS[d.getDay()]);
}

// 是否工作日（周一~周五；非法日期返回 false）
export function isWorkday(date) {
  const value = date instanceof Date ? date : new Date(`${date}T12:00:00`);
  const day = value.getDay();
  return Number.isFinite(value.getTime()) && day >= 1 && day <= 5;
}

// 下一个周二 / 周四（含今天）
export function nextReleaseDate() {
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const t2 = new Date(today);
    t2.setDate(today.getDate() + i);
    if (t2.getDay() === 2 || t2.getDay() === 4) return fmtDate(t2);
  }
  return fmtDate(today);
}

// 本周周一零点
export function startOfWeek(d = new Date()) {
  const t2 = new Date(d);
  const day = (t2.getDay() + 6) % 7; // 周一=0
  t2.setHours(0, 0, 0, 0);
  t2.setDate(t2.getDate() - day);
  return t2;
}
