// 结果归类：把一次 HTTP 结果翻译成界面上的状态。
//
// 这层是整个工具可信度的关口。签到类接口极常见的两个坑：
//   1. HTTP 200 但 body 里 code 是错误码（网关层统一包了一层，HTTP 永远是 200）；
//   2. 登录态过期时返回 200 + 一段 HTML 登录页。
// 这两种情况如果按「2xx 即成功」处理，界面会天天显示「签到成功」，而积分纹丝不动——
// 用户要过好几天才发现。所以 success / failed / unknown 三态必须分清，
// 「读不出状态」绝不能落到成功那一侧。
import { extractValue } from "./extract.js";
import { pickPath, toTriState } from "./paths.js";

export const OUTCOME = Object.freeze({
  OK: "ok",
  ALREADY: "already",
  NEEDED: "needed",
  FAILED: "failed",
  UNKNOWN: "unknown",
  AUTH: "auth",
  RATE_LIMITED: "rate-limited",
  SERVER: "server",
  CLIENT: "client",
  NOT_JSON: "not-json",
  NETWORK: "network",
  BAD_DESCRIPTOR: "bad-descriptor",
  SKIPPED: "skipped",
});

/** 界面上算「今天签到了」的两种：本次签成（ok）与本来就已签（already）。 */
export const DONE_OUTCOMES = new Set([OUTCOME.OK, OUTCOME.ALREADY]);

/** 值得退避后重试的：网络抖动与 5xx。鉴权失败/描述文件错误重试多少次都没用。 */
export const RETRYABLE_OUTCOMES = new Set([OUTCOME.NETWORK, OUTCOME.SERVER, OUTCOME.CLIENT]);

function parseJson(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, reason: "empty" };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

function readPoint(json, read) {
  const raw = pickPath(json, read.points);
  if (raw === undefined || raw === null || raw === "") return undefined;
  const num = Number(raw);
  // 积分可能是字符串（"100"）也可能是数字；都不是就当没读到，不显示 0——
  // 显示 0 比不显示更像「已清零」，是误导。
  return Number.isFinite(num) ? num : undefined;
}

/**
 * 有些接口用业务码表达「限流/稍后再试」：HTTP 是 200，含义却和 429 一样。
 * 不认出来的话，它会被当成一次普通失败——不退避、当天继续按额度重试，
 * 而服务端那边的惩罚窗口恰恰会被连发拉长（TRAE 的 9074 实测就是这样）。
 */
function rateLimitCode(json, read) {
  const list = Array.isArray(read.rateLimitCodes) ? read.rateLimitCodes : [];
  if (!list.length || !read.code) return null;
  const code = pickPath(json, read.code);
  if (code === undefined || code === null || code === "") return null;
  return list.some((allowed) => String(allowed) === String(code)) ? code : null;
}

/**
 * 业务码形式的「今天已经签过了」。
 *
 * 为什么不能只靠 HTTP 状态码：WorkBuddy CN 重复签到返回的是 **HTTP 400 +
 * {"code":10001,"msg":"今天已签到，请明天再来"}**。只看状态码会把它归进 client 失败，
 * 于是当天继续重试、界面显示红色徽章——而事实是今天已经签好了，
 * 用户会跑去查网络和登录态，方向完全错。
 *
 * 幂等语义必须与「限流」分开：已签不该退避（重试没有意义），也不该推进 lastDay
 * 之外的任何东西——而它**要**推进 lastDay，否则第二天会以为今天没签。
 */
function alreadyCode(json, read) {
  const list = Array.isArray(read.alreadyCodes) ? read.alreadyCodes : [];
  if (!list.length || !read.code) return null;
  const code = pickPath(json, read.code);
  if (code === undefined || code === null || code === "") return null;
  return list.some((allowed) => String(allowed) === String(code)) ? code : null;
}

/**
 * 判断业务码是否成功。
 *
 * 没配 code/successCodes 就跳过这一步（很多接口没有业务码）。
 * 配了 successCodes，就必须命中才算成功：code 缺失也判失败——
 * 因为「路径写错了导致取不到 code」和「接口说 code 不对」在后果上一样，都不能报成功。
 */
function businessOk(json, read) {
  if (!read.code || !Array.isArray(read.successCodes) || !read.successCodes.length) return null;
  const code = pickPath(json, read.code);
  if (code === undefined || code === null || code === "") return false;
  const normalized = typeof code === "number" ? code : String(code);
  return read.successCodes.some((allowed) => (typeof allowed === "number" ? Number(normalized) === allowed : String(normalized) === String(allowed)));
}

