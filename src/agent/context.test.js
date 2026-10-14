// 工作域上下文提示行的纯函数单测：无领域返回空串（默认提示词零变化的根因），
// 有领域时带上名称与代码池名。t 用桩注入，避开真实字典语言。
import { describe, it, expect } from "vitest";
import { buildContextLine } from "./context.js";

const t = (key, params) => {
  if (key === "agent.contextPools") return `（代码池：${params.pools}）`;
  if (key === "agent.contextPrompt") return `当前工作领域：${params.name}${params.pools}；与领域相关的问题请优先结合该背景。`;
  return key;
};

describe("buildContextLine", () => {
  it("无领域 / 空名称返回空串（调用方据此不注入提示行）", () => {
    expect(buildContextLine(null, t)).toBe("");
    expect(buildContextLine({}, t)).toBe("");
    expect(buildContextLine({ name: "   " }, t)).toBe("");
  });

  it("有领域：带名称与代码池名", () => {
    expect(buildContextLine({ name: "云仓", pools: ["wms.api", "wms.ui"] }, t)).toBe(
      "当前工作领域：云仓（代码池：wms.api、wms.ui）；与领域相关的问题请优先结合该背景。"
    );
  });

  it("无代码池：不出现空括号", () => {
    expect(buildContextLine({ name: "云仓", pools: [] }, t)).toBe(
      "当前工作领域：云仓；与领域相关的问题请优先结合该背景。"
    );
  });

  it("过滤空白代码池名", () => {
    expect(buildContextLine({ name: "云仓", pools: ["", "  ", "a"] }, t)).toContain("代码池：a");
  });
});
