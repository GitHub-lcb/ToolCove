// 工具结果小件（中立共享层）：解开 { ok, error, value/output } 形态的工具返回。
//
// 为什么放在 shared（被允许的最底层）：Agent 手写实现区（agent/executors.js）与各工具包内的
// executor 都要用它——放 agent/ 会让工具包反向依赖引擎，放 tools/ 又会散成多份。shared/ 只依赖
// shared/self、i18n、platform，本文件零依赖，正好合适。
//
// 约定来自 json.js / yaml.js：它们的成功路径返回 { ok: true, value|output }，失败返回 { ok: false, error }，
// **不抛异常**；调用方用这里的 unwrap 把失败翻成异常，把成功解成需要的字段。
/** 解开工具结果：失败时抛出 error.message，成功时取指定字段。 */
export function unwrap(result, key) {
  if (!result.ok) throw Error(result.error?.message || "数据格式错误");
  return result[key];
}
