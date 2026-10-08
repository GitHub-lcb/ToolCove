// 把一条抓到的请求，变成自动签到工具能直接用的「站点描述」。
//
// 为什么值得单独写一个模块（而不是在界面里拼字符串）：
// 生成出来的东西必须能**通过 checkin/descriptor.js 的校验**，否则用户粘贴过去只会被
// 打回，而报错信息（urlNotHttps / pathProtocolRelative / headerNameInvalid…）说的是
// 描述文件的规则，不是「你抓错了」。这里生成的每一条都要自洽。
//
// 一件容易搞错、实测纠正过的事：**凭据能不能抓到，取决于抓的是哪一层请求头。**
//
// 早先这里写着「CDP 根本不给 Cookie，凭据必须用户自己取」。那是只看了
// Network.requestWillBeSent（应用层设的头）就下的结论，**是错的**：
//   1. Storage.getCookies 能直接读出浏览器里真实的 Cookie；
//   2. 更要紧的是 requestWillBeSentExtraInfo 给的是**真正上线**的请求头。
//      实测 Qoder 的签到 token 是 Electron 主进程在网络层注入的 34 字符 Bearer token，
//      应用层请求头里一个字都没有，只有 ExtraInfo 看得到——抓到它，用户就不用碰任何凭据。
//
// 所以现在的规则是：**只把真值写进配置**。值是脱敏占位符时说明这次没抓到上线的那份，
// 必须如实提示用户，绝不能把占位符当值写进去——那样签到工具会拿假 token 去打接口，
// 返回的 401 看起来像「token 过期」，而真正的原因是压根没抓到。
import { validateDescriptor } from "../../checkin/descriptor.js";
import { REDACTED } from "./cdp.js";

// 浏览器自己加的、换一个客户端重发时既没必要也不对的请求头。
// 留下它们会让描述文件绑死在「当时那台机器的浏览器特征」上，且 User-Agent/Referer 一变就失配。
const NOISE_HEADERS = new Set([
  "accept", "accept-encoding", "accept-language", "cache-control", "connection",
  "content-length", "dnt", "from", "host", "pragma", "priority", "range", "te",
  "upgrade-insecure-requests", "user-agent", "referer", "origin", "if-modified-since",
  "if-none-match", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user",
]);

function isNoiseHeader(name) {
  const lower = name.toLowerCase();
  return lower.startsWith("sec-") || NOISE_HEADERS.has(lower);
}

/** 凭据头：值可能是真值（来自上线请求头），也可能是脱敏占位符（只有应用层头）。 */
const CREDENTIAL_HEADERS = new Set(["cookie", "authorization", "x-api-key"]);
function isCredentialHeader(name) {
  return CREDENTIAL_HEADERS.has(name.toLowerCase());
}

/**
 * 这个凭据值是**真的**吗？
 *
 * 区分真假是这一步的关键：真值可以直接写进配置让用户省掉手抄；
 * 脱敏占位符写进去则会让签到工具拿一个假 token 去打接口，
 * 得到的 401 看起来像「token 过期了」，而真正的原因是压根没抓到。
 */
function isRealCredential(value) {
  const text = String(value ?? "").trim();
  return !!text && text !== REDACTED;
}

/**
 * 「可以领」型字段名：它们的布尔语义是**能力**（能不能领），不是**结果**（领没领）。
 *
 * 踩过的坑：Qoder 的状态响应里有 `claimable`，生成器按 /claim/ 规则猜成了 read.checkedIn
 * 却没带取反，于是产出一份**校验通过、语法正确、行为完全相反**的配置——
 * 该签的那天被判成「已签」然后跳过，全程不报任何错。
 * 这类静默错误比报错危险得多：报错你会去查，跳过你只会以为「今天没到点」。
 *
 * 所以命中这类名字时必须带上 checkedInInvert。方向也是挑过的：
 * 万一猜错，取反会让工具「多签一次」（服务端幂等，无害），
 * 而不取反会让工具「该签不签」（用户白丢一天的额度）。
 */
