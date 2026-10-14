// 周报素材构建的纯函数层：把「周范围计算」与「给 AI 的素材文本拼接」从 TaskView 抽出。
//
// 为什么单独成文件：定时生成（src/report/index.js）与界面手动生成（TaskView）必须产出
// **完全一致**的素材文本——否则同一周在「定时草稿」与「手动生成」两处内容会对不上，
// 而这种漂移既无编译期错误也无运行时报错，只能靠共用一份实现避免。
// t 由调用方注入（界面用 useI18n 的 t，定时任务用 i18n.global.t），这样这里是纯函数、可直接单测。
import { fmtDate, startOfWeek, weekday } from "../shared/dates.js";

function round(n) {
  return Math.round(n * 100) / 100;
}

// 周范围：本周（周一至今天）/ 上周（上周一至上周日）。
// now 注入以便单测钉住跨周边界；界面与定时任务都用默认的「现在」。
export function weekRange(kind, t, now = new Date()) {
  const mon = startOfWeek(now);
  if (kind === "last") {
    const from = new Date(mon);
    from.setDate(mon.getDate() - 7);
    const to = new Date(mon);
    to.setDate(mon.getDate() - 1);
    return { from: fmtDate(from), to: fmtDate(to), label: t("task.rangeLast"), labelKey: "task.rangeLast" };
  }
  return { from: fmtDate(mon), to: fmtDate(now), label: t("task.rangeThis"), labelKey: "task.rangeThis" };
}

// 把范围内的工时/迭代/问题/未完成需求整理成给 AI 的素材文本。
// dayLogs 为 shared/hours.js 的 collectDayLogs 产出，iterations 为迭代树；两者都从入参取，
// 让调用方（界面取响应式数据、定时任务取 repository 读出的数据）共用同一段拼接逻辑。
export function buildReportMaterial({ dayLogs, iterations } = {}, range, t) {
  const inRange = (d) => d && d >= range.from && d <= range.to;
  const lines = [t("task.materialRange", { from: range.from, to: range.to, label: range.label })];

  const logs = (dayLogs || []).filter((e) => inRange(e.date));
  const total = round(logs.reduce((s, e) => s + e.hours, 0));
  if (logs.length) {
    lines.push(t("task.materialHoursHead", { total }));
    const byDay = {};
    logs.forEach((e) => (byDay[e.date] = byDay[e.date] || []).push(e));
    Object.keys(byDay)
      .sort()
      .forEach((d) => {
        lines.push(t("task.materialDayHead", { date: d, weekday: weekday(d) }));
        byDay[d].forEach((e) =>
          lines.push(t("task.materialEntryLine", { hours: e.hours, title: e.title, note: e.note ? t("task.copyNote", { note: e.note }) : "" }))
        );
      });
  } else {
    lines.push(t("task.materialNoLogs"));
  }

  const its = iterations || [];
  const rel = its.filter((it) => inRange(it.releaseDate));
  if (rel.length) {
    lines.push(t("task.materialReleasesHead"));
    rel.forEach((it) =>
      lines.push(
        t("task.materialReleaseLine", {
          version: it.version ? it.version + " " : "",
          title: it.title,
          date: it.releaseDate,
          status: t(it.status === "live" ? "task.releaseLive" : "task.releaseNotLive"),
        })
      )
    );
  }

  const undone = [];
  its.forEach((it) => {
    if (it.status === "live") return;
    (it.items || []).forEach((r) => {
      if (!r.done) undone.push(`- ${it.title} / ${r.name}`);
    });
  });
  if (undone.length) {
    lines.push(t("task.materialUndoneHead"));
    lines.push(...undone.slice(0, 20));
  }
  return { text: lines.join("\n"), hasLogs: logs.length > 0 };
}
