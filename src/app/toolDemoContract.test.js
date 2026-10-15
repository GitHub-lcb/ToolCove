// 契约 ↔ 视图的锚点一致性守卫。
//
// 演示机制是**跨两处声明**的：契约说「我要操作名为 input 的锚点」，视图说「input 是这个元素」。
// 两处漂移不会有任何报错——表现只是演示时那一步没有聚光、什么都不发生，静默退化。
// 所以这里把两边钉在一起：契约里出现的锚点名，必须在对应工具的 View.vue 的 useToolDemo
// 注册块里真实存在；反过来视图注册的锚点也不该是契约里没用的孤儿。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_CONTRACTS } from "../contracts/index.js";
import { STEP_ACTIONS } from "./toolDemo.js";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");

/** 取工具视图里 useToolDemo 那段注册块（锚点必须写在这里面，写在别处只是巧合撞名） */
function anchorsBlock(source) {
  const at = source.indexOf("useToolDemo(");
  if (at < 0) return "";
  const open = source.indexOf("{", at);
  if (open < 0) return "";
  // 从第一个 { 起做花括号配平，拿到完整对象字面量
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

/** 契约里所有声明了演示的动作（工具包 + 动作名 + 锚点名集合） */
function demoDeclarations() {
  return TOOL_CONTRACTS.flatMap((contract) =>
    (contract.actions || [])
      .filter((action) => action && action.demo && Array.isArray(action.demo.steps) && action.demo.steps.length)
      .map((action) => ({
        toolKey: contract.key,
        action: action.name,
        anchors: [...new Set(action.demo.steps.map((step) => String(step.anchor || "")))].filter(Boolean),
      }))
  );
}

describe("演示声明的形状", () => {
  it("扫到了声明（机制要有真实样本，否则这些断言等于空转）", () => {
    const declared = demoDeclarations();
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.some((d) => d.toolKey === "table")).toBe(true);
  });

  it("每个步骤的动作类型合法、锚点非空", () => {
    for (const contract of TOOL_CONTRACTS) {
      for (const action of contract.actions || []) {
        for (const step of action?.demo?.steps || []) {
          expect(STEP_ACTIONS, `${action.name} 的步骤动作非法：${step.action}`).toContain(step.action);
          expect(String(step.anchor || "").length, `${action.name} 的步骤缺锚点`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("填/选步骤必须给出取值来源（value 常量或 from 参数名），否则永远只能被丢弃", () => {
    for (const contract of TOOL_CONTRACTS) {
      for (const action of contract.actions || []) {
        for (const step of action?.demo?.steps || []) {
          // click / reveal 不需要值：点一下按钮、指出结果，本身与参数无关
          if (step.action !== "fill" && step.action !== "select") continue;
          const hasSource = Object.hasOwn(step, "value") || typeof step.from === "string";
          expect(hasSource, `${action.name} 的 ${step.action} 步骤既没有 value 也没有 from`).toBe(true);
        }
      }
    }
  });
});

describe("锚点在视图里真实注册", () => {
  it("每个契约锚点都能在对应工具视图的 useToolDemo 注册块里找到", () => {
    const missing = [];
    for (const { toolKey, action, anchors } of demoDeclarations()) {
      const source = read(`src/tools/${toolKey}/View.vue`);
      const block = anchorsBlock(source);
      if (!block) {
        missing.push(`${toolKey}：视图没有调用 useToolDemo（${action} 的演示无从播放）`);
        continue;
      }
      for (const anchor of anchors) {
        // 锚点在注册块里是对象键：形如 `input:` 或 `"export-format":`
        if (!new RegExp(`["']?${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*:`).test(block)) {
          missing.push(`${toolKey}[${action}] 锚点 ${anchor} 未在视图注册`);
        }
      }
    }
    expect(missing, `契约与视图的锚点对不上：\n${missing.join("\n")}`).toEqual([]);
  });

  it("视图里注册的锚点也不许是孤儿（契约没声明却在视图里挂着）", () => {
    // 一个工具的锚点常被多个动作共用（table.parse 用 input/table，table.convert 还用 delimiter 等），
    // 所以按**工具**取并集再比，否则单看某一个动作会把共用锚点误判成孤儿。
    const declaredByTool = new Map();
    for (const { toolKey, anchors } of demoDeclarations()) {
      const set = declaredByTool.get(toolKey) || new Set();
      for (const anchor of anchors) set.add(anchor);
      declaredByTool.set(toolKey, set);
    }
    const orphans = [];
    for (const [toolKey, declared] of declaredByTool) {
      const block = anchorsBlock(read(`src/tools/${toolKey}/View.vue`));
      for (const match of block.matchAll(/["']?([A-Za-z][\w-]*)["']?\s*:\s*\(\)\s*=>/g)) {
        if (!declared.has(match[1])) orphans.push(`${toolKey}：视图注册了契约没用到的锚点 ${match[1]}`);
      }
    }
    expect(orphans, `孤儿锚点：\n${orphans.join("\n")}`).toEqual([]);
  });
});
