// PDF 工具纯逻辑层：页码范围解析 + 基于 pdf-lib 的「字节进字节出」页面操作。
// 不依赖 DOM / Tauri / i18n，可在 node 环境直接单测；UI 只负责取文件、组装参数、落盘与提示。
// 约束：pdf-lib 不能解密，遇到加密 PDF 抛 code=encrypted，绝不产出损坏文件。
import { PDFDocument, degrees } from "pdf-lib";

/** 逻辑层错误：带 code（UI 映射 i18n 文案）与可选 detail（原始 token / 文件名等）。 */
export function pdfError(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

const SEPARATOR = /[,，;；、\s]+/;
const TOKEN = /^(\d+)(?:\s*[-~—－]\s*(\d+))?$/;

/** 归一化旋转角到 [0,360)，pdf-lib 只认 0 / 90 / 180 / 270。 */
export function normalizeAngle(angle) {
  const value = Math.round(Number(angle) || 0);
  return ((value % 360) + 360) % 360;
}

/**
 * 解析页码表达式为「分组」：逗号分段，每段是拆分/提取的一个独立单元。
 * 输入 1 基（用户视角），输出 0 基页码；支持 1-3 / 1~3 / 反写 3-1（自动交换）。
 * 越界段做钳制（3-99 在 10 页文档里取 3-10）并把原始 token 记入 outOfRange，整体越界则不产组。
 */
export function parseRangeGroups(input, pageCount) {
  const total = Math.max(0, Math.floor(Number(pageCount) || 0));
  const tokens = String(input ?? "")
    .split(SEPARATOR)
    .map((token) => token.trim())
    .filter(Boolean);
  const groups = [];
  const invalid = [];
  const outOfRange = [];

  for (const token of tokens) {
    const match = token.match(TOKEN);
    if (!match) {
      invalid.push(token);
      continue;
    }
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    if (low < 1 || high > total) outOfRange.push(token);
    const from = Math.max(1, low);
    const to = Math.min(total, high);
    if (from > to) continue;
    const indices = [];
    for (let n = from; n <= to; n += 1) indices.push(n - 1);
    groups.push({ token, indices });
  }
  return { groups, invalid, outOfRange };
}

/** 展平所有分组为去重、保序的页码列表（提取/删除用；顺序即用户输入顺序）。 */
export function parsePageRanges(input, pageCount) {
  const seen = new Set();
  const indices = [];
  for (const group of parseRangeGroups(input, pageCount).groups) {
    for (const index of group.indices) {
      if (seen.has(index)) continue;
      seen.add(index);
      indices.push(index);
    }
  }
  return indices;
}

/** 页码列表 → 规范化表达式（1-3,5），用于结果摘要与文件名。 */
export function formatPageRanges(indices) {
  const sorted = [
    ...new Set((Array.isArray(indices) ? indices : []).filter((n) => Number.isInteger(n) && n >= 0)),
  ].sort((a, b) => a - b);
  const parts = [];
  let start = null;
  let prev = null;
  const flush = () => {
    if (start === null) return;
    parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
  };
  for (const n of sorted) {
    if (start === null) {
      start = n;
      prev = n;
      continue;
    }
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    flush();
    start = n;
    prev = n;
  }
  flush();
  return parts.join(",");
}

/** 拆分计划：留空 = 每页一个文件；否则每个逗号分段产出一个文件。 */
export function buildSplitGroups(input, pageCount) {
  const total = Math.max(0, Math.floor(Number(pageCount) || 0));
  if (String(input ?? "").trim()) return parseRangeGroups(input, total).groups;
  return Array.from({ length: total }, (_, index) => ({ token: String(index + 1), indices: [index] }));
}

/** 过滤非法/越界/重复页码，保持调用方给定顺序（顺序 = 输出页面顺序）。 */
export function normalizeIndices(indices, pageCount) {
  const total = Math.max(0, Math.floor(Number(pageCount) || 0));
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(indices) ? indices : []) {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= total || seen.has(index)) continue;
    seen.add(index);
    result.push(index);
  }
  return result;
}

/** 输出文件基名：去扩展名 + 去非法字符，空则回退 document。 */
export function pdfBaseName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop() || "";
  const stripped = base.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return stripped || "document";
}

/** 输出文件名：<基名>-<后缀>.pdf；后缀为空则不加连字符。 */
export function pdfOutputName(name, suffix) {
  const base = pdfBaseName(name);
  const tail = String(suffix ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return tail ? `${base}-${tail}.pdf` : `${base}.pdf`;
}

/**
 * 字节级判断「这份 PDF 是否带加密字典」。
 * 只在 PDFDocument.load 已经失败之后用作归因依据：宁可把损坏文件说成加密，也绝不能反过来
 * 把正常文件误判成加密拒掉 —— 所以匹配很保守：文件头必须是 %PDF-，且只在尾部 8KB 里找
 * /Encrypt 后跟引用（经典 trailer）或内联字典（xref 流字典）——两者都在文件末尾。
 * 禁止在此使用 Buffer：本模块同时跑在浏览器端。
 */
export function looksEncryptedPdf(bytes) {
  if (!bytes || bytes.length < 16) return false;
  const decoder = new TextDecoder("latin1");
  if (!decoder.decode(bytes.subarray(0, 8)).startsWith("%PDF-")) return false;
  const tail = decoder.decode(bytes.subarray(Math.max(0, bytes.length - 8192)));
  return /\/Encrypt\b\s*(\d+\s+\d+\s+R|<<)/.test(tail);
}

/**
 * 解析失败时的归因：尾部带加密字典就按「已加密」报，否则才说文件损坏。
 * 抽成纯函数便于单测 —— pdf-lib 对退化结构的容忍度在 CJS/ESM 构建间并不一致，
 * 靠构造「必然解析失败」的样本去测这条分支并不可靠。
 */
export function attributeLoadFailure(bytes) {
  return looksEncryptedPdf(bytes) ? pdfError("encrypted") : pdfError("invalid");
}

/**
 * 加载文档：加密文档必须显式拒绝，且要和「文件损坏」区分开。
 * 这里刻意不用 catch EncryptedPDFError —— pdf-lib 编译目标是 ES5，Error 子类的 instanceof 会失效
 * （实测 throw 出来的对象 constructor.name 是 Error），改用官方公开属性 isEncrypted 判定，
 * 配合 ignoreEncryption 只跳过它自己的抛错检查。
 * 但 isEncrypted 依赖能解析出 trailer：电子发票 / 银行回单一类「权限加密」文件常因对象流被加密
 * 而直接解析失败，此时必须靠 looksEncryptedPdf 归因，否则用户会被告知文件损坏。
 */
async function loadPdf(bytes) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    throw attributeLoadFailure(bytes);
  }
  if (doc.isEncrypted) throw pdfError("encrypted");
  // 解析通过但页面树取不出来（加密对象流常见症状）：同样按加密归因
  try {
    doc.getPages();
  } catch {
    throw attributeLoadFailure(bytes);
  }
  return doc;
}

