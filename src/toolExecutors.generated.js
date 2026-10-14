// ⚠️ 本文件由 scripts/gen-tool-registry.mjs 生成，请勿手改。
// 重新生成：node scripts/gen-tool-registry.mjs
//
// 各工具包自带的 Agent 动作实现。还没迁进包的工具，其实现仍在 agent/executors.js 手写区。
// 装配：agent/executors.js 把本对象合并进 BUILTIN_TOOL_IMPLS（键集合由 catalog.test.js 双向强制）。
import executor0 from "./tools/convert/executor.js";
import executor1 from "./tools/table/executor.js";
import executor2 from "./tools/markdown/executor.js";
import executor3 from "./tools/xml/executor.js";
import executor4 from "./tools/diff/executor.js";
import executor5 from "./tools/schema/executor.js";
import executor6 from "./tools/time/executor.js";
import executor7 from "./tools/json/executor.js";
import executor8 from "./tools/network/executor.js";
import executor9 from "./tools/crypto/executor.js";
import executor10 from "./tools/file/executor.js";
import executor11 from "./tools/image/executor.js";
import executor12 from "./tools/generator/executor.js";
import executor13 from "./tools/pdf/executor.js";
import executor14 from "./tools/request/executor.js";
import executor15 from "./tools/db/executor.js";

export const TOOL_EXECUTORS = Object.freeze({
  ...executor0,
  ...executor1,
  ...executor2,
  ...executor3,
  ...executor4,
  ...executor5,
  ...executor6,
  ...executor7,
  ...executor8,
  ...executor9,
  ...executor10,
  ...executor11,
  ...executor12,
  ...executor13,
  ...executor14,
  ...executor15,
});
