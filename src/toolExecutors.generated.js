// ⚠️ 本文件由 scripts/gen-tool-registry.mjs 生成，请勿手改。
// 重新生成：node scripts/gen-tool-registry.mjs
//
// 各工具包自带的 Agent 动作实现。还没迁进包的工具，其实现仍在 agent/executors.js 手写区。
// 装配：agent/executors.js 把本对象合并进 BUILTIN_TOOL_IMPLS（键集合由 catalog.test.js 双向强制）。
import executor0 from "./tools/pdf/executor.js";

export const TOOL_EXECUTORS = Object.freeze({
  ...executor0,
});
