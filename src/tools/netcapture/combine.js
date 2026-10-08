// 把「查状态」和「领取」两条抓到的请求合并成一份完整站点描述。
//
// 为什么需要这一步：有些站点的签到端点里带一个**每天都会变**的 ID，
// 而那个 ID 只能从另一个请求的响应里拿到。实测 Qoder 就是这样——
// 每日签到活动只活一天（当天 10:00 到次日 09:59），campaignId 每天不同。
// 只抓一条请求生成不出可用配置，必须两条一起看。
//
// 核心推断只有一条：**领取请求路径里的某一段，正好等于查状态响应里的某个值。**
// 找到它，把那段换成占位符，并记下这个值在响应里的位置，就得到了 pathFrom。
//
// 推断出来的东西一律带警告。这里的目标是「把机器能确定的部分确定下来，
// 把不确定的明确标出来」，不是假装全都确定。
import { parsePath } from "../../checkin/paths.js";

/** 占位符名允许的字符（与 checkin/extract.js 的规则一致）。 */
const PLACEHOLDER_NAME = /^[A-Za-z0-9_$-]{1,40}$/;

/**
 * 这段路径像不像一个「会变的 ID」？
 *
 * 必须有这道闸，否则 "v1"、"me"、"api" 这些段只要碰巧在响应里出现过就会被当成动态值，
 * 生成出一份看着对、实际把 API 版本号也占位化的配置。
 * 实测那个 campaignId 是 36 字符的 UUID，而 v1 只有 2 字符——长度和字符构成足够区分。
 */
export function looksLikeId(segment) {
  const text = String(segment ?? "");
  if (text.length < 8) return false;
  if (!/[-_]|\d/.test(text)) return false;
  return /^[A-Za-z0-9._~-]+$/.test(text);
}

/** 把响应体摊平成「路径 -> 值」，同时记下每个值所在的数组元素（如果有）。 */
function collectLeaves(body) {
  const leaves = [];
  const walk = (node, path, depth, container) => {
    if (depth > 6 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        if (item && typeof item === "object") {
          // 进入数组元素：记下容器信息，后面挑 where 判别字段要用
          walk(item, `${path}[${index}]`, depth + 1, { arrayPath: path, index, element: item, siblings: node });
        } else {
          leaves.push({ path: `${path}[${index}]`, value: item, container: null });
        }
      });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (value && typeof value === "object") {
        walk(value, childPath, depth + 1, container);
        continue;
      }
      leaves.push({ path: childPath, value, container });
    }
  };
  walk(body, "", 0, null);
  return leaves;
}

/**
 * 给数组元素挑一个「判别字段」，用来写成 {path, where, pick} 选择器。
 *
 * 为什么不用下标：`campaigns[0].campaignId` 今天对，明天数组顺序一变就指错活动。
 * 而 Qoder 的活动列表里恰好还有一个能稳定识别的字段。
 *
 * 挑法（按优先级）：
 *   1. 值必须是基本类型，且在该数组里**唯一**——不唯一就没法定位；
 *   2. 值里不含数字的优先。枚举值（CLAIM_BENEFIT）稳定，
 *      带数字的（act-20260930-295、时间戳）往往是日期或 ID，明天就变了；
 *   3. 名字像枚举的优先（type / kind / action / category / status）。
 *
 * 实测 Qoder 的元素里：campaignKey="act-20260930-295" 带日期会被降权，
 * claimStatus 两条都是 CLAIMED 不唯一会被淘汰，最终选中 actionType="CLAIM_BENEFIT"。
 */
