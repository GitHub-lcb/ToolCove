// 文件观察门禁（对标 DSH 的 fs-observation-policy：未读不许写）。
//
// 为什么需要它：file.write_text 原本可以在从未读取过的路径上盲写。模型很容易「以为文件是空的」
// 而覆盖掉真实内容——这是当前最可能造成真实数据损失的一条路径。
//
// 两套记账，刻意分开：
//   内容观察 contentObserved —— 成功读过内容（file.read_text / file.preview_write）。**这是唯一能开门禁的凭据。**
//   存在性证据 existence      —— 该路径当前存在 / 有证据不存在。用来阻止「盲创建覆盖同名文件」。
//
// 为什么 inspect 不算内容观察：它只读元信息，不看内容。同名不等于同内容，
// 拿「我看到有这个文件」去授权「我要用新内容覆盖它」是两回事。
//
// 存在性三态：
//   present → 有证据表明该路径存在
//   absent  → 有证据表明该路径当前不存在（读过但报「不存在」，或 inspect 证明缺失）→ 允许创建
//   unknown → 读过但失败且原因不是「不存在」（权限、编码、目录、超 10MB 限制……）
//
// unknown 刻意也拒绝写入：Tauri 侧 file_tool_read_text 把任何 IO 错误都包成
// 「无法读取文件：<e>」字符串（见 src-tauri/src/file_tool.rs），前端无法可靠区分「不存在」与
// 「读不了」。与其用字符串匹配去猜，不如让模型自己澄清——门禁只在有证据时放行。
//
// 拒绝文案要能教会模型自救，而不是甩一句「被拒绝」——形态取自 DSH 的
// `edit requires reading "<path>" first`。
//
// 本模块保持纯函数/纯内存：不 import Vue / Tauri / i18n，可在 node 环境直接单测。

export const OBSERVATION_STATUS = Object.freeze({ PRESENT: "present", ABSENT: "absent", UNKNOWN: "unknown" });

// 读到内容的工具：成功后既算内容观察、也算存在性证据
export const OBSERVE_CONTENT_TOOLS = Object.freeze(["file.read_text", "file.preview_write"]);
// 只证明存在性的工具：算存在性证据，但不算内容观察（不开门禁）
export const OBSERVE_EXISTENCE_TOOLS = Object.freeze(["file.inspect"]);
// 记账时要关心成败的全部工具
export const OBSERVE_TOOLS = Object.freeze([...OBSERVE_CONTENT_TOOLS, ...OBSERVE_EXISTENCE_TOOLS]);
// 受门禁保护的写入类工具
export const GUARDED_TOOLS = Object.freeze(["file.write_text", "file.preview_write"]);

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const stringOf = (value) => (typeof value === "string" ? value : "");
// 「文件不存在」的判定：Tauri 的错误串里会带 OS 的 not found（os error 2）
const ABSENT_PATTERN = /不存在|找不到|no such file|not found|os error 2\b/i;

/** 单路径归一：仅去首尾空白。不做 realpath——两侧都归一成同一个字符串即可比较。 */
export function normalizePath(path) {
  return stringOf(path).trim();
}

/**
 * 取出本次调用涉及的路径。不同工具的参数形状不同，必须分开取：
 *   file.read_text / file.write_text / file.preview_write → { path: string }
 *   file.inspect                                         → { paths: string[] }
 * 早先只读 args.path，导致 file.inspect 永远登记不上（inspect 成功却仍被门禁拦住写入）。
 */
export function pathsOf(toolName, args) {
  if (toolName === "file.inspect") {
    const list = Array.isArray(args?.paths) ? args.paths : [args?.paths];
    return [...new Set(list.map(normalizePath).filter(Boolean))];
  }
  const single = normalizePath(args?.path);
  return single ? [single] : [];
}

function namesPath(candidate, path) {
  if (!isPlainObject(candidate)) return false;
  for (const field of ["path", "file", "name", "fullPath", "full_path"]) {
    // 必须走 isSamePath：大小写与分隔符差异在 Windows 上是同一个文件，
    // 用字符串全等比较会让 C:/a.txt 与 c:\a.txt 认不出来。
    if (isSamePath(candidate[field], path)) return true;
  }
  return false;
}

/**
 * 在 inspect 的结果里找该路径的证据；找到返回 true，找不到返回 undefined（= 没有证据）。
 *
 * 返回形状未知（可能是数组、也可能包在 paths / files.list 这类嵌套对象里），所以整棵树
 * 广度优先遍历：每个对象都按候选字段名比对一次，同时继续往下走。**不能只遍历数组层的项**
 * ——那样 { paths: [...] } 这种包装永远找不到（inspect 成功却登记不上，写入一直被拒）。
 * seen 挡住循环引用；比对失败只是保守地不放行，不会误放行。
 */
