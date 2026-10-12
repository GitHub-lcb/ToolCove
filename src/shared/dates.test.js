// src/shared/dates.js 的纯函数单测（从原 508 行的 shared.test.js 按领域拆出来）。
import { describe, it, expect } from "vitest";
import { fmtDate, isWorkday, nextReleaseDate, relativeTime, startOfWeek, weekday } from "./dates.js";
import { i18n } from "../i18n/index.js";describe("fmtDate", () => {
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

describe("isWorkday", () => {
  it("周一至周五为工作日", () => {
    expect(isWorkday("2026-07-22")).toBe(true); // 周三
    expect(isWorkday("2026-07-20")).toBe(true); // 周一
    expect(isWorkday("2026-07-24")).toBe(true); // 周五
  });
  it("周末与非法日期不是工作日", () => {
    expect(isWorkday("2026-07-25")).toBe(false); // 周六
    expect(isWorkday("2026-07-26")).toBe(false); // 周日
    expect(isWorkday("bad-date")).toBe(false);
    expect(isWorkday("")).toBe(false);
  });
});

describe("nextReleaseDate", () => {
  it("返回的日期一定是周二或周四", () => {
    const d = new Date(nextReleaseDate() + "T00:00:00");
    expect([2, 4]).toContain(d.getDay());
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
