import { describe, expect, it } from "vitest";
import { i18n } from "./i18n/index.js";
import {
  addDateTime,
  calculateDateDifference,
  convertZonedDateTime,
  formatInstant,
  getNextCronRuns,
  parseTimestamp,
} from "./timeTool.js";

// 固定英文 locale，使 weekday 等本地化输出可断言
i18n.global.locale.value = "en-US";

describe("parseTimestamp", () => {
  it("auto-detects seconds vs milliseconds timestamps", () => {
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

  it("rejects non-integer and out-of-range timestamps", () => {
    expect(() => parseTimestamp("123.45")).toThrow(i18n.global.t("toolbox.time.errTimestampInteger"));
    expect(() => parseTimestamp("999999999999999999")).toThrow(i18n.global.t("toolbox.time.errTimestampRange"));
  });
});

describe("formatInstant", () => {
  it("formats the same instant in given IANA zones", () => {
    expect(formatInstant(1786505400000, "Asia/Shanghai")).toMatchObject({
      dateTime: "2026-08-12 11:30:00.000",
      offset: "UTC+8",
      weekday: "Wednesday",
    });
    expect(formatInstant(1786505400000, "America/New_York")).toMatchObject({
      dateTime: "2026-08-11 23:30:00.000",
      offset: "UTC-4",
      weekday: "Tuesday",
    });
  });
});

describe("convertZonedDateTime", () => {
  it("converts Shanghai wall time to New York time", () => {
    const result = convertZonedDateTime("2026-08-12T11:30", "Asia/Shanghai", "America/New_York");
    expect(result.source.dateTime).toBe("2026-08-12 11:30:00");
    expect(result.target.dateTime).toBe("2026-08-11 23:30:00");
    expect(result.timestamp).toBe(1786505400000);
  });

  it("rejects nonexistent DST instants", () => {
    expect(() => convertZonedDateTime("2026-03-08T02:30", "America/New_York", "Asia/Shanghai"))
      .toThrow(i18n.global.t("toolbox.time.errDstGap"));
  });
});

describe("date arithmetic", () => {
  it("uses calendar semantics for leap years and month ends", () => {
    expect(addDateTime("2024-02-28T10:00", 1, "days", "Asia/Shanghai").dateTime)
      .toBe("2024-02-29 10:00:00");
    expect(addDateTime("2024-01-31T10:00", 1, "months", "Asia/Shanghai").dateTime)
      .toBe("2024-02-29 10:00:00");
  });

  it("computes signed intervals between two instants", () => {
    expect(calculateDateDifference("2026-08-12T08:00", "2026-08-13T10:30", "Asia/Shanghai"))
      .toMatchObject({ totalMilliseconds: 95400000, days: 1, hours: 2, minutes: 30, seconds: 0 });
    expect(calculateDateDifference("2026-08-13T10:30", "2026-08-12T08:00", "Asia/Shanghai"))
      .toMatchObject({ totalMilliseconds: -95400000, days: -1, hours: -2, minutes: -30, seconds: 0 });
  });
});

describe("getNextCronRuns", () => {
  it("computes upcoming weekday runs in a given zone", () => {
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

  it("supports six-field cron with seconds and rejects invalid expressions", () => {
    const runs = getNextCronRuns("*/15 * * * * *", {
      zone: "UTC",
      currentDate: "2026-08-12T03:30:01Z",
      count: 2,
    });
    expect(runs.map((run) => run.dateTime)).toEqual(["2026-08-12 03:30:15", "2026-08-12 03:30:30"]);
    expect(() => getNextCronRuns("bad cron", { zone: "UTC" })).toThrow("Cron");
  });
});