export function pickDiscriminator(container, idField) {
  if (!container?.element || !Array.isArray(container.siblings)) return null;
  const candidates = [];
  for (const [key, value] of Object.entries(container.element)) {
    if (key === idField) continue;
    if (value === null || typeof value === "object") continue;
    const text = String(value);
    if (!text || text.length > 64) continue;
    // 唯一性：整个数组里只有这一个元素满足，否则定位不到
    const sameCount = container.siblings.filter((item) => item && typeof item === "object" && String(item[key]) === text).length;
    if (sameCount !== 1) continue;
    const noDigits = !/\d/.test(text);
    const semanticName = /type|kind|action|category|status/i.test(key);
    candidates.push({ key, value, score: (noDigits ? 2 : 0) + (semanticName ? 2 : 0) });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const best = candidates[0];
  return { where: { [best.key]: best.value }, field: best.key, value: best.value };
}

/**
 * 在领取请求的路径里找出「来自查状态响应」的那一段。
 *
 * @returns {{segmentIndex, placeholder, selector, warning}|null}
 */
export function findDynamicSegment(checkinPath, statusBody) {
  const segments = String(checkinPath ?? "").split("/");
  const leaves = collectLeaves(statusBody);

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (!looksLikeId(segment)) continue;
    const hit = leaves.find((leaf) => String(leaf.value) === segment);
    if (!hit) continue;

    // 取值字段名做占位符名；取不到合法名字就跳过这一段，别硬造
    const tail = String(hit.path).split(".").pop() || "";
    const field = tail.replace(/\[\d+\]$/, "");
    if (!PLACEHOLDER_NAME.test(field)) continue;

    const placeholder = field;
    const replaced = [...segments];
    replaced[i] = `\${${placeholder}}`;
    const path = replaced.join("/");

    // 值在数组元素里时用 where 选择器；否则直接点路径。
    // 数组元素里**必须**用 where：下标选择今天对、明天就指到别的活动上。
    if (hit.container) {
      const discriminator = pickDiscriminator(hit.container, field);
      if (discriminator) {
        // 抓到的这条不像签到活动、但同组里有像的，就用像的那条。
        // 不这么做的话，用户抓到的多半是应用自动重放的别的活动，
        // 配出来的配置会去签错的活动——而且看不出来哪里不对。
        const claimed = preferClaimCampaign(hit.container, discriminator.field, String(discriminator.value));
        const chosen = claimed ?? String(discriminator.value);
        const switched = claimed !== null;
        const looksLikeClaim = /claim|checkin|sign|receive/i.test(chosen);
        const where = { [discriminator.field]: discriminator.value };
        if (switched) {
          // 判别字段的值本身可能是字符串，保持与元素里的原值类型一致
          const sample = hit.container.siblings.find((item) => String(item?.[discriminator.field] ?? "") === claimed);
          where[discriminator.field] = sample[discriminator.field];
        }
        return {
          segmentIndex: i,
          placeholder,
          path,
          selector: { path: hit.container.arrayPath, where, pick: field },
          warning:
            `「${segment}」看起来每天会变，已改成占位符并从查状态响应里取值：` +
            `在 ${hit.container.arrayPath} 里找 ${discriminator.field}=${JSON.stringify(where[discriminator.field])} 的那一条，取它的 ${field}。` +
            "这是推断，请核对一次。" +
            (switched
              ? `\n注意：抓到的这条活动是 ${discriminator.field}=${JSON.stringify(discriminator.value)}，` +
                `看名字不像「签到/领取」类，而同一组里有一个像的，所以**改用了后者**。` +
                "如果这不对，请手动把 where 改回去。"
              : looksLikeClaim
                ? ""
                : `\n⚠️ 注意：判别的这条活动（${discriminator.field}=${JSON.stringify(where[discriminator.field])}）看名字**不像是「签到/领取」类活动**，` +
                  "而且同组里也没有更像的。如果它其实是你抓包时应用自动重放的另一个活动，" +
                  "那这份配置签的就不是你想签的那个——请手动把 where 改成真正的签到活动对应的取值。"),
        };
      }
      // 没有可用的判别字段：退回下标，但必须说清楚它不稳
      return {
        segmentIndex: i,
        placeholder,
        path,
        selector: { path: hit.path },
        warning:
          `「${segment}」已改成占位符，取值路径用的是数组下标（${hit.path}）。` +
          "**下标会随列表顺序变化而指错**，建议在描述框里改成带 where 的写法。",
      };
    }

    return {
      segmentIndex: i,
      placeholder,
      path,
      selector: { path: hit.path },
      warning: `「${segment}」看起来每天会变，已改成占位符并从查状态响应里取 ${hit.path}。这是推断，请核对一次。`,
    };
  }
  return null;
}

