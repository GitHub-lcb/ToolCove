const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const NANO_ALPHABET = "_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?";
const SURNAMES = ["赵", "钱", "孙", "李", "周", "吴", "郑", "王", "冯", "陈", "褚", "卫", "蒋", "沈", "韩", "杨", "朱", "秦", "许", "何", "张", "刘", "林", "黄", "马", "罗", "梁", "宋"];
const GIVEN_NAMES = ["伟", "芳", "娜", "敏", "静", "秀英", "强", "磊", "洋", "艳", "勇", "军", "杰", "娟", "涛", "明", "超", "平", "刚", "欣怡", "宇轩", "子涵", "雨桐", "浩然"];
const CITIES = ["北京", "上海", "广州", "深圳", "杭州", "南京", "苏州", "成都", "武汉", "西安", "长沙", "重庆", "青岛", "厦门"];
const DISTRICTS = ["朝阳区", "浦东新区", "南山区", "滨江区", "江宁区", "武侯区", "洪山区", "雁塔区", "岳麓区", "市中区"];
const ROADS = ["创新路", "科技大道", "人民路", "中山路", "建设路", "解放路", "文一路", "软件园路", "高新路"];
const COMPANY_PREFIXES = ["华云", "启明", "远航", "卓越", "新程", "智联", "博远", "星河", "鼎盛", "云杉"];
const COMPANY_SUFFIXES = ["科技", "信息", "网络", "供应链", "数据", "软件", "电子商务"];
const EMAIL_DOMAINS = ["example.com", "test.dev", "mail.local", "demo.cn"];
const PRODUCT_ADJECTIVES = ["轻量", "专业", "智能", "便携", "高速", "经典", "云端", "多功能"];
const PRODUCT_NOUNS = ["键盘", "显示器", "开发套件", "路由器", "移动硬盘", "办公椅", "耳机", "扩展坞"];

export const RANDOM_TYPES = [
  { key: "integer", label: "整数" },
  { key: "decimal", label: "小数" },
  { key: "boolean", label: "布尔值" },
  { key: "string", label: "随机字符串" },
  { key: "date", label: "日期" },
  { key: "datetime", label: "日期时间" },
  { key: "name", label: "中文姓名" },
  { key: "email", label: "邮箱" },
  { key: "phone", label: "手机号" },
  { key: "ipv4", label: "IPv4" },
  { key: "ipv6", label: "IPv6" },
  { key: "url", label: "URL" },
  { key: "company", label: "公司名称" },
  { key: "city", label: "城市" },
  { key: "address", label: "地址" },
  { key: "enum", label: "枚举值" },
];

export const MOCK_FIELD_TYPES = [
  { key: "sequence", label: "自增序号", hint: "起始值,步长" },
  { key: "uuid", label: "UUID v4", hint: "无需参数" },
  { key: "ulid", label: "ULID", hint: "无需参数" },
  ...RANDOM_TYPES,
];

export const BUILTIN_TEMPLATES = [
  {
    key: "user", label: "用户", desc: "账号、姓名与联系信息",
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
    key: "order", label: "订单", desc: "订单号、金额与履约状态",
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
    key: "product", label: "商品", desc: "SKU、价格与库存数据",
    fields: [
      { name: "id", type: "sequence", params: "1,1", unique: true },
      { name: "sku", type: "string", params: "12,upper-number", unique: true },
      { name: "name", type: "product" },
      { name: "category", type: "enum", params: "数码,办公,家居,软件,配件" },
      { name: "price", type: "decimal", params: "9.9,4999,2" },
      { name: "stock", type: "integer", params: "0,500" },
      { name: "active", type: "boolean" },
    ],
  },
  {
    key: "address", label: "地址簿", desc: "收件人与结构化地址",
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
    if (!globalThis.crypto?.getRandomValues) throw new Error("当前环境不支持安全随机数");
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return value[0] / 0x100000000;
  }
  return {
    next,
    int(min, max) {
      const lower = Math.ceil(Number(min));
      const upper = Math.floor(Number(max));
      if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) throw new Error("随机范围无效");
      return lower + Math.floor(next() * (upper - lower + 1));
    },
    pick(values) {
      const candidates = Array.isArray(values) ? values : [...String(values ?? "")];
      if (!candidates.length) throw new Error("候选值不能为空");
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
    throw new Error("不支持的标识符类型");
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
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(input)) throw new Error("ULID 格式无效");
  let time = 0n;
  for (const character of input.slice(0, 10)) time = time * 32n + BigInt(CROCKFORD.indexOf(character));
  if (time > 0xffffffffffffn) throw new Error("ULID 时间部分超出范围");
  return Number(time);
}

