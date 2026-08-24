const MAX_MATCHES = 1000;

function normalizeFlags(flags, forceGlobal = false) {
  const allowed = new Set(["d", "g", "i", "m", "s", "u", "v", "y"]);
  const result = [];
  for (const flag of String(flags || "")) {
    if (allowed.has(flag) && !result.includes(flag)) result.push(flag);
  }
  if (forceGlobal && !result.includes("g")) result.push("g");
  return result.join("");
}

function compileRegex(pattern, flags) {
  try {
    return new RegExp(String(pattern ?? ""), normalizeFlags(flags));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`正则表达式无效：${message}`);
  }
}

export function findRegexMatches(pattern, text, flags = "g", limit = MAX_MATCHES) {
  const source = String(text ?? "");
  if (!pattern) return { matches: [], truncated: false };
  const regex = compileRegex(pattern, flags);
  const matches = [];
  let match;

  if (!regex.global && !regex.sticky) {
    match = regex.exec(source);
    if (match) matches.push(toMatch(match));
    return { matches, truncated: false };
  }

  while ((match = regex.exec(source)) !== null) {
    matches.push(toMatch(match));
    if (matches.length >= limit) return { matches, truncated: true };
    if (match[0] === "") regex.lastIndex += 1;
  }
  return { matches, truncated: false };
}

function toMatch(match) {
  return {
    index: match.index,
    end: match.index + match[0].length,
    value: match[0],
    groups: match.slice(1),
    namedGroups: match.groups ? { ...match.groups } : {},
  };
}

export function buildHighlightSegments(text, matches) {
  const source = String(text ?? "");
  const segments = [];
  let cursor = 0;
  matches.forEach((match, matchIndex) => {
    if (match.index > cursor) segments.push({ text: source.slice(cursor, match.index), match: false });
    if (match.end > match.index) {
      segments.push({ text: source.slice(match.index, match.end), match: true, matchIndex });
      cursor = match.end;
    }
  });
  if (cursor < source.length) segments.push({ text: source.slice(cursor), match: false });
  return segments;
}

export function replaceText(text, find, replacement, options = {}) {
  const source = String(text ?? "");
  const target = String(find ?? "");
  if (!target) return source;
  const value = String(replacement ?? "");
  if (!options.regex) {
    return options.replaceAll ? source.split(target).join(value) : source.replace(target, value);
  }
  let flags = "";
  if (options.replaceAll) flags += "g";
  if (options.ignoreCase) flags += "i";
  if (options.multiline) flags += "m";
  if (options.dotAll) flags += "s";
  return source.replace(compileRegex(target, flags), value);
}

function splitLines(text) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n");
  return source === "" ? [] : source.split("\n");
}

export function processLines(text, action, options = {}) {
  let lines = splitLines(text);
  switch (action) {
    case "dedupe": {
      const seen = new Set();
      lines = lines.filter((line) => {
        let key = options.trimForCompare ? line.trim() : line;
        if (options.ignoreCase) key = key.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      break;
    }
    case "sort-asc":
      lines.sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
      break;
    case "sort-desc":
      lines.sort((a, b) => b.localeCompare(a, "zh-CN", { numeric: true }));
      break;
    case "sort-number":
      lines.sort((a, b) => Number(a.trim()) - Number(b.trim()));
      break;
    case "remove-empty":
      lines = lines.filter((line) => line.trim() !== "");
      break;
    case "trim":
      lines = lines.map((line) => line.trim());
      break;
    case "affix":
      lines = lines.map((line) => `${options.prefix || ""}${line}${options.suffix || ""}`);
      break;
    case "reverse":
      lines.reverse();
      break;
    default:
      throw new Error("不支持的行处理操作");
  }
  return lines.join("\n");
}

function splitWords(text) {
  return String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9\p{L}]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

export function convertNaming(text, style) {
  const words = splitWords(text);
  if (!words.length) return "";
  const cap = (word) => word.charAt(0).toUpperCase() + word.slice(1);
  switch (style) {
    case "camel": return words[0] + words.slice(1).map(cap).join("");
    case "pascal": return words.map(cap).join("");
    case "snake": return words.join("_");
    case "kebab": return words.join("-");
    case "constant": return words.join("_").toUpperCase();
    case "dot": return words.join(".");
    case "space": return words.join(" ");
    default: throw new Error("不支持的命名风格");
  }
}

export function getTextStats(text) {
  const source = String(text ?? "");
  if (!source) {
    return { characters: 0, charactersNoWhitespace: 0, lines: 0, words: 0, chineseCharacters: 0, bytes: 0, uniqueLines: 0, duplicateLines: 0, emptyLines: 0 };
  }
  const lines = splitLines(source);
  const nonEmptyLines = lines.filter((line) => line.trim() !== "");
  const uniqueLines = new Set(nonEmptyLines).size;
  const words = source.match(/[\p{L}\p{N}]+/gu) || [];
  const chineseCharacters = source.match(/[\p{Script=Han}]/gu) || [];
  return {
    characters: Array.from(source).length,
    charactersNoWhitespace: Array.from(source.replace(/\s/gu, "")).length,
    lines: source.endsWith("\n") ? Math.max(0, lines.length - 1) : lines.length,
    words: words.length,
    chineseCharacters: chineseCharacters.length,
    bytes: new TextEncoder().encode(source).length,
    uniqueLines,
    duplicateLines: nonEmptyLines.length - uniqueLines,
    emptyLines: lines.filter((line) => line.trim() === "").length - (source.endsWith("\n") ? 1 : 0),
  };
}