const CAPABILITY_NAMES = /(able$|^can|^is_?can|available|allowed|remaining|left$|claimable|receivable|todo|pending)/;

/**
 * 在响应体里猜「哪些字段是签到状态 / 积分 / 文案 / 业务码」。
 *
 * 这是**猜测**，所以返回值只是填进描述文件的初稿，用户必须核对。
 * 猜错的代价很低：猜错时 checkin 工具会显示「无法判定」而不是谎报成功。
 */
export function guessReadPaths(body) {
  const guess = { checkedIn: "", points: "", message: "", code: "", successCodes: null, checkedInInvert: false };
  if (!body || typeof body !== "object" || Array.isArray(body)) return guess;

  const found = new Map(); // 完整路径 -> 值
  const walk = (node, prefix, depth) => {
    if (depth > 4 || !node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object") {
        walk(value, path, depth + 1);
        continue;
      }
      if (!found.has(path)) found.set(path, value);
    }
  };
  walk(body, "", 0);

  const lower = (p) => p.toLowerCase();
  for (const [path, value] of found) {
    const name = lower(path);
    if (!guess.code && (name === "code" || name.endsWith(".code") || name === "errcode" || name === "err_no")) {
      guess.code = path;
      if (typeof value === "number") guess.successCodes = [value];
      else if (typeof value === "string" && /^\d+$/.test(value)) guess.successCodes = [Number(value)];
      continue;
    }
    if (!guess.message && /message|msg|desc|error_?msg/.test(name)) {
      guess.message = path;
      continue;
    }
    // 认 check 而不是 checked：checkIn / canCheckIn / hasChecked 这些常见写法都得覆盖，
    // 只认 checked 会把 checkIn 整个漏掉（实测漏过 canCheckIn）。
    // 命中范围宽一点是可接受的——它只在**布尔**字段里找，且猜错时签到工具会显示
    // 「无法判定」而不是谎报状态；下面还会统一提示这是猜的。
    if (!guess.checkedIn && typeof value === "boolean" && /check|sign|claim|received|done/.test(name)) {
      guess.checkedIn = path;
      // 名字是「能力」语义时必须取反，否则产出的配置行为是反的（见 CAPABILITY_NAMES 注释）
      if (CAPABILITY_NAMES.test(name.split(".").pop() || "")) guess.checkedInInvert = true;
      continue;
    }
    if (!guess.points && typeof value === "number" && /point|credit|score|reward|积分/.test(name)) {
      guess.points = path;
    }
  }
  return guess;
}