function nanoId(random, length, alphabet) {
  const size = Math.trunc(Number(length));
  if (!Number.isInteger(size) || size < 1 || size > 256) throw new Error("Nano ID 长度必须在 1 到 256 之间");
  validateAlphabet(alphabet);
  return Array.from({ length: size }, () => random.pick([...alphabet])).join("");
}

function validateAlphabet(alphabet) {
  const characters = [...String(alphabet ?? "")];
  if (characters.length < 2 || characters.length > 256) throw new Error("字符表长度必须在 2 到 256 之间");
  if (new Set(characters).size !== characters.length) throw new Error("字符表不能包含重复字符");
}

function checkedTimestamp(value) {
  const timestamp = Math.trunc(Number(value));
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) throw new Error("时间戳超出 48 位毫秒范围");
  return timestamp;
}

function checkedCount(value, max = 10000) {
  const count = Math.trunc(Number(value));
  if (!Number.isInteger(count) || count < 1 || count > max) throw new Error(`数量必须在 1 到 ${max} 之间`);
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
    case "company": return `${random.pick(COMPANY_PREFIXES)}${random.pick(COMPANY_SUFFIXES)}有限公司`;
    case "city": return random.pick(CITIES);
    case "address": return `${random.pick(CITIES)}${random.pick(DISTRICTS)}${random.pick(ROADS)}${random.int(1, 999)}号`;
    case "enum": return random.pick(parseEnum(options.values ?? options.params));
    case "uuid": return uuidV4(random);
    case "ulid": return ulid(random, checkedTimestamp(options.timestamp ?? Date.now()) + index);
    case "product": return `${random.pick(PRODUCT_ADJECTIVES)}${random.pick(PRODUCT_NOUNS)}`;
    default: throw new Error(`不支持的数据类型：${type}`);
  }
}

function numberOption(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function randomDecimal(random, min, max, precision) {
  if (min > max) throw new Error("最小值不能大于最大值");
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
  if (!Number.isInteger(size) || size < 1 || size > 1024) throw new Error("字符串长度必须在 1 到 1024 之间");
  const values = [...String(alphabet ?? "")];
  if (!values.length) throw new Error("字符表不能为空");
  return Array.from({ length: size }, () => random.pick(values)).join("");
}

function randomDate(random, start, end, includeTime) {
  const fallbackEnd = Date.now();
  const fallbackStart = fallbackEnd - 365 * 24 * 60 * 60 * 1000;
  const startTime = start ? new Date(start).getTime() : fallbackStart;
  const endTime = end ? new Date(end).getTime() + (includeTime ? 0 : 24 * 60 * 60 * 1000 - 1) : fallbackEnd;
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime) throw new Error("日期范围无效");
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
  const values = String(value ?? "").split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
  if (!values.length) throw new Error("枚举候选值不能为空");
  return values;
}

export function generateMockRows(fields, count, options = {}) {
  const total = checkedCount(count);
  const activeFields = (Array.isArray(fields) ? fields : []).filter((field) => String(field?.name ?? "").trim());
  const names = activeFields.map((field) => String(field.name).trim());
  if (new Set(names).size !== names.length) throw new Error("字段名重复，请修改后再生成");
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
        if (seen.has(uniqueKey(value))) throw new Error(`字段「${name}」无法在当前规则下生成足够的唯一值`);
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
  const parts = params.split(/[,，]/).map((item) => item.trim());
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
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(tableName)) throw new Error("SQL 表名只能包含字母、数字、下划线或 $，且不能以数字开头");
    if (!columns.length || !values.length) return "";
    const tuples = values.map((row) => `(${columns.map((column) => sqlValue(row?.[column])).join(", ")})`);
    return `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES\n${tuples.join(",\n")};`;
  }
  throw new Error("不支持的输出格式");
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
  if (radix < 2 || radix > 36) throw new Error("进制必须在 2 到 36 之间");
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(step)) throw new Error("起始值和步长必须是安全整数");
  return Array.from({ length: count }, (_, index) => {
    const value = start + step * index;
    if (!Number.isSafeInteger(value)) throw new Error("序列值超出安全整数范围");
    const sign = value < 0 ? "-" : "";
    let digits = Math.abs(value).toString(radix);
    if (options.uppercase) digits = digits.toUpperCase();
    digits = digits.padStart(padding, "0");
    return `${String(options.prefix ?? "")}${sign}${digits}${String(options.suffix ?? "")}`;
  });
}