function textOf(json, read) {
  const message = pickPath(json, read.message);
  return message === undefined || message === null ? "" : String(message);
}

/**
 * 业务码不匹配时把实际读到的 code 一起带出去。
 *
 * 限流、没有资格、活动结束在服务端是三个不同的码，但 message 常常是同一句
 * 「请稍后再试」——不带码就只能猜，而这三者的正确处理方式完全不一样。
 */
function codeHint(json, read) {
  const code = pickPath(json, read.code);
  return code === undefined || code === null || code === "" ? "code-missing" : `code=${code}`;
}

/**
 * 读「是否已签」字段。
 *
 * 三种形态：
 *   - 点路径字符串（如 "data.checkedIn"）——普通接口；
 *   - 带 where 的条件选择器——状态藏在数组元素里时用（「哪个活动」+「它的状态」）；
 *   - 上面两者的**数组**——按顺序试，第一个读得出的算数。
 *
 * 为什么需要数组：同一个站点的「查状态」和「执行签到」两个响应形状可以完全不同
 * （Qoder CN：前者是 campaigns[].claimStatus，后者是顶层 status），而 read 只有一份配置。
 * 只填其中一个，另一个响应就读不出状态——签成了显示「无法判定」，
 * 或者明明已领过却显示「描述无效」。
 *
 * 取反是必需能力：有些接口的布尔语义是「**可以**领」而不是「已经领」。
 * 不取反就会在恰好该签的时候判成「已签」并跳过，而且全程不报错。
 */
function oneTriState(json, spec) {
  if (spec && typeof spec === "object") {
    const got = extractValue(json, spec);
    return got.ok ? toTriState(got.value) : undefined;
  }
  return toTriState(pickPath(json, spec));
}

function readCheckedIn(json, read) {
  const specs = Array.isArray(read.checkedIn) ? read.checkedIn : [read.checkedIn];
  for (const spec of specs) {
    const tri = oneTriState(json, spec);
    if (tri !== undefined) return read.checkedInInvert ? !tri : tri;
  }
  // 布尔字段一个都读不出时，退到「某字段出现即已完成」。
  //
  // 为什么需要：有的站点**签到响应里没有任何状态字段**，成功判据就是响应体里出现了
  // 某个业务字段。WorkBuddy CN 就是这样——签到成功时 data 里是 {credit, streak_days,
  // is_streak_day}，app 自己也是靠 `!('credit' in e)` 区分成功与业务错误。
  // 没有这个口子，一次真的签成了会被读成「无法判定」，用户看到黄色警告去改一份
  // 根本没写错的描述。
  //
  // 只看「字段是否存在」而**不看值**：出现即代表服务端认了这次请求，
  // 而值本身可能是 0（如 credit 为 0 的活动），按真值判断会把它误判成失败。
  if (read.checkedInPresence) {
    const present = pickPath(json, read.checkedInPresence);
    if (present !== undefined) return true;
  }
  return undefined;
}

/**
 * 归类一次「查状态」的结果。
 * 只需要知道三件事：今天是不是已经签了（true/false/unknown）、积分多少、失败原因。
 */
