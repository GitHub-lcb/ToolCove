// Agent 设置的读盘入口。与 ai.js 的 loadAIConfig() 同款：每次按需读、不缓存。
// Agent 运行是低频重操作，多一次 load_data 是噪音，而缓存会带来「设置页改了、运行还用旧值」的竞态。
import { invoke } from "../platform/invoke.js";
import { normalizeAgent } from "../settingsConfig.js";
import { AGENT_TOOL_NAMES } from "./tools.js";

export { AGENT_TOOL_NAMES };

async function readSettings() {
  let s = {};
  try {
    s = await invoke("load_data", { key: "settings" });
  } catch {
    s = {};
  }
  // load_data 对缺失文件返回 []，只接受真正的对象
  return s && typeof s === "object" && !Array.isArray(s) ? s : {};
}

export async function loadAgentConfig() {
  const s = await readSettings();
  return normalizeAgent(s.agent, AGENT_TOOL_NAMES);
}

/**
 * 读-合并-写：只覆盖 settings.agent，其余分组（ai / ui / telemetry / sync）原样保留。
 * 能力面板的开关从这里落盘，与设置页保存互不踩踏（先例：sync/index.js 的 writeSyncConfig）。
 * 落盘失败向上抛，让调用方提示用户——静默吞掉会造成「开关看着关了、重启又打开」。
 */
export async function saveAgentConfig(patch) {
  const s = await readSettings();
  const merged = normalizeAgent({ ...(s.agent || {}), ...(patch || {}) }, AGENT_TOOL_NAMES);
  s.agent = merged;
  await invoke("save_data", { key: "settings", data: s });
  return merged;
}
