// Agent 工具集装配：把内置工具按用户开关（disabledTools）装成 registry，
// 并把 settings.agent 的运行参数钳制到硬上限。
//
// settings.agent 是用户可改的 JSON，永不信任：maxSteps / retries / requireConfirmation
// 都在这里重算，越界值落回默认，防止手改配置绕过运行时的受控边界。
import { AGENT_CONFIRM_POLICIES, AGENT_MAX_STEPS_HARD_CAP, AGENT_MAX_RETRIES } from "../settingsConfig.js";
import { isDesktop } from "../platform/env.js";
import { createBuiltinRegistry } from "./builtins.js";
import { createDataTools } from "./dataTools.js";
import { createToolRegistry } from "./runtime.js";

const asConfig = (cfg) => (cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {});
const disabledSet = (cfg) => new Set(Array.isArray(asConfig(cfg).disabledTools) ? asConfig(cfg).disabledTools : []);

/** 全部工具定义（含 execute）：内置工具箱能力 + 业务数据工具 */
function allTools() {
  const builtin = createBuiltinRegistry();
  const data = createToolRegistry(createDataTools());
  return [...builtin.list().map((t) => builtin.get(t.name)), ...data.list().map((t) => data.get(t.name))];
}

// 停用清单与设置归一（settingsConfig.normalizeAgent）共用的名字全集。
// 数据工具各端都可用，不参与桌面过滤。
export const AGENT_TOOL_NAMES = Object.freeze(allTools().map((t) => t.name));

// 返回要交给 runAgent 的三个受控参数。
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
export function buildAgentRegistry(cfg) {
  const disabled = disabledSet(cfg);
  const tools = allTools().filter((t) => !disabled.has(t.name) && (isDesktop || !t.desktopOnly));
  return createToolRegistry(tools);
}

// 能力面板/设置矩阵的数据源：始终返回当前平台可用的全部工具（含被停用的），由 UI 决定怎么展示。
export function listAgentTools(cfg) {
  const disabled = disabledSet(cfg);
  return allTools()
    .filter((t) => isDesktop || !t.desktopOnly)
    .map((t) => ({
      name: t.name,
      risk: t.risk,
      descriptionKey: t.descriptionKey || "",
      toolKey: t.toolKey || "",
      enabled: !disabled.has(t.name),
    }));
}
