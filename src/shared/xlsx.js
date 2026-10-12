// Excel 导出：上线包三表、个人工时表、数据库结果集。
//
// 为什么单独成文件（评审文档 §2.3 点名的那件事）：这三个构建函数此前躺在"通用"的
// shared.js 里，但它们的调用方各属一个模块（发布 / 工时 / 数据库工具），
// 且都带着同一套排版约定（表头配色、分区标题、空表占位行）。
// 收在一处后，"改导出的观感"只需要开一个文件；`exceljs` 依然是导出时才动态加载，
// 不进首屏 chunk。
//
// 三条链路的平台差异不同，刻意**不合并**：
//   · exportDbResultXlsx → 桌面端 rust_xlsxwriter 直写目标路径（不加载 exceljs、不过 base64）
//   · buildReleaseXlsx / buildWorkHoursXlsx → exceljs 生成工作簿，返回 base64 给原生侧写文件
import { i18n } from "../i18n/index.js";
import { invoke } from "../platform/invoke.js";
import { workHoursRows } from "./hours.js";
import { PKG_ART_COLS, PKG_DB_COLS, PKG_POOL_COLS, emptyPkg } from "./pkg.js";

const t = (key, params) => i18n.global.t(key, params);

const XLSX_BORDER = {
  top: { style: "thin", color: { argb: "FF808080" } },
  left: { style: "thin", color: { argb: "FF808080" } },
  bottom: { style: "thin", color: { argb: "FF808080" } },
  right: { style: "thin", color: { argb: "FF808080" } },
};

function fillOf(argb) {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function cellVal(row, col) {
  const v = row[col.key];
  if (col.type === "bool") return v ? t("common.yes") : t("common.no");
  return v == null ? "" : v;
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

// 工作簿大标题行（两张表共用同款蓝底白字）
function addXlsxTitle(ws, text, span) {
  const titleRow = ws.addRow([text]);
  ws.mergeCells(titleRow.number, 1, titleRow.number, span);
  titleRow.height = 26;
  for (let c = 1; c <= span; c++) {
    const cell = titleRow.getCell(c);
    cell.border = XLSX_BORDER;
    cell.fill = fillOf("FF4472C4");
    cell.font = { bold: true, size: 13, color: { argb: "FFFFFFFF" }, name: "Microsoft YaHei" };
    cell.alignment = { vertical: "middle" };
  }
  ws.addRow([]);
  return titleRow;
}

// 数据库结果集 → .xlsx：桌面端 rust_xlsxwriter 直写目标路径（不加载 exceljs、不过 base64）。
// 该导出只在桌面端提供（浏览器端 DbTool 直接提示需桌面版），故不做浏览器分支。
export async function exportDbResultXlsx(path, cols, rows) {
  await invoke("export_xlsx", {
    path,
    sheet: {
      name: t("common.dbSheet") || "Result",
      columns: cols.map((c) => Math.max(10, Math.min(46, String(c).length + 6))),
      header: cols.map((c) => String(c)),
      rows: rows.map((row) => row.map((v) => (v === null || v === undefined ? null : v))),
      freezeHeader: true,
    },
  });
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
  addXlsxTitle(ws, titleText, maxSpan);

  addXlsxTable(ws, t("common.pkgTablePool"), PKG_POOL_COLS, pkg.pools, maxSpan);
  addXlsxTable(ws, t("common.pkgTableArt"), PKG_ART_COLS, pkg.artifacts, maxSpan);
  addXlsxTable(ws, t("common.pkgTableDb"), PKG_DB_COLS, pkg.dbScripts, maxSpan);

  return bufferToBase64(await wb.xlsx.writeBuffer());
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
  addXlsxTitle(ws, titleText, cols.length);

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
