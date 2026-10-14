// 企业策略的模块级缓存 + 持久化（三期管理面）。
//
// 为什么要有同步可得的缓存：投影（toolboxTools.visibleToolboxTools / agent/tools.*）是**同步纯函数**，
// 不能 await 一次读盘再决定过滤。于是启动时 loadPolicy 读一次填充内存缓存，之后投影只读 getPolicySync。
// 写路径（设置页改动）走 setPolicy：先更新缓存（投影立刻反映人的选择），再落盘。
import { invoke } from "../platform/invoke.js";
import { POLICY_KEY, normalizePolicy } from "./policy.js";

// 空策略＝不限制。企业态未配置策略时行为与个人版一致。
let cache = normalizePolicy(null);

const snapshot = () => ({ disabledTools: [...cache.disabledTools], maxRisk: cache.maxRisk });

/** 当前策略的只读快照（投影处同步读取）。返回副本，避免调用方改到缓存本体。 */
export function getPolicySync() {
  return snapshot();
}

/**
 * 更新策略：缓存立即生效（投影是同步判定，人一拨开关就该看到结果），随后异步落盘。
 * 落盘失败不回滚缓存——内存里已是用户刚选的结果，回滚会让人「看着改了其实没改」；
 * 失败由下一次落盘或重启后的读盘纠正。
 */
export function setPolicy(policy) {
  cache = normalizePolicy(policy);
  invoke("save_data", { key: POLICY_KEY, data: snapshot() }).catch(() => {});
  return snapshot();
}

/**
 * 从存储载入策略填充缓存（启动时调用一次）。
 * 读失败**保留既有缓存**而不是清空：一次瞬时失败不该把管理员刚配好的门禁悄悄放开。
 * load_data 对缺失键返回 []（桌面/浏览器/远端三端一致）——非对象即按空策略处理。
 */
export async function loadPolicy() {
  try {
    const raw = await invoke("load_data", { key: POLICY_KEY });
    if (raw && typeof raw === "object" && !Array.isArray(raw)) cache = normalizePolicy(raw);
  } catch {
    // 保留既有缓存
  }
  return snapshot();
}

/** 供测试清理缓存，避免跨用例状态泄漏。 */
export function __resetPolicy() {
  cache = normalizePolicy(null);
}
