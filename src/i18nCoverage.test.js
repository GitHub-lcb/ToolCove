// i18n 覆盖守卫：受管界面**必须**走字典，不许把文案写死在组件里。
//
// 为什么需要它：`i18nKeys.test.js` 能抓到「引用了不存在的键」，`i18n/i18n.test.js` 能抓到
// 「中英键集合不一致」，但**没有任何守卫能发现一段界面根本没用字典**——
// 键存在、编译通过、中文界面照常显示，只有英文用户看到的是整页中文。
// 本仓实测过这个形态：研发管理六个视图曾有 0 个 `t()` 调用、672 处硬编码中文，
// 而 3,957 个键的字典里一个 `work` 模块的键都没有，测试全绿。
//
// 判据刻意保持机械：脚本块里不含中文的字符串字面量、模板文本节点里不含中文，
// 且 `t()` 调用数量不低于下限（防止有人把文案改成拼接或直接删掉国际化）。
// 新增界面时把文件加进 VIEWS——加不进去就说明它还没国际化，那正是这条测试要拦的事。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CJK = /[一-鿿]/;

/** 受管界面：模块 → 视图文件 → 至少多少个 t() 调用。 */
const VIEWS = [
  // 研发管理（nav.work）
  ["src/views/WorkOverviewView.vue", 30],
  ["src/views/DomainView.vue", 80],
  ["src/views/IterationView.vue", 150],
  ["src/views/RequirementBoardView.vue", 40],
  ["src/views/ReleaseView.vue", 50],
  ["src/views/TaskView.vue", 100],
  // 记录（nav.records）
  ["src/views/SnippetView.vue", 50],
  ["src/views/ProblemView.vue", 90],
  // 手机端对应界面
  ["mobile/app/work/WorkOverview.vue", 12],
  ["mobile/app/work/DomainPanel.vue", 25],
  ["mobile/app/work/ReleasePanel.vue", 25],
  ["mobile/app/RecordsView.vue", 15],
];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** 去注释：注释里举例的中文（"比如「待产品确认」"）不算界面文案。 */
function stripComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 取 `<script>` 块（单文件组件可能有多个，全部拼起来）。 */
function scriptBlocks(text) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out.join("\n");
}

/** 取最外层 `<template>` 块。 */
function templateBlock(text) {
  const start = text.indexOf("<template");
  if (start < 0) return "";
  const end = text.lastIndexOf("</template>");
  return text.slice(start, end < 0 ? text.length : end);
}

/** 字符串字面量里的中文（模板插值/属性绑定不参与，另由文本节点判据覆盖）。 */
function cjkLiterals(code) {
  const hits = [];
  const re = /(["'`])((?:\\.|(?!\1)[^\\\n])*?)\1/g;
  let m;
  while ((m = re.exec(code))) if (CJK.test(m[2])) hits.push(m[2].slice(0, 40));
  return hits;
}

/** 模板静态文本节点里的中文（`>…<` 之间、不含 {{ }} 插值）。 */
function cjkTextNodes(tpl) {
  const hits = [];
  const re = />([^<>]+)</g;
  let m;
  while ((m = re.exec(tpl))) {
    const chunk = m[1].trim();
    if (chunk && CJK.test(chunk) && !chunk.includes("{{")) hits.push(chunk.slice(0, 40));
  }
  return hits;
}

describe("界面文案必须走字典", () => {
  it("清单里的文件都还在（界面被改名/删除时要同步更新本守卫）", () => {
    const missing = VIEWS.map(([rel]) => rel).filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    expect(missing, `缺失：${missing.join(", ")}`).toEqual([]);
    expect(VIEWS.length).toBeGreaterThanOrEqual(12);
  });

  for (const [rel, minCalls] of VIEWS) {
    it(`${rel} 走 i18n`, () => {
      const raw = read(rel);
      const code = stripComments(scriptBlocks(raw));
      const tpl = stripComments(templateBlock(raw));

      const calls = (raw.match(/(?<![\w$.])\$?t\(\s*["'`]/g) || []).length;
      expect(calls, `${rel} 的 t() 调用数`).toBeGreaterThanOrEqual(minCalls);

      const lit = cjkLiterals(code);
      expect(lit, `${rel} 脚本里写死的中文文案：${lit.join(" / ")}`).toEqual([]);

      const nodes = cjkTextNodes(tpl);
      expect(nodes, `${rel} 模板里写死的中文文案：${nodes.join(" / ")}`).toEqual([]);
    });
  }
});
