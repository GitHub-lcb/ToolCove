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
import { mergeBuiltinSites } from "./builtin.js";

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

// 站点列表从「存储里读出来的值」到「界面看到的列表」的公共管线：
// 先收掉改名后遗留的旧内置条目，再合并当前内置站点。
//
// 单独抽出来是为了让单测能直接验证这条顺序——顺序反了的话，旧条目会在
// mergeBuiltinSites 里被当成「用户自己加的同名条目」原样保留下来，清不掉。
export function prepareSites(stored) {
  return mergeBuiltinSites(dropRenamedBuiltinSites(stored));
}

export async function loadSites() {
  // 读回来的已经是解密后的明文；旧版本若存的是明文，restore 会原样返回（decryptValue 对无前缀值透传）。
  const stored = await loadSecureToolbox(SITES_KEY, [], restoreSites);
  return prepareSites(stored);
}

/** 防抖写（200ms）——描述文件在编辑框里逐字输入时不该每敲一下就写一次盘。 */
export function saveSites(sites, onError) {
  saveSecureToolbox(SITES_KEY, sites, protectSites, onError);
}

// 内置站点改过 key（区分 CN 与国际版）：读取时把旧 key 的状态带过来，
// 否则用户昨天刚签成的记录会凭空消失，今天又被判成「没签过」再跑一遍。
const RENAMED_SITE_KEYS = { qoder: "qoder-cn" };

// 同一次改名的另一半：**站点列表**里那条旧 key 的条目也要收走。
// 只迁状态不迁列表的话，界面上会一直挂着一个「Qoder / qoder / 内置」，
// 点了「立即签到」报「找不到该站点」，而它既不是当前内置条目（不给删除按钮）、
// 又确实是用户自己那条（不给不了删除），就成了怎么都清不掉的僵尸条目。
//
// 只认「旧 key + builtin 为真」这一种组合：用户可能自己加过一个就叫 qoder 的站点，
// 那种必须原样留下，否则就是把他自己的配置悄悄删了。
function dropRenamedBuiltinSites(sites) {
  const list = Array.isArray(sites) ? sites : [];
  const dead = new Set(
    Object.keys(RENAMED_SITE_KEYS).filter((old) => list.some((s) => s?.key === old && s?.builtin === true)),
  );
  if (!dead.size) return list;
  return list.filter((s) => !dead.has(String(s?.key ?? "")));
}

export async function loadStates() {
  const value = await loadToolbox(STATE_KEY, {});
  const states = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const from = Object.keys(RENAMED_SITE_KEYS).find((key) => states[key] && !states[RENAMED_SITE_KEYS[key]]);
  if (!from) return states;
  const next = { ...states, [RENAMED_SITE_KEYS[from]]: states[from] };
  delete next[from];
  return next;
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
