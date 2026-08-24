// 本地数据结构版本管理与一次性迁移
// -------------------------------------------------------------
// 设计：每个数据 key 一个 JSON 文件，无中枢。历史上「兼容旧数据」的逻辑
// 分散在各视图 load() 里（每次加载就地补默认，不落盘）。这里把它们收敛成
// 一次性、可版本化、可测试的迁移：启动挂载前跑一次，把结构升级固化落盘，
// 并在独立的 meta.json 里记版本号，供未来演进对齐基线。
//
// 约束：
// - 所有迁移步骤必须【幂等】——重复跑结果不变（升级完写版本号，下次秒退）。
// - 纯转换逻辑抽成导出函数（migrate*V1），便于单测；invoke 编排只做 IO。
// - 任何一步失败都不得阻断应用启动（main.js 里 catch 后照常挂载）。
import { invoke } from "@tauri-apps/api/core";

// 当前数据结构版本。每次改动持久化结构时 +1，并在 MIGRATIONS 末尾补一步。
export const SCHEMA_VERSION = 7;
const META_KEY = "meta";

// ===================== 纯转换函数（可单测，就地改并返回） =====================

// 迭代：docs 数组化、domainId(单)→domainIds(多)、items 与 subtask 补默认字段
export function migrateIterationsV1(iterations) {
  if (!Array.isArray(iterations)) return iterations;
  iterations.forEach((it) => {
    if (!Array.isArray(it.docs)) it.docs = [];
    if (!Array.isArray(it.domainIds)) it.domainIds = it.domainId ? [it.domainId] : [];
    delete it.domainId; // 单值旧字段已并入 domainIds，清理掉
    (it.items || []).forEach((r) => {
      if (typeof r.url !== "string") r.url = "";
      if (!Array.isArray(r.subtasks)) r.subtasks = [];
      r.subtasks.forEach((s) => {
        if (typeof s.url !== "string") s.url = "";
        if (typeof s.code !== "string") s.code = "";
      });
      if (!Array.isArray(r.logs)) r.logs = [];
      if (!Array.isArray(r.questions)) r.questions = [];
    });
  });
  return iterations;
}

// 问题：logs / images / domainIds 数组化，resolution 补字符串
export function migrateProblemsV1(problems) {
  if (!Array.isArray(problems)) return problems;
  problems.forEach((p) => {
    if (!Array.isArray(p.logs)) p.logs = [];
    if (!Array.isArray(p.images)) p.images = [];
    if (!Array.isArray(p.domainIds)) p.domainIds = [];
    if (typeof p.resolution !== "string") p.resolution = "";
  });
  return problems;
}

// 发布单：旧结构 pools[] → items[]（kind=pool），并移除旧字段
export function migrateReleasesV1(releases) {
  if (!Array.isArray(releases)) return releases;
  releases.forEach((r) => {
    if (!Array.isArray(r.items)) {
      r.items = (r.pools || []).map((p) => ({
        id: crypto.randomUUID(),
        kind: "pool",
        name: p.name,
        value: "",
        note: p.note || "",
        done: !!p.done,
      }));
      delete r.pools;
    }
  });
  return releases;
}

// 迭代：待确认问题补 images 数组（截图附件）
export function migrateIterationsV2(iterations) {
  if (!Array.isArray(iterations)) return iterations;
  iterations.forEach((it) => {
    (it.items || []).forEach((r) => {
      (r.questions || []).forEach((q) => {
        if (!Array.isArray(q.images)) q.images = [];
      });
    });
  });
  return iterations;
}

// 迭代：需求补 bugs 数组（缺陷跟踪）
export function migrateIterationsV3(iterations) {
  if (!Array.isArray(iterations)) return iterations;
  iterations.forEach((it) => {
    (it.items || []).forEach((r) => {
      if (!Array.isArray(r.bugs)) r.bugs = [];
    });
  });
  return iterations;
}

// 迭代：需求补预估人天。规模与超额状态均为派生值，不持久化。
export function migrateIterationsV4(iterations) {
  if (!Array.isArray(iterations)) return iterations;
  iterations.forEach((it) => {
    (it.items || []).forEach((r) => {
      const days = Number(r.estimateDays);
      r.estimateDays = Number.isFinite(days) && days > 0 ? days : null;
    });
  });
  return iterations;
}

