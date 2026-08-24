import { createTwoFilesPatch, diffArrays } from "diff";

export function splitTextLines(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function normalizeLine(line, options) {
  let value = line;
  if (options.ignoreWhitespace) value = value.trim();
  if (options.ignoreCase) value = value.toLowerCase();
  return value;
}

function makeLine(lines, index) {
  return { number: index + 1, text: lines[index] };
}

function appendChangedRows(rows, removed, added, leftLines, rightLines, positions, stats) {
  const count = Math.max(removed, added);
  for (let i = 0; i < count; i += 1) {
    const hasLeft = i < removed;
    const hasRight = i < added;
    const left = hasLeft ? makeLine(leftLines, positions.left++) : null;
    const right = hasRight ? makeLine(rightLines, positions.right++) : null;
    let type;
    if (hasLeft && hasRight) {
      type = "modified";
      stats.modified += 1;
    } else if (hasLeft) {
      type = "removed";
      stats.removed += 1;
    } else {
      type = "added";
      stats.added += 1;
    }
    rows.push({ type, left, right });
  }
}

export function buildTextDiff(leftText, rightText, options = {}) {
  const leftLines = splitTextLines(leftText);
  const rightLines = splitTextLines(rightText);
  const leftComparable = leftLines.map((line) => normalizeLine(line, options));
  const rightComparable = rightLines.map((line) => normalizeLine(line, options));
  const changes = diffArrays(leftComparable, rightComparable, { timeout: 2000 });
  if (!changes) throw new Error("文本内容过大或差异过多，请缩小对比范围后重试");

  const rows = [];
  const stats = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  const positions = { left: 0, right: 0 };

  for (let i = 0; i < changes.length;) {
    const change = changes[i];
    if (!change.added && !change.removed) {
      for (let j = 0; j < change.count; j += 1) {
        rows.push({
          type: "equal",
          left: makeLine(leftLines, positions.left++),
          right: makeLine(rightLines, positions.right++),
        });
        stats.unchanged += 1;
      }
      i += 1;
      continue;
    }

    let removed = 0;
    let added = 0;
    while (i < changes.length && (changes[i].added || changes[i].removed)) {
      if (changes[i].removed) removed += changes[i].count;
      if (changes[i].added) added += changes[i].count;
      i += 1;
    }
    appendChangedRows(rows, removed, added, leftLines, rightLines, positions, stats);
  }

  return {
    rows,
    stats,
    hasChanges: stats.added + stats.removed + stats.modified > 0,
    leftLineCount: leftLines.length,
    rightLineCount: rightLines.length,
  };
}

export function createUnifiedDiff(leftText, rightText, options = {}) {
  const result = buildTextDiff(leftText, rightText, options);
  if (!result.hasChanges) return "";
  return createTwoFilesPatch(
    "原始文本",
    "新文本",
    String(leftText ?? "").replace(/\r\n?/g, "\n"),
    String(rightText ?? "").replace(/\r\n?/g, "\n"),
    "",
    "",
    {
      context: 3,
      ignoreCase: Boolean(options.ignoreCase),
      ignoreWhitespace: Boolean(options.ignoreWhitespace),
      ignoreNewlineAtEof: true,
      stripTrailingCr: true,
    },
  );
}
