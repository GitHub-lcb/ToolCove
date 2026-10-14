// 接口调试工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据在同一包的 ./contract.js。
//
// 发请求经**中立平台层** src/platform/invoke.js（浏览器端走 fetch，受 CORS 限制）。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { invoke } from "../../platform/invoke.js";

export default {
  "http.request": {
    execute: ({ method, url, headers = [], body, timeoutMs = 20000 }) =>
      invoke("http_request", { method, url, headers: headers.map((h) => [h.name, h.value]), body: body ?? null, timeoutMs }),
  },
};