/**
 * 在同一个数组里另找一个「像签到活动」的元素。
 *
 * 为什么需要：实测抓到的往往是应用**自己重放**的那条，不一定是你想签的那条。
 * Qoder 里每日签到是 `actionType=CLAIM_BENEFIT`，而 Pro 首月翻倍是 `VIEW_DETAILS`；
 * 今天每日签到已领过时，应用只重放后者——照它配下去，签的会是错的活动，
 * 而且配置看起来完全正常、校验也过。
 *
 * 挑选规则收得很紧，避免自作聪明：
 *   - 只在**同一个数组**里找，且必须用同一个判别字段；
 *   - 值必须匹配 claim/checkin/sign 这类「领取」语义；
 *   - 该值在数组里必须唯一，否则定位不到。
 * 找不到就返回 null，由调用方退回原来那条并给出警告。
 */
function preferClaimCampaign(container, field, currentValue) {
  if (!container?.siblings) return null;
  const candidates = container.siblings.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const value = String(item[field] ?? "");
    if (!value || value === currentValue) return false;
    if (!/claim|checkin|sign|receive/i.test(value)) return false;
    // 唯一性：整组里只有这一个元素是该值
    return container.siblings.filter((other) => other && typeof other === "object" && String(other[field] ?? "") === value).length === 1;
  });
  if (candidates.length !== 1) return null;
  return String(candidates[0][field]);
}

/**
 * 在选中的那条活动里找一个「状态词」字段（CLAIMABLE / CLAIMED 这类）。
 *
 * 为什么要用它而不是顶层的布尔汇总字段：实测顶层 claimable 在明明可领的时候
 * 给出过 false，工具据此把该签的那天判成「已签」并跳过——真实漏签过一次。
 * 活动自己的状态字段才是准确的。
 *
 * 只认**明确的**状态词，认不出来就返回 null，由调用方退回原来的推断方式。
 */
const STATUS_WORD = /^(claimable|claimed|unclaimed|not_claimed|available|pending|todo|done|finished)$/i;

function pickStatusField(element) {
  if (!element || typeof element !== "object") return null;
  for (const [key, value] of Object.entries(element)) {
    if (typeof value !== "string") continue;
    if (!STATUS_WORD.test(value.trim())) continue;
    // 名字也得像状态（status / state），免得把某个恰好叫 CLAIMED 的别名字段当成状态
    if (!/status|state/i.test(key)) continue;
    return key;
  }
  return null;
}

/** 确认选择器语法合法——生成的东西必须能过 checkin 的校验，否则用户粘过去只会被打回。 */
export function selectorIsValid(selector) {
  if (typeof selector === "string") return !!parsePath(selector);
  if (!selector || typeof selector !== "object") return false;
  if (!parsePath(selector.path)) return false;
  if (selector.pick !== undefined && !parsePath(selector.pick)) return false;
  return true;
}

/**
 * 用两条请求拼出一份完整描述。
 *
 * @param {object} checkinRec 领取请求（抓包记录）
 * @param {object} statusRec  查状态请求（抓包记录）
 * @param {object} deps       { buildDescriptor, guessReadPaths } —— 注入以便单测不依赖真实抓包
 */
