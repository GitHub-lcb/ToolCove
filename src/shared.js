// 资料类型元数据（图标对应 Icon.vue 中的 name，cls 对应 App.vue 全局 tc-chip 配色类）
import { i18n } from "./i18n/index.js";
import { highlightCode } from "./highlight.js";

const t = (key, params) => i18n.global.t(key, params);

export const TYPES = {
  file: { labelKey: "common.typeFile", icon: "folder", cls: "tc-primary" },
  url: { labelKey: "common.typeUrl", icon: "link", cls: "tc-sky" },
  project: { labelKey: "common.typeProject", icon: "briefcase", cls: "tc-amber" },
  note: { labelKey: "common.typeNote", icon: "note", cls: "tc-accent" },
};

// 领域配色（循环取用；只用中性主色与领域色板，不混入 danger/success 语义色）
// 单一来源：DomainView 领域卡、IterationView 色点、ProblemView 等按 index 循环取色
export const DOMAIN_COLORS = ["var(--primary)", "var(--teal)", "var(--primary-hover)", "var(--amber)", "var(--fuchsia)", "var(--green)", "var(--orange)", "var(--sky)"];

// 发布用途（资料在上线发布单里的角色）
export const RELEASE_ROLES = {
  pool: { labelKey: "common.rolePool", shortKey: "common.rolePoolShort", icon: "upload", cls: "tc-primary" },
  sql: { labelKey: "common.roleSql", shortKey: "common.roleSqlShort", icon: "database", cls: "tc-teal" },
  config: { labelKey: "common.roleConfig", shortKey: "common.roleConfigShort", icon: "settings", cls: "tc-accent" },
  note: { labelKey: "common.roleNote", shortKey: "common.roleNoteShort", icon: "note", cls: "tc-note" },
};
export const RELEASE_ROLE_ORDER = ["pool", "sql", "config", "note"];

// 排序方式
export const SORTS = {
  updated: { labelKey: "common.sortUpdated" },
  created: { labelKey: "common.sortCreated" },
  name: { labelKey: "common.sortName" },
};

// 相对时间格式化
export function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return t("common.timeJustNow");
  if (m < 60) return t("common.timeMinutesAgo", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("common.timeHoursAgo", { n: h });
  const d = Math.floor(h / 24);
  if (d < 30) return t("common.timeDaysAgo", { n: d });
  const date = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// 日期助手
export function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const WEEKDAY_KEYS = ["common.weekSun", "common.weekMon", "common.weekTue", "common.weekWed", "common.weekThu", "common.weekFri", "common.weekSat"];
export function weekday(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return isNaN(d) ? "" : t(WEEKDAY_KEYS[d.getDay()]);
}
// 下一个周二 / 周四（含今天）
export function nextReleaseDate() {
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const t = new Date(today);
    t.setDate(today.getDate() + i);
    if (t.getDay() === 2 || t.getDay() === 4) return fmtDate(t);
  }
  return fmtDate(today);
}

// 由一条资料按发布用途派生发布项内容
export function releaseItemFromResource(res) {
  const role = res.role || "pool";
  if (role === "sql" || role === "config")
    return { kind: role, name: (res.title || res.value || "").trim(), value: (res.value || "").trim(), note: res.note || "" };
  return { kind: role, name: (res.value || res.title || "").trim(), value: "", note: res.note || "" };
}
// 组装某项目下全部资料的发布清单
export function buildReleaseItems(allItems, projectId) {
  return allItems
    .filter((it) => it.type !== "project" && it.projectId === projectId)
    .map((res) => ({ id: crypto.randomUUID(), resId: res.id, ...releaseItemFromResource(res), done: false }));
}

