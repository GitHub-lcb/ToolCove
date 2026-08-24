// JSON 语法高亮纯逻辑层（无 Vue、无 HTML 拼接，避免注入；便于单测）。
// 把文本逐行切分为着色片段：{ t: 文本, c: 类别 }，类别：key | str | num | bool | null | punct | plain
// 合法 JSON 的字符串不含裸换行，因此逐行独立分词是安全的（仅用于高亮自家格式化输出）。

const NUM_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;

export function highlightLine(line) {
  const out = [];
  let i = 0;
  const push = (t, c) => { if (t) out.push({ t, c }); };
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"') {
      // 扫描完整字符串（含转义）
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") j += 2;
        else if (line[j] === '"') { j++; break; }
        else j++;
      }
      const str = line.slice(i, j);
      // 其后第一个非空白字符是冒号则视为键
      let k = j;
      while (k < line.length && (line[k] === " " || line[k] === "\t")) k++;
      push(str, line[k] === ":" ? "key" : "str");
      i = j;
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const m = NUM_RE.exec(line.slice(i));
      if (m) { push(m[0], "num"); i += m[0].length; }
      else { push(ch, "plain"); i++; }
    } else if (line.startsWith("true", i)) { push("true", "bool"); i += 4; }
    else if (line.startsWith("false", i)) { push("false", "bool"); i += 5; }
    else if (line.startsWith("null", i)) { push("null", "null"); i += 4; }
    else if ("{}[]:,".includes(ch)) { push(ch, "punct"); i++; }
    else {
      // 空白与其它字符归为 plain，连续吃到下一个可识别字符
      let j = i + 1;
      while (j < line.length && !'"{}[]:,-0123456789tfn'.includes(line[j])) j++;
      push(line.slice(i, j), "plain");
      i = j;
    }
  }
  return out;
}

export function highlightLines(text) {
  return String(text ?? "").split("\n").map(highlightLine);
}
