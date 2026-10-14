// 工具契约聚合（对外稳定入口）：TOOL_CONTRACTS / CONTRACT_BY_KEY 的真实清单由
// src/contracts/index.generated.js 生成 —— **目录即注册**。
//
// 一个工具 = 一个自包含包（就像一份 skill / 一个 MCP server）：
//   src/tools/<key>/contract.js   纯数据：ui + actions / agentExempt + order（零依赖）
//   src/tools/<key>/logic.js      可选：纯逻辑，工具界面与 Agent 执行器共用
//   src/tools/<key>/executor.js   可选：Agent 动作实现（重依赖只在执行那一刻 import）
//   src/tools/<key>/View.vue      工具界面（懒加载，见 toolComponents.generated.js）
//
// 新增工具：加一个 src/tools/<key>/ 目录，跑 `npm run gen:tools` 重新生成注册表。
// 因为注册是扫出来的，两个人在不同分支各加一个工具时不会争抢同一个登记点。
//
// 分层约束（importBoundaries.test.js 守着）：契约文件必须是纯数据——只能互相导入或导入
// 本目录的 kit.js。首屏要同步读它，手机端对齐测试要用**原生 Node ESM** 直接 import
// （见 mobile/app/toolboxIcons.test.js）。所以聚合器只能是「静态 import + 数组」这种
// 生成形态：import.meta.glob 是 Vite 特性、原生 Node 不认，用不了。
//
// 过渡期：还没搬进工具包的契约暂时仍住在本目录（生成器同时扫两处）；全部迁完后，
// 本目录只剩 kit.js / groups.js / index.js / index.generated.js。
export { TOOL_CONTRACTS, CONTRACT_BY_KEY } from "./index.generated.js";