export function findInspectEvidence(result, path) {
  const target = normalizePath(path);
  if (!target) return undefined;
  const queue = [result];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (current == null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    // 数组本身不是候选（namesPath 只认普通对象），但它的项要继续往下走；
    // 普通对象既可能是候选、也可能只是包装层，两件事都做。
    if (namesPath(current, target)) return true;
    for (const item of Array.isArray(current) ? current : Object.values(current)) queue.push(item);
  }
  return undefined;
}

/** 路径比较：大小写不敏感，容忍分隔符差异（Windows 上 C:\a\b 与 c:/a/b 是同一个文件）。 */
export function isSamePath(a, b) {
  const norm = (p) => normalizePath(p).replace(/[\\/]+/g, "\\").toLowerCase();
  const left = norm(a);
  return !!left && left === norm(b);
}

function matchesPath(recorded, path) {
  for (const key of recorded) if (isSamePath(key, path)) return true;
  return false;
}

/**
 * 建一次运行的观察门禁。
 * @param {{probeMissing?: boolean}} options probeMissing=false 关闭「读过但不存在」的判定（默认开启）
 */
export function createObservationGate(options = {}) {
  const probeMissing = options.probeMissing !== false;
  // 存归一化后的原始串做展示，比较走 isSamePath（大小写/分隔符无关）
  const contentObserved = new Set();
  const existence = new Map();

  const remember = (set, path) => {
    const key = normalizePath(path);
    if (!key) return false;
    for (const existing of set) if (isSamePath(existing, key)) return true;
    set.add(key);
    return true;
  };
  const rememberStatus = (path, value) => {
    const key = normalizePath(path);
    if (key) existence.set(key, value);
    return !!key;
  };
  const statusKeyOf = (path) => {
    for (const [key, value] of existence) if (isSamePath(key, path)) return value;
    return undefined;
  };

  return {
    statusOf: (path) => statusKeyOf(path) || OBSERVATION_STATUS.UNKNOWN,
    hasContent: (path) => matchesPath(contentObserved, path),
    get size() {
      return contentObserved.size;
    },
    clear() {
      contentObserved.clear();
      existence.clear();
    },

    /** 成功执行观察类工具后登记。返回是否登记成功（缺路径参数时不登记）。 */
    observeSuccess(toolName, args, result) {
      const paths = pathsOf(toolName, args);
      if (!paths.length) return false;
      return paths.reduce((any, path) => {
        if (toolName === "file.inspect") {
          // inspect 成功且返回里点名了该路径 → 存在性证据。返回形状不符时不猜。
          if (findInspectEvidence(result, path)) return rememberStatus(path, OBSERVATION_STATUS.PRESENT) || any;
          return any;
        }
        // read_text / preview_write：读到内容 → 既开门禁，也证明存在
        remember(contentObserved, path);
        return rememberStatus(path, OBSERVATION_STATUS.PRESENT) || any;
      }, false);
    },

    /**
     * 观察类工具失败后登记。probeMissing 开启时，错误文本里出现「不存在/找不到」视为「确定缺失」，
     * 允许后续创建；其余失败归为 unknown（拒写，要求模型先澄清）。
     */
    observeFailure(toolName, args, error) {
      if (toolName === "file.inspect") return false; // inspect 失败同样没有证据
      const paths = pathsOf(toolName, args);
      if (!paths.length) return false;
      const message = stringOf(error?.message || error);
      const absent = probeMissing && ABSENT_PATTERN.test(message);
      return paths.reduce(
        (any, path) => rememberStatus(path, absent ? OBSERVATION_STATUS.ABSENT : OBSERVATION_STATUS.UNKNOWN) || any,
        false
      );
    },

    /**
     * 写入前置检查。返回 null 表示放行，否则返回 {code, message}。
     * OBSERVATION_REQUIRED 是给 UI 映射 i18n 用的稳定错误码（UI 不匹配中文文案）。
     */
    check(toolName, args) {
      const path = normalizePath(args?.path);
      if (!path) return { code: "OBSERVATION_REQUIRED", message: `${toolName} 缺少 path 参数` };
      // 已读到内容：放行（无论存在性是 present 还是 absent——内容优先）
      if (matchesPath(contentObserved, path)) return null;
      const state = statusKeyOf(path);
      // 有证据表明不存在：放行创建新文件
      if (state === OBSERVATION_STATUS.ABSENT) return null;
      if (state === OBSERVATION_STATUS.PRESENT) {
        return {
          code: "OBSERVATION_REQUIRED",
          message:
            `该文件已存在，但本次运行只查看过它的元信息、没读过内容：${path}。` +
            `请先调用 file.read_text 读取它，确认后再写入，避免覆盖掉原有内容。`,
        };
      }
      return {
        code: "OBSERVATION_REQUIRED",
        message:
          `写入前需先读取该文件：${path}。请先调用 file.read_text 读取它；` +
          `若确认该路径当前不存在、要新建文件，请先调用 file.inspect 证明其不存在，再重试写入。`,
      };
    },
  };
}
