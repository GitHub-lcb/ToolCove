import { i18n } from "./i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const NANO_ALPHABET = "_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?";
// 中文 mock 语料以 unicode 转义书写，保持源码纯 ASCII
const SURNAMES = ["\u8d75", "\u94b1", "\u5b59", "\u674e", "\u5468", "\u5434", "\u90d1", "\u738b", "\u51af", "\u9648", "\u891a", "\u536b", "\u848b", "\u6c88", "\u97e9", "\u6768", "\u6731", "\u79e6", "\u8bb8", "\u4f55", "\u5f20", "\u5218", "\u6797", "\u9ec4", "\u9a6c", "\u7f57", "\u6881", "\u5b8b"];
const GIVEN_NAMES = ["\u4f1f", "\u82b3", "\u5a1c", "\u654f", "\u9759", "\u79c0\u82f1", "\u5f3a", "\u78ca", "\u6d0b", "\u8273", "\u52c7", "\u519b", "\u6770", "\u5a1f", "\u6d9b", "\u660e", "\u8d85", "\u5e73", "\u521a", "\u6b23\u6021", "\u5b87\u8f69", "\u5b50\u6db5", "\u96e8\u6850", "\u6d69\u7136"];
const CITIES = ["\u5317\u4eac", "\u4e0a\u6d77", "\u5e7f\u5dde", "\u6df1\u5733", "\u676d\u5dde", "\u5357\u4eac", "\u82cf\u5dde", "\u6210\u90fd", "\u6b66\u6c49", "\u897f\u5b89", "\u957f\u6c99", "\u91cd\u5e86", "\u9752\u5c9b", "\u53a6\u95e8"];
const DISTRICTS = ["\u671d\u9633\u533a", "\u6d66\u4e1c\u65b0\u533a", "\u5357\u5c71\u533a", "\u6ee8\u6c5f\u533a", "\u6c5f\u5b81\u533a", "\u6b66\u4faf\u533a", "\u6d2a\u5c71\u533a", "\u96c1\u5854\u533a", "\u5cb3\u9e93\u533a", "\u5e02\u4e2d\u533a"];
const ROADS = ["\u521b\u65b0\u8def", "\u79d1\u6280\u5927\u9053", "\u4eba\u6c11\u8def", "\u4e2d\u5c71\u8def", "\u5efa\u8bbe\u8def", "\u89e3\u653e\u8def", "\u6587\u4e00\u8def", "\u8f6f\u4ef6\u56ed\u8def", "\u9ad8\u65b0\u8def"];
const COMPANY_PREFIXES = ["\u534e\u4e91", "\u542f\u660e", "\u8fdc\u822a", "\u5353\u8d8a", "\u65b0\u7a0b", "\u667a\u8054", "\u535a\u8fdc", "\u661f\u6cb3", "\u9f0e\u76db", "\u4e91\u6749"];
const COMPANY_SUFFIXES = ["\u79d1\u6280", "\u4fe1\u606f", "\u7f51\u7edc", "\u4f9b\u5e94\u94fe", "\u6570\u636e", "\u8f6f\u4ef6", "\u7535\u5b50\u5546\u52a1"];
const COMPANY_TAIL = "\u6709\u9650\u516c\u53f8";
const ADDRESS_NO = "\u53f7";
const EMAIL_DOMAINS = ["example.com", "test.dev", "mail.local", "demo.cn"];
const PRODUCT_ADJECTIVES = ["\u8f7b\u91cf", "\u4e13\u4e1a", "\u667a\u80fd", "\u4fbf\u643a", "\u9ad8\u901f", "\u7ecf\u5178", "\u4e91\u7aef", "\u591a\u529f\u80fd"];
const PRODUCT_NOUNS = ["\u952e\u76d8", "\u663e\u793a\u5668", "\u5f00\u53d1\u5957\u4ef6", "\u8def\u7531\u5668", "\u79fb\u52a8\u786c\u76d8", "\u529e\u516c\u6905", "\u8033\u673a", "\u6269\u5c55\u575e"];

