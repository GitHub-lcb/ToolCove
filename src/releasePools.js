// 发布工作台「临时 Pool」Pool（区别于领域 Pool）的纯函数逻辑。
// 数据结构：{ id, name, codingProject, codingProjectName, createdAt, updatedAt, archivedAt? }
// 持久化 key：release-pools = { active: [...], archived: [...] }（经 load_data/save_data 读写）

// 多行文本 → 有序去重的 Pool 名列表（忽略空行、去除首尾空白；大小写不敏感去重，保留首次出现）
export function parsePoolLines(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const name = raw.trim();
    if (!name) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

// 发布临时 Pool 新增时，只比较临时 Pool，不纳入领域 Pool。
export function localPoolNames(active, archived) {
  return [...(Array.isArray(active) ? active : []), ...(Array.isArray(archived) ? archived : [])]
    .map((p) => String(p?.name ?? "").trim())
    .filter(Boolean);
}

// Coding 项目命中结果：唯一命中自动选择，多命中交给 UI 让用户选择。
export function splitProjectHits(hits) {
  const candidates = [...new Set((Array.isArray(hits) ? hits : []).filter((x) => typeof x === "string" && x.trim()))];
  return candidates.length === 1 ? { selected: candidates[0], candidates: [] } : { selected: "", candidates };
}

// 与传入的已有临时 Pool 名称比较，拆出可新增与需跳过两组
export function splitNewPools(names, existingNames) {
  const existing = new Set((existingNames || []).map((n) => String(n ?? "").trim().toLowerCase()).filter(Boolean));
  const addable = [];
  const skipped = [];
  for (const n of names || []) {
    (existing.has(String(n).toLowerCase()) ? skipped : addable).push(n);
  }
  return { addable, skipped };
}

// 组装临时 Pool 记录（新建时用）
export function makeLocalPool(name, codingProject = "", codingProjectName = "") {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: String(name ?? "").trim(),
    codingProject: String(codingProject ?? "").trim(),
    codingProjectName: String(codingProjectName ?? "").trim(),
    createdAt: now,
    updatedAt: now,
  };
}

// 部署方式选项：auto=按命名约定推断（online 前缀视为容器化）；container=容器化（构建完成即发布）；host=主机部署（构建后需 CD 部署）
export const DEPLOY_TYPES = ["auto", "container", "host"];

// Pool 实际部署模式：显式配置（deployType）优先；auto/缺省时按命名约定兜底（online 开头 = 容器化）。
// 拿不准时兜底为 host：多一步部署提示是冗余，漏掉部署是事故。
export function poolDeployMode(pool) {
  const t = pool?.deployType;
  if (t === "container" || t === "host") return t;
  return /^online/i.test(String(pool?.name ?? "").trim()) ? "container" : "host";
}

// 名称是否与某条记录冲突（编辑改名时用）：同 id 除外
export function nameConflict(name, others, ignoreId) {
  const kw = String(name ?? "").trim().toLowerCase();
  if (!kw) return false;
  return (others || []).some((p) => p && p.id !== ignoreId && String(p.name ?? "").trim().toLowerCase() === kw);
}
