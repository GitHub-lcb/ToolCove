// shared.js 纯函数单测：日期助手、工时聚合、Markdown 渲染
import { describe, it, expect } from "vitest";
import {
  fmtDate,
  weekday,
  nextReleaseDate,
  startOfWeek,
  collectDayLogs,
  subLogsByDate,
  workHoursRows,
  renderMarkdown,
  relativeTime,
  subRemaining,
  subPushedHours,
  errText,
  extractCode,
  parseIssueUrl,
  bugStatusInfo,
} from "./shared.js";
import { i18n } from "./i18n/index.js";

describe("fmtDate", () => {
  it("补零成 YYYY-MM-DD", () => {
    expect(fmtDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(fmtDate(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("weekday", () => {
  it("按日期返回中文星期", () => {
    expect(weekday("2026-07-22")).toBe(i18n.global.t("common.weekWed"));
  });
  it("空串或非法日期返回空", () => {
    expect(weekday("")).toBe("");
    expect(weekday("not-a-date")).toBe("");
  });
});

describe("nextReleaseDate", () => {
  it("返回的日期一定是周二或周四", () => {
    const d = new Date(nextReleaseDate() + "T00:00:00");
    expect([2, 4]).toContain(d.getDay());
  });
});

describe("workHoursRows", () => {
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

describe("startOfWeek", () => {
  it("返回当周周一零点", () => {
    // 2026-07-22 是周三，本周周一应为 07-20
    const mon = startOfWeek(new Date(2026, 6, 22, 15, 30));
    expect(fmtDate(mon)).toBe("2026-07-20");
    expect(mon.getHours()).toBe(0);
    expect(mon.getMinutes()).toBe(0);
  });
  it("周日归属上一个周一", () => {
    // 2026-07-26 是周日，本周周一应为 07-20
    const mon = startOfWeek(new Date(2026, 6, 26));
    expect(fmtDate(mon)).toBe("2026-07-20");
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

describe("renderMarkdown", () => {
  it("转义 HTML 防注入", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("标题降级：# 渲染为 h3，封顶 h6", () => {
    expect(renderMarkdown("# 标题")).toContain("<h3>标题</h3>");
    expect(renderMarkdown("#### 四级")).toContain("<h6>四级</h6>");
  });
  it("粗体与行内代码", () => {
    const html = renderMarkdown("**粗** 与 `码`");
    expect(html).toContain("<strong>粗</strong>");
    expect(html).toContain("<code>码</code>");
  });
  it("有序列表支持点号 / 括号分隔（后接空格）", () => {
    expect(renderMarkdown("1. 第一")).toContain("<ol>");
    expect(renderMarkdown("1) 第一")).toContain("<li>第一</li>");
  });
  it("围栏代码块", () => {
    const html = renderMarkdown("```\nconst a = 1;\n```");
    expect(html).toContain('<pre class="md-code">');
  });
  it("表格：表头 + 分隔行 + 数据行", () => {
    const html = renderMarkdown("| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 梨 | 5 |");
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain("<th>名称</th>");
    expect(html).toContain("<td>苹果</td>");
  });
  it("表格：无分隔行时按段落输出不丢内容", () => {
    const html = renderMarkdown("| a | b |\n| c | d |");
    expect(html).not.toContain("<table");
    expect(html).toContain("<p>a | b</p>");
  });
  it("围栏代码块语言标注与高亮选项", () => {
    const plain = renderMarkdown("```js\nconst a = 1;\n```");
    expect(plain).toContain('<pre class="md-code">');
    expect(plain).not.toContain("hljs");
    const hl = renderMarkdown("```js\nconst a = 1;\n```", { highlight: true });
    expect(hl).toContain('<pre class="md-code" data-lang="js">');
    expect(hl).toContain('class="md-copy"');
    expect(hl).toContain("hljs");
  });
  it("highlight 默认关闭，不影响既有调用", () => {
    const html = renderMarkdown("**粗**");
    expect(html).toContain("<strong>粗</strong>");
  });
  it("高亮输出仍防注入（代码内 HTML 被转义）", () => {
    const hl = renderMarkdown("```html\n<script>alert(1)</script>\n```", { highlight: true });
    expect(hl).not.toContain("<script>alert");
  });
  it("空输入返回空串", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown(null)).toBe("");
  });
});

describe("relativeTime", () => {
  it("刚刚 / 分钟 / 小时", () => {
    const now = Date.now();
    expect(relativeTime(now)).toBe(i18n.global.t("common.timeJustNow"));
    expect(relativeTime(now - 5 * 60000)).toBe(i18n.global.t("common.timeMinutesAgo", { n: 5 }));
    expect(relativeTime(now - 3 * 3600000)).toBe(i18n.global.t("common.timeHoursAgo", { n: 3 }));
  });
  it("空值返回空串", () => {
    expect(relativeTime(0)).toBe("");
  });
});

describe("errText", () => {
  it("字符串原样返回", () => {
    expect(errText("boom")).toBe("boom");
  });
  it("Error 取 message", () => {
    expect(errText(new Error("bad"))).toBe("bad");
  });
  it("null 返回兜底文案", () => {
    expect(errText(null)).toBe(i18n.global.t("common.unknownError"));
  });
});

describe("extractCode", () => {
  it("从完整链接提取编号", () => {
    expect(extractCode("https://team.coding.net/p/foo/backlog/issues/123/detail")).toBe("#123");
  });
  it("纯编号 / 带 # 编号", () => {
    expect(extractCode("#456")).toBe("#456");
    expect(extractCode("456")).toBe("#456");
  });
  it("空 / 无效输入返回空串", () => {
    expect(extractCode("")).toBe("");
    expect(extractCode("abc")).toBe("");
  });
});

describe("parseIssueUrl", () => {
  it("解析项目名与事项编号", () => {
    expect(parseIssueUrl("https://team.coding.net/p/myproj/backlog/issues/789/detail")).toEqual({ projectName: "myproj", issueCode: 789 });
  });
  it("bug 链接 / 纯编号兜底", () => {
    expect(parseIssueUrl("https://team.coding.net/p/p2/bugs/1001")).toEqual({ projectName: "p2", issueCode: 1001 });
    expect(parseIssueUrl("999")).toEqual({ projectName: "", issueCode: 999 });
  });
  it("无法解析返回 null", () => {
    expect(parseIssueUrl("")).toBeNull();
    expect(parseIssueUrl("随便什么")).toBeNull();
  });
});

describe("bugStatusInfo", () => {
  it("COMPLETED 类型归 done", () => {
    expect(bugStatusInfo("随便", "COMPLETED").tone).toBe("done");
  });
  it("名称关键词归类", () => {
    expect(bugStatusInfo("已完成").tone).toBe("done");
    expect(bugStatusInfo("处理中").tone).toBe("active");
    expect(bugStatusInfo("待修复").tone).toBe("pending");
  });
  it("空状态归 unknown", () => {
    expect(bugStatusInfo("").tone).toBe("unknown");
  });
});