// 类型/模板清单含展示文案，改函数以便随语言切换重新求值
export function randomTypes() {
  return [
    { key: "integer", label: t("toolbox.generator.typeInteger") },
    { key: "decimal", label: t("toolbox.generator.typeDecimal") },
    { key: "boolean", label: t("toolbox.generator.typeBoolean") },
    { key: "string", label: t("toolbox.generator.typeString") },
    { key: "date", label: t("toolbox.generator.typeDate") },
    { key: "datetime", label: t("toolbox.generator.typeDatetime") },
    { key: "name", label: t("toolbox.generator.typeName") },
    { key: "email", label: t("toolbox.generator.typeEmail") },
    { key: "phone", label: t("toolbox.generator.typePhone") },
    { key: "ipv4", label: "IPv4" },
    { key: "ipv6", label: "IPv6" },
    { key: "url", label: "URL" },
    { key: "company", label: t("toolbox.generator.typeCompany") },
    { key: "city", label: t("toolbox.generator.typeCity") },
    { key: "address", label: t("toolbox.generator.typeAddress") },
    { key: "enum", label: t("toolbox.generator.typeEnum") },
  ];
}

export function mockFieldTypes() {
  return [
    { key: "sequence", label: t("toolbox.generator.fieldTypeSequence"), hint: t("toolbox.generator.hintSequence") },
    { key: "uuid", label: "UUID v4", hint: t("toolbox.generator.hintNoParams") },
    { key: "ulid", label: "ULID", hint: t("toolbox.generator.hintNoParams") },
    ...randomTypes(),
  ];
}

export function builtinTemplates() {
  return [
    {
      key: "user", label: t("toolbox.generator.tplUser"), desc: t("toolbox.generator.tplUserDesc"),
      fields: [
        { name: "id", type: "sequence", params: "1001,1", unique: true },
        { name: "user_id", type: "uuid", unique: true },
        { name: "name", type: "name" },
        { name: "email", type: "email", unique: true },
        { name: "phone", type: "phone" },
        { name: "city", type: "city" },
        { name: "enabled", type: "boolean" },
        { name: "created_at", type: "datetime", params: "2025-01-01,2026-12-31" },
      ],
    },
    {
      key: "order", label: t("toolbox.generator.tplOrder"), desc: t("toolbox.generator.tplOrderDesc"),
      fields: [
        { name: "id", type: "sequence", params: "1,1", unique: true },
        { name: "order_no", type: "string", params: "18,upper-number", unique: true },
        { name: "buyer_name", type: "name" },
        { name: "amount", type: "decimal", params: "10,9999,2" },
        { name: "status", type: "enum", params: "pending,paid,shipped,completed,cancelled" },
        { name: "shipping_address", type: "address" },
        { name: "created_at", type: "datetime", params: "2025-01-01,2026-12-31" },
      ],
    },
    {
      key: "product", label: t("toolbox.generator.tplProduct"), desc: t("toolbox.generator.tplProductDesc"),
      fields: [
        { name: "id", type: "sequence", params: "1,1", unique: true },
        { name: "sku", type: "string", params: "12,upper-number", unique: true },
        { name: "name", type: "product" },
        { name: "category", type: "enum", params: "\u6570\u7801,\u529e\u516c,\u5bb6\u5c45,\u8f6f\u4ef6,\u914d\u4ef6" },
        { name: "price", type: "decimal", params: "9.9,4999,2" },
        { name: "stock", type: "integer", params: "0,500" },
        { name: "active", type: "boolean" },
      ],
    },
    {
      key: "address", label: t("toolbox.generator.tplAddress"), desc: t("toolbox.generator.tplAddressDesc"),
      fields: [
        { name: "id", type: "sequence", params: "1,1", unique: true },
        { name: "contact", type: "name" },
        { name: "phone", type: "phone" },
        { name: "city", type: "city" },
        { name: "detail", type: "address" },
        { name: "postcode", type: "string", params: "6,number" },
        { name: "default", type: "boolean" },
      ],
    },
  ];
}

