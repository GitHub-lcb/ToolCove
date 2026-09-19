// 表格工具（CSV/TSV/分隔文本）的纯逻辑：解析、嗅探、转换、统计、排序筛选。
//
// 为什么单独做这个工具：现有 15 个工具里，`generator` 只能**产出** CSV，`json` 只做 YAML↔JSON，
// **没有任何工具能解析和查看分隔文本**——而"看一眼导出报表、清洗两列、转成 JSON/SQL"是日常高频动作。
//
// 与相邻工具的边界（刻意划清，避免功能重叠）：
//   · 不做通用文本处理 → 那是 text 工具（正则/替换/行处理/命名）
//   · 不做 JSON 语法校验 → 那是 json 工具
//   · 只负责"分隔文本 ⇄ 结构化数据"这一件事，以及围绕它的表格操作
//
// 全部是纯函数，所以桌面端、网页版、手机端共用同一份实现（含手机端）。

/** 可选分隔符（嗅探候选）。 */
export const DELIMITERS = [
  { key: "comma", char: ",", labelKey: "toolbox.table.delimComma" },
  { key: "tab", char: "\t", labelKey: "toolbox.table.delimTab" },
  { key: "semicolon", char: ";", labelKey: "toolbox.table.delimSemicolon" },
  { key: "pipe", char: "|", labelKey: "toolbox.table.delimPipe" },
  { key: "space", char: " ", labelKey: "toolbox.table.delimSpace" },
];

/** 单个单元格的最大长度（防御畸形输入把内存吃满）。 */
const MAX_CELL = 100_000;
/** 最多解析的行数（超出的截断并标记，而不是让界面卡死）。 */
export const MAX_ROWS = 20_000;

/**
 * 解析分隔文本（RFC4180 风格）。
 *
 * 必须处理的真实情况：
 *   · 引号包裹的字段里含分隔符（`"a,b",c`）
 *   · 引号转义（`"他说""你好"""`）
 *   · 字段里含换行（Excel 导出的多行单元格）
 *   · CRLF / LF / CR 三种行尾混用
 *   · BOM 开头（Excel 另存 CSV 必带）
 *
 * @returns {{ rows: string[][], truncated: boolean, totalRows: number }}
 */
export function parseDelimited(text, delimiter = ",", { maxRows = MAX_ROWS } = {}) {
  const source = String(text ?? "").replace(/^\uFEFF/, ""); // 去 BOM，否则第一列会多一个看不见的字符
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  let truncated = false;
  let totalRows = 0;

  const pushCell = () => {
    row.push(cell.length > MAX_CELL ? cell.slice(0, MAX_CELL) : cell);
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    totalRows += 1;
    if (rows.length < maxRows) rows.push(row);
    else truncated = true;
    row = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        // 连续两个引号 = 一个字面引号；单个 = 结束引用
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      // 只有字段开头（还没内容）的引号才是引用开始——`ab"cd` 里的引号是普通字符
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      pushCell();
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // CRLF 算一次换行
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      pushRow();
      continue;
    }
    cell += ch;
  }
  // 收尾：最后一行没有换行符时也要落进来；但"以换行结尾"不该多出一个空行
  if (cell !== "" || row.length > 0) pushRow();

  return { rows, truncated, totalRows };
}

/**
 * 嗅探分隔符。
 *
 * 做法：对每个候选，按它切分前若干行，取"每行列数的众数"作为一致性得分，
 * 得分高且列数 > 1 的胜出。这比"数哪个字符出现次数多"可靠——
 * 后者会把内容里的逗号（如 `"a,b"` 或地址）误判成分隔符。
 */
