import { describe, expect, it } from "vitest";
import { i18n } from "./i18n/index.js";
import {
  builtinTemplates,
  createRandomSource,
  formatMockOutput,
  generateIdentifiers,
  generateMockRows,
  generateRandomValues,
  generateSequence,
  parseUlidTime,
} from "./generatorTool.js";

describe("random source", () => {
  it("same seed yields same sequence, different seed differs", () => {
    const first = createRandomSource("release-42");
    const second = createRandomSource("release-42");
    const third = createRandomSource("release-43");
    const values = (source) => Array.from({ length: 5 }, () => source.next());
    expect(values(first)).toEqual(values(second));
    expect(values(createRandomSource("release-42"))).not.toEqual(values(third));
  });
});

describe("identifier generation", () => {
  it("generates UUID v4 with correct version and variant bits", () => {
    const [uuid] = generateIdentifiers("uuid-v4", 1, { seed: "uuid-test" });
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("UUID v7 and ULID both preserve millisecond time", () => {
    const timestamp = Date.UTC(2026, 7, 12, 8, 30, 0, 123);
    const [uuid] = generateIdentifiers("uuid-v7", 1, { seed: "v7", timestamp });
    const [ulid] = generateIdentifiers("ulid", 1, { seed: "ulid", timestamp });
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(parseUlidTime(ulid)).toBe(timestamp);
  });

  it("Nano ID supports custom length/alphabet and rejects duplicate chars", () => {
    const values = generateIdentifiers("nanoid", 3, { seed: "nano", length: 12, alphabet: "ABC123" });
    expect(values).toHaveLength(3);
    expect(values.every((value) => /^[ABC123]{12}$/.test(value))).toBe(true);
    expect(() => generateIdentifiers("nanoid", 1, { alphabet: "AABC" })).toThrow(i18n.global.t("toolbox.generator.errAlphabetDup"));
  });
});

describe("random data", () => {
  it("generates integers, decimals and dates within range", () => {
    const integers = generateRandomValues("integer", 20, { seed: "number", min: 10, max: 20 });
    expect(integers.every((value) => Number.isInteger(value) && value >= 10 && value <= 20)).toBe(true);
    const decimals = generateRandomValues("decimal", 10, { seed: "decimal", min: 1, max: 2, precision: 3 });
    expect(decimals.every((value) => value >= 1 && value <= 2 && String(value).split(".")[1]?.length <= 3)).toBe(true);
    const dates = generateRandomValues("date", 10, { seed: "date", start: "2026-01-01", end: "2026-01-10" });
    expect(dates.every((value) => value >= "2026-01-01" && value <= "2026-01-10")).toBe(true);
  });

  it("generates well-formed emails, phones, IPv4 and CJK names", () => {
    expect(generateRandomValues("email", 4, { seed: "email" }).every((value) => /^[a-z][a-z0-9.]+@[^@]+\.[a-z]+$/.test(value))).toBe(true);
    expect(generateRandomValues("phone", 4, { seed: "phone" }).every((value) => /^1[3-9]\d{9}$/.test(value))).toBe(true);
    expect(generateRandomValues("ipv4", 4, { seed: "ip" }).every((value) => value.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255))).toBe(true);
    expect(generateRandomValues("name", 4, { seed: "name" }).every((value) => /^[\u4e00-\u9fff]{2,4}$/.test(value))).toBe(true);
  });
});

describe("mock data", () => {
  const fields = [
    { name: "id", type: "sequence", unique: true, params: "1001,1" },
    { name: "user_id", type: "uuid", unique: true },
    { name: "name", type: "name" },
    { name: "status", type: "enum", params: "pending,paid,closed" },
    { name: "score", type: "integer", params: "60,100", nullable: true, nullRate: 1 },
  ];

  it("generates row objects per field rules with unique/nullable constraints", () => {
    const rows = generateMockRows(fields, 8, { seed: "mock" });
    expect(rows).toHaveLength(8);
    expect(rows.map((row) => row.id)).toEqual([1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008]);
    expect(new Set(rows.map((row) => row.user_id)).size).toBe(8);
    expect(rows.every((row) => ["pending", "paid", "closed"].includes(row.status))).toBe(true);
    expect(rows.every((row) => row.score === null)).toBe(true);
  });

  it("ignores empty field names and rejects duplicates", () => {
    expect(generateMockRows([{ name: "", type: "string" }], 2, { seed: "empty" })).toEqual([{}, {}]);
    expect(() => generateMockRows([{ name: "id", type: "integer" }, { name: "id", type: "uuid" }], 1)).toThrow(i18n.global.t("toolbox.generator.errDupFields"));
  });

  it("formats JSON, CSV and SQL INSERT with proper escaping", () => {
    const rows = [{ id: 1, name: "O'Reilly", note: "a,b\nline" }];
    expect(JSON.parse(formatMockOutput(rows, "json"))).toEqual(rows);
    expect(formatMockOutput(rows, "csv")).toContain('"a,b\nline"');
    const sql = formatMockOutput(rows, "sql", { tableName: "demo_users" });
    expect(sql).toContain("INSERT INTO demo_users");
    expect(sql).toContain("O''Reilly");
  });

  it("all builtin templates generate data directly", () => {
    for (const template of builtinTemplates()) {
      const rows = generateMockRows(template.fields, 2, { seed: template.key });
      expect(rows).toHaveLength(2);
      expect(Object.keys(rows[0]).length).toBeGreaterThan(2);
    }
  });
});

describe("sequence generation", () => {
  it("supports start, step, padding and affix", () => {
    expect(generateSequence({ start: 7, step: 3, count: 4, padding: 4, prefix: "ORD-", suffix: "-CN" }))
      .toEqual(["ORD-0007-CN", "ORD-0010-CN", "ORD-0013-CN", "ORD-0016-CN"]);
  });

  it("supports radix 2-36 and case options", () => {
    expect(generateSequence({ start: 15, step: 1, count: 3, radix: 16, padding: 2, uppercase: true }))
      .toEqual(["0F", "10", "11"]);
    expect(() => generateSequence({ count: 10001 })).toThrow("10000");
  });
});
