// 加密与校验工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据在同一包的 ./contract.js。
//
// 哈希 / HMAC / 口令生成的纯逻辑在**中立共享层** src/cryptoTool.js：
// 工具界面与手机端也在用同一份实现，故留在根级而非沉入本包。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { digestText, generatePassword, hmacText } from "../../cryptoTool.js";

export default {
  "crypto.hash": { execute: ({ text, algorithm = "SHA-256", output = "hex" }) => digestText(text, algorithm, output) },
  "crypto.hmac": { execute: ({ text, secret, algorithm = "SHA-256", output = "hex" }) => hmacText(text, secret, algorithm, output) },
  "crypto.password": { execute: (args) => ({ password: generatePassword(args) }) },
};