export function detectDelimiter(text, { sampleLines = 20 } = {}) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  if (!source.trim()) return ",";
  const sample = source.split(/\r?\n/).slice(0, sampleLines).filter((line) => line.trim() !== "");
  if (!sample.length) return ",";

  let best = { char: ",", score: -1 };
  for (const { char } of DELIMITERS) {
    // 用完整解析（能正确处理引号内的分隔符），只看前若干行
    const counts = sample.map((line) => parseDelimited(line, char).rows[0]?.length ?? 1);
    const frequency = new Map();
    for (const count of counts) frequency.set(count, (frequency.get(count) || 0) + 1);
    const [modeCount, modeHits] = [...frequency.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] || [1, 0];
    // 列数必须 > 1 才算候选；得分 = 一致的行数（列数越多越优先）
    const score = modeCount > 1 ? modeHits * 100 + modeCount : -1;
    if (score > best.score) best = { char, score };
  }
  return best.char;
}

/** 把二维数组序列化成分隔文本（需要时加引号）。 */
export function toDelimited(rows, { delimiter = ",", eol = "\n", trailingNewline = false } = {}) {
  const escapeCell = (value) => {
    const text = value == null ? "" : String(value);
    // 含分隔符/引号/换行时必须加引号，否则解析不回来
    const needsQuote = text.includes(delimiter) || text.includes('"') || /[\r\n]/.test(text);
    return needsQuote ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const body = (rows || []).map((row) => (row || []).map(escapeCell).join(delimiter)).join(eol);
  return trailingNewline && body ? body + eol : body;
}

/**
 * 转 JSON。
 *
 * `header: true` 时第一行当键名，输出对象数组；否则输出二维数组。
 * 键名会去重（同名加 `_2`）——否则后一列会**静默覆盖**前一列，是真实的数据丢失。
 */
export function toJson(rows, { header = true, indent = 2 } = {}) {
  const list = rows || [];
  if (!header) return JSON.stringify(list, null, indent);
  if (!list.length) return "[]";
  const keys = dedupeKeys(list[0]);
  const body = list.slice(1).map((row) => {
    const item = {};
    keys.forEach((key, index) => {
      item[key] = row[index] ?? "";
    });
    return item;
  });
  return JSON.stringify(body, null, indent);
}

/** 表头去重：空列名给 `col1` 这样的占位，重名加序号。 */
export function dedupeKeys(headerRow) {
  const seen = new Map();
  return (headerRow || []).map((raw, index) => {
    let key = String(raw ?? "").trim() || `col${index + 1}`;
    if (seen.has(key)) {
      const count = seen.get(key) + 1;
      seen.set(key, count);
      key = `${key}_${count}`;
    } else {
      seen.set(key, 1);
    }
    return key;
  });
}

/** 转 Markdown 表格（贴文档用；`|` 必须转义，否则表格会错列）。 */
export function toMarkdown(rows) {
  const list = rows || [];
  if (!list.length) return "";
  const width = Math.max(...list.map((row) => row.length));
  const pad = (row) => Array.from({ length: width }, (_, i) => String(row[i] ?? "").replaceAll("|", "\\|").replace(/[\r\n]+/g, " "));
  const [head, ...body] = list;
  const lines = [`| ${pad(head).join(" | ")} |`, `| ${Array.from({ length: width }, () => "---").join(" | ")} |`];
  for (const row of body) lines.push(`| ${pad(row).join(" | ")} |`);
  return lines.join("\n");
}

/**
 * 转 SQL INSERT。
 *
 * 值一律按字符串转义后加引号（不做类型推断）——推断成数字会把 `007` 变成 `7`、
 * 把空串变成 NULL，那是**静默改数据**。表名与列名做标识符校验。
 */
export function toSqlInsert(rows, { table = "t", header = true, batchSize = 100 } = {}) {
  const list = rows || [];
  if (!list.length) return "";
  const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(table) ? table : "t";
  const columns = header ? dedupeKeys(list[0]) : [];
  const body = header ? list.slice(1) : list;
  const quote = (value) => `'${String(value ?? "").replaceAll("'", "''")}'`;
  const columnSql = columns.length ? ` (${columns.map((c) => `\`${c}\``).join(", ")})` : "";

  const statements = [];
  for (let i = 0; i < body.length; i += batchSize) {
    const chunk = body.slice(i, i + batchSize);
    const values = chunk.map((row) => `(${row.map(quote).join(", ")})`).join(",\n  ");
    statements.push(`INSERT INTO \`${name}\`${columnSql} VALUES\n  ${values};`);
  }
  return statements.join("\n\n");
}

