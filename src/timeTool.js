import { CronExpressionParser } from "cron-parser";
import { DateTime } from "luxon";
import { i18n } from "./i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

const INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const DATE_TIME_FORMAT = "yyyy-LL-dd HH:mm:ss";

function ensureZone(zone) {
  const value = String(zone || "").trim();
  if (!value || !DateTime.now().setZone(value).isValid) throw new Error(t("toolbox.time.errInvalidZone"));
  return value;
}

function parseLocalDateTime(input, zone) {
  const match = INPUT_RE.exec(String(input || "").trim());
  if (!match) throw new Error(t("toolbox.time.errIncompleteDateTime"));
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
    millisecond: 0,
  };
  const dateTime = DateTime.fromObject(parts, { zone: ensureZone(zone) });
  if (!dateTime.isValid) throw new Error(t("toolbox.time.errInvalidDateTime"));
  const keys = ["year", "month", "day", "hour", "minute", "second"];
  if (keys.some((key) => dateTime[key] !== parts[key])) {
    throw new Error(t("toolbox.time.errDstGap"));
  }
  return dateTime;
}

function formatOffset(offsetMinutes) {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const total = Math.abs(offsetMinutes);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

function formatDateTime(dateTime, includeMilliseconds = false) {
  return {
    dateTime: dateTime.toFormat(includeMilliseconds ? `${DATE_TIME_FORMAT}.SSS` : DATE_TIME_FORMAT),
    iso: dateTime.toISO({ suppressMilliseconds: !includeMilliseconds }),
    offset: formatOffset(dateTime.offset),
    zone: dateTime.zoneName,
    weekday: dateTime.setLocale(i18n.global.locale.value || "en-US").toFormat("cccc"),
  };
}

export function parseTimestamp(input, unit = "auto") {
  const text = String(input ?? "").trim();
  if (!/^-?\d+$/.test(text)) throw new Error(t("toolbox.time.errTimestampInteger"));
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(t("toolbox.time.errTimestampRange"));
  const resolvedUnit = unit === "auto" ? (Math.abs(value) < 100_000_000_000 ? "seconds" : "milliseconds") : unit;
  if (!['seconds', 'milliseconds'].includes(resolvedUnit)) throw new Error(t("toolbox.time.errTimestampUnit"));
  const milliseconds = resolvedUnit === "seconds" ? value * 1000 : value;
  const dateTime = DateTime.fromMillis(milliseconds, { zone: "UTC" });
  if (!dateTime.isValid) throw new Error(t("toolbox.time.errTimestampDateRange"));
  return {
    milliseconds,
    seconds: Math.trunc(milliseconds / 1000),
    unit: resolvedUnit,
    iso: dateTime.toISO(),
  };
}

export function formatInstant(milliseconds, zone) {
  const dateTime = DateTime.fromMillis(Number(milliseconds), { zone: ensureZone(zone) });
  if (!dateTime.isValid) throw new Error(t("toolbox.time.errInvalidInstant"));
  return formatDateTime(dateTime, true);
}

export function convertZonedDateTime(input, sourceZone, targetZone) {
  const source = parseLocalDateTime(input, sourceZone);
  const target = source.setZone(ensureZone(targetZone));
  return {
    source: formatDateTime(source),
    target: formatDateTime(target),
    timestamp: source.toMillis(),
  };
}

export function addDateTime(input, amount, unit, zone) {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new Error(t("toolbox.time.errInvalidAmount"));
  const supportedUnits = ["years", "months", "weeks", "days", "hours", "minutes", "seconds"];
  if (!supportedUnits.includes(unit)) throw new Error(t("toolbox.time.errCalcUnit"));
  const result = parseLocalDateTime(input, zone).plus({ [unit]: value });
  if (!result.isValid) throw new Error(t("toolbox.time.errCalcRange"));
  return { ...formatDateTime(result), timestamp: result.toMillis() };
}

export function calculateDateDifference(startInput, endInput, zone) {
  const start = parseLocalDateTime(startInput, zone);
  const end = parseLocalDateTime(endInput, zone);
  const totalMilliseconds = end.toMillis() - start.toMillis();
  const sign = Math.sign(totalMilliseconds);
  let remaining = Math.abs(totalMilliseconds);
  const days = Math.floor(remaining / 86_400_000);
  remaining %= 86_400_000;
  const hours = Math.floor(remaining / 3_600_000);
  remaining %= 3_600_000;
  const minutes = Math.floor(remaining / 60_000);
  remaining %= 60_000;
  const seconds = Math.floor(remaining / 1000);
  const signed = (value) => value === 0 ? 0 : value * sign;
  return {
    totalMilliseconds,
    totalSeconds: totalMilliseconds / 1000,
    totalMinutes: totalMilliseconds / 60_000,
    totalHours: totalMilliseconds / 3_600_000,
    days: signed(days),
    hours: signed(hours),
    minutes: signed(minutes),
    seconds: signed(seconds),
  };
}

export function getNextCronRuns(expression, options = {}) {
  const zone = ensureZone(options.zone || "UTC");
  const count = Math.min(20, Math.max(1, Math.trunc(Number(options.count) || 5)));
  try {
    const interval = CronExpressionParser.parse(String(expression || "").trim(), {
      currentDate: options.currentDate || new Date(),
      tz: zone,
    });
    return interval.take(count).map((cronDate) => {
      const dateTime = DateTime.fromJSDate(cronDate.toDate(), { zone });
      return { ...formatDateTime(dateTime), timestamp: dateTime.toMillis() };
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(t("toolbox.time.errInvalidCron", { err: message }));
  }
}

export function toDateTimeInput(milliseconds = Date.now(), zone = DateTime.local().zoneName) {
  const dateTime = DateTime.fromMillis(Number(milliseconds), { zone: ensureZone(zone) });
  if (!dateTime.isValid) return "";
  return dateTime.toFormat("yyyy-LL-dd'T'HH:mm:ss");
}
