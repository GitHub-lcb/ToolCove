// JSON Schema 工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据在同一包的 ./contract.js。
//
// 推断/校验纯逻辑在 ./logic.js（自研，零依赖）；输入是 JSON 文本，故复用中立层的
// json.js（parseJson）与 shared/toolResult.js（unwrap）把文本解成对象。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { inferSchema, validateSchema } from "./logic.js";
import { parseJson } from "../../json.js";
import { unwrap } from "../../shared/toolResult.js";

export default {
  "schema.infer": { execute: ({ text, required = true }) => inferSchema(unwrap(parseJson(text), "value"), { required }) },
  "schema.validate": { execute: ({ value, schemaText }) => validateSchema(unwrap(parseJson(value), "value"), unwrap(parseJson(schemaText), "value")) },
};
