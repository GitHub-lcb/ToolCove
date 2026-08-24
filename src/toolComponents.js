// 工具箱工具组件映射：ToolboxView（主窗口内嵌）与 ToolWindow（独立窗口）共用，
// key 与 toolboxTools.js 注册表一一对应，避免多入口重复维护映射。
// 工具组件体积大，用 defineAsyncComponent 切到才加载（入口处 Suspense/动态组件触发）。
import { defineAsyncComponent } from "vue";

export const TOOL_COMPONENTS = {
  convert: defineAsyncComponent(() => import("./tools/ConvertTool.vue")),
  diff: defineAsyncComponent(() => import("./tools/TextTool.vue")),
  time: defineAsyncComponent(() => import("./tools/TimeTool.vue")),
  json: defineAsyncComponent(() => import("./tools/JsonTool.vue")),
  network: defineAsyncComponent(() => import("./tools/NetworkTool.vue")),
  crypto: defineAsyncComponent(() => import("./tools/CryptoTool.vue")),
  file: defineAsyncComponent(() => import("./tools/FileTool.vue")),
  image: defineAsyncComponent(() => import("./tools/ImageTool.vue")),
  generator: defineAsyncComponent(() => import("./tools/GeneratorTool.vue")),
  request: defineAsyncComponent(() => import("./tools/RequestTool.vue")),
  db: defineAsyncComponent(() => import("./tools/DbTool.vue")),
  chat: defineAsyncComponent(() => import("./tools/AiChatTool.vue")),
};

export function getToolComponent(key) {
  const comp = TOOL_COMPONENTS[key];
  if (!comp) {
    console.error("工具箱注册表缺少组件映射：", key);
    return TOOL_COMPONENTS.json;
  }
  return comp;
}