// ===================== 上线包（三表） =====================
// Pool 发布表列
export const PKG_POOL_COLS = [
  { key: "pool", labelKey: "common.colPool", type: "text" },
  { key: "content", labelKey: "common.colContent", type: "text" },
  { key: "devBranch", labelKey: "common.colDevBranch", type: "text" },
  { key: "testBranch", labelKey: "common.colTestBranch", type: "text" },
  { key: "uatBranch", labelKey: "common.colUatBranch", type: "text" },
  { key: "prodBranch", labelKey: "common.colProdBranch", type: "text" },
  { key: "backupMaster", labelKey: "common.colBackupMaster", type: "bool" },
  { key: "releaseMerged", labelKey: "common.colReleaseMerged", type: "bool" },
  { key: "dev", labelKey: "common.colDev", type: "text" },
  { key: "test", labelKey: "common.colTest", type: "text" },
  { key: "published", labelKey: "common.colPublished", type: "bool" },
  { key: "note", labelKey: "common.colNote", type: "text" },
];
// 制品表列
export const PKG_ART_COLS = [
  { key: "name", labelKey: "common.colArtifact", type: "text" },
  { key: "module", labelKey: "common.colModule", type: "text" },
  { key: "owner", labelKey: "common.colOwner", type: "text" },
  { key: "version", labelKey: "common.colVersion", type: "text" },
  { key: "note", labelKey: "common.colNote", type: "text" },
];
// 数据库脚本表列
export const PKG_DB_COLS = [
  { key: "db", labelKey: "common.colDatabase", type: "text" },
  { key: "file", labelKey: "common.colScriptFile", type: "text" },
  { key: "owner", labelKey: "common.colOwner", type: "text" },
  { key: "order", labelKey: "common.colOrder", type: "text" },
  { key: "note", labelKey: "common.colNote", type: "text" },
];

// 空的上线包结构
export function emptyPkg() {
  return { pools: [], artifacts: [], dbScripts: [] };
}
export function newPkgRow(cols) {
  const r = { id: crypto.randomUUID() };
  cols.forEach((c) => (r[c.key] = c.type === "bool" ? false : ""));
  return r;
}

function cellVal(row, col) {
  const v = row[col.key];
  if (col.type === "bool") return v ? t("common.yes") : t("common.no");
  return v == null ? "" : v;
}

