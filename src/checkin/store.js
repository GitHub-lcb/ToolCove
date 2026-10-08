// 持久化：站点描述（凭据加密）+ 每站状态与历史。
//
// 落点沿用工具箱资产：toolbox-checkin-sites.json / toolbox-checkin-state.json，
// 与其它工具的数据同级，自动参与每日备份。
//
// 凭据处理：描述文件里的 header 名命中「cookie / token / authorization / …」就整体加密。
// 用现成的 isSensitiveName 而不是自己写白名单——它已经有单测钉住，
// 新增敏感字段时两边自动对齐，不会出现「界面显示加密了、实际存明文」。
import { loadToolbox, saveToolbox } from "../toolboxStore.js";
import { loadSecureToolbox, saveSecureToolbox, isSensitiveName } from "../secureToolbox.js";
import { encryptValue, decryptValue } from "../secure.js";

export const SITES_KEY = "checkin-sites";
export const STATE_KEY = "checkin-state";
export const POLICY_KEY = "checkin-policy";

/** 把描述文件里的 header 值按名字脱敏/还原。 */
async function transformSiteHeaders(sites, transform) {
  return Promise.all(
    (Array.isArray(sites) ? sites : []).map(async (site) => {
      const copy = { ...(site || {}) };
      for (const action of ["status", "checkin"]) {
        if (!copy[action] || !Array.isArray(copy[action].headers)) continue;
        copy[action] = {
          ...copy[action],
          headers: await Promise.all(
            copy[action].headers.map(async ([name, value]) => [name, isSensitiveName(name) ? await transform(String(value ?? "")) : String(value ?? "")]),
          ),
        };
      }
      return copy;
    }),
  );
}

export const protectSites = (sites) => transformSiteHeaders(sites, encryptValue);
export const restoreSites = (sites) => transformSiteHeaders(sites, decryptValue);

export async function loadSites() {
  // 读回来的已经是解密后的明文；旧版本若存的是明文，restore 会原样返回（decryptValue 对无前缀值透传）。
  return loadSecureToolbox(SITES_KEY, [], restoreSites);
}

/** 防抖写（200ms）——描述文件在编辑框里逐字输入时不该每敲一下就写一次盘。 */
export function saveSites(sites, onError) {
  saveSecureToolbox(SITES_KEY, sites, protectSites, onError);
}

export async function loadStates() {
  const value = await loadToolbox(STATE_KEY, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function saveStates(states, onError) {
  saveToolbox(STATE_KEY, states, { onError });
}

export async function loadPolicy() {
  const value = await loadToolbox(POLICY_KEY, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function savePolicy(policy, onError) {
  saveToolbox(POLICY_KEY, policy, { onError });
}