function copyMetadata(source, target) {
  const title = source.getTitle();
  const author = source.getAuthor();
  const subject = source.getSubject();
  if (title) target.setTitle(title);
  if (author) target.setAuthor(author);
  if (subject) target.setSubject(subject);
}

async function copySelection(source, indices) {
  const target = await PDFDocument.create();
  const pages = await target.copyPages(source, indices);
  for (const page of pages) target.addPage(page);
  return target;
}

async function saveDocument(doc) {
  if (doc.getPageCount() === 0) throw pdfError("emptyResult");
  return doc.save();
}

/** 读取文档概要：页数、每页旋转角、页面尺寸分布与元数据（供 UI 显示与校验）。 */
export async function readPdfSummary(bytes) {
  const doc = await loadPdf(bytes);
  const sizes = [];
  const pageRotations = [];
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const label = `${Math.round(width)} × ${Math.round(height)} pt`;
    const found = sizes.find((item) => item.label === label);
    if (found) found.count += 1;
    else sizes.push({ label, count: 1 });
    pageRotations.push(normalizeAngle(page.getRotation().angle));
  }
  return {
    pageCount: doc.getPageCount(),
    pageRotations,
    sizes,
    title: doc.getTitle() || "",
    author: doc.getAuthor() || "",
    subject: doc.getSubject() || "",
    creator: doc.getCreator() || "",
    producer: doc.getProducer() || "",
    sizeBytes: bytes?.length || 0,
  };
}

/** 按给定顺序合并多个 PDF（页面尺寸/内容原样复制，标题作者沿用第一个文件）。 */
export async function mergePdfs(list) {
  const items = (Array.isArray(list) ? list : []).filter(Boolean);
  if (!items.length) throw pdfError("emptyInput");
  const target = await PDFDocument.create();
  let first = null;
  for (const bytes of items) {
    const source = await loadPdf(bytes);
    if (!first) first = source;
    const pages = await target.copyPages(source, source.getPageIndices());
    for (const page of pages) target.addPage(page);
  }
  if (first) copyMetadata(first, target);
  return saveDocument(target);
}

/** 提取指定页（顺序即入参顺序，可用来重排页面）。 */
export async function extractPages(bytes, indices) {
  const source = await loadPdf(bytes);
  const wanted = normalizeIndices(indices, source.getPageCount());
  if (!wanted.length) throw pdfError("emptySelection");
  const target = await copySelection(source, wanted);
  copyMetadata(source, target);
  return saveDocument(target);
}

/** 删除指定页，其余保持原顺序。 */
export async function removePages(bytes, indices) {
  const source = await loadPdf(bytes);
  const total = source.getPageCount();
  const dropped = new Set(normalizeIndices(indices, total));
  if (!dropped.size) throw pdfError("emptySelection");
  const kept = source.getPageIndices().filter((index) => !dropped.has(index));
  if (!kept.length) throw pdfError("emptyResult");
  const target = await copySelection(source, kept);
  copyMetadata(source, target);
  return saveDocument(target);
}

/** 旋转：angles 为 { 页码(0基): 增量角度 }，增量叠加在页面原有旋转上。 */
export async function rotatePages(bytes, angles) {
  const doc = await loadPdf(bytes);
  const pages = doc.getPages();
  let changed = 0;
  for (const [key, delta] of Object.entries(angles || {})) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) continue;
    const step = Number(delta) || 0;
    if (!step) continue;
    const page = pages[index];
    page.setRotation(degrees(normalizeAngle(page.getRotation().angle + step)));
    changed += 1;
  }
  if (!changed) throw pdfError("emptySelection");
  return saveDocument(doc);
}

/** 拆分：每个分组产出一个独立 PDF，返回 [{ token, indices, bytes }] 供 UI 落盘。 */
export async function splitPdf(bytes, groups) {
  const source = await loadPdf(bytes);
  const total = source.getPageCount();
  const plans = (Array.isArray(groups) ? groups : [])
    .map((group) => ({ token: String(group?.token ?? ""), indices: normalizeIndices(group?.indices, total) }))
    .filter((plan) => plan.indices.length);
  if (!plans.length) throw pdfError("emptySelection");
  const results = [];
  for (const plan of plans) {
    const target = await copySelection(source, plan.indices);
    copyMetadata(source, target);
    results.push({ token: plan.token, indices: plan.indices, bytes: await saveDocument(target) });
  }
  return results;
}
