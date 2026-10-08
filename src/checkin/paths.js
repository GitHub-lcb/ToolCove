// 响应字段取值：从 JSON 里按「路径表达式」取一个值。
//
// 为什么要有这层：站点描述文件是用户手填的，不知道响应长什么样，只能让用户告诉工具
// 「已签到这个字段在哪儿」。而这个路径直接决定界面上显示「已签」还是「未签」——
// 取错了就会谎报状态，所以语法必须收窄，且取不到时必须说「取不到」而不是猜成 false。

// 段名允许字母数字下划线连字符美元号；索引单独用 [n]。
// 刻意不允许点号出现在段名里：data..x 这种写法在别的实现里可能被解析成两段，
// 而用户看到的是一个段——宁可报错让他改。
const SEGMENT = /^[A-Za-z0-9_$-]+$/;
const INDEX = /^\d+$/;

// 原型链上的三个名字必须挡住：路径是外部输入，
// `__proto__.x` 能改到 Object.prototype，`constructor.x` 能摸到构造函数。
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/**
 * 把 "data.items[0].points" 解析成段数组。
 * 非法返回 null（不抛错——描述文件校验要把多个错误一次收齐，而不是遇到第一个就炸）。
 *
 * 用显式状态机而不是「找下一个分隔符」：段名的结束符有两个（. 和 [），
 * 只盯着一个就会把 "items[0]" 整段当段名，然后因非法字符把合法路径拒掉。
 */
export function parsePath(path) {
  const raw = String(path ?? "").trim();
  if (!raw || raw === ".") return [];
  const out = [];
  let i = 0;
  // start：整条路径开头；seg：刚读完 '.'；afterSeg：刚读完一个段名或 [n]
  let mode = "start";
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === ".") {
      if (mode !== "afterSeg") return null; // 开头的 '.' 或 "a..b"
      mode = "seg";
      i += 1;
      continue;
    }
    if (ch === "[") {
      if (mode !== "afterSeg") return null; // "[0]" 或 "a.[0]"
      const close = raw.indexOf("]", i);
      if (close < 0) return null;
      const inner = raw.slice(i + 1, close);
      if (!INDEX.test(inner)) return null;
      out.push(Number(inner));
      i = close + 1;
      mode = "afterSeg"; // "a[0][1]" 与 "a[0].x" 都从这儿继续
      continue;
    }
    if (mode !== "start" && mode !== "seg") return null; // "a[0]b"
    const next = raw.slice(i).search(/[.[]/);
    const seg = next < 0 ? raw.slice(i) : raw.slice(i, i + next);
    if (!SEGMENT.test(seg) || FORBIDDEN.has(seg)) return null;
    out.push(seg);
    i += seg.length;
    mode = "afterSeg";
  }
  // 停在 "seg" 说明路径以 '.' 结尾（"a."），那是非法而不是「根节点」
  if (mode === "seg" || !out.length) return null;
  return out;
}

function isMissing(value) {
  return value === undefined;
}

/**
 * 按段数组取值。只读自有属性：不 inherited，也就不可能被原型链上的东西骗到。
 * 中途遇到非容器（字符串/数字/null）就返回 undefined，而不是继续往下钻。
 */
export function pickSegments(source, segments) {
  let node = source;
  for (const seg of segments) {
    if (isMissing(node) || node === null) return undefined;
    if (Array.isArray(node)) {
      if (typeof seg !== "number" || seg < 0 || seg >= node.length) return undefined;
      node = node[seg];
      continue;
    }
    if (typeof node !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, seg)) return undefined;
    node = node[seg];
  }
  return node;
}

/** 一步到位：解析 + 取值。路径非法或取不到都返回 undefined（界面据此显示「无法判定」）。 */
export function pickPath(source, path) {
  const segments = parsePath(path);
  if (!segments) return undefined;
  return pickSegments(source, segments);
}

// 除了 true/false/1/0，也认「状态词」。
//
// 为什么必须认：有些接口根本不返回布尔值，而是给一个状态字符串。
// 实测 Qoder 的每日签到活动就是 claimStatus: "CLAIMABLE" / "CLAIMED"——
// 而顶层那个 claimable 布尔字段语义含糊，实测在明明可领的时候给出 false，
// 于是工具把该签的那天判成「已签」然后跳过（真实漏签过一次）。
// 真正准确的只有活动自己的 claimStatus。
//
// 全部按**精确整词**匹配，不做包含判断：unclaimed 的结尾也是 claimed，
// 用 includes 会把「未领取」认成「已领取」，结论正好反了。
const TRUTHY = new Set(["true", "1", "yes", "y", "claimed", "done", "finished", "received", "success"]);
const FALSY = new Set(["false", "0", "no", "n", "claimable", "available", "unclaimed", "pending", "todo", "not_claimed"]);

/**
 * 把「已签到」字段归一成 true / false / undefined。
 *
 * undefined（字段不存在或值看不懂）必须与 false 区分开：
 * false 是「接口明确说今天没签」，可以放心去签；
 * undefined 是「描述文件填的路径不对」，此时若当成 false 就去签，签完仍然显示不了状态，
 * 用户会以为工具坏了。区分开才能提示「核对路径」。
 */
export function toTriState(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (TRUTHY.has(text)) return true;
    if (FALSY.has(text)) return false;
  }
  return undefined;
}
