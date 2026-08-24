// YAML 纯逻辑层：面向工程配置的 YAML 1.2 Core，并额外支持常见的合并键 <<。
import { CORE_SCHEMA, dump, loadAll, mergeTag } from "js-yaml";
import { parseJson } from "./json.js";
import { i18n } from "../i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

const YAML_SCHEMA = CORE_SCHEMA.withTags(mergeTag);
const MAX_SOURCE_LENGTH = 1024 * 1024;
const MAX_ALIASES = 50;
const MAX_DEPTH = 100;
const MAX_MERGE_KEYS = 5000;
const MAX_EXPANDED_NODES = 50000;
const MAX_OUTPUT_LENGTH = 2 * 1024 * 1024;

const LOAD_OPTIONS = {
  schema: YAML_SCHEMA,
  maxAliases: MAX_ALIASES,
  maxDepth: MAX_DEPTH,
  maxTotalMergeKeys: MAX_MERGE_KEYS,
};

function errorResult(message, line = 0, column = 0, kind = "syntax") {
  return { ok: false, error: { line, column, message, kind } };
}

function normalizeYamlError(error) {
  const line = error?.mark && typeof error.mark.line === "number" ? error.mark.line + 1 : 0;
  const column = error?.mark && typeof error.mark.column === "number" ? error.mark.column + 1 : 0;
  const reason = error?.reason || error?.message || String(error);
  if (/alias/i.test(reason) && /(limit|maximum|maxAliases)/i.test(reason)) {
    return { line, column, message: t("toolbox.yaml.errAliasLimit", { count: MAX_ALIASES }), kind: "syntax" };
  }
  if (/maximum nesting depth|maxDepth/i.test(reason)) {
    return { line, column, message: t("toolbox.yaml.errDepthLimit", { count: MAX_DEPTH }), kind: "syntax" };
  }
  if (/merge/i.test(reason) && /(limit|maximum)/i.test(reason)) {
    return { line, column, message: t("toolbox.yaml.errMergeLimit"), kind: "syntax" };
  }
  return { line, column, message: reason, kind: "syntax" };
}

// 成功时 documents 始终保留原始文档边界；value 兼容旧调用，单文档为值，多文档为数组。
export function parseYaml(text) {
  const source = String(text ?? "");
  if (source.length > MAX_SOURCE_LENGTH) {
    return errorResult(t("toolbox.yaml.errSourceTooLarge", { kb: MAX_SOURCE_LENGTH / 1024 }));
  }
  try {
    const documents = loadAll(source, LOAD_OPTIONS);
    return {
      ok: true,
      value: documents.length === 0 ? null : documents.length === 1 ? documents[0] : documents,
      documents,
      documentCount: documents.length,
      multiple: documents.length > 1,
      error: null,
    };
  } catch (error) {
    return { ok: false, error: normalizeYamlError(error) };
  }
}

function conversionError(message) {
  return {
    ok: false,
    output: "",
    error: { line: 0, column: 0, message, kind: "conversion" },
  };
}

// 把 YAML 解析结果复制成 JSON 可表达的数据，同时限制别名展开后的真实规模。
function toJsonCompatible(value) {
  const state = { nodes: 0 };

  function walk(current, ancestors) {
    state.nodes++;
    if (state.nodes > MAX_EXPANDED_NODES) {
      throw new Error(t("toolbox.yaml.errExpandedTooLarge"));
    }
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(t("toolbox.yaml.errNonFiniteNumber"));
      return current;
    }
    if (typeof current !== "object") {
      throw new Error(t("toolbox.yaml.errUnsupportedType", { type: typeof current }));
    }
    if (ancestors.has(current)) throw new Error(t("toolbox.yaml.errCircularRef"));

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(current);
    if (Array.isArray(current)) return current.map((item) => walk(item, nextAncestors));

    const output = {};
    for (const key of Object.keys(current)) {
      const converted = walk(current[key], nextAncestors);
      if (key === "__proto__") {
        Object.defineProperty(output, key, { value: converted, enumerable: true, configurable: true, writable: true });
      } else {
        output[key] = converted;
      }
    }
    return output;
  }

  return walk(value, new Set());
}

function ensureOutputSize(output, operation) {
  if (output.length > MAX_OUTPUT_LENGTH) {
    throw new Error(t("toolbox.yaml.errOutputTooLarge", { op: operation, kb: MAX_OUTPUT_LENGTH / 1024 }));
  }
  return output;
}