export function classifyStatus(response, read) {
  if (response.error) {
    return { outcome: OUTCOME.NETWORK, error: String(response.error), checkedIn: undefined };
  }
  const { status } = response;
  // 「已签」判定必须排在状态码之前：WorkBuddy 用 HTTP 400 表达它。
  // 先按 4xx 归成 client 失败的话，一次「今天早已签好」会被报成红色错误。
  const parsedEarly = parseJson(response.text);
  if (parsedEarly.ok) {
    const already = alreadyCode(parsedEarly.value, read);
    if (already !== null) {
      return { outcome: OUTCOME.ALREADY, error: "", checkedIn: true, points: readPoint(parsedEarly.value, read) };
    }
  }
  if (status === 401 || status === 403) {
    return { outcome: OUTCOME.AUTH, error: `HTTP ${status}`, checkedIn: undefined };
  }
  if (status === 429) return { outcome: OUTCOME.RATE_LIMITED, error: "HTTP 429", checkedIn: undefined };
  if (status >= 500) return { outcome: OUTCOME.SERVER, error: `HTTP ${status}`, checkedIn: undefined };
  if (status < 200 || status >= 300) return { outcome: OUTCOME.CLIENT, error: `HTTP ${status}`, checkedIn: undefined };

  const parsed = parsedEarly;
  if (!parsed.ok) return { outcome: OUTCOME.NOT_JSON, error: parsed.reason, checkedIn: undefined };

  const limited = rateLimitCode(parsed.value, read);
  if (limited !== null) {
    return { outcome: OUTCOME.RATE_LIMITED, error: `${textOf(parsed.value, read) || "限流"} · code=${limited}`, checkedIn: undefined };
  }

  const codeOk = businessOk(parsed.value, read);
  if (codeOk === false) {
    return { outcome: OUTCOME.FAILED, error: `${textOf(parsed.value, read) || "code-mismatch"} · ${codeHint(parsed.value, read)}`, checkedIn: undefined };
  }
  const tri = readCheckedIn(parsed.value, read);
  if (tri === undefined) return { outcome: OUTCOME.UNKNOWN, error: "checkedIn-unreadable", checkedIn: undefined };
  // false 不是「跳过」，是「还没签，得去签」——给独立取值，
  // 免得调用方把「跳过」和「需要签」混为一谈而漏掉这次签到。
  return {
    outcome: tri ? OUTCOME.ALREADY : OUTCOME.NEEDED,
    error: "",
    checkedIn: tri,
    points: readPoint(parsed.value, read),
  };
}

/**
 * 归类一次「执行签到」的结果。
 *
 * tri === true  → 签成了（ok）
 * tri === false → 奇怪：刚签完却说今天没签。判 failed 而不是成功——
 *                  这通常意味着填的路径不是「今天是否已签」而是别的布尔字段。
 * tri undefined → unknown：读不出状态，提示核对描述文件。
 */
export function classifyCheckIn(response, read) {
  if (response.error) {
    return { outcome: OUTCOME.NETWORK, error: String(response.error), checkedIn: undefined };
  }
  const { status } = response;
  // 同 classifyStatus：业务码语义优先于 HTTP 状态码。
  // 对签到而言这条尤其重要——重复签到时服务端正是在 400 里告诉我们「今天已签到」，
  // 而那是一次**成功**的幂等结果，不是失败。
  const parsedEarly = parseJson(response.text);
  if (parsedEarly.ok) {
    const already = alreadyCode(parsedEarly.value, read);
    if (already !== null) {
      return {
        outcome: OUTCOME.ALREADY,
        error: "",
        checkedIn: true,
        points: readPoint(parsedEarly.value, read),
        message: textOf(parsedEarly.value, read),
      };
    }
  }
  if (status === 401 || status === 403) {
    return { outcome: OUTCOME.AUTH, error: `HTTP ${status}`, checkedIn: undefined };
  }
  if (status === 429) return { outcome: OUTCOME.RATE_LIMITED, error: "HTTP 429", checkedIn: undefined };
  if (status >= 500) return { outcome: OUTCOME.SERVER, error: `HTTP ${status}`, checkedIn: undefined };
  if (status < 200 || status >= 300) return { outcome: OUTCOME.CLIENT, error: `HTTP ${status}`, checkedIn: undefined };

  const parsed = parsedEarly;
  if (!parsed.ok) return { outcome: OUTCOME.NOT_JSON, error: parsed.reason, checkedIn: undefined };

  const limited = rateLimitCode(parsed.value, read);
  if (limited !== null) {
    return { outcome: OUTCOME.RATE_LIMITED, error: `${textOf(parsed.value, read) || "限流"} · code=${limited}`, checkedIn: undefined };
  }

  const codeOk = businessOk(parsed.value, read);
  if (codeOk === false) {
    return { outcome: OUTCOME.FAILED, error: `${textOf(parsed.value, read) || "code-mismatch"} · ${codeHint(parsed.value, read)}`, checkedIn: undefined };
  }
  const tri = readCheckedIn(parsed.value, read);
  const points = readPoint(parsed.value, read);
  const message = textOf(parsed.value, read);
  if (tri === true) return { outcome: OUTCOME.OK, error: "", checkedIn: true, points, message };
  if (tri === false) return { outcome: OUTCOME.FAILED, error: message || "checkedIn-still-false", checkedIn: false, points, message };
  return { outcome: OUTCOME.UNKNOWN, error: message || "checkedIn-unreadable", checkedIn: undefined, points, message };
}
