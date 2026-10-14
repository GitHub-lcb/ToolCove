// 工具契约的准入与一致性守卫。
//
// 准入规则（README「工具准入」一节的执行形态）：每个工具要么声明 ≥1 个 Agent 动作，
// 要么用 agentExempt 写明刻意豁免的理由——两条都不占就是"没做完"，在这里变红。
// 这条测试替代的是过去"漏接一个工具不会有人发现"的人工自觉：
// 那时 Agent 能不能驱动某个工具，只能靠文档计数（38 动作 / 15 工具）去对。
import { describe, expect, it } from "vitest";
import { TOOL_CONTRACTS, CONTRACT_BY_KEY } from "./index.js";
import { TOOLBOX_GROUPS } from "./groups.js";
import { TOOL_COMPONENTS } from "../toolComponents.js";

const RISKS = ["read", "transform", "write", "database"];

describe("工具契约的完整性", () => {
  it("key 唯一，且与工具组件映射一一对应（无孤儿、无缺件）", () => {
    expect(TOOL_CONTRACTS.length).toBeGreaterThanOrEqual(27);
    const keys = TOOL_CONTRACTS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.keys(TOOL_COMPONENTS).sort());
    for (const key of keys) expect(CONTRACT_BY_KEY.get(key)?.key).toBe(key);
  });

  it("UI 元数据齐全，分组在已定义的分组里", () => {
    const groupKeys = new Set(TOOLBOX_GROUPS.map((g) => g.key));
    for (const c of TOOL_CONTRACTS) {
      expect(c.ui, `${c.key} 缺 ui`).toBeTruthy();
      for (const field of ["labelKey", "icon", "descKey", "keywordsKey"]) {
        expect(c.ui[field], `${c.key} 缺 ui.${field}`).toBeTruthy();
      }
      expect(groupKeys.has(c.ui.category), `${c.key} 的分组 ${c.ui.category} 未定义`).toBe(true);
      expect(c.ui.ready, `${c.key} 未标 ready`).toBe(true);
    }
  });

  it("准入规则：每个工具要么有 Agent 动作，要么写明豁免理由（二选一）", () => {
    for (const c of TOOL_CONTRACTS) {
      const actions = Array.isArray(c.actions) ? c.actions : [];
      const exempt = typeof c.agentExempt === "string" && c.agentExempt.trim().length > 0;
      expect(actions.length > 0 || exempt, `${c.key} 既无 Agent 动作也无豁免理由——没做完`).toBe(true);
      expect(actions.length > 0 && exempt, `${c.key} 同时声明了动作与豁免，自相矛盾`).toBe(false);
    }
  });

  it("动作声明齐全且归属于本工具", () => {
    for (const c of TOOL_CONTRACTS) {
      for (const action of c.actions || []) {
        expect(action.toolKey, `${action.name} 的 toolKey 应等于契约 key ${c.key}`).toBe(c.key);
        expect(RISKS, `${action.name} 的风险级别非法`).toContain(action.risk);
        expect(action.description?.length, `${action.name} 缺 description`).toBeGreaterThan(0);
        expect(action.descriptionKey, `${action.name} 缺 descriptionKey`).toBeTruthy();
        expect(action.inputSchema?.type, `${action.name} 缺 inputSchema`).toBe("object");
        // 动作不能比工具本身更"可用"：工具桌面独占 ⇒ 动作也必须桌面独占
        // （反向不成立：pdf 这类跨端工具的动作仍可以只接桌面端——浏览器端 UI 走 pdf-lib，
        //   而动作依赖原生文件桥，天然只能在桌面跑）
        if (c.ui.desktopOnly) expect(action.desktopOnly, `${action.name} 属于桌面独占工具 ${c.key}，动作也必须标 desktopOnly`).toBe(true);
      }
    }
  });

  it("刻意豁免的工具都写清了理由（豁免是决策，不是遗漏）", () => {
    const exempted = TOOL_CONTRACTS.filter((c) => c.agentExempt);
    expect(exempted.length, "一个豁免都没有反而可疑（截图/打印这类工具永远存在）").toBeGreaterThan(0);
    for (const c of exempted) expect(c.agentExempt.trim().length, `${c.key} 的豁免理由太敷衍`).toBeGreaterThan(10);
  });
});