/** 站点 key：规范要求小写字母数字与 - _，从域名里取最像标识符的一段。 */
export function keyFromHost(host) {
  const cleaned = String(host || "")
    .replace(/:\d+$/, "")
    .replace(/^www\./i, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return (cleaned || "site").slice(0, 40);
}

/**
 * 由一条抓到的请求生成站点描述。
 *
 * @param {object} request cdp.js 产出的 CapturedRequest
 * @param {{key?:string,label?:string}} options
 * @returns {{descriptor:object, warnings:string[], readHints:object, valid:boolean, errors:Array}}
 */
export function buildDescriptor(request, options = {}) {
  const warnings = [];
  if (!request) return { descriptor: null, warnings: ["没有选中请求"], readHints: {}, valid: false, errors: [] };

  let origin = "";
  const path = String(request.path || "/");
  try {
    origin = new URL(request.url).origin;
  } catch {
    // 记录里存过拆好的 origin，解析整串失败时用它兜底
    origin = String(request.origin || "").replace(/\/+$/, "");
    if (!origin) warnings.push("这条记录的 URL 解析不了，baseUrl 需要手填");
  }

  // baseUrl 不允许带 query/hash；这里取 origin 天生满足，但显式兜一层以防将来改动。
  const baseUrl = origin.replace(/\/+$/, "");

  const headers = [];
  const missingCredentials = [];
  const droppedCookies = [];

  // 凭据的挑选规则：
  //   1. 有真值的 Authorization —— 直接用。这是 token 类接口的凭据，
  //      实测 Qoder 就是这一种（主进程在网络层注入 34 字符的 Bearer token）。
  //   2. 只有真值的 Cookie —— 也带上，否则靠 cookie 鉴权的站点配不出来。
  //   3. 两者都有 —— 只留 Authorization。Cookie 此时是冗余的，
  //      而且往往裹着一堆跟踪值，留着会让配置又长又容易过期。
  //   4. 值是脱敏占位符 —— 说明只有应用层请求头、没抓到上线的那一份，
  //      这时**必须**提示用户自己填，绝不能把占位符当成真值写进配置。
  const credentials = Object.entries(request.requestHeaders || {}).filter(([name]) => isCredentialHeader(name));
  const real = credentials.filter(([, value]) => isRealCredential(value));
  const fake = credentials.filter(([, value]) => !isRealCredential(value));

  const authLike = real.filter(([name]) => !/^cookie$/i.test(name));
  const cookieLike = real.filter(([name]) => /^cookie$/i.test(name));
  const keep = authLike.length ? authLike : cookieLike;
  if (authLike.length && cookieLike.length) droppedCookies.push(...cookieLike.map(([name]) => name));
  for (const [name] of fake) missingCredentials.push(name);

  for (const [name, value] of Object.entries(request.requestHeaders || {})) {
    if (isNoiseHeader(name) || isCredentialHeader(name)) continue;
    headers.push([name, String(value)]);
  }
  for (const [name, value] of keep) headers.push([name, String(value)]);

  let body = "";
  if (request.requestBody != null) {
    body = typeof request.requestBody === "string" ? request.requestBody : JSON.stringify(request.requestBody);
  }

  const readHints = guessReadPaths(request.responseBody);
  if (!readHints.checkedIn) {
    warnings.push("响应体里没找到「是否已签到」的布尔字段，read.checkedIn 必须手填（缺了它签到工具没法按天幂等）");
  } else if (readHints.checkedInInvert) {
    warnings.push(
      `「${readHints.checkedIn}」这个名字看起来是「**可以**领」而不是「已经领」，` +
        "所以已自动勾上 checkedInInvert（取反）。这是推断，请对着响应核对一次：" +
        "如果这个字段为 true 时表示「已经领过」，就把取反去掉。",
    );
  } else {
    // 猜对了没提示、猜错了也不提示，是最糟的组合：用户会以为这个字段是确定来的。
    // 它本来就是从响应形状推出来的，说清楚成本很低。
    warnings.push(`read.checkedIn 取的是响应里的「${readHints.checkedIn}」，这是按字段名猜的，请核对一次。`);
  }
  if (!readHints.code) warnings.push("响应体里没找到业务码字段，read.code 可留空");
  if (missingCredentials.length) {
    warnings.push(`凭据头（${missingCredentials.join("、")}）只有脱敏占位符——说明这次没抓到真正上线的那份。请到目标应用里操作一次让请求重新发出，或自行填入。`);
  }
  if (droppedCookies.length) {
    warnings.push(`已省略 Cookie（${droppedCookies.join("、")}）：已有 Authorization，Cookie 是冗余的。若接口其实只认 Cookie，请手动加回。`);
  }

  const descriptor = {
    key: options.key || keyFromHost(request.host),
    label: options.label || request.host || "抓到的站点",
    enabled: true,
    baseUrl,
    status: null,
    checkin: {
      method: String(request.method || "POST").toUpperCase(),
      path,
      headers,
      ...(body ? { body } : {}),
    },
    read: {
      checkedIn: readHints.checkedIn,
      // 只在推断出「能力语义」时才写这个字段：老配置里没有它等价于 false，
      // 多写一个恒为 false 的键只会让描述文件更难读。
      ...(readHints.checkedInInvert ? { checkedInInvert: true } : {}),
      points: readHints.points,
      message: readHints.message,
      code: readHints.code,
      ...(readHints.successCodes ? { successCodes: readHints.successCodes } : {}),
    },
  };

  const result = validateDescriptor(descriptor);
  return {
    descriptor: result.ok ? result.value : descriptor,
    warnings,
    readHints,
    valid: result.ok,
    errors: result.errors,
  };
}
