// Agent 工具集装配：把**目录**（catalog，零依赖、首屏可用）与**实现**（executors + dataTools，
// 按需加载）合成一个 registry，并把 settings.agent 的运行参数钳制到硬上限。
//
// 分层动机：这一层原来在模块加载时就 createBuiltinRegistry()，于是 luxon / js-yaml / hash-wasm /
// 各工具模块（实测约 300KB）全被拖进启动阶段。现在：
//   - 首屏只需要 AGENT_TOOL_NAMES 与元数据（设置归一化、能力面板）→ 走 catalog，无重依赖；
//   - 真正跑 Agent 时才 buildAgentRegistry()，那一刻才动态 import 实现层。
//
// settings.agent 是用户可改的 JSON，永不信任：maxSteps / retries / requireConfirmation
// 都在这里重算，越界值落回默认，防止手改配置绕过运行时的受控边界。
import { AGENT_CONFIRM_POLICIES, AGENT_MAX_STEPS_HARD_CAP, AGENT_MAX_RETRIES } from "../settingsConfig.js";
import { isDesktop } from "../platform/env.js";
import { AGENT_TOOL_CATALOG, AGENT_TOOL_NAMES, AGENT_TOOL_BY_NAME } from "./catalog.js";
import { createToolRegistry } from "./runtime.js";

export { AGENT_TOOL_NAMES };

const asConfig = (cfg) => (cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {});
const disabledSet = (cfg) => new Set(Array.isArray(asConfig(cfg).disabledTools) ? asConfig(cfg).disabledTools : []);

// 实现层缓存：同一个进程里只加载一次（动态 import 本身有模块缓存，这里只是省一次 await 链）
let implsPromise = null;
function loadImpls() {
  if (!implsPromise) {
    implsPromise = Promise.all([import("./executors.js"), import("./dataTools.js")]).then(([builtin, data]) => ({
      ...builtin.BUILTIN_TOOL_IMPLS,
      ...Object.fromEntries(data.createDataTools().map((tool) => [tool.name, tool])),
    }));
  }
  return implsPromise;
}

/** 目录 + 实现 → 完整工具定义（含 execute 与 inputSchema）。 */
function assemble(impls) {
  return AGENT_TOOL_CATALOG.map((meta) => {
    const impl = impls[meta.name];
    if (!impl) throw Error(`工具目录与实现不一致：${meta.name} 没有实现`);
    return { ...impl, ...meta, inputSchema: impl.inputSchema || {} };
  });
}

/** 全部工具定义（含 execute）。异步：实现层是动态加载的。 */
export async function allTools() {
  return assemble(await loadImpls());
}

// 返回要交给 runAgent 的三个受控参数。同步（只读 config，不需要实现层）。
export function resolveRunOptions(cfg) {
  const c = asConfig(cfg);
  const wantedSteps = Number.isInteger(c.maxSteps) && c.maxSteps > 0 ? c.maxSteps : 12;
  const wantedRetries = Number.isInteger(c.retries) && c.retries >= 0 ? c.retries : 1;
  const mode = AGENT_CONFIRM_POLICIES.includes(c.requireConfirmation) ? c.requireConfirmation : "risky";
  return {
    maxSteps: Math.min(wantedSteps, AGENT_MAX_STEPS_HARD_CAP),
    retries: Math.min(wantedRetries, AGENT_MAX_RETRIES),
    requireConfirmation: mode,
  };
}

// 建一个「用户开关」下的工具 registry。resume 守卫用同一个 registry 判定，
// 所以试图续跑含已停用工具的历史会被既有 canResume 逻辑拒绝，无需额外代码。
// 浏览器端额外剔除 desktopOnly 工具（依赖原生能力），保证规划器不会选中注定失败的工具。
export async function buildAgentRegistry(cfg) {
  const disabled = disabledSet(cfg);
  const tools = (await allTools()).filter((t) => !disabled.has(t.name) && (isDesktop || !t.desktopOnly));
  return createToolRegistry(tools);
}

// 能力面板/设置矩阵的数据源：**同步**返回，只读目录（不加载实现层）。
// 失败用例是「视图为了画一个开关列表而把 300KB 工具实现拉进首屏」，所以这里刻意不碰实现。
export function listAgentTools(cfg) {
  const disabled = disabledSet(cfg);
  return AGENT_TOOL_CATALOG
    .filter((t) => isDesktop || !t.desktopOnly)
    .map((t) => ({
      name: t.name,
      risk: t.risk,
      descriptionKey: t.descriptionKey || "",
      toolKey: t.toolKey || "",
      enabled: !disabled.has(t.name),
    }));
}

/** 单个工具的元数据（风险分级等），供视图同步读取。 */
export function agentToolMeta(name) {
  return AGENT_TOOL_BY_NAME.get(name) || null;
}
