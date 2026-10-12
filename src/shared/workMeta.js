// 研发管理面的展示元数据：资料类型、领域配色、发布用途、排序方式。
//
// 这些不是"通用工具"，是**业务词表**——每个 `labelKey` 都指向 `common.*` 词条，
// 每个 `cls` 都对应 globals.css 里的 `tc-chip` 配色类，`icon` 对应 ui/Icon.vue 的 name。
// 放在 shared.js 里会让人以为改配色要通读一大片纯函数；单独成文件后，
// "加一个发布用途要改哪几处"一眼可见（词表 + 词条 + 配色类）。
export const TYPES = {
  file: { labelKey: "common.typeFile", icon: "folder", cls: "tc-primary" },
  url: { labelKey: "common.typeUrl", icon: "link", cls: "tc-sky" },
  project: { labelKey: "common.typeProject", icon: "briefcase", cls: "tc-amber" },
  note: { labelKey: "common.typeNote", icon: "note", cls: "tc-accent" },
};

// 领域配色（循环取用；只用中性主色与领域色板，不混入 danger/success 语义色）
// 单一来源：DomainView 领域卡、IterationView 色点、ProblemView 等按 index 循环取色
export const DOMAIN_COLORS = ["var(--primary)", "var(--teal)", "var(--primary-hover)", "var(--amber)", "var(--fuchsia)", "var(--green)", "var(--orange)", "var(--sky)"];

// 发布用途（资料在上线发布单里的角色）
export const RELEASE_ROLES = {
  pool: { labelKey: "common.rolePool", shortKey: "common.rolePoolShort", icon: "upload", cls: "tc-primary" },
  sql: { labelKey: "common.roleSql", shortKey: "common.roleSqlShort", icon: "database", cls: "tc-teal" },
  config: { labelKey: "common.roleConfig", shortKey: "common.roleConfigShort", icon: "settings", cls: "tc-accent" },
  note: { labelKey: "common.roleNote", shortKey: "common.roleNoteShort", icon: "note", cls: "tc-note" },
};
export const RELEASE_ROLE_ORDER = ["pool", "sql", "config", "note"];

// 排序方式
export const SORTS = {
  updated: { labelKey: "common.sortUpdated" },
  created: { labelKey: "common.sortCreated" },
  name: { labelKey: "common.sortName" },
};

// 由一条资料按发布用途派生发布项内容
export function releaseItemFromResource(res) {
  const role = res.role || "pool";
  if (role === "sql" || role === "config")
    return { kind: role, name: (res.title || res.value || "").trim(), value: (res.value || "").trim(), note: res.note || "" };
  return { kind: role, name: (res.value || res.title || "").trim(), value: "", note: res.note || "" };
}

// 组装某项目下全部资料的发布清单
export function buildReleaseItems(allItems, projectId) {
  return allItems
    .filter((it) => it.type !== "project" && it.projectId === projectId)
    .map((res) => ({ id: crypto.randomUUID(), resId: res.id, ...releaseItemFromResource(res), done: false }));
}
