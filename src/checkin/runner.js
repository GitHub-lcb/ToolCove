// 编排：把「读描述 → 判幂等 → 查状态 → 签到 → 记状态」串起来。
//
// 依赖全部注入（deps.request / deps.loadSites / deps.now …），所以单测里不需要 mock Tauri，
// 也不需要真发请求——这是这个模块能写得住 30 条以上断言的前提。
//
// 两个必须守住的约束：
// 1. 同一站点同时只允许一个在途请求。自动定时和用户手点撞在一起时，
//    两个请求都会「今天没签」然后各签一次——多签一次轻则被限流，重则被风控标记。
// 2. 站点之间顺序执行，不并发。定时任务不该在一分钟内同时打向 N 个站点。
import { classifyCheckIn, classifyStatus, OUTCOME } from "./classify.js";
import { appendHistory, applyResult, normalizePolicy, planDailyRun, todayKey, withPoints } from "./daily.js";
import { resolvePath } from "./extract.js";
import { runAction } from "./http.js";

export const TRIGGER = Object.freeze({ MANUAL: "manual", AUTO: "auto", CATCHUP: "catchup" });

/** 状态响应不是合法 JSON 时返回 undefined，让下游报「取不到」而不是在这里炸。 */
function tryParseJson(text) {
  try {
    const value = JSON.parse(String(text ?? ""));
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function reasonOf(response) {
  return { ok: response.ok, status: response.status, text: response.text, error: response.error, retryAfterMs: response.retryAfterMs };
}

export function createCheckInRunner(deps) {
  const now = deps.now || (() => Date.now());
  const inFlight = new Map(); // siteKey -> Promise

  /** 幂等判定：手动签到一律放行（用户想重试是他的权利），自动/补签才查当日记录与次数。 */
  function shouldRun(siteState, policy, trigger) {
    if (trigger === TRIGGER.MANUAL) return { run: true, plan: null };
    const plan = planDailyRun(siteState, policy, now());
    return { run: plan.due, plan };
  }

  /**
   * 跑单个站点。
   * @returns {{key, outcome, error, points, at, trigger, skipped?}}
   */
  async function runSite(siteInput, siteState, { trigger = TRIGGER.MANUAL, policy = {} } = {}) {
    const normalizedPolicy = normalizePolicy(policy);
    const key = String(siteInput?.key || "").trim();

    // 停用的站点只在手动点单个站点时才跑：全局自动任务不该碰它，
    // 但用户单独点一下「立即签到」是明确意图，不拦。
    if (siteInput?.enabled === false && trigger !== TRIGGER.MANUAL) {
      return { key, outcome: OUTCOME.SKIPPED, error: "disabled", trigger, at: now(), points: undefined };
    }

    const { run, plan } = shouldRun(siteState, normalizedPolicy, trigger);
    if (!run) {
      return {
        key,
        outcome: OUTCOME.SKIPPED,
        error: plan?.reason || "skipped",
        trigger,
        at: now(),
        points: siteState?.points,
        skipped: true,
      };
    }

    if (inFlight.has(key)) return inFlight.get(key);
    const task = execute(siteInput, siteState, { trigger, policy: normalizedPolicy, key });
    inFlight.set(key, task);
    try {
      return await task;
    } finally {
      inFlight.delete(key);
    }
  }

  async function execute(siteInput, siteState, { trigger, policy, key }) {
    // 第 0 步：先查状态（可选）。省掉一次盲签，也让「今天已签」不必靠本地记录判断。
    let points = siteState?.points;
    let statusJson;
    if (siteInput?.status) {
      const probe = await runAction(siteInput, "status", deps);
      if (probe.descriptor) siteInput = probe.descriptor;
      // 只有拿到可解析的 JSON 才可能取值成功。解析失败不单独报错——
      // 有 pathFrom 的站点会在下面的 resolve 里报出「取不到」，原因更具体。
      statusJson = tryParseJson(probe.response?.text);
      const status = classifyStatus(reasonOf(probe.response), probe.descriptor?.read || { checkedIn: "" });
      if (status.outcome === OUTCOME.ALREADY) {
        return { key, outcome: OUTCOME.ALREADY, error: "", trigger, at: now(), points: status.points ?? points };
      }
      // 查状态失败（鉴权/网络）时**不放弃签到**：不少接口的签到端点不依赖状态端点，
      // 直接签一次比把整轮判定挂掉更有用。失败原因留到签到结果里。
      points = status.points ?? points;
    }

    // 动态路径：签到端点里带一个每天会变的 ID 时，用状态响应把它填出来。
    // 取不到就**到此为止**——宁可不发请求，也不拿空值拼出一个打到别处的路径。
    if (siteInput?.checkin?.pathFrom) {
      const resolved = resolvePath(siteInput.checkin.path, siteInput.checkin.pathFrom, statusJson);
      if (!resolved.ok) {
        return {
          key,
          outcome: OUTCOME.BAD_DESCRIPTOR,
          error: `pathFrom:${resolved.error}${resolved.detail ? `(${resolved.detail})` : ""}`,
          trigger,
          at: now(),
          points,
        };
      }
      // pathFrom 用完必须一起摘掉：路径里已经没有占位符了，还留着它
      // 会被下一次校验判成「声明了取值规则却没用上」，把一次成功的签到报成配置错误。
      const consumed = { ...siteInput.checkin, path: resolved.path };
      delete consumed.pathFrom;
      siteInput = { ...siteInput, checkin: consumed };
    }

    const action = await runAction(siteInput, "checkin", deps);
    const descriptor = action.descriptor;
    if (!descriptor) {
      return { key, outcome: OUTCOME.BAD_DESCRIPTOR, error: (action.errors || []).map((e) => `${e.field}:${e.code}`).join(", ") || "bad-descriptor", trigger, at: now(), points, descriptorErrors: action.errors || [] };
    }
    const result = classifyCheckIn(reasonOf(action.response), descriptor.read);
    const day = todayKey(now(), policy.offsetMinutes);
    return {
      key,
      outcome: result.outcome,
      error: result.error || "",
      trigger,
      at: now(),
      day,
      points: result.points ?? points,
      retryAfterMs: action.response?.retryAfterMs || 0,
    };
  }

  /**
   * 把结果并进状态并落盘。runner 只算结果，落盘由 store 决定——
   * 这样「算」和「写」能分别测，也不会出现 runner 顺手改了别处的状态。
   */
  function settle(siteState, result, policyInput = {}) {
    const offsetMinutes = normalizePolicy(policyInput).offsetMinutes;
    let next = applyResult(siteState, result.outcome, { now: result.at || now(), offsetMinutes, detail: result.error });
    next = withPoints(next, result.points);
    next = appendHistory(next, {
      at: result.at || now(),
      day: todayKey(result.at || now(), offsetMinutes),
      outcome: result.outcome,
      trigger: result.trigger,
      error: result.error || "",
      points: result.points,
    });
    if (result.retryAfterMs) next.retryAfterAt = Math.max(Number(next.retryAfterAt) || 0, (result.at || now()) + result.retryAfterMs);
    return next;
  }

  /**
   * 跑全部启用站点（顺序执行）。
   * @param sites [{ key, enabled, ...descriptor }]
   * @param states { [key]: siteState }
   * @returns {{results: Array, states: object}}
   */
  async function runAll(sites, states, { trigger = TRIGGER.AUTO, policy = {} } = {}) {
    const results = [];
    const nextStates = { ...(states || {}) };
    for (const site of sites || []) {
      if (!site?.key) continue;
      const result = await runSite(site, nextStates[site.key], { trigger, policy });
      results.push(result);
      // skipped 只在两种情况出现：不该跑（不推进任何状态）与查状态发现已签（要推进 lastDay，
      // 否则明天开了新的一天、同一个站点还会再查一次状态）。
      if (!result.skipped || result.outcome === OUTCOME.ALREADY) {
        nextStates[site.key] = settle(nextStates[site.key], result, policy);
      }
    }
    return { results, states: nextStates };
  }

  /** 自动任务：只跑「该跑」的站点，且不计入手动语义。 */
  async function runDue(sites, states, policy) {
    return runAll(sites, states, { trigger: TRIGGER.AUTO, policy });
  }

  return { runSite, runAll, runDue, settle, isBusy: (key) => inFlight.has(key) };
}
