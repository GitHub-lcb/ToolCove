// 装配层：把真实实现（存储 / HTTP / 通知）接到 runner 与 scheduler 上。
//
// 单独的必要性：runner 与 scheduler 都是 deps 注入的纯逻辑，单测里塞假实现就行；
// 真实接线集中在这里，避免 App.vue 与工具窗口各写一份「怎么创建 runner」。
import { invoke } from "../platform/invoke.js";
import { isDesktop } from "../platform/env.js";
import { createCheckInRunner, TRIGGER } from "./runner.js";
import { createScheduler } from "./schedule.js";
import { requestOnce } from "./http.js";
import {
  loadPolicy as loadPolicyRaw,
  loadSites as loadSitesRaw,
  loadStates as loadStatesRaw,
  savePolicy as savePolicyRaw,
  saveSites as saveSitesRaw,
  saveStates as saveStatesRaw,
} from "./store.js";

export { loadPolicyRaw as loadPolicy, loadSitesRaw as loadSites, loadStatesRaw as loadStates, savePolicyRaw as savePolicy, saveSitesRaw as saveSites, saveStatesRaw as saveStates };

/**
 * 站点列表变更事件名（跨窗口广播）。
 *
 * 抓包工具和签到工具是两个独立窗口，各自有各自的内存状态。抓包窗口新增站点后
 * 如果不通知，已经打开的签到窗口会一直显示旧列表——用户会以为「加不进去」。
 * 存盘走的是同一个文件，所以只要刷新一遍就一致，不需要任何同步机制。
 */
export const SITES_CHANGED_EVENT = "checkin:sites-changed";

const runner = createCheckInRunner({ request: requestOnce });

/**
 * 自动任务结果的通知。
 *
 * 只在「有站点真的签成了」时才发：每天早上弹一条「0/3 成功」没有意义，
 * 反而训练用户忽略通知。而失败静默——用户打开窗口能看到红色徽章，不该被通知轰炸。
 */
async function notifySummary(summary) {
  if (!isDesktop || !summary?.results?.length) return;
  const done = summary.results.filter((r) => r.outcome === "ok" || r.outcome === "already").length;
  if (!done) return;
  const title = "自动签到";
  const body = summary.results.map((r) => `${r.key}：${r.outcome}`).join("\n");
  try {
    await invoke("notify", { title, body });
  } catch {
    // 通知失败不影响签到结果，也不该冒泡到定时任务。
  }
}

let scheduler = null;

/** 取得（必要时创建）全局调度器。必须在主窗口调用。 */
export function getScheduler() {
  if (!scheduler) {
    scheduler = createScheduler({
      loadSites: loadSitesRaw,
      loadStates: loadStatesRaw,
      saveStates: saveStatesRaw,
      loadPolicy: loadPolicyRaw,
      runDue: (sites, states, policy) => runner.runDue(sites, states, policy),
      notify: notifySummary,
    });
  }
  return scheduler;
}

export function startCheckInScheduler(options) {
  return getScheduler().start(options);
}

export function stopCheckInScheduler() {
  scheduler?.stop();
}

/** 手动「立即全部签到」：与自动任务互斥（runner 内按站点去重）。 */
export async function runAllNow({ trigger = TRIGGER.MANUAL } = {}) {
  const sites = await loadSitesRaw();
  const states = await loadStatesRaw();
  const policy = await loadPolicyRaw();
  const { results, states: nextStates } = await runner.runAll(sites, states, { trigger, policy });
  saveStatesRaw(nextStates);
  return { results, states: nextStates };
}

/** 手动「立即签到」单个站点；站点不存在时返回 null。 */
export async function runSiteNow(key, { trigger = TRIGGER.MANUAL } = {}) {
  const sites = await loadSitesRaw();
  const site = sites.find((s) => s.key === key);
  if (!site) return null;
  const states = await loadStatesRaw();
  const policy = await loadPolicyRaw();
  const result = await runner.runSite(site, states[key], { trigger, policy });
  const next = runner.settle(states[key], result, policy);
  saveStatesRaw({ ...states, [key]: next });
  return result;
}

export { runner, TRIGGER };
