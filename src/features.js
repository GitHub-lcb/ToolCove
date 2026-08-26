// Pro 功能开关表与判定。与 license.rs 的 payload.features 字符串严格一致。
// 首批锁定的真实功能（其余全部免费）：
//   db-export-xlsx  数据库结果集 Excel 导出（新能力，CSV/JSON 保持免费）
//   theme-custom    自定义主题色（新能力）

export const PRO_FEATURES = {
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
};

/** 某 Pro 功能是否对当前授权态可用 */
export function isFeatureEnabled(status, feature) {
  if (!status || status.pro !== true) return false;
  const features = Array.isArray(status.features) ? status.features : [];
  return features.includes(feature);
}

/** 锁定提示的 i18n 键（工具窗口提示需含「主窗口 设置 → Pro」导航指引） */
export function proLockHint() {
  return "license.lockHint";
}

/** 所有 Pro 功能的 key 列表（对比表/测试用） */
export function proFeatureKeys() {
  return Object.keys(PRO_FEATURES);
}
