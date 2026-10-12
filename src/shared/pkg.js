// 上线包（三张表）的结构定义：列、空包、新行。
// 列的 `labelKey` 指向 common.* 词条，`type` 决定 xlsx.js 里怎么取值与是否画勾选。
export const PKG_POOL_COLS = [
  { key: "pool", labelKey: "common.colPool", type: "text" },
  { key: "content", labelKey: "common.colContent", type: "text" },
  { key: "devBranch", labelKey: "common.colDevBranch", type: "text" },
  { key: "testBranch", labelKey: "common.colTestBranch", type: "text" },
  { key: "uatBranch", labelKey: "common.colUatBranch", type: "text" },
  { key: "prodBranch", labelKey: "common.colProdBranch", type: "text" },
  { key: "backupMaster", labelKey: "common.colBackupMaster", type: "bool" },
  { key: "releaseMerged", labelKey: "common.colReleaseMerged", type: "bool" },
  { key: "dev", labelKey: "common.colDev", type: "text" },
  { key: "test", labelKey: "common.colTest", type: "text" },
  { key: "published", labelKey: "common.colPublished", type: "bool" },
  { key: "note", labelKey: "common.colNote", type: "text" },
];
// 制品表列
export const PKG_ART_COLS = [
  { key: "name", labelKey: "common.colArtifact", type: "text" },
  { key: "module", labelKey: "common.colModule", type: "text" },
  { key: "owner", labelKey: "common.colOwner", type: "text" },
  { key: "version", labelKey: "common.colVersion", type: "text" },
  { key: "note", labelKey: "common.colNote", type: "text" },
];
// 数据库脚本表列
export const PKG_DB_COLS = [
  { key: "db", labelKey: "common.colDatabase", type: "text" },
  { key: "file", labelKey: "common.colScriptFile", type: "text" },
  { key: "owner", labelKey: "common.colOwner", type: "text" },
  { key: "order", labelKey: "common.colOrder", type: "text" },
  { key: "note", labelKey: "common.colNote", type: "text" },
];

// 空的上线包结构
export function emptyPkg() {
  return { pools: [], artifacts: [], dbScripts: [] };
}

export function newPkgRow(cols) {
  const r = { id: crypto.randomUUID() };
  cols.forEach((c) => (r[c.key] = c.type === "bool" ? false : ""));
  return r;
}