/** 统计：行/列/空单元格/重复行/最长单元格——清洗前先看清数据长什么样。 */
export function stats(rows, { header = true } = {}) {
  const list = rows || [];
  const body = header ? list.slice(1) : list;
  const columns = Math.max(0, ...list.map((row) => row.length));
  let empty = 0;
  let longest = 0;
  for (const row of body) {
    for (let i = 0; i < columns; i += 1) {
      const value = row[i];
      if (value == null || String(value).trim() === "") empty += 1;
      longest = Math.max(longest, String(value ?? "").length);
    }
  }
  const seen = new Map();
  let duplicates = 0;
  for (const row of body) {
    const key = JSON.stringify(row);
    if (seen.has(key)) duplicates += 1;
    else seen.set(key, true);
  }
  return { rows: body.length, columns, cells: body.length * columns, empty, duplicates, longest };
}

/** 排序：`numeric` 时按数字比（否则 `10` 会排在 `9` 前面）。空值恒排在最后。 */
export function sortRows(rows, columnIndex, direction = "asc", { header = true, numeric = false } = {}) {
  const list = rows || [];
  const head = header ? list.slice(0, 1) : [];
  const body = header ? list.slice(1) : list.slice();
  const sign = direction === "desc" ? -1 : 1;
  const compare = (a, b) => {
    const left = a[columnIndex];
    const right = b[columnIndex];
    const leftEmpty = left == null || String(left).trim() === "";
    const rightEmpty = right == null || String(right).trim() === "";
    if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1; // 空值恒在最后
    if (numeric) {
      const ln = Number(String(left).replaceAll(",", ""));
      const rn = Number(String(right).replaceAll(",", ""));
      if (Number.isFinite(ln) && Number.isFinite(rn)) return (ln - rn) * sign;
    }
    return String(left).localeCompare(String(right), "zh-CN", { numeric: true }) * sign;
  };
  return [...head, ...body.sort(compare)];
}

/** 去重（保留首次出现）。 */
export function dedupeRows(rows, { header = true } = {}) {
  const list = rows || [];
  const head = header ? list.slice(0, 1) : [];
  const body = header ? list.slice(1) : list;
  const seen = new Set();
  const out = [];
  for (const row of body) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return [...head, ...out];
}

/** 删除整行为空的记录（全空行通常是导出文件的尾部噪声）。 */
export function removeEmptyRows(rows, { header = true } = {}) {
  const list = rows || [];
  const head = header ? list.slice(0, 1) : [];
  const body = header ? list.slice(1) : list;
  return [...head, ...body.filter((row) => row.some((cell) => cell != null && String(cell).trim() !== ""))];
}

/** 按列裁剪（保留列序，越界的忽略）。 */
export function selectColumns(rows, indexes) {
  const keep = (indexes || []).filter((i) => Number.isInteger(i) && i >= 0);
  return (rows || []).map((row) => keep.map((i) => row[i] ?? ""));
}

/**
 * 按条件过滤行（只支持等值/包含/非空三种——复杂条件交给 SQL 或 JSON 工具，
 * 这里保持"一眼能懂"的操作集）。
 */
export function filterRows(rows, { columnIndex = 0, op = "contains", value = "", header = true } = {}) {
  const list = rows || [];
  const head = header ? list.slice(0, 1) : [];
  const body = header ? list.slice(1) : list;
  const needle = String(value ?? "").toLowerCase();
  const match = (row) => {
    const cell = String(row[columnIndex] ?? "");
    if (op === "notEmpty") return cell.trim() !== "";
    if (op === "equals") return cell.toLowerCase() === needle;
    return cell.toLowerCase().includes(needle);
  };
  return [...head, ...body.filter(match)];
}
