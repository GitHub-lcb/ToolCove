import { i18n } from "./i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const INVALID_FILE_NAME = /[<>:"/\\|?*\u0000-\u001f]/;

export function getFileName(path) {
  return String(path ?? "").split(/[\\/]/).pop() || "";
}

export function formatFileSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${trimDecimal(value / 1024)} KB`;
  if (value < 1024 ** 3) return `${trimDecimal(value / 1024 ** 2)} MB`;
  return `${trimDecimal(value / 1024 ** 3)} GB`;
}

function trimDecimal(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function estimateBase64Bytes(value) {
  const normalized = String(value ?? "")
    .replace(/^data:[^,]*,/, "")
    .replace(/\s/g, "");
  if (!normalized) return 0;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(normalized.length * 3 / 4) - padding);
}

export function countLineEndings(text) {
  const value = String(text ?? "");
  if (!value) return { crlf: 0, lf: 0, cr: 0, lines: 0, mixed: false };
  const crlf = value.match(/\r\n/g)?.length || 0;
  const withoutCrlf = value.replace(/\r\n/g, "");
  const lf = withoutCrlf.match(/\n/g)?.length || 0;
  const cr = withoutCrlf.match(/\r/g)?.length || 0;
  const kinds = [crlf, lf, cr].filter(Boolean).length;
  return { crlf, lf, cr, lines: crlf + lf + cr + 1, mixed: kinds > 1 };
}

export function convertLineEndings(text, target = "LF") {
  const endings = { LF: "\n", CRLF: "\r\n", CR: "\r" };
  if (!endings[target]) throw new Error(t("toolbox.file.errLineEnding"));
  return String(text ?? "").replace(/\r\n|\r|\n/g, endings[target]);
}

export function buildRenamePreview(files, options = {}) {
  const source = Array.isArray(files) ? files : [];
  let replacer;
  try {
    replacer = createReplacer(options);
  } catch (error) {
    return source.map((file) => previewError(file, t("toolbox.file.errRegex", { error: error.message })));
  }

  const result = source.map((file, index) => {
    const sourceName = String(file?.name || getFileName(file?.path));
    const { stem, extension } = splitFileName(sourceName, options.preserveExtension !== false);
    let targetStem = replacer(stem);
    targetStem = `${String(options.prefix ?? "")}${targetStem}${String(options.suffix ?? "")}`;
    targetStem = changeCase(targetStem, options.caseMode);
    const number = formatSequence(index, options);
    if (number) {
      const separator = String(options.numberSeparator ?? "_");
      targetStem = options.numbering === "prefix"
        ? `${number}${separator}${targetStem}`
        : `${targetStem}${separator}${number}`;
    }
    const targetName = `${targetStem}${extension}`;
    const error = validateFileName(targetName);
    return {
      path: String(file?.path ?? ""),
      sourceName,
      targetName,
      changed: sourceName !== targetName,
      valid: !error,
      error,
    };
  });

  const targets = new Map();
  result.forEach((item, index) => {
    const key = item.targetName.toLocaleLowerCase();
    const indexes = targets.get(key) || [];
    indexes.push(index);
    targets.set(key, indexes);
  });
  for (const indexes of targets.values()) {
    if (indexes.length < 2) continue;
    indexes.forEach((index) => {
      result[index].valid = false;
      result[index].error = t("toolbox.file.errDupName");
    });
  }
  return result;
}

function createReplacer(options) {
  const find = String(options.find ?? "");
  if (!find) return (value) => value;
  const flags = options.caseSensitive === false ? "gi" : "g";
  const pattern = options.useRegex ? find : escapeRegExp(find);
  const regex = new RegExp(pattern, flags);
  const replacement = String(options.replace ?? "");
  return (value) => value.replace(regex, replacement);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitFileName(name, preserveExtension) {
  if (!preserveExtension) return { stem: name, extension: "" };
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

function changeCase(value, mode) {
  if (mode === "lower") return value.toLocaleLowerCase();
  if (mode === "upper") return value.toLocaleUpperCase();
  return value;
}

function formatSequence(index, options) {
  if (!options.numbering || options.numbering === "none") return "";
  const start = Number.isFinite(Number(options.numberStart)) ? Math.trunc(Number(options.numberStart)) : 1;
  const padding = Math.min(12, Math.max(1, Math.trunc(Number(options.numberPadding) || 1)));
  return String(start + index).padStart(padding, "0");
}

function validateFileName(name) {
  if (!name || name === "." || name === "..") return t("toolbox.file.errEmptyName");
  if (INVALID_FILE_NAME.test(name)) return t("toolbox.file.errInvalidChar");
  if (/[. ]$/.test(name)) return t("toolbox.file.errTrailing");
  if (WINDOWS_RESERVED.test(name)) return t("toolbox.file.errReserved");
  if (new TextEncoder().encode(name).length > 255) return t("toolbox.file.errTooLong");
  return "";
}

function previewError(file, error) {
  const sourceName = String(file?.name || getFileName(file?.path));
  return {
    path: String(file?.path ?? ""),
    sourceName,
    targetName: sourceName,
    changed: false,
    valid: false,
    error,
  };
}
