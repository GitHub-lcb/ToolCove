// Agent 工具的实现层：**只有 execute，不含元数据**。
//
// 元数据（描述/风险分级/参数 Schema）与工具箱 UI 元数据同源：工具包形态下在同包的
// src/tools/<key>/contract.js，过渡期仍住 src/contracts/<key>.js；
// data.* 的 Schema 依赖仓库层 KINDS，留在 dataTools.js 随实现给出（见 catalog.js 说明）。
//
// 为什么单独一层：这一层会牵出 luxon / js-yaml / hash-wasm / 各工具模块（实测约 300KB），
// 只有真正要跑 Agent 时才需要加载。首屏只需要 catalog（设置归一化 + 能力面板）。
// 运行期装配见 tools.js 的 buildAgentRegistry（动态 import 本模块）。
// 一致性由 catalog.test.js 双向强制（目录 ↔ 实现，两边都不许多一个少一个）。
//
// 手写区只留「还没迁进工具包」的动作；已迁进包的动作由 TOOL_EXECUTORS（生成物）并入。
// 解开 { ok, error, value/output } 的通用小件 unwrap 在 shared/toolResult.js（被包内 executor 共用）。
import { readSpillResult } from "../readWindow.js";
import { spillStore } from "./spillStoreInstance.js";
import { TOOL_EXECUTORS } from "../toolExecutors.generated.js";

/** 名字 → { execute }。与 catalog.js 的键集合必须一致（由 catalog.test.js 强制）。 */
export const BUILTIN_TOOL_IMPLS = Object.freeze({
  // ── 引擎自身 ───────────────────────────────────────────────
  "spill.read": {
    execute: async ({ key, offset, limit, keyword }) => {
      const target = String(key || "").trim();
      if (target === "list") return { list: await spillStore.list() };
      const body = await spillStore.read(target);
      if (body == null) {
        throw Object.assign(Error(`找不到 ${target}：可能已过期（保留 7 天 / 最多 30 份）或不是本次运行写下的`), { code: "SPILL_NOT_FOUND" });
      }
      return { key: target, ...readSpillResult(body, { offset, limit, keyword }) };
    },
  },
  // 工具包自带的动作实现（生成物）：迁进 src/tools/<key>/ 的工具在这里并入，
  // 手写区会随迁移逐块缩小、最终清空。
  ...TOOL_EXECUTORS,
});