// ===================== 上线包 xlsx 导出 =====================
const XLSX_BORDER = {
  top: { style: "thin", color: { argb: "FF808080" } },
  left: { style: "thin", color: { argb: "FF808080" } },
  bottom: { style: "thin", color: { argb: "FF808080" } },
  right: { style: "thin", color: { argb: "FF808080" } },
};
function fillOf(argb) {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}
// 在工作表上追加一段表：分区标题行 + 表头行 + 数据行（无数据时占位行）+ 空行
function addXlsxTable(ws, title, cols, rows, maxSpan) {
  const sec = ws.addRow([title]);
  ws.mergeCells(sec.number, 1, sec.number, maxSpan);
  for (let c = 1; c <= maxSpan; c++) {
    const cell = sec.getCell(c);
    cell.border = XLSX_BORDER;
    cell.fill = fillOf("FFD9E1F2");
    cell.font = { bold: true, size: 11, color: { argb: "FF1F3864" }, name: "Microsoft YaHei" };
  }
  const hd = ws.addRow(cols.map((c) => t(c.labelKey)));
  hd.eachCell({ includeEmpty: false }, (cell) => {
    cell.border = XLSX_BORDER;
    cell.fill = fillOf("FF8EA9DB");
    cell.font = { bold: true, size: 10, color: { argb: "FF1F3864" }, name: "Microsoft YaHei" };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  if ((rows || []).length) {
    for (const r of rows) {
      const row = ws.addRow(cols.map((c) => cellVal(r, c)));
      for (let c = 1; c <= cols.length; c++) {
        const cell = row.getCell(c);
        cell.border = XLSX_BORDER;
        cell.font = { size: 10, name: "Microsoft YaHei" };
        cell.alignment = { vertical: "middle", wrapText: true };
      }
    }
  } else {
    const empty = ws.addRow([t("common.none")]);
    ws.mergeCells(empty.number, 1, empty.number, cols.length);
    for (let c = 1; c <= cols.length; c++) {
      const cell = empty.getCell(c);
      cell.border = XLSX_BORDER;
      cell.font = { size: 10, color: { argb: "FF999999" }, name: "Microsoft YaHei" };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    }
  }
  ws.addRow([]);
}

// 生成上线包 Excel（真正的 .xlsx 二进制工作簿），返回 base64 字符串供原生侧写文件
// exceljs 体积较大，导出时才动态加载，避免拖慢启动
export async function buildReleaseXlsx(iteration) {
  const { default: ExcelJS } = await import("exceljs");
  const pkg = iteration.pkg || emptyPkg();
  const maxSpan = Math.max(PKG_POOL_COLS.length, PKG_ART_COLS.length, PKG_DB_COLS.length);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t("common.pkgSheet"));
  ws.columns = Array.from({ length: maxSpan }, () => ({ width: 26 }));

  const titleText =
    t("common.pkgTitleBase", { title: iteration.title || t("common.iteration") }) +
    (iteration.version ? t("common.pkgTitleVersion", { version: iteration.version }) : "") +
    (iteration.releaseDate ? t("common.pkgTitleDate", { date: iteration.releaseDate }) : "");
  const titleRow = ws.addRow([titleText]);
  ws.mergeCells(titleRow.number, 1, titleRow.number, maxSpan);
  titleRow.height = 26;
  for (let c = 1; c <= maxSpan; c++) {
    const cell = titleRow.getCell(c);
    cell.border = XLSX_BORDER;
    cell.fill = fillOf("FF4472C4");
    cell.font = { bold: true, size: 13, color: { argb: "FFFFFFFF" }, name: "Microsoft YaHei" };
    cell.alignment = { vertical: "middle" };
  }
  ws.addRow([]);

  addXlsxTable(ws, t("common.pkgTablePool"), PKG_POOL_COLS, pkg.pools, maxSpan);
  addXlsxTable(ws, t("common.pkgTableArt"), PKG_ART_COLS, pkg.artifacts, maxSpan);
  addXlsxTable(ws, t("common.pkgTableDb"), PKG_DB_COLS, pkg.dbScripts, maxSpan);

  const buf = await wb.xlsx.writeBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// ===================== 工时统计 =====================
// 收集迭代需求（子任务即工时 + 历史工时记录）与问题的按日工时，展平为统一条目
// mineName 有值时只统计自己：带平台处理人且不是本人的子任务不计入（无处理人的本地子任务视为自己的）
export function collectDayLogs(iterations, problems, mineName = "") {
  const entries = [];
  (iterations || []).forEach((it) =>
    (it.items || []).forEach((r) => {
      // 子任务工时（现行机制）：有工时且有归属日才进按日统计。
      // 有平台工时登记明细（logs）时按每条实际登记日逐条统计，跨天填写可正确拆分；
      // 无明细（本地手工子任务或明细拉取失败）回退子任务累计工时与归属日。
      (r.subtasks || []).forEach((s) => {
        const detail = Array.isArray(s.logs) && s.logs.length ? s.logs : null;
        if (detail) {
          detail.forEach((l) => {
            const h = Number(l.hours) || 0;
            if (h <= 0 || !l.date) return;
            // 明细带填写人时按填写人过滤；解析不到填写人时按子任务处理人兜底
            if (mineName && l.name && l.name !== mineName) return;
            if (mineName && !l.name && s.assignee && s.assignee !== mineName) return;
            entries.push({
              date: l.date,
              hours: h,
              source: "iteration",
              title: `${it.title} · ${s.name}`,
              note: r.name || "",
              it, // 迭代/需求/子任务引用：工时页未提交工时就地编辑/推送用
              r,
              s,
            });
          });
        } else {
          if (mineName && s.assignee && s.assignee !== mineName) return;
          const h = Number(s.hours) || 0;
          if (h > 0 && s.date)
            entries.push({
              date: s.date,
              hours: h,
              source: "iteration",
              title: `${it.title} · ${s.name}`,
              note: r.name || "",
              it,
              r,
              s,
            });
        }
      });
      // 历史「记一笔」工时记录（已下线录入，保留旧数据统计）
      (r.logs || []).forEach((l) =>
        entries.push({
          date: l.date,
          hours: Number(l.hours) || 0,
          source: "iteration",
          title: `${it.title} · ${r.name}`,
          note: l.note || "",
        })
      );
    })
  );
  (problems || []).forEach((p) =>
    (p.logs || []).forEach((l) =>
      entries.push({
        date: l.date,
        hours: Number(l.hours) || 0,
        source: "problem",
        title: p.title,
        note: l.note || "",
      })
    )
  );
  return entries;
}

export const WORK_SOURCES = {
  iteration: { labelKey: "common.sourceIteration", color: "var(--accent)" },
  problem: { labelKey: "common.sourceProblem", color: "var(--danger)" },
};

// 子任务工时登记明细：按登记日聚合升序（[{ date, hours }]），无明细返回空数组
export function subLogsByDate(s) {
  const map = {};
  ((s && s.logs) || []).forEach((l) => {
    const h = Number(l.hours) || 0;
    if (!l.date || h <= 0) return;
    map[l.date] = (map[l.date] || 0) + h;
  });
  return Object.keys(map)
    .sort()
    .map((d) => ({ date: d, hours: map[d] }));
}

// 子任务剩余未登记工时：总工时 - 已登记明细（四舍五入到 0.1），支持分次推送剩余部分
export function subRemaining(s) {
  const total = Math.max(0, Number(s && s.hours) || 0);
  const pushed = ((s && s.logs) || []).reduce((sum, l) => sum + (Number(l.hours) || 0), 0);
  return Math.max(0, Math.round((total - pushed) * 10) / 10);
}

// 子任务已登记到平台的工时合计（四舍五入到 0.1）
export function subPushedHours(s) {
  const pushed = ((s && s.logs) || []).reduce((sum, l) => sum + (Number(l.hours) || 0), 0);
  return Math.round(pushed * 10) / 10;
}

// ===================== 工时 xlsx 导出 =====================
// 把按日工时条目整理成 Excel 明细行（按日期升序）：日期/星期/来源/工时/事项/备注
export function workHoursRows(entries) {
  const round2 = (n) => Math.round(n * 100) / 100;
  return [...(entries || [])]
    .filter((e) => e && e.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((e) => ({
      date: e.date,
      weekday: weekday(e.date),
      source: (WORK_SOURCES[e.source] && t(WORK_SOURCES[e.source].labelKey)) || e.source || "",
      hours: round2(Number(e.hours) || 0),
      title: e.title || "",
      note: e.note || "",
    }));
}

// 生成个人工时 Excel（.xlsx 二进制工作簿），返回 base64 字符串供原生侧写文件
// exceljs 体积较大，导出时才动态加载，避免拖慢启动
export async function buildWorkHoursXlsx({ entries, from, to, userName = "" }) {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t("common.hoursSheet"));
  const cols = [
    { key: "date", labelKey: "common.hoursColDate" },
    { key: "weekday", labelKey: "common.hoursColWeekday" },
    { key: "source", labelKey: "common.hoursColSource" },
    { key: "hours", labelKey: "common.hoursColHours" },
    { key: "title", labelKey: "common.hoursColTitle" },
    { key: "note", labelKey: "common.colNote" },
  ];
  ws.columns = [13, 9, 11, 9, 42, 30].map((width) => ({ width }));

  const rows = workHoursRows(entries);
  const total = rows.reduce((s, r) => s + r.hours, 0);
  const itTotal = rows.filter((r) => r.source === t("common.sourceIteration")).reduce((s, r) => s + r.hours, 0);

  const titleText = t("common.hoursTitle", {
    name: userName || t("common.me"),
    from,
    to,
    count: rows.length,
    total: Math.round(total * 100) / 100,
  });
  const titleRow = ws.addRow([titleText]);
  ws.mergeCells(titleRow.number, 1, titleRow.number, cols.length);
  titleRow.height = 26;
  for (let c = 1; c <= cols.length; c++) {
    const cell = titleRow.getCell(c);
    cell.border = XLSX_BORDER;
    cell.fill = fillOf("FF4472C4");
    cell.font = { bold: true, size: 13, color: { argb: "FFFFFFFF" }, name: "Microsoft YaHei" };
    cell.alignment = { vertical: "middle" };
  }
  ws.addRow([]);

  addXlsxTable(
    ws,
    t("common.hoursTableSummary"),
    [
      { key: "k", labelKey: "common.statItem" },
      { key: "v", labelKey: "common.statValue" },
    ],
    [
      { k: t("common.statTotal"), v: Math.round(total * 100) / 100 },
      { k: t("common.statIteration"), v: Math.round(itTotal * 100) / 100 },
      { k: t("common.statProblem"), v: Math.round((total - itTotal) * 100) / 100 },
    ],
    cols.length
  );
  addXlsxTable(ws, t("common.hoursTableDetail"), cols, rows, cols.length);

  return bufferToBase64(await wb.xlsx.writeBuffer());
}

// ArrayBuffer/Uint8Array → base64（分块防调用栈溢出）
function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// 本周周一零点时间戳
export function startOfWeek(d = new Date()) {
  const t = new Date(d);
  const day = (t.getDay() + 6) % 7; // 周一=0
  t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() - day);
  return t;
}

// ===================== 轻量 Markdown 渲染 =====================
// AI 分析结果展示用：先整体 HTML 转义（防注入），再做常用语法替换。
// 支持：标题 / 粗体 / 行内码 / 围栏代码块（可选语言高亮）/ 表格 / 无序·有序列表 / 引用 / 分割线 / 链接。
// opts.highlight=true 时围栏代码块走 highlight.js 并带复制按钮（AI 对话用）；默认 false 保持既有输出。
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function mdCodeBlock(code, lang, highlight) {
  if (highlight && lang) {
    return `<pre class="md-code" data-lang="${lang}"><button type="button" class="md-copy">${t("common.copy")}</button><code class="hljs">${highlightCode(code, lang)}</code></pre>`;
  }
  return `<pre class="md-code">${escapeHtml(code)}</pre>`;
}
export function renderMarkdown(src, opts = {}) {
  const highlight = !!opts.highlight;
  const raw = String(src || "").replace(/\r\n/g, "\n");
  // 转义不改变行数，escapedLines 与 rawLines 下标一一对应；代码块内保留原文供高亮
  const escapedLines = escapeHtml(raw).split("\n");
  const rawLines = raw.split("\n");
  const out = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf = []; // 代码块原始行
  let listTag = ""; // "ul" | "ol"
  let tableBuf = []; // 连续表格行
  const closeList = () => {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = "";
    }
  };
  const openList = (tag) => {
    if (listTag !== tag) {
      closeList();
      out.push(`<${tag}>`);
      listTag = tag;
    }
  };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.map((line) => {
      const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
      return body.split("|").map((c) => mdInline(c.trim()));
    });
    tableBuf = [];
    // 第二行全为分隔单元（--- / :---: 等）才按表格输出，否则降级为段落
    if (rows.length >= 2 && rows[1].length && rows[1].every((c) => /^:?-{2,}:?$/.test(c))) {
      const head = rows[0];
      const body = rows.slice(2);
      let html = '<table class="md-table"><thead><tr>' + head.map((c) => `<th>${c}</th>`).join("") + "</tr></thead>";
      if (body.length) {
        html += "<tbody>" + body.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") + "</tbody>";
      }
      out.push(html + "</table>");
    } else {
      out.push(rows.map((r) => `<p>${r.join(" | ")}</p>`).join(""));
    }
  };
  for (let i = 0; i < escapedLines.length; i++) {
    const line = escapedLines[i];
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      if (inCode) {
        out.push(mdCodeBlock(codeBuf.join("\n"), codeLang, highlight));
        codeBuf = [];
        inCode = false;
        codeLang = "";
      } else {
        closeList();
        flushTable();
        inCode = true;
        codeLang = fence[1] || "";
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(rawLines[i]);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeList();
      tableBuf.push(line);
      continue;
    }
    flushTable();
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      closeList();
      const tag = "h" + Math.min(h[1].length + 2, 6); // # -> h3，避免撑爆卡片
      out.push(`<${tag}>${mdInline(h[2])}</${tag}>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      closeList();
      out.push("<hr>");
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    if (ul) {
      openList("ul");
      out.push(`<li>${mdInline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.\u3001)]\s+(.+)$/);
    if (ol) {
      openList("ol");
      out.push(`<li>${mdInline(ol[1])}</li>`);
      continue;
    }
    const bq = line.match(/^\s*&gt;\s?(.*)$/);
    if (bq) {
      closeList();
      out.push(`<blockquote>${mdInline(bq[1])}</blockquote>`);
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${mdInline(line)}</p>`);
  }
  if (inCode && codeBuf.length) out.push(mdCodeBlock(codeBuf.join("\n"), codeLang, highlight));
  flushTable();
  closeList();
  return out.join("");
}

// 错误对象转可读文案（原工时模块 errText，平台逻辑剥离后并入 shared）
export function errText(e) {
  if (e == null) return t("common.unknownError");
  if (typeof e === "string") return e;
  if (e.message) return e.message;
  try {
    return JSON.stringify(e).slice(0, 300);
  } catch {
    return String(e);
  }
}
