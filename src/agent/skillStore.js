// 技能库的持久化与增删。用 toolboxStore（桌面落应用数据目录、浏览器落 IndexedDB），
// 与 agentRuns 同一套存储惯例；落盘失败向上抛，让调用方提示用户——
// 静默吞掉会造成「刚保存的技能，重启就没了」。
import { loadToolbox, saveToolbox } from "../toolboxStore.js";
import { SKILL_MAX_ITEMS, validateSkill } from "./skills.js";

export const SKILLS_KEY = "agentSkills";

/** 列表归一：过滤坏数据、去重、按时间倒序、限量。纯函数，落盘与读取共用一份口径。 */
export function normalizeSkillList(raw, limit = SKILL_MAX_ITEMS) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const item of [...list].sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0))) {
    const skill = validateSkill(item);
    if (!skill || seen.has(skill.id)) continue;
    seen.add(skill.id);
    out.push(skill);
    if (out.length >= limit) break;
  }
  return out;
}

export async function loadSkills() {
  const raw = await loadToolbox(SKILLS_KEY, []);
  return normalizeSkillList(raw);
}

export async function saveSkills(list) {
  const normalized = normalizeSkillList(list);
  await saveToolbox(SKILLS_KEY, normalized);
  return normalized;
}

/**
 * 追加一条技能。
 * 同名技能视为「同一条」而更新而不是堆叠——用户重复沉淀同一个目标时不应得到两条几乎一样的技能。
 * 返回 { skill, updated } 或 null（体检不过）。
 */
export function upsertSkill(list, skill) {
  const clean = validateSkill(skill);
  if (!clean) return null;
  const existing = (Array.isArray(list) ? list : []).find((item) => item?.name === clean.name);
  if (existing) {
    const merged = { ...existing, ...clean, id: existing.id, createdAt: existing.createdAt };
    return { skill: merged, updated: true, list: normalizeSkillList([merged, ...list.filter((item) => item?.id !== existing.id)]) };
  }
  return { skill: clean, updated: false, list: normalizeSkillList([clean, ...(Array.isArray(list) ? list : [])]) };
}

/** 删除一条技能；返回新列表（不存在时原样返回）。 */
export function removeSkill(list, id) {
  const target = String(id || "");
  return normalizeSkillList((Array.isArray(list) ? list : []).filter((item) => item?.id !== target));
}
