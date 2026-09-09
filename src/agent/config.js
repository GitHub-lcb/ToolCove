// Agent 设置的读盘入口。与 ai.js 的 loadAIConfig() 同款：每次按需读、不缓存。
// Agent 运行是低频重操作，多一次 load_data 是噪音，而缓存会带来「设置页改了、运行还用旧值」的竞态。
import { invoke } from "@tauri-apps/api/core";
import { normalizeAgent } from "../settingsConfig.js";
import { AGENT_TOOL_NAMES } from "./builtins.js";

export { AGENT_TOOL_NAMES };

export async function loadAgentConfig() {
  let s = {};
  try {
    s = await invoke("load_data", { key: "settings" });
  } catch {
    s = {};
  }
  // load_data 对缺失文件返回 []，只接受真正的对象
  if (!s || typeof s !== "object" || Array.isArray(s)) s = {};
  return normalizeAgent(s.agent, AGENT_TOOL_NAMES);
}
