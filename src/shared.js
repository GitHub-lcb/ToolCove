// 资料类型元数据（图标对应 Icon.vue 中的 name，cls 对应 App.vue 全局 tc-chip 配色类）
import { highlightCode } from "./highlight.js";

export const TYPES = {
  file: { label: "文件", icon: "folder", cls: "tc-primary" },
  url: { label: "链接", icon: "link", cls: "tc-sky" },
  project: { label: "项目", icon: "briefcase", cls: "tc-amber" },
  note: { label: "备注", icon: "note", cls: "tc-accent" },
};

// 领域配色（循环取用；只用中性主色与领域色板，不混入 danger/success 语义色）
// 单一来源：DomainView 领域卡、IterationView 色点、ProblemView 等按 index 循环取色
export const DOMAIN_COLORS = ["var(--primary)", "var(--teal)", "var(--primary-hover)", "var(--amber)", "var(--fuchsia)", "var(--green)", "var(--orange)", "var(--sky)"];

// 发布用途（资料在上线发布单里的角色）
export const RELEASE_ROLES = {
  pool: { label: "服务 / Pool", short: "Pool", icon: "upload", cls: "tc-primary" },
  sql: { label: "SQL 脚本", short: "SQL", icon: "database", cls: "tc-teal" },
  config: { label: "配置", short: "配置", icon: "settings", cls: "tc-accent" },
  note: { label: "说明 / 步骤", short: "说明", icon: "note", cls: "tc-note" },
};
export const RELEASE_ROLE_ORDER = ["pool", "sql", "config", "note"];

// 排序方式
export const SORTS = {
  updated: { label: "最近更新" },
  created: { label: "最近添加" },
  name: { label: "按名称" },
};

// 相对时间格式化
export function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const date = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// 日期助手
export function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
export function weekday(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return isNaN(d) ? "" : WEEKDAYS[d.getDay()];
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
  { key: "pool", label: "需要发布的Pool", type: "text" },
  { key: "content", label: "上线内容", type: "text" },
  { key: "devBranch", label: "开发分支", type: "text" },
  { key: "testBranch", label: "测试分支", type: "text" },
  { key: "uatBranch", label: "UAT分支", type: "text" },
  { key: "prodBranch", label: "上线分支", type: "text" },
  { key: "backupMaster", label: "是否备份master", type: "bool" },
  { key: "releaseMerged", label: "release合并完成", type: "bool" },
  { key: "dev", label: "研发", type: "text" },
  { key: "test", label: "测试", type: "text" },
  { key: "published", label: "是否已发布", type: "bool" },
  { key: "note", label: "备注", type: "text" },
];
// 制品表列
export const PKG_ART_COLS = [
  { key: "name", label: "制品", type: "text" },
  { key: "module", label: "模块", type: "text" },
  { key: "owner", label: "责任人", type: "text" },
  { key: "version", label: "版本", type: "text" },
  { key: "note", label: "备注", type: "text" },
];
// 数据库脚本表列
export const PKG_DB_COLS = [
  { key: "db", label: "数据库", type: "text" },
  { key: "file", label: "脚本文件", type: "text" },
  { key: "owner", label: "责任人", type: "text" },
  { key: "order", label: "多脚本执行顺序", type: "text" },
  { key: "note", label: "备注", type: "text" },
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
  if (col.type === "bool") return v ? "是" : "否";
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
  const hd = ws.addRow(cols.map((c) => c.label));
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
    const empty = ws.addRow(["（无）"]);
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
  const ws = wb.addWorksheet("上线包");
  ws.columns = Array.from({ length: maxSpan }, () => ({ width: 26 }));

  const titleText =
    `${iteration.title || "迭代"} 上线包` +
    (iteration.version ? " · " + iteration.version : "") +
    (iteration.releaseDate ? " · 计划上线 " + iteration.releaseDate : "");
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

  addXlsxTable(ws, "一、Pool 发布表", PKG_POOL_COLS, pkg.pools, maxSpan);
  addXlsxTable(ws, "二、制品表", PKG_ART_COLS, pkg.artifacts, maxSpan);
  addXlsxTable(ws, "三、数据库脚本表", PKG_DB_COLS, pkg.dbScripts, maxSpan);

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
// mineName 有值时只统计自己：带 Coding 处理人且不是本人的子任务不计入（无处理人的本地子任务视为自己的）
export function collectDayLogs(iterations, problems, mineName = "") {
  const entries = [];
  (iterations || []).forEach((it) =>
    (it.items || []).forEach((r) => {
      // 子任务工时（现行机制）：有工时且有归属日才进按日统计。
      // 有 Coding 工时登记明细（logs）时按每条实际登记日逐条统计，跨天填写可正确拆分；
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
  iteration: { label: "迭代需求", color: "var(--accent)" },
  problem: { label: "问题", color: "var(--danger)" },
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

// 子任务已登记到 Coding 的工时合计（四舍五入到 0.1）
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
      source: (WORK_SOURCES[e.source] && WORK_SOURCES[e.source].label) || e.source || "",
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
  const ws = wb.addWorksheet("工时");
  const cols = [
    { key: "date", label: "日期" },
    { key: "weekday", label: "星期" },
    { key: "source", label: "来源" },
    { key: "hours", label: "工时(h)" },
    { key: "title", label: "事项" },
    { key: "note", label: "备注" },
  ];
  ws.columns = [13, 9, 11, 9, 42, 30].map((width) => ({ width }));

  const rows = workHoursRows(entries);
  const total = rows.reduce((s, r) => s + r.hours, 0);
  const itTotal = rows.filter((r) => r.source === "迭代需求").reduce((s, r) => s + r.hours, 0);

  const titleText = `个人工时 · ${userName || "我"} · ${from} 至 ${to}（共 ${rows.length} 条，合计 ${Math.round(total * 100) / 100}h）`;
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
    "一、工时汇总",
    [
      { key: "k", label: "统计项" },
      { key: "v", label: "数值" },
    ],
    [
      { k: "总工时", v: Math.round(total * 100) / 100 },
      { k: "迭代需求工时", v: Math.round(itTotal * 100) / 100 },
      { k: "问题工时", v: Math.round((total - itTotal) * 100) / 100 },
    ],
    cols.length
  );
  addXlsxTable(ws, "二、工时明细", cols, rows, cols.length);

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
    return `<pre class="md-code" data-lang="${lang}"><button type="button" class="md-copy">复制</button><code class="hljs">${highlightCode(code, lang)}</code></pre>`;
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
    const ol = line.match(/^\s*\d+[.、)]\s+(.+)$/);
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

// 错误对象转可读文案（原 coding.js errText，Coding 剥离后并入 shared）
export function errText(e) {
  if (e == null) return "未知错误";
  if (typeof e === "string") return e;
  if (e.message) return e.message;
  try {
    return JSON.stringify(e).slice(0, 300);
  } catch {
    return String(e);
  }
}
