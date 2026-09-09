// Pro 功能开关表与判定。与 license.rs 的 payload.features 字符串严格一致。
// 当前锁定的真实功能（其余全部免费）：
//   agent-pro       Agent 完整能力（写入类工具 / 步数与日配额解除 / 免确认策略 / 断点续跑）
//   db-export-xlsx  数据库结果集 Excel 导出（CSV/JSON 保持免费）
//   theme-custom    自定义主题色
//   cloud-sync      速记与问题记录端到端加密云同步

export const PRO_FEATURES = {
  "agent-pro": {
    labelKey: "pro.featureAgent",
    descKey: "pro.featureAgentDesc",
    icon: "zap",
  },
  "db-export-xlsx": {
    labelKey: "pro.featureDbExportXlsx",
    descKey: "pro.featureDbExportXlsxDesc",
    icon: "table",
  },
  "theme-custom": {
    labelKey: "pro.featureThemeCustom",
    descKey: "pro.featureThemeCustomDesc",
    icon: "palette",
  },
  "cloud-sync": {
    labelKey: "pro.featureCloudSync",
    descKey: "pro.featureCloudSyncDesc",
    icon: "refresh",
  },
};

// 特性蕴含表：将来若把 agent-pro 拆成更细的 SKU，在这里声明即可，已签发的旧 key 自动覆盖新特性名。
// 反方向做不到——无法从已签发的 key 里删掉字符串，所以起步只用一个 SKU。
const IMPLIES = {
  "agent-pro": ["agent-write", "agent-unlimited"],
};

/** 某 Pro 功能是否对当前授权态可用 */
export function isFeatureEnabled(status, feature) {
  if (!status || status.pro !== true) return false;
  const features = Array.isArray(status.features) ? status.features : [];
  return features.includes(feature) || features.some((f) => (IMPLIES[f] || []).includes(feature));
}

/** 锁定提示的 i18n 键（工具窗口提示需含「主窗口 设置 → Pro」导航指引） */
export function proLockHint() {
  return "license.lockHint";
}

/** 所有 Pro 功能的 key 列表（对比表/测试用） */
export function proFeatureKeys() {
  return Object.keys(PRO_FEATURES);
}