// 速记：补 images 数组（图片附件）
export function migrateSnippetsV3(snippets) {
  if (!Array.isArray(snippets)) return snippets;
  snippets.forEach((s) => {
    if (!Array.isArray(s.images)) s.images = [];
  });
  return snippets;
}

// 速记：补 fields 数组（结构化字段：账号/密码等多条「标签: 值」）
export function migrateSnippetsV4(snippets) {
  if (!Array.isArray(snippets)) return snippets;
  snippets.forEach((s) => {
    if (!Array.isArray(s.fields)) s.fields = [];
  });
  return snippets;
}

// 领域 codingProject 下沉 Pool：把领域的标识复制给其下未填的 Pool，再从领域删除该字段。
// 就地改并返回 [domains, pools]（供单测断言）；幂等：重复跑结果不变。
export function migrateLegacyProjectToPools(domains, pools) {
  if (!Array.isArray(domains) || !Array.isArray(pools)) return [domains, pools];
  domains.forEach((d) => {
    const proj = d && typeof d.codingProject === "string" ? d.codingProject.trim() : "";
    if (proj) {
      pools.forEach((p) => {
        if (p && p.domainId === d.id && !(typeof p.codingProject === "string" && p.codingProject.trim())) {
          p.codingProject = proj;
        }
      });
    }
    delete d.codingProject;
  });
  return [domains, pools];
}

// v(index) → v(index+1) 的迁移步骤。每步幂等，内部各 key 独立加载/落盘。
const MIGRATIONS = [
  // v0 → v1：固化历史上分散在各视图的结构兼容逻辑
  async () => {
    await migrateKey("iterations", migrateIterationsV1);
    await migrateKey("problems", migrateProblemsV1);
    await migrateKey("releases", migrateReleasesV1);
  },
  // v1 → v2：待确认问题支持截图附件，补 images 数组
  async () => {
    await migrateKey("iterations", migrateIterationsV2);
  },
  // v2 → v3：速记支持图片附件，补 images 数组
  async () => {
    await migrateKey("snippets", migrateSnippetsV3);
  },
  // v3 → v4：速记支持结构化字段（账号/密码等多条「标签: 值」），补 fields 数组
  async () => {
    await migrateKey("snippets", migrateSnippetsV4);
  },
  // v4 → v5：迭代需求支持缺陷跟踪，补 bugs 数组
  async () => {
    await migrateKey("iterations", migrateIterationsV3);
  },
  // v5 → v6：领域 codingProject 下沉到 Pool（复制给未填 Pool 后删除领域字段）。
  // 跨 key 迁移：两个 key 都读回数组才落盘，防止损坏数据被覆盖。
  async () => {
    const domains = await loadKey("domains", []);
    const pools = await loadKey("pools", []);
    if (!Array.isArray(domains) || !Array.isArray(pools)) return;
    migrateLegacyProjectToPools(domains, pools);
    await invoke("save_data", { key: "domains", data: domains });
    await invoke("save_data", { key: "pools", data: pools });
  },
  // v6 → v7：需求支持预估人天；规模、实际人天与超额状态运行时统一计算。
  async () => {
    await migrateKey("iterations", migrateIterationsV4);
  },
];

// ===================== IO 编排 =====================

async function loadKey(key, fallback) {
  const v = await invoke("load_data", { key });
  return v == null ? fallback : v;
}

// 读一个 key → 跑纯转换 → 仅当结构确实为数组时才落盘（避免把损坏数据的空数组写回覆盖）
async function migrateKey(key, transform) {
  const data = await loadKey(key, []);
  if (!Array.isArray(data)) return;
  transform(data);
  await invoke("save_data", { key, data });
}

// 启动时调用一次：幂等。已是最新版本则秒退；任何步骤失败向上抛，由调用方兜底。
// 返回 { migrated, from, to }。
export async function runMigrations() {
  let meta = await loadKey(META_KEY, {});
  // meta 首次不存在时 load_data 返回空数组，统一按空对象处理
  if (Array.isArray(meta) || meta == null || typeof meta !== "object") meta = {};
  const from = Number(meta.schemaVersion) || 0;
  if (from >= SCHEMA_VERSION) return { migrated: false, from, to: from };
  for (let v = from; v < SCHEMA_VERSION; v++) {
    await MIGRATIONS[v]();
  }
  meta.schemaVersion = SCHEMA_VERSION;
  await invoke("save_data", { key: META_KEY, data: meta });
  return { migrated: true, from, to: SCHEMA_VERSION };
}
