// 「抓到请求 → 加进签到站点」这一步的纯逻辑。
//
// 抽出来是为了能直接测：这里最要紧的行为是**绝不静默覆盖**已有的站点配置，
// 而这类行为藏在组件方法里就没人测得到。
//
// 为什么坚持不覆盖：key 冲突时直接替换，抹掉的可能是一份正在正常跑的签到配置，
// 而用户此刻以为的只是「多加了一条」。这种静默的数据丢失比报错糟糕得多。
//
// 关键设计：**以用户编辑后的内容为准**，而不是以生成器的输出为准。
// 实测发现，只看领取请求的响应（{"status":"CLAIMED"}）是生成不出完整配置的——
// 真正的「今天是否已领」信号在**查状态**那个请求里（顶层 claimable，语义还是反的）。
// 生成器拒绝猜是对的，但它不该因此把整条路堵死：描述框是可编辑的，
// 用户把缺的字段补上、勾上 checkedInInvert，再点加入就行。
import { validateDescriptor } from "../../checkin/descriptor.js";

export const HANDOFF = Object.freeze({
  EMPTY: "empty",
  NOT_JSON: "notJson",
  DUPLICATE: "duplicate",
  INVALID: "invalid",
  OK: "ok",
});

/** 只把描述框里的文本解析成对象；解析不了返回 null，由调用方提示。 */
export function parseDescriptorObject(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** 解析描述框里的文本并校验（不查重）。给只想一步拿到结果的调用方用。 */
export function parseDescriptorText(text) {
  const value = parseDescriptorObject(text);
  if (!value) {
    return { ok: false, reason: HANDOFF.NOT_JSON, errors: ["jsonInvalid"], site: null };
  }
  return evaluateAdd(value, []);
}

/**
 * 判断一份站点描述能不能加入。
 *
 * @param {object} descriptor 用户确认过的描述（来自描述框）
 * @param {Array}  existing   已有站点
 * @returns {{ok: boolean, reason: string, errors: Array, site: object|null}}
 */
export function evaluateAdd(descriptor, existing) {
  const list = Array.isArray(existing) ? existing : [];
  if (!descriptor || typeof descriptor !== "object") {
    return { ok: false, reason: HANDOFF.EMPTY, errors: [], site: null };
  }

  // key 冲突直接拒绝，不覆盖：抹掉的可能是正在跑的签到配置，
  // 而用户此刻以为的只是「新增了一条」。
  const keys = list.map((s) => s?.key).filter(Boolean);
  if (descriptor.key && keys.includes(descriptor.key)) {
    return { ok: false, reason: HANDOFF.DUPLICATE, errors: [], site: null };
  }

  const { ok, errors } = validateDescriptor(descriptor, { existingKeys: keys });
  if (!ok) return { ok: false, reason: HANDOFF.INVALID, errors, site: null };

  return { ok: true, reason: HANDOFF.OK, errors: [], site: { ...descriptor } };
}

/** 追加后的完整列表。返回新数组，**不修改**入参。 */
export function appendSite(existing, site) {
  return [...(Array.isArray(existing) ? existing : []), site];
}