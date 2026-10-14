// 工具箱工具组件映射：ToolboxView（主窗口内嵌）与 ToolWindow（独立窗口）共用。
//
// 清单由 src/toolComponents.generated.js 生成（每个工具包自带 View.vue）；
// 这里只负责两件事：包一层 defineAsyncComponent（切到才加载），以及「找不到就退回 JSON 工具」的兜底
// ——注册表与组件映射由 registryGating.test.js 强制一一对应，兜底只是防御性最后一道。
import { defineAsyncComponent } from "vue";
import { i18n } from "./i18n/index.js";
import { TOOL_COMPONENT_LOADERS } from "./toolComponents.generated.js";

export const TOOL_COMPONENTS = Object.freeze(
  Object.fromEntries(Object.entries(TOOL_COMPONENT_LOADERS).map(([key, loader]) => [key, defineAsyncComponent(loader)]))
);

export function getToolComponent(key) {
  const comp = TOOL_COMPONENTS[key];
  if (!comp) {
    console.error(i18n.global.t("common.missingToolComp", { key }));
    return TOOL_COMPONENTS.json;
  }
  return comp;
}
