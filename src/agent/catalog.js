// Agent 工具目录（纯元数据，零重依赖）：
// 刻意与实现层（executors.js / dataTools.js）分离——首屏只需要目录
// （设置归一化、能力面板），不必把 exceljs/hash-wasm 等重依赖一起拉进来。
// 一致性由 catalog.test.js 双向强制：目录里的每个名字都必须有实现，反之亦然。
//
// 工具动作的元数据不再写在这里：它们与工具箱 UI 元数据一起住在
// src/contracts/<key>.js（单一真相源），本文件只做投影。
// 留在本文件的是两类「不属于任何工具箱工具」的动作：
//   - 引擎自身动作（spill.read，toolKey 为 agent）
//   - 业务数据动作（data.*）：其 inputSchema 依赖仓库层 KINDS，留在 dataTools.js
//     按需加载，目录这边只放描述性元数据
import { TOOL_CONTRACTS } from "../contracts/index.js";
import { schema, str } from "../contracts/kit.js";

// 引擎自身动作：spill.read 读回被溢出的工具结果。toolKey 为 agent（不属于任何工具箱工具）。
const ENGINE_ACTIONS = [
  {
    name: "spill.read",
    description: "读回被裁剪的大结果：按 key 分段读取（offset/limit）或按 keyword 定位（context 指定上下文字符数）",
    descriptionKey: "agent.toolSpillRead",
    toolKey: "agent",
    risk: "read",
    retryable: false,
    concurrencySafe: true,
    inputSchema: schema(
      { key: str(64), keyword: str(256), offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 64000 }, context: { type: "integer", minimum: 0, maximum: 4000 } },
      ["key"]
    ),
  },
];

// 业务数据动作（inputSchema 在 dataTools.js 随实现给出，避免把仓库层拉进首屏）。
const BUSINESS_ACTIONS = [
  {
    name: "data.query",
    description: "检索本地业务数据（kind：snippets 速记 / problems 问题 / iterations 迭代 / domains 领域 / pools 池 / releases 发布 / prompts 生图与生视频提示词），支持关键词、标签、状态过滤，返回按更新时间倒序的 {total, items} 摘要",
    descriptionKey: "agent.toolDataQuery",
    toolKey: "data",
    risk: "read",
    retryable: false,
  },
  {
    name: "data.get",
    description: "按 id 读取一条完整的本地业务数据（先用 data.query 拿到 id；kind 同 data.query）",
    descriptionKey: "agent.toolDataGet",
    toolKey: "data",
    risk: "read",
    retryable: false,
  },
  {
    name: "data.create",
    description: "新建一条本地业务数据（kind 同 data.query）。draft 必填：snippets/problems 用 title，domains 用 name，pools 用 domainId+name，iterations 用 title+version，releases 用 name，prompts 用 positive",
    descriptionKey: "agent.toolDataCreate",
    toolKey: "data",
    risk: "write",
    retryable: false,
  },
  {
    name: "data.update",
    description: `按 id 修改一条本地业务数据（kind 同 data.query）。可改字段：snippets→title/category/content/pinned；problems→title/type/status/tags/note/resolution；iterations→title/version/status/releaseDate/goal/domainIds；domains→name/note；pools→name/note/path；releases→name/codingProject；prompts→title/positive/negative/target/category/tags/note/pinned`,
    descriptionKey: "agent.toolDataUpdate",
    toolKey: "data",
    risk: "write",
    retryable: false,
  },
  {
    name: "data.remove",
    description: "删除一条本地业务数据（速记/问题/提示词属同步类别，会同步删除到其他设备；不可恢复）。执行前必须由用户确认",
    descriptionKey: "agent.toolDataRemove",
    toolKey: "data",
    risk: "write",
    confirm: "always",
    retryable: false,
  },
];

// 目录保持全量静态导出（首屏同步读取，不做版本过滤）；版本过滤在消费处
// （agent/tools.js 的 buildAgentRegistry / listAgentTools）按 meta.scope 进行。
// 所以投影动作时把契约的 scope 带到每个动作 meta 上——动作本身没有 scope 声明。
export const AGENT_TOOL_CATALOG = Object.freeze([
  ...TOOL_CONTRACTS.flatMap((contract) => (contract.actions || []).map((action) => ({ ...action, scope: contract.scope }))),
  ...ENGINE_ACTIONS,
  ...BUSINESS_ACTIONS,
]);

// 供 config.normalize 与 UI 复用（Object.freeze 防止误改：normalizeAgent 只认这个名单）
export const AGENT_TOOL_NAMES = Object.freeze(AGENT_TOOL_CATALOG.map((tool) => tool.name));

// 运行期按名查元数据的索引（CatalogMeta 查询）
export const AGENT_TOOL_BY_NAME = new Map(AGENT_TOOL_CATALOG.map((tool) => [tool.name, tool]));
