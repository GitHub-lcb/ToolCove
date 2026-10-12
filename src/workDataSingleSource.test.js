// 「同一件事只能有一处实现」守卫（工时聚合 / 迭代完成度）。
//
// 为什么需要它：这两段逻辑此前在四个文件里各写一份，而且**已经漂了**——
//   · `WorkOverviewView.vue` 的日合计缺 `subtasks[].logs` 明细分支，
//     跨天登记的工时在概览算到归属日、在任务页算到登记日，两页显示两个数；
//   · 手机端 `work/WorkOverview.vue` 的进度用 `req.status === "done"` 判定，
//     但需求的数据模型里根本没有 status 字段（`src/iterations.js` 写的是 `done` 布尔），
//     于是手机概览的迭代进度恒为 0%，而它自己的注释声称"与桌面端同一口径"。
// 这类漂移没有编译期错误、没有运行时报错，只有界面上的数字对不上——只能靠静态比对钉住。
//
// 思路与 `mobile/app/parity.test.js` 一致：读源码文本比对，而不是靠人记得去改第二份。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { iterationProgress } from "./requirementMetrics.js";
import { collectDayLogs, partitionDayLogs, sumHoursByDate } from "./shared/hours.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** 消费工时时钟与迭代进度的界面（桌面两端 + 手机） */
const CONSUMERS = ["src/views/WorkOverviewView.vue", "src/views/IterationView.vue", "src/views/TaskView.vue", "mobile/app/work/WorkOverview.vue"];
/** 其中真正显示「迭代完成度」的三处（任务页只显示工时，不显示进度） */
const PROGRESS_CONSUMERS = ["src/views/WorkOverviewView.vue", "src/views/IterationView.vue", "mobile/app/work/WorkOverview.vue"];
/** 真正做按日工时合计的三处（迭代页是编辑器，不做日合计） */
const HOURS_CONSUMERS = ["src/views/WorkOverviewView.vue", "src/views/TaskView.vue", "mobile/app/work/WorkOverview.vue"];

describe("工时聚合与迭代进度只有一处实现", () => {
  it("扫描规模合理（防止守卫自己扫不到文件却显示全绿）", () => {
    const missing = CONSUMERS.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    expect(missing, `视图文件被移动或删除，请同步更新本守卫的清单：${missing.join(", ")}`).toEqual([]);
    for (const rel of CONSUMERS) expect(read(rel).length).toBeGreaterThan(500);
  });

  it("三处进度消费方都从 requirementMetrics 取迭代进度", () => {
    for (const rel of PROGRESS_CONSUMERS) expect(read(rel), rel).toContain("iterationProgress");
  });

  it("没有任何视图再自己数 done/total", () => {
    // 被删掉的那份拷贝长这样；再出现就说明有人把进度算回视图里了
    const DRIFT = /(?:const|let)\s+(?:done|requirements)\s*=\s*[^;\n]*\.filter\(\([^)]*\)\s*=>\s*[^)]*(?:\.done|status === "done")[^\n]*\)\s*;/;
    for (const rel of CONSUMERS) expect(DRIFT.test(read(rel)), `${rel} 重新实现了迭代进度`).toBe(false);
  });

  it("三处工时消费方都走 shared 的聚合入口", () => {
    for (const rel of HOURS_CONSUMERS) {
      const text = read(rel);
      expect(text, `${rel} 应调用 collectDayLogs`).toContain("collectDayLogs");
      expect(text, `${rel} 应调用 sumHoursByDate`).toContain("sumHoursByDate");
    }
  });

  it("只有 shared/hours.js 会造出按日工时条目（视图不许再拼 source: \"iteration\"）", () => {
    for (const rel of CONSUMERS) expect(read(rel), rel).not.toContain('source: "iteration"');
    expect(read("src/shared/hours.js")).toContain('source: "iteration"');
  });
});

describe("迭代进度的口径", () => {
  it("需求只有 done 布尔，没有 status——进度必须按 done 数（手机端曾按 status 判，恒 0%）", () => {
    const iteration = { items: [{ name: "a", done: true }, { name: "b", status: "done" }, { name: "c" }] };
    // 第二行带 status 但没有 done：按模型的真相字段，它不算完成
    expect(iterationProgress(iteration)).toEqual({ total: 3, done: 1, pct: 33 });
  });

  it("聚合链路的三段都是纯函数：collectDayLogs → sumHoursByDate / partitionDayLogs", () => {
    const iterations = [
      {
        id: "i1",
        title: "迭代A",
        items: [
          {
            id: "r1",
            name: "需求1",
            subtasks: [{ id: "s1", name: "子任务a", hours: 3, date: "2026-07-20" }],
          },
        ],
      },
    ];
    const entries = collectDayLogs(iterations, []);
    expect(sumHoursByDate(entries)).toEqual({ "2026-07-20": 3 });
    expect(partitionDayLogs(entries).editable).toHaveLength(1);
  });
});
