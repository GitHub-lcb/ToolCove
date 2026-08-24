import { describe, expect, it } from "vitest";
import {
  addDateTime,
  calculateDateDifference,
  convertZonedDateTime,
  formatInstant,
  getNextCronRuns,
  parseTimestamp,
} from "./timeTool.js";

describe("parseTimestamp", () => {
  it("自动识别秒级与毫秒级时间戳", () => {
    expect(parseTimestamp("1786505400")).toMatchObject({
      milliseconds: 1786505400000,
      seconds: 1786505400,
      unit: "seconds",
    });
    expect(parseTimestamp("1786505400000")).toMatchObject({
      milliseconds: 1786505400000,
      seconds: 1786505400,
      unit: "milliseconds",
    });
  });

  it("拒绝非整数和超出可表示范围的时间戳", () => {
    expect(() => parseTimestamp("123.45")).toThrow("整数");
    expect(() => parseTimestamp("999999999999999999")).toThrow("范围");
  });
});

describe("formatInstant", () => {
  it("在指定 IANA 时区格式化同一时刻", () => {
    expect(formatInstant(1786505400000, "Asia/Shanghai")).toMatchObject({
      dateTime: "2026-08-12 11:30:00.000",
      offset: "UTC+8",
      weekday: "星期三",
    });
    expect(formatInstant(1786505400000, "America/New_York")).toMatchObject({
      dateTime: "2026-08-11 23:30:00.000",
      offset: "UTC-4",
      weekday: "星期二",
    });
  });
});

describe("convertZonedDateTime", () => {
  it("把上海墙上时间转换为纽约时间", () => {
    const result = convertZonedDateTime("2026-08-12T11:30", "Asia/Shanghai", "America/New_York");
    expect(result.source.dateTime).toBe("2026-08-12 11:30:00");
    expect(result.target.dateTime).toBe("2026-08-11 23:30:00");
    expect(result.timestamp).toBe(1786505400000);
  });

  it("拒绝不存在的夏令时时刻", () => {
    expect(() => convertZonedDateTime("2026-03-08T02:30", "America/New_York", "Asia/Shanghai"))
      .toThrow("不存在");
  });
});

describe("日期计算", () => {
  it("使用日历语义处理闰年和月底", () => {
    expect(addDateTime("2024-02-28T10:00", 1, "days", "Asia/Shanghai").dateTime)
      .toBe("2024-02-29 10:00:00");
    expect(addDateTime("2024-01-31T10:00", 1, "months", "Asia/Shanghai").dateTime)
      .toBe("2024-02-29 10:00:00");
  });

  it("计算两个时刻之间的正负间隔", () => {
    expect(calculateDateDifference("2026-08-12T08:00", "2026-08-13T10:30", "Asia/Shanghai"))
      .toMatchObject({ totalMilliseconds: 95400000, days: 1, hours: 2, minutes: 30, seconds: 0 });
    expect(calculateDateDifference("2026-08-13T10:30", "2026-08-12T08:00", "Asia/Shanghai"))
      .toMatchObject({ totalMilliseconds: -95400000, days: -1, hours: -2, minutes: -30, seconds: 0 });
  });
});

describe("getNextCronRuns", () => {
  it("按指定时区计算工作日的后续执行时间", () => {
    const runs = getNextCronRuns("0 9 * * 1-5", {
      zone: "Asia/Shanghai",
      currentDate: "2026-08-14T09:00:01+08:00",
      count: 3,
    });
    expect(runs.map((run) => run.dateTime)).toEqual([
      "2026-08-17 09:00:00",
      "2026-08-18 09:00:00",
      "2026-08-19 09:00:00",
    ]);
  });

  it("支持含秒的六段 Cron 并校验非法表达式", () => {
    const runs = getNextCronRuns("*/15 * * * * *", {
      zone: "UTC",
      currentDate: "2026-08-12T03:30:01Z",
      count: 2,
    });
    expect(runs.map((run) => run.dateTime)).toEqual(["2026-08-12 03:30:15", "2026-08-12 03:30:30"]);
    expect(() => getNextCronRuns("bad cron", { zone: "UTC" })).toThrow("Cron");
  });
});
