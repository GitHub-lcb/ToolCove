// 工具契约聚合（对外稳定入口）：TOOL_CONTRACTS / CONTRACT_BY_KEY 的真实清单由
// src/contracts/index.generated.js 生成 —— **目录即注册**。
//
// 一个工具 = 一个自包含包（就像一份 skill / 一个 MCP server）：
//   src/tools/<key>/contract.js        纯数据：ui + actions / agentExempt + order（零依赖）
//   src/tools/<key>/logic.js           可选：纯逻辑，工具界面与 Agent 执行器共用
//   src/tools/<key>/executor.js        可选：Agent 动作实现（重依赖只在执行那一刻 import）
//   src/tools/<key>/View.vue           工具界面（懒加载，见 toolComponents.generated.js）
//   src/tools/<key>/i18n.<locale>.json 可选：本工具的词条片段（归包，见 scripts/gen-tool-i18n.mjs）
//
// 新增工具：加一个 src/tools/<key>/ 目录，跑 `npm run gen:tools` 重新生成注册表。
// 因为注册是扫出来的，两个人在不同分支各加一个工具时不会争抢同一个登记点。
//
// 分层约束（importBoundaries.test.js 守着）：契约文件必须是纯数据——只能互相导入或导入
// 本目录的 kit.js。首屏要同步读它，手机端对齐测试要用**原生 Node ESM** 直接 import
// （见 mobile/app/toolboxIcons.test.js）。所以聚合器只能是「静态 import + 数组」这种
// 生成形态：import.meta.glob 是 Vite 特性、原生 Node 不认，用不了。
//
// 迁移已完成（工具包模型第三波收尾）：27 个工具全部住 src/tools/<key>/，本目录只剩
// 基础设施 kit.js / groups.js / index.js / index.generated.js；生成器只扫 src/tools/*/contract.js，
// 旧形态 src/contracts/<key>.js 不再存在（再出现会被生成器守卫成红灯）。
export { TOOL_CONTRACTS, CONTRACT_BY_KEY } from "./index.generated.js";
