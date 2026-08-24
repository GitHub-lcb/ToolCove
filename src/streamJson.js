// 增量 JSON 补全解析：文本是合法 JSON 的前缀时，虚拟补全未闭合结构后解析，
// 返回整树镜像（消费方可直接用于表单中间态渲染）。
// 返回 { ok: true, value } | { ok: false, reason }。
// reason: empty | not_string | not_json | bad_value | bad_number | bad_json
export function parsePartialJson(text) {
  if (typeof text !== "string") return { ok: false, reason: "not_string" };
  const src = text.trim();
  if (!src) return { ok: false, reason: "empty" };
  const first = src[0];
  if (first !== "{" && first !== "[") return { ok: false, reason: "not_json" };

  const scanned = scan(src);
  if (!scanned.ok) return scanned;
  const base = scanned.trimComma ? src.replace(/,\s*$/, "") : src;
  try {
    return { ok: true, value: JSON.parse(base + scanned.completion) };
  } catch {
    return { ok: false, reason: "bad_json" };
  }
}

// 扫描器：返回 { ok: true, completion }（completion 为 EOF 处需追加的补全文本）
// 或 { ok: false, reason }（明确的非法形态）。
function scan(src) {
  const n = src.length;
  let i = 0;
  const stack = []; // { type: "obj"|"arr", expect: "key"|"colon"|"value"|"sep" }
  let str = false; // 是否在字符串内
  let esc = 0; // 转义状态：0 无，1 刚遇到 \，2 刚遇到 \u，3-6 \u 后已收 hex 位数
  let lastOutChar = ""; // 最后一个字符串外的非空白字符（尾随逗号检测）
  let prevOut = ""; // 上一个字符串外的非空白字符（当前字符处理前的值）

  const top = () => stack[stack.length - 1];
  const fail = (reason) => ({ ok: false, reason });

  // 推进当前容器 expect（值已完整）
  const valueDone = () => {
    const t = top();
    if (!t) return;
    t.expect = "sep"; // 期待 , 或闭合符
  };
  // 处理分隔符/闭合符
  const onSepOrClose = (ch) => {
    const t = top();
    if (t.expect !== "sep") return fail("bad_value"); // 如 {"a":} 的空槽、尾随逗号后接闭合
    if (ch === ",") {
      t.expect = t.type === "obj" ? "key" : "value";
    } else {
      stack.pop();
      if (stack.length) valueDone(); // 内层闭合后外层值完整
    }
    return null;
  };
  // 处理值起始（对象值/数组元素）
  const onValueStart = (ch) => {
    const t = top();
    if (t.expect !== "value") return fail("bad_value");
    if (ch === "]" && t.type === "arr") {
      if (prevOut === ",") return fail("bad_value"); // 尾随逗号后闭合
      stack.pop();
      if (stack.length) valueDone();
      return null;
    }
    if (ch === "{" || ch === "[") {
      stack.push({ type: ch === "{" ? "obj" : "arr", expect: ch === "{" ? "key" : "value" });
      t.expect = "sep"; // 值已开始（等内层闭合后 valueDone 幂等）
    } else if (ch === '"') {
      str = true;
      esc = 0;
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      return scanNumber(ch);
    } else if (ch === "t" || ch === "f" || ch === "n") {
      return scanLiteral(ch);
    } else {
      return fail("bad_value");
    }
    return null;
  };

  // 数字：失败返回 fail；成功推进到数字末尾并 valueDone
  const scanNumber = (firstCh) => {
    let j = i;
    let ch = firstCh;
    if (ch === "-") {
      j++;
      ch = src[j];
      if (!ch || !(ch >= "0" && ch <= "9")) return fail("bad_number");
    }
    if (ch === "0") {
      j++;
      ch = src[j];
      if (ch >= "0" && ch <= "9") return fail("bad_number"); // 前导 0
    } else {
      while (ch >= "0" && ch <= "9") {
        j++;
        ch = src[j];
      }
    }
    if (ch === ".") {
      j++;
      ch = src[j];
      if (!(ch >= "0" && ch <= "9")) return fail("bad_number");
      while (ch >= "0" && ch <= "9") {
        j++;
        ch = src[j];
      }
    }
    if (ch === "e" || ch === "E") {
      j++;
      ch = src[j];
      if (ch === "+" || ch === "-") {
        j++;
        ch = src[j];
      }
      if (!(ch >= "0" && ch <= "9")) return fail("bad_number");
      while (ch >= "0" && ch <= "9") {
        j++;
        ch = src[j];
      }
    }
    i = j - 1; // 主循环 i++ 后对齐到最后一个数字字符
    valueDone();
    return null;
  };

  const scanLiteral = (firstCh) => {
    const word = firstCh === "t" ? "true" : firstCh === "f" ? "false" : "null";
    if (src.slice(i, i + word.length) !== word) return fail("bad_value");
    i += word.length - 1;
    valueDone();
    return null;
  };

  while (i < n) {
    const ch = src[i];
    if (str) {
      if (esc === 1) {
        if (ch === "u") {
          esc = 2;
        } else {
          esc = 0;
        }
      } else if (esc >= 2) {
        if (esc < 6) {
          if (isHex(ch)) esc++;
          else return fail("bad_value");
        } else {
          esc = 0;
        }
      } else if (ch === "\\") {
        esc = 1;
      } else if (ch === '"') {
        str = false;
        valueDone();
      } else if (ch === "\n" || ch === "\r") {
        return fail("bad_value"); // 字符串内裸换行
      }
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    prevOut = lastOutChar; // 前一个字符串外非空白字符（尾随逗号判定用）
    lastOutChar = ch;
    const t = top();
    if (!t) {
      // 顶层：只允许开启容器
      if (ch === "{" || ch === "[") {
        stack.push({ type: ch === "{" ? "obj" : "arr", expect: ch === "{" ? "key" : "value" });
      } else {
        return fail("bad_value");
      }
      i++;
      continue;
    }
    if (t.type === "obj") {
      if (t.expect === "key") {
        if (ch === '"') {
          // 键名：读到闭合引号
          let j = i + 1;
          let closed = false;
          while (j < n) {
            if (src[j] === "\\") j += 2;
            else if (src[j] === '"') {
              closed = true;
              break;
            } else j++;
          }
          if (!closed) return { ok: true, completion: '": ""' + closeStack() }; // 键名未闭合
          i = j;
          t.expect = "colon";
        } else if (ch === "}") {
          if (prevOut === ",") return fail("bad_value"); // 尾随逗号后闭合
          stack.pop();
          if (stack.length) valueDone();
        } else {
          return fail("bad_value");
        }
      } else if (t.expect === "colon") {
        if (ch === ":") t.expect = "value";
        else return fail("bad_value");
      } else if (t.expect === "value") {
        const r = onValueStart(ch);
        if (r) return r;
      } else {
        const r = onSepOrClose(ch);
        if (r) return r;
      }
    } else {
      // arr
      if (t.expect === "value") {
        const r = onValueStart(ch);
        if (r) return r;
      } else {
        const r = onSepOrClose(ch);
        if (r) return r;
      }
    }
    i++;
  }

  // ---- EOF：补全 ----
  if (str) {
    // 字符串未闭合：\u 序列不完整时无法补全（JSON.parse 兜底报 bad_json）
    if (esc >= 2) return fail("bad_value");
    if (stack.length) stack[stack.length - 1].expect = "sep"; // 补 " 后当前值完整
    return { ok: true, completion: '"' + closeStack() };
  }
  const t = top();
  const trimComma = !!(t && (t.expect === "key" || t.expect === "value") && lastOutChar === ",");
  return { ok: true, completion: closeStack(), trimComma };

  function closeStack() {
    let out = "";
    for (let k = stack.length - 1; k >= 0; k--) {
      const t = stack[k];
      if (t.type === "obj") {
        if (t.expect === "colon") out += ': ""}';
        else if (t.expect === "value") out += '""}';
        else out += "}";
      } else {
        out += "]";
      }
    }
    return out;
  }
}

function isHex(ch) {
  return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}