// YAML 校验并转换为格式化 JSON。语法错误与转换限制通过 error.kind 区分。
export function yamlToJson(text, indent = 2) {
  const parsed = parseYaml(text);
  if (!parsed.ok) return { ...parsed, output: "" };
  if (parsed.documentCount === 0) return { ok: true, output: "", empty: true, value: null, documentCount: 0 };
  try {
    const value = toJsonCompatible(parsed.value);
    const output = ensureOutputSize(JSON.stringify(value, null, indent), "JSON");
    return { ok: true, output, value, documentCount: parsed.documentCount, error: null };
  } catch (error) {
    return conversionError(error?.message || String(error));
  }
}

// YAML 格式化会重新序列化数据，因此注释不会进入结果；输入区原文不会被修改。
export function formatYaml(text, indent = 2) {
  const parsed = parseYaml(text);
  if (!parsed.ok) return { ...parsed, output: "" };
  if (parsed.documentCount === 0) return { ok: true, output: "", empty: true, documentCount: 0 };
  try {
    const chunks = parsed.documents.map((document) => dump(document, {
      schema: YAML_SCHEMA,
      indent,
      lineWidth: -1,
      noRefs: false,
    }).trimEnd());
    const output = ensureOutputSize(chunks.join("\n---\n") + "\n", "YAML");
    return { ok: true, output, documentCount: parsed.documentCount, error: null };
  } catch (error) {
    return conversionError(t("toolbox.yaml.errFormatFailed", { err: error?.message || String(error) }));
  }
}

export function jsonToYaml(text, indent = 2) {
  const parsed = parseJson(String(text ?? ""));
  if (!parsed.ok) return { ...parsed, output: "" };
  try {
    const output = ensureOutputSize(dump(parsed.value, {
      schema: YAML_SCHEMA,
      indent,
      lineWidth: -1,
      noRefs: false,
    }), "YAML");
    return { ok: true, output, value: parsed.value, error: null };
  } catch (error) {
    return conversionError(t("toolbox.yaml.errJsonToYamlFailed", { err: error?.message || String(error) }));
  }
}

// 去掉真正的 YAML 行注释；引号内及未由空白引出的 # 属于标量内容。
function stripComment(raw) {
  let quote = "";
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (quote === "'") {
      if (char === "'" && raw[i + 1] === "'") i++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
  }
  return raw;
}

function leadingSpaces(raw) {
  const match = /^ */.exec(raw);
  return match ? match[0].length : 0;
}

function startsBlockScalar(content) {
  return /(?:^|:\s+|-\s+)[|>](?:[1-9]?[+-]?|[+-]?[1-9]?)?$/.test(content.trimEnd());
}

// 只保留无需理解 YAML 层级即可确定的样式/兼容性提示；重复键由解析器负责。
export function lintYaml(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const warnings = [];
  let blockIndent = null;

  lines.forEach((raw, index) => {
    const line = index + 1;
    const indent = leadingSpaces(raw);
    if (blockIndent !== null) {
      if (!raw.trim() || indent > blockIndent) return;
      blockIndent = null;
    }

    const content = stripComment(raw);
    if (!content.trim()) return;

    if (/^[ \t]*\u3000/.test(raw)) {
      warnings.push({ line, message: t("toolbox.yaml.lintFullWidthSpace") });
    }
    if (/[ \t]+$/.test(raw)) {
      warnings.push({ line, message: t("toolbox.yaml.lintTrailingSpace") });
    }
    if (/^\s*(?:-\s+)?[\w\u4e00-\u9fff.-]+：(?=\s|$)/.test(content)) {
      warnings.push({ line, message: t("toolbox.yaml.lintFullWidthColon") });
    }
    if (/^\s*(?:-\s+)?[A-Za-z0-9_.-]+\s+:(?=\s|$)/.test(content)) {
      warnings.push({ line, message: t("toolbox.yaml.lintSpaceBeforeColon") });
    }
    const legacyBool = /(?:^|:\s+|-\s+)(ON|OFF|YES|NO|On|Off|Yes|No)\s*$/.exec(content);
    if (legacyBool) {
      warnings.push({ line, message: t("toolbox.yaml.lintLegacyBool", { value: legacyBool[1] }) });
    }
    if (startsBlockScalar(content)) blockIndent = indent;
  });

  return warnings;
}
