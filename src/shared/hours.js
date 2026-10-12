// 工时统计的纯函数层——**按日工时的唯一真相源**。
//
// 为什么单独成文件（而不是留在 shared.js 里）：这一段是第 5 轮那场"同一个数在三个页面
// 显示成三种结果"的直接修复点。桌面概览、任务页、手机概览都从这里取聚合，
// 判据与口径写在一起才读得完整：为什么有明细按明细、为什么旧「记一笔」只读、
// 为什么按 mineName 过滤。
import { i18n } from "../i18n/index.js";
import { weekday } from "./dates.js";

const t = (key, params) => i18n.global.t(key, params);

// 收集迭代需求（子任务即工时 + 历史工时记录）与问题的按日工时，展平为统一条目
// mineName 有值时只统计自己：带平台处理人且不是本人的子任务不计入（无处理人的本地子任务视为自己的）
export function collectDayLogs(iterations, problems, mineName = "") {
  const entries = [];
  (iterations || []).forEach((it) =>
    (it.items || []).forEach((r) => {
      // 子任务工时（现行机制）：有工时且有归属日才进按日统计。
      // 有平台工时登记明细（logs）时按每条实际登记日逐条统计，跨天填写可正确拆分；
      // 无明细（本地手工子任务或明细拉取失败）回退子任务累计工时与归属日。
      (r.subtasks || []).forEach((s) => {
        const detail = Array.isArray(s.logs) && s.logs.length ? s.logs : null;
        if (detail) {
          detail.forEach((l) => {
            const h = Number(l.hours) || 0;
            if (h <= 0 || !l.date) return;
            // 明细带填写人时按填写人过滤；解析不到填写人时按子任务处理人兜底
            if (mineName && l.name && l.name !== mineName) return;
            if (mineName && !l.name && s.assignee && s.assignee !== mineName) return;
            entries.push({
              date: l.date,
              hours: h,
              source: "iteration",
              title: `${it.title} · ${s.name}`,
              note: r.name || "",
              it, // 迭代/需求/子任务引用：工时页未提交工时就地编辑/推送用
              r,
              s,
            });
          });
        } else {
          if (mineName && s.assignee && s.assignee !== mineName) return;
          const h = Number(s.hours) || 0;
          if (h > 0 && s.date)
            entries.push({
              date: s.date,
              hours: h,
              source: "iteration",
              title: `${it.title} · ${s.name}`,
              note: r.name || "",
              it,
              r,
              s,
            });
        }
      });
      // 历史「记一笔」工时记录（已下线录入，保留旧数据统计）
      // 这里也带上 it/r 引用：消费方（概览的「最近动态」）要靠它还原「哪个迭代 · 哪个需求」。
      // 刻意不带 s——这一类没有子任务，消费方据此区分「可就地编辑的子任务行」与「只读的旧记录行」。
      (r.logs || []).forEach((l) =>
        entries.push({
          date: l.date,
          hours: Number(l.hours) || 0,
          source: "iteration",
          title: `${it.title} · ${r.name}`,
          note: l.note || "",
          it,
          r,
        })
      );
    })
  );
  (problems || []).forEach((p) =>
    (p.logs || []).forEach((l) =>
      entries.push({
        date: l.date,
        hours: Number(l.hours) || 0,
        source: "problem",
        title: p.title,
        note: l.note || "",
        // 引用原对象：概览的「最近动态」要靠它拿到问题 id 才能点击跳转（同迭代侧带 it/r/s）
        problem: p,
      })
    )
  );
  return entries;
}

/**
 * 按日合计工时（`date → hours`），忽略无日期或零工时的条目。
 * 概览的「今日工时」KPI 与任务页的月度日合计都走这里——同一份数据在两个页面必须是同一个数。
 */
export function sumHoursByDate(entries) {
  const bucket = {};
  for (const entry of entries || []) {
    if (!entry || !entry.date || !entry.hours) continue;
    bucket[entry.date] = (bucket[entry.date] || 0) + Number(entry.hours);
  }
  return bucket;
}

/**
 * 把按日工时条目分成「可就地编辑的子任务行」与「只读的历史记录行」。
 *
 * 判据是**引用完整性**：只有带 subtask 引用的条目能回写到迭代树；
 * 历史「记一笔」（需求级 logs）没有对应子任务，给它编辑/删除按钮会写坏数据，只能只读展示。
 * 之所以抽成函数：任务页模板此前对**所有** iteration 条目都取 `e.s.id`，
 * 一旦某条需求留有旧 logs 就直接 TypeError 白屏（本仓的实测崩点，见 TaskView 的 day-entry 块）。
 */
export function partitionDayLogs(entries) {
  const editable = [];
  const readOnly = [];
  for (const entry of entries || []) (entry && entry.s ? editable : readOnly).push(entry);
  return { editable, readOnly };
}

export const WORK_SOURCES = {
  iteration: { labelKey: "common.sourceIteration", color: "var(--accent)" },
  problem: { labelKey: "common.sourceProblem", color: "var(--danger)" },
};

// 子任务工时登记明细：按登记日聚合升序（[{ date, hours }]），无明细返回空数组
export function subLogsByDate(s) {
  const map = {};
  ((s && s.logs) || []).forEach((l) => {
    const h = Number(l.hours) || 0;
    if (!l.date || h <= 0) return;
    map[l.date] = (map[l.date] || 0) + h;
  });
  return Object.keys(map)
    .sort()
    .map((d) => ({ date: d, hours: map[d] }));
}

// 子任务剩余未登记工时：总工时 - 已登记明细（四舍五入到 0.1），支持分次推送剩余部分
export function subRemaining(s) {
  const total = Math.max(0, Number(s && s.hours) || 0);
  const pushed = ((s && s.logs) || []).reduce((sum, l) => sum + (Number(l.hours) || 0), 0);
  return Math.max(0, Math.round((total - pushed) * 10) / 10);
}

// 子任务已登记到平台的工时合计（四舍五入到 0.1）
export function subPushedHours(s) {
  const pushed = ((s && s.logs) || []).reduce((sum, l) => sum + (Number(l.hours) || 0), 0);
  return Math.round(pushed * 10) / 10;
}

// 把按日工时条目整理成 Excel 明细行（按日期升序）：日期/星期/来源/工时/事项/备注
export function workHoursRows(entries) {
  const round2 = (n) => Math.round(n * 100) / 100;
  return [...(entries || [])]
    .filter((e) => e && e.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((e) => ({
      date: e.date,
      weekday: weekday(e.date),
      source: (WORK_SOURCES[e.source] && t(WORK_SOURCES[e.source].labelKey)) || e.source || "",
      hours: round2(Number(e.hours) || 0),
      title: e.title || "",
      note: e.note || "",
    }));
}