export function combineRequests(checkinRec, statusRec, deps) {
  const { buildDescriptor, guessReadPaths } = deps;
  const base = buildDescriptor(checkinRec);
  const descriptor = { ...base.descriptor, status: null };
  const warnings = [...base.warnings];

  // 1) 查状态动作：路径与请求头照抄，但凭据用**领取请求**那份。
  //    两个请求的凭据通常一样，而领取请求那份是用户实际选中要用的，保持一致更不容易出错。
  const statusHeaders = (base.descriptor.checkin.headers || []).filter(([name]) => /^(authorization|cookie|x-api-key)$/i.test(name));
  descriptor.status = {
    method: String(statusRec.method || "GET").toUpperCase(),
    path: String(statusRec.path || ""),
    headers: statusHeaders,
  };

  // 2) 动态路径：领取路径里那段每天会变的值，从查状态响应里取
  const dynamic = findDynamicSegment(descriptor.checkin.path, statusRec.responseBody);
  if (dynamic && selectorIsValid(dynamic.selector)) {
    descriptor.checkin = { ...descriptor.checkin, path: dynamic.path, pathFrom: { [dynamic.placeholder]: dynamic.selector } };
    warnings.push(dynamic.warning);
  } else if (dynamic) {
    // 推出来了但选择器不合法：宁可不写，也不能写一个校验不过的配置
    warnings.push("路径里似乎有一段是每天会变的，但没能推出可靠的取值规则，请手动配 pathFrom。");
  } else {
    warnings.push("领取路径里没找到「来自查状态响应」的片段。如果这个接口的 ID 每天都变，请手动配 pathFrom，否则明天会 404。");
  }

  // 3) read 从**查状态响应**里推——签到工具判断「今天是否已签」看的就是它。
  //    这里刻意覆盖掉 base 的推断结果：base 是从领取响应推的，而领取响应往往
  //    只说「这次领取的结果」，不说「今天是否已经领过」，两者不是一回事。
  //
  //    优先用「选中的那条活动自己的状态字段」，而不是响应里的布尔汇总字段。
  //    实测汇总字段（顶层 claimable）在明明可领时给出过 false，照它判会漏签。
  const matchedCampaign = dynamic ? pickMatchedCampaign(statusRec.responseBody, dynamic.selector) : null;
  const statusField = pickStatusField(matchedCampaign);
  if (statusField && dynamic) {
    descriptor.read = {
      ...descriptor.read,
      checkedIn: { path: dynamic.selector.path, where: dynamic.selector.where, pick: statusField },
    };
    delete descriptor.read.checkedInInvert;
    warnings.push(
      `read.checkedIn 取的是那条活动自己的 ${statusField}（一个状态值），而不是响应里的布尔汇总字段——` +
        "汇总字段的语义常常不准，实测在明明可领时给过 false，会让人白丢一天的额度。",
    );
  } else {
    const statusHints = guessReadPaths(statusRec.responseBody);
    if (statusHints.checkedIn) {
      descriptor.read = {
        ...descriptor.read,
        checkedIn: statusHints.checkedIn,
        ...(statusHints.checkedInInvert ? { checkedInInvert: true } : {}),
      };
      warnings.push(
        `read.checkedIn 改从查状态响应里取「${statusHints.checkedIn}」` +
          `${statusHints.checkedInInvert ? "（已勾取反）" : ""}——判断今天是否已签要看查状态的响应，不是领取的响应。`,
      );
    } else {
      warnings.push("查状态响应里也没找到「是否已签」的字段，read.checkedIn 仍需手填。");
    }
  }

  return { descriptor, warnings };
}

/** 按 pathFrom 的选择器，在查状态响应里找出「那条活动」本身。 */
function pickMatchedCampaign(body, selector) {
  if (!selector || typeof selector !== "object") return null;
  const segments = parsePath(selector.path);
  if (!segments) return null;
  let list = body;
  for (const seg of segments) {
    if (list == null || typeof list !== "object") return null;
    list = list[seg];
  }
  if (!Array.isArray(list)) return null;
  return list.find((item) => {
    if (!item || typeof item !== "object") return false;
    if (!selector.where) return true;
    return Object.entries(selector.where).every(([k, v]) => item[k] === v);
  }) || null;
}