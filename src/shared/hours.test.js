// src/shared/hours.js 的纯函数单测（从原 508 行的 shared.test.js 按领域拆出来）。
// 拆分的意义：概览 / 任务页 / 手机概览共用同一份聚合，测试也只需对着这一个入口写。
import { describe, it, expect } from "vitest";
import { collectDayLogs, partitionDayLogs, subLogsByDate, subPushedHours, subRemaining, sumHoursByDate, workHoursRows } from "./hours.js";
import { i18n } from "../i18n/index.js";describe("workHoursRows", () => {
  it("映射来源中文名并补充星期", () => {
    const rows = workHoursRows([
      { date: "2026-07-22", hours: 2, source: "iteration", title: "A", note: "n1" },
      { date: "2026-07-23", hours: 1.5, source: "problem", title: "B" },
    ]);
    expect(rows[0]).toEqual({
      date: "2026-07-22",
      weekday: i18n.global.t("common.weekWed"),
      source: i18n.global.t("common.sourceIteration"),
      hours: 2,
      title: "A",
      note: "n1",
    });
    expect(rows[1].source).toBe(i18n.global.t("common.sourceProblem"));
    expect(rows[1].weekday).toBe(i18n.global.t("common.weekThu"));
    expect(rows[1].note).toBe("");
  });
  it("按日期升序排列", () => {
    const rows = workHoursRows([
      { date: "2026-07-23", hours: 1, source: "iteration", title: "晚" },
      { date: "2026-07-22", hours: 1, source: "iteration", title: "早" },
    ]);
    expect(rows.map((r) => r.title)).toEqual(["早", "晚"]);
  });
  it("过滤无日期条目并保留未知来源", () => {
    const rows = workHoursRows([
      { hours: 3, source: "iteration", title: "无日期" },
      { date: "2026-07-22", hours: 2, source: "other", title: "C" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("other");
  });
  it("工时数值保留两位小数", () => {
    const rows = workHoursRows([{ date: "2026-07-22", hours: 1.666, source: "iteration", title: "D" }]);
    expect(rows[0].hours).toBe(1.67);
  });
  it("空输入返回空数组", () => {
    expect(workHoursRows()).toEqual([]);
    expect(workHoursRows([])).toEqual([]);
  });
});

describe("collectDayLogs", () => {
  it("展平迭代子任务、历史 logs 与问题工时", () => {
    const iterations = [
      {
        title: "迭代A",
        items: [
          {
            name: "需求1",
            subtasks: [
              { name: "子任务a", hours: 2, date: "2026-07-20" },
              { name: "无工时", hours: 0, date: "2026-07-20" }, // 不计入
              { name: "无日期", hours: 3, date: "" }, // 不计入
            ],
            logs: [{ date: "2026-07-19", hours: 1.5, note: "历史记一笔" }],
          },
        ],
      },
    ];
    const problems = [{ title: "问题X", logs: [{ date: "2026-07-21", hours: 4 }] }];
    const logs = collectDayLogs(iterations, problems);
    expect(logs).toHaveLength(3);

    const sub = logs.find((e) => e.title.includes("子任务a"));
    expect(sub).toMatchObject({ date: "2026-07-20", hours: 2, source: "iteration", note: "需求1" });

    const problem = logs.find((e) => e.source === "problem");
    expect(problem).toMatchObject({ date: "2026-07-21", hours: 4, title: "问题X" });
  });

  it("空输入返回空数组", () => {
    expect(collectDayLogs(null, null)).toEqual([]);
    expect(collectDayLogs([], [])).toEqual([]);
  });

  it("传 mineName 时只统计自己：别人的子任务不计入，无处理人视为自己", () => {
    const iterations = [
      {
        title: "迭代A",
        items: [
          {
            name: "需求1",
            subtasks: [
              { name: "我的", hours: 2, date: "2026-07-20", assignee: "比特" },
              { name: "同事的", hours: 4, date: "2026-07-20", assignee: "华佗" }, // 不计入
              { name: "本地无处理人", hours: 1, date: "2026-07-20" }, // 视为自己的
            ],
          },
        ],
      },
    ];
    const mine = collectDayLogs(iterations, [], "比特");
    expect(mine.map((e) => e.hours)).toEqual([2, 1]);
    // 不传 mineName 时全量兑底
    expect(collectDayLogs(iterations, [])).toHaveLength(3);
  });

  it("有工时登记明细时按实际登记日逐条统计（跨天拆分）", () => {
    const iterations = [
      {
        title: "迭代A",
        items: [
          {
            name: "需求1",
            subtasks: [
              {
                name: "子任务a",
                hours: 8, // 累计 8h，归属日取更新时间的旧口径
                date: "2026-07-21",
                logs: [
                  { date: "2026-07-20", hours: 4, name: "比特" },
                  { date: "2026-07-21", hours: 4, name: "比特" },
                ],
              },
              { name: "无明细子任务", hours: 2, date: "2026-07-22" }, // 回退旧口径
            ],
          },
        ],
      },
    ];
    const logs = collectDayLogs(iterations, []);
    const sub = logs.filter((e) => e.title.includes("子任务a"));
    expect(sub).toHaveLength(2);
    expect(sub.find((e) => e.date === "2026-07-20")).toMatchObject({ hours: 4, source: "iteration", note: "需求1" });
    expect(sub.find((e) => e.date === "2026-07-21")).toMatchObject({ hours: 4 });
    // 无明细子任务按累计与归属日回退
    expect(logs.find((e) => e.title.includes("无明细子任务"))).toMatchObject({ date: "2026-07-22", hours: 2 });
  });

  it("明细带填写人时按填写人过滤，同事代填的工时不计入", () => {
    const iterations = [
      {
        title: "迭代A",
        items: [
          {
            name: "需求1",
            subtasks: [
              {
                name: "子任务a",
                hours: 6,
                date: "2026-07-21",
                assignee: "比特",
                logs: [
                  { date: "2026-07-20", hours: 4, name: "比特" },
                  { date: "2026-07-21", hours: 2, name: "华佗" }, // 同事代填，不计入
                ],
              },
              {
                name: "解析不到填写人",
                hours: 3,
                date: "2026-07-22",
                assignee: "华佗", // 明细无 name，按处理人兜底过滤
                logs: [{ date: "2026-07-22", hours: 3, name: "" }],
              },
            ],
          },
        ],
      },
    ];
    const mine = collectDayLogs(iterations, [], "比特");
    expect(mine.map((e) => [e.title, e.date, e.hours])).toEqual([["迭代A · 子任务a", "2026-07-20", 4]]);
  });
});

describe("subLogsByDate", () => {
  it("按登记日聚合升序，忽略无日期/零工时条目", () => {
    const logs = subLogsByDate({
      logs: [
        { date: "2026-07-21", hours: 4, name: "比特" },
        { date: "2026-07-20", hours: 4, name: "比特" },
        { date: "2026-07-20", hours: 2, name: "华佗" }, // 同日合并
        { date: "", hours: 3, name: "比特" }, // 无日期忽略
        { date: "2026-07-22", hours: 0 }, // 零工时忽略
      ],
    });
    expect(logs).toEqual([
      { date: "2026-07-20", hours: 6 },
      { date: "2026-07-21", hours: 4 },
    ]);
  });
  it("无明细或空输入返回空数组", () => {
    expect(subLogsByDate({})).toEqual([]);
    expect(subLogsByDate(null)).toEqual([]);
    expect(subLogsByDate({ logs: [] })).toEqual([]);
  });
});

describe("subRemaining", () => {
  it("无登记明细时返回总工时", () => {
    expect(subRemaining({ hours: 8, logs: [] })).toBe(8);
    expect(subRemaining({ hours: 8 })).toBe(8);
  });
  it("扣减已登记明细工时", () => {
    expect(
      subRemaining({
        hours: 8,
        logs: [
          { date: "2026-07-20", hours: 2 },
          { date: "2026-07-21", hours: 2.5 },
        ],
      })
    ).toBe(3.5);
  });
  it("已登记超过总工时返回 0", () => {
    expect(subRemaining({ hours: 8, logs: [{ hours: 5 }, { hours: 6 }] })).toBe(0);
  });
  it("空对象或空值返回 0", () => {
    expect(subRemaining({})).toBe(0);
    expect(subRemaining(null)).toBe(0);
  });
});

describe("subPushedHours", () => {
  it("汇总已登记明细工时", () => {
    expect(subPushedHours({ logs: [{ hours: 2 }, { hours: 2.5 }] })).toBe(4.5);
  });
  it("无明细或空输入返回 0", () => {
    expect(subPushedHours({})).toBe(0);
    expect(subPushedHours(null)).toBe(0);
    expect(subPushedHours({ logs: [] })).toBe(0);
  });
});

describe("sumHoursByDate", () => {
  it("按日合计并忽略无日期/零工时条目", () => {
    const entries = [
      { date: "2026-07-20", hours: 4 },
      { date: "2026-07-20", hours: 2 },
      { date: "2026-07-21", hours: 0 }, // 零工时不出键
      { date: "", hours: 3 }, // 无日期丢弃
      { hours: 5 }, // 连日期字段都没有
    ];
    expect(sumHoursByDate(entries)).toEqual({ "2026-07-20": 6 });
    expect(sumHoursByDate(null)).toEqual({});
  });

  // 这条锁住的是「同一份数据在两个页面必须是同一个数」：
  // 概览的今日工时 KPI 与任务页的日合计数此前各有实现，
  // 概览缺 subtasks[].logs 明细分支，跨天填写时两边显示不同的工时。
  it("跨天登记的工时逐日拆分（概览与任务页因此同源）", () => {
    const iterations = [
      {
        id: "i1",
        title: "迭代A",
        items: [
          {
            name: "需求1",
            subtasks: [
              {
                id: "s1",
                name: "子任务a",
                hours: 8, // 累计 8h，归属日是旧口径
                date: "2026-07-21",
                logs: [
                  { date: "2026-07-20", hours: 5, name: "比特" },
                  { date: "2026-07-21", hours: 3, name: "比特" },
                ],
              },
            ],
          },
        ],
      },
    ];
    const totals = sumHoursByDate(collectDayLogs(iterations, []));
    // 按实际登记日拆开，而不是把整笔 8h 记到子任务归属日
    expect(totals).toEqual({ "2026-07-20": 5, "2026-07-21": 3 });
  });
});

describe("partitionDayLogs", () => {
  const iterations = [
    {
      id: "i1",
      title: "迭代A",
      items: [
        {
          id: "r1",
          name: "需求1",
          subtasks: [{ id: "s1", name: "子任务a", hours: 2, date: "2026-07-20" }],
          logs: [{ date: "2026-07-19", hours: 1, note: "历史记一笔" }],
        },
      ],
    },
  ];
  const problems = [{ id: "p1", title: "问题X", logs: [{ date: "2026-07-21", hours: 4, note: "排查" }] }];
  const entries = collectDayLogs(iterations, problems);

  it("只有带子任务引用的条目可编辑，历史「记一笔」只读", () => {
    const { editable, readOnly } = partitionDayLogs(entries.filter((e) => e.source === "iteration"));
    expect(editable.map((e) => e.title)).toEqual(["迭代A · 子任务a"]);
    expect(editable.every((e) => e.s && e.it && e.r)).toBe(true);
    expect(readOnly.map((e) => e.title)).toEqual(["迭代A · 需求1"]);
    // 旧实现里模板对每条 iteration 条目都取 e.s.id，历史 logs 一到就 TypeError
    expect(readOnly.every((e) => !e.s)).toBe(true);
  });

  it("问题条目带 problem 引用，供跳转取 id", () => {
    const problem = entries.find((e) => e.source === "problem");
    expect(problem.problem).toMatchObject({ id: "p1", title: "问题X" });
  });

  it("空输入不抛错", () => {
    expect(partitionDayLogs(null)).toEqual({ editable: [], readOnly: [] });
    expect(partitionDayLogs([])).toEqual({ editable: [], readOnly: [] });
  });
});
