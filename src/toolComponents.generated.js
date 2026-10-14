// ⚠️ 本文件由 scripts/gen-tool-registry.mjs 生成，请勿手改。
// 重新生成：node scripts/gen-tool-registry.mjs
//
// 工具界面一律懒加载：只有真要打开某个工具的窗口/页面时才 import 它的 View.vue。
export const TOOL_COMPONENT_LOADERS = Object.freeze({
  "convert": () => import("./tools/ConvertTool.vue"),
  "table": () => import("./tools/TableTool.vue"),
  "markdown": () => import("./tools/MarkdownTool.vue"),
  "xml": () => import("./tools/XmlTool.vue"),
  "diff": () => import("./tools/TextTool.vue"),
  "schema": () => import("./tools/SchemaTool.vue"),
  "time": () => import("./tools/TimeTool.vue"),
  "json": () => import("./tools/JsonTool.vue"),
  "network": () => import("./tools/NetworkTool.vue"),
  "crypto": () => import("./tools/CryptoTool.vue"),
  "file": () => import("./tools/FileTool.vue"),
  "image": () => import("./tools/ImageTool.vue"),
  "photo": () => import("./tools/PhotoTool.vue"),
  "screenshot": () => import("./tools/ScreenshotTool.vue"),
  "disk": () => import("./tools/DiskAnalyzerTool.vue"),
  "generator": () => import("./tools/GeneratorTool.vue"),
  "pdf": () => import("./tools/pdf/View.vue"),
  "request": () => import("./tools/RequestTool.vue"),
  "downloader": () => import("./tools/DownloadTool.vue"),
  "db": () => import("./tools/DbTool.vue"),
  "chat": () => import("./tools/AiChatTool.vue"),
  "checkin": () => import("./tools/CheckInTool.vue"),
  "prompt": () => import("./tools/PromptTool.vue"),
  "netcapture": () => import("./tools/NetCaptureTool.vue"),
  "label": () => import("./tools/LabelTool.vue"),
  "rail": () => import("./tools/RailTycoonTool.vue"),
  "interview": () => import("./tools/InterviewTool.vue"),
});