export function createRandomSource(seed = "") {
  const seedText = String(seed ?? "");
  let seeded = null;
  if (seedText) {
    let state = hashSeed(seedText);
    seeded = () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
    };
  }
  function next() {
    if (seeded) return seeded();
    if (!globalThis.crypto?.getRandomValues) throw new Error(t("toolbox.generator.errNoSecureRandom"));
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return value[0] / 0x100000000;
  }
  return {
    next,
    int(min, max) {
      const lower = Math.ceil(Number(min));
      const upper = Math.floor(Number(max));
      if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) throw new Error(t("toolbox.generator.errRandomRange"));
      return lower + Math.floor(next() * (upper - lower + 1));
    },
    pick(values) {
      const candidates = Array.isArray(values) ? values : [...String(values ?? "")];
      if (!candidates.length) throw new Error(t("toolbox.generator.errNoCandidates"));
      return candidates[Math.floor(next() * candidates.length)];
    },
    bytes(length) {
      return Uint8Array.from({ length }, () => Math.floor(next() * 256));
    },
  };
}

function hashSeed(value) {
  let hash = 1779033703 ^ value.length;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return (hash ^= hash >>> 16) >>> 0;
}

export function generateIdentifiers(type, count = 1, options = {}) {
  const total = checkedCount(count);
  const random = createRandomSource(options.seed);
  const timestamp = checkedTimestamp(options.timestamp ?? Date.now());
  if (type === "nanoid") validateAlphabet(options.alphabet ?? NANO_ALPHABET);
  return Array.from({ length: total }, (_, index) => {
    if (type === "uuid-v4") return uuidV4(random);
    if (type === "uuid-v7") return uuidV7(random, timestamp + index);
    if (type === "ulid") return ulid(random, timestamp + index);
    if (type === "nanoid") return nanoId(random, options.length ?? 21, options.alphabet ?? NANO_ALPHABET);
    throw new Error(t("toolbox.generator.errIdentifierType"));
  });
}

