// ⚠️ 本文件由 scripts/gen-tool-registry.mjs 生成，请勿手改。
// 重新生成：node scripts/gen-tool-registry.mjs
//
// 工具界面一律懒加载：只有真要打开某个工具的窗口/页面时才 import 它的 View.vue。
export const TOOL_COMPONENT_LOADERS = Object.freeze({
  "convert": () => import("./tools/convert/View.vue"),
  "table": () => import("./tools/table/View.vue"),
  "markdown": () => import("./tools/markdown/View.vue"),
  "xml": () => import("./tools/xml/View.vue"),
  "diff": () => import("./tools/diff/View.vue"),
  "schema": () => import("./tools/schema/View.vue"),
  "time": () => import("./tools/time/View.vue"),
  "json": () => import("./tools/json/View.vue"),
  "network": () => import("./tools/network/View.vue"),
  "crypto": () => import("./tools/crypto/View.vue"),
  "file": () => import("./tools/file/View.vue"),
  "image": () => import("./tools/image/View.vue"),
  "photo": () => import("./tools/photo/View.vue"),
  "screenshot": () => import("./tools/screenshot/View.vue"),
  "disk": () => import("./tools/disk/View.vue"),
  "generator": () => import("./tools/generator/View.vue"),
  "pdf": () => import("./tools/pdf/View.vue"),
  "request": () => import("./tools/request/View.vue"),
  "downloader": () => import("./tools/downloader/View.vue"),
  "db": () => import("./tools/db/View.vue"),
  "chat": () => import("./tools/chat/View.vue"),
  "checkin": () => import("./tools/checkin/View.vue"),
  "prompt": () => import("./tools/prompt/View.vue"),
  "netcapture": () => import("./tools/netcapture/View.vue"),
  "label": () => import("./tools/label/View.vue"),
  "rail": () => import("./tools/rail/View.vue"),
  "interview": () => import("./tools/interview/View.vue"),
});