function uuidV4(random) {
  const bytes = random.bytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function uuidV7(random, timestamp) {
  const bytes = random.bytes(16);
  let time = BigInt(timestamp);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function formatUuid(bytes) {
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ulid(random, timestamp) {
  let time = BigInt(timestamp);
  let timePart = "";
  for (let index = 0; index < 10; index += 1) {
    timePart = CROCKFORD[Number(time & 31n)] + timePart;
    time >>= 5n;
  }
  let randomPart = "";
  for (let index = 0; index < 16; index += 1) randomPart += CROCKFORD[random.int(0, 31)];
  return timePart + randomPart;
}

export function parseUlidTime(value) {
  const input = String(value ?? "").toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(input)) throw new Error(t("toolbox.generator.errUlidFormat"));
  let time = 0n;
  for (const character of input.slice(0, 10)) time = time * 32n + BigInt(CROCKFORD.indexOf(character));
  if (time > 0xffffffffffffn) throw new Error(t("toolbox.generator.errUlidTime"));
  return Number(time);
}

function nanoId(random, length, alphabet) {
  const size = Math.trunc(Number(length));
  if (!Number.isInteger(size) || size < 1 || size > 256) throw new Error(t("toolbox.generator.errNanoLength"));
  validateAlphabet(alphabet);
  return Array.from({ length: size }, () => random.pick([...alphabet])).join("");
}

function validateAlphabet(alphabet) {
  const characters = [...String(alphabet ?? "")];
  if (characters.length < 2 || characters.length > 256) throw new Error(t("toolbox.generator.errAlphabetLength"));
  if (new Set(characters).size !== characters.length) throw new Error(t("toolbox.generator.errAlphabetDup"));
}

function checkedTimestamp(value) {
  const timestamp = Math.trunc(Number(value));
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) throw new Error(t("toolbox.generator.errTimestamp48"));
  return timestamp;
}

function checkedCount(value, max = 10000) {
  const count = Math.trunc(Number(value));
  if (!Number.isInteger(count) || count < 1 || count > max) throw new Error(t("toolbox.generator.errCountRange", { max }));
  return count;
}

export function generateRandomValues(type, count = 1, options = {}) {
  const total = checkedCount(count);
  const random = createRandomSource(options.seed);
  return Array.from({ length: total }, (_, index) => randomValue(type, options, random, index));
}

function randomValue(type, options, random, index = 0) {
  switch (type) {
    case "integer": return random.int(numberOption(options.min, 0), numberOption(options.max, 100));
    case "decimal": return randomDecimal(random, numberOption(options.min, 0), numberOption(options.max, 100), options.precision ?? 2);
    case "boolean": return random.next() >= 0.5;
    case "string": return randomString(random, options.length ?? 16, resolveStringAlphabet(options.alphabet ?? options.charset));
    case "date": return randomDate(random, options.start, options.end, false);
    case "datetime": return randomDate(random, options.start, options.end, true);
    case "name": return random.pick(SURNAMES) + random.pick(GIVEN_NAMES);
    case "email": return `${random.pick(LETTERS)}${randomString(random, random.int(5, 11), LETTERS + DIGITS)}@${random.pick(EMAIL_DOMAINS)}`;
    case "phone": return `1${random.pick("3456789")}${randomString(random, 9, DIGITS)}`;
    case "ipv4": return Array.from({ length: 4 }, () => random.int(0, 255)).join(".");
    case "ipv6": return Array.from({ length: 8 }, () => random.int(0, 0xffff).toString(16)).join(":");
    case "url": return `https://${randomString(random, random.int(6, 12), LETTERS)}.${random.pick(["com", "cn", "dev", "io"])}/${randomString(random, random.int(4, 10), LETTERS + DIGITS)}`;
    case "company": return `${random.pick(COMPANY_PREFIXES)}${random.pick(COMPANY_SUFFIXES)}${COMPANY_TAIL}`;
    case "city": return random.pick(CITIES);
    case "address": return `${random.pick(CITIES)}${random.pick(DISTRICTS)}${random.pick(ROADS)}${random.int(1, 999)}${ADDRESS_NO}`;
    case "enum": return random.pick(parseEnum(options.values ?? options.params));
    case "uuid": return uuidV4(random);
    case "ulid": return ulid(random, checkedTimestamp(options.timestamp ?? Date.now()) + index);
    case "product": return `${random.pick(PRODUCT_ADJECTIVES)}${random.pick(PRODUCT_NOUNS)}`;
    default: throw new Error(t("toolbox.generator.errUnsupportedType", { type }));
  }
}

function numberOption(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function randomDecimal(random, min, max, precision) {
  if (min > max) throw new Error(t("toolbox.generator.errMinGtMax"));
  const digits = Math.min(12, Math.max(0, Math.trunc(Number(precision) || 0)));
  return Number((min + random.next() * (max - min)).toFixed(digits));
}

function resolveStringAlphabet(value) {
  const presets = {
    "lower": LETTERS,
    "upper": UPPERCASE,
    "number": DIGITS,
    "lower-number": LETTERS + DIGITS,
    "upper-number": UPPERCASE + DIGITS,
    "letter-number": LETTERS + UPPERCASE + DIGITS,
    "all": LETTERS + UPPERCASE + DIGITS + SYMBOLS,
  };
  return presets[value] || String(value || LETTERS + UPPERCASE + DIGITS);
}

function randomString(random, length, alphabet) {
  const size = Math.trunc(Number(length));
  if (!Number.isInteger(size) || size < 1 || size > 1024) throw new Error(t("toolbox.generator.errStringLength"));
  const values = [...String(alphabet ?? "")];
  if (!values.length) throw new Error(t("toolbox.generator.errAlphabetEmpty"));
  return Array.from({ length: size }, () => random.pick(values)).join("");
}

function randomDate(random, start, end, includeTime) {
  const fallbackEnd = Date.now();
  const fallbackStart = fallbackEnd - 365 * 24 * 60 * 60 * 1000;
  const startTime = start ? new Date(start).getTime() : fallbackStart;
  const endTime = end ? new Date(end).getTime() + (includeTime ? 0 : 24 * 60 * 60 * 1000 - 1) : fallbackEnd;
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime) throw new Error(t("toolbox.generator.errDateRange"));
  const date = new Date(Math.floor(startTime + random.next() * (endTime - startTime + 1)));
  return includeTime ? toLocalDateTime(date) : toLocalDate(date);
}

function toLocalDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toLocalDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${toLocalDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseEnum(value) {
  // 兼容中英文逗号与换行分隔
  const values = String(value ?? "").split(/[,\uff0c\n]/).map((item) => item.trim()).filter(Boolean);
  if (!values.length) throw new Error(t("toolbox.generator.errEnumEmpty"));
  return values;
}

export function generateMockRows(fields, count, options = {}) {
  const total = checkedCount(count);
  const activeFields = (Array.isArray(fields) ? fields : []).filter((field) => String(field?.name ?? "").trim());
  const names = activeFields.map((field) => String(field.name).trim());
  if (new Set(names).size !== names.length) throw new Error(t("toolbox.generator.errDupFields"));
  const random = createRandomSource(options.seed);
  const uniqueValues = new Map();
  return Array.from({ length: total }, (_, rowIndex) => {
    const row = {};
    activeFields.forEach((field) => {
      const name = String(field.name).trim();
      const nullRate = Math.min(1, Math.max(0, Number(field.nullRate) || 0));
      if (field.nullable && random.next() < nullRate) {
        row[name] = null;
        return;
      }
      const createValue = () => mockFieldValue(field, rowIndex, random);
      let value = createValue();
      if (field.unique) {
        const seen = uniqueValues.get(name) || new Set();
        let attempts = 0;
        while (seen.has(uniqueKey(value)) && attempts < 100) {
          value = createValue();
          attempts += 1;
        }
        if (seen.has(uniqueKey(value))) throw new Error(t("toolbox.generator.errUniqueExhausted", { name }));
        seen.add(uniqueKey(value));
        uniqueValues.set(name, seen);
      }
      row[name] = value;
    });
    return row;
  });
}

function uniqueKey(value) {
  return value === null ? "null" : `${typeof value}:${String(value)}`;
}

function mockFieldValue(field, rowIndex, random) {
  const params = String(field.params ?? "");
  const parts = params.split(/[,\uff0c]/).map((item) => item.trim());
  if (field.type === "sequence") {
    const start = numberOption(parts[0], 1);
    const step = numberOption(parts[1], 1);
    return start + rowIndex * step;
  }
  const options = { params };
  if (field.type === "integer") [options.min, options.max] = [parts[0], parts[1]];
  if (field.type === "decimal") [options.min, options.max, options.precision] = [parts[0], parts[1], parts[2]];
  if (field.type === "string") [options.length, options.charset] = [parts[0], parts[1]];
  if (field.type === "date" || field.type === "datetime") [options.start, options.end] = [parts[0], parts[1]];
  if (field.type === "enum") options.values = params;
  return randomValue(field.type, options, random, rowIndex);
}

export function formatMockOutput(rows, format = "json", options = {}) {
  const values = Array.isArray(rows) ? rows : [];
  if (format === "json") return JSON.stringify(values, null, 2);
  const columns = [...new Set(values.flatMap((row) => Object.keys(row || {})))];
  if (format === "csv") {
    const lines = [columns.map(csvCell).join(",")];
    values.forEach((row) => lines.push(columns.map((column) => csvCell(row?.[column])).join(",")));
    return lines.join("\r\n");
  }
  if (format === "sql") {
    const tableName = String(options.tableName || "mock_data").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(tableName)) throw new Error(t("toolbox.generator.errSqlTableName"));
    if (!columns.length || !values.length) return "";
    const tuples = values.map((row) => `(${columns.map((column) => sqlValue(row?.[column])).join(", ")})`);
    return `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES\n${tuples.join(",\n")};`;
  }
  throw new Error(t("toolbox.generator.errOutputFormat"));
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

export function generateSequence(options = {}) {
  const count = checkedCount(options.count ?? 10);
  const start = Math.trunc(numberOption(options.start, 1));
  const step = Math.trunc(numberOption(options.step, 1));
  const radix = Math.trunc(numberOption(options.radix, 10));
  const padding = Math.min(128, Math.max(0, Math.trunc(numberOption(options.padding, 0))));
  if (radix < 2 || radix > 36) throw new Error(t("toolbox.generator.errRadix"));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(step)) throw new Error(t("toolbox.generator.errStartStep"));
  return Array.from({ length: count }, (_, index) => {
    const value = start + step * index;
    if (!Number.isSafeInteger(value)) throw new Error(t("toolbox.generator.errSeqOverflow"));
    const sign = value < 0 ? "-" : "";
    let digits = Math.abs(value).toString(radix);
    if (options.uppercase) digits = digits.toUpperCase();
    digits = digits.padStart(padding, "0");
    return `${String(options.prefix ?? "")}${sign}${digits}${String(options.suffix ?? "")}`;
  });
}
