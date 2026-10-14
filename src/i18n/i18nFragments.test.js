// 工具 i18n 片段守卫：**工具词条住各自包内**（src/tools/<key>/i18n.<locale>.json），
// 框架把片段合并进手写字典后才交给 vue-i18n。
//
// 为什么需要它：把词条从共享字典搬进工具包，抹掉了「巨型字典里几行手滑」的那道天然约束——
// 片段漏一个键、或片段与字典两处都定义同一个键（两处真相），界面只会把键名显示给用户，
// 而任何既有测试都**不会**报错（vue-i18n 对未知键静默返回键名）。这里把四件事变成红灯：
//   1. 逐工具 zh / en 片段键集合一致（漏翻译）
//   2. 片段键不得同时躺在手写字典里（单一真相）
//   3. 生成物 tools.generated.js 与片段现状一致（忘了跑 npm run gen:i18n）
//   4. 合并后的消息不得丢键（合并结果 == 手写字典 ∪ 片段）
// 外加一条迁移安全性断言（见文末）：合并结果的键集合必须与迁移前快照完全相等。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildI18n, checkI18n, ROOT, LOCALES } from "../../scripts/gen-tool-i18n.mjs";
import { flatKeys, mergeMessages } from "./index.js";
import zhRaw from "./zh-CN.json";
import enRaw from "./en-US.json";
import baseline from "./preMigrationKeys.json";

const RAW = { "zh-CN": zhRaw, "en-US": enRaw };
// 合并后的消息 = 手写字典 + 生成物 TOOL_MESSAGES[locale]（即运行时交给 vue-i18n 的那份）。
const MERGED = { "zh-CN": mergeMessages("zh-CN", zhRaw), "en-US": mergeMessages("en-US", enRaw) };

const readJson = (abs) => JSON.parse(fs.readFileSync(abs, "utf8"));
const get = (obj, dotPath) => dotPath.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

/** 带 i18n 片段的工具包（目录 + 两种语言的片段路径）。 */
function fragmentTools() {
  const toolsDir = path.join(ROOT, "src/tools");
  return fs
    .readdirSync(toolsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      key: entry.name,
      files: Object.fromEntries(LOCALES.map((l) => [l, path.join(toolsDir, entry.name, `i18n.${l}.json`)])),
    }))
    .filter((tool) => LOCALES.some((l) => fs.existsSync(tool.files[l])))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** 键→值 摘要：对「排序后的扁平键→值对」取 sha256，用于断言「键集合 + 值都未改动」。 */
function messagesHash(dict) {
  const flat = {};
  const walk = (o, prefix = "") => {
    for (const [k, v] of Object.entries(o)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object") walk(v, key);
      else flat[key] = v;
    }
  };
  walk(dict);
  const canonical = Object.keys(flat)
    .sort()
    .map((k) => [k, flat[k]]);
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

describe("工具 i18n 片段", () => {
  it("扫到了片段（防空转：机制要有真实样本）", () => {
    const tools = fragmentTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((t) => t.key === "pdf"), "pdf 是试点，必须已有片段").toBe(true);
  });

  it("逐工具：两种语言的片段同在，且键集合一致", () => {
    const problems = [];
    for (const tool of fragmentTools()) {
      const missing = LOCALES.filter((l) => !fs.existsSync(tool.files[l]));
      if (missing.length) {
        problems.push(`${tool.key}: 缺少 ${missing.map((l) => `i18n.${l}.json`).join("、")}`);
        continue;
      }
      let zh;
      let en;
      try {
        zh = readJson(tool.files["zh-CN"]);
        en = readJson(tool.files["en-US"]);
      } catch (error) {
        problems.push(`${tool.key}: JSON 解析失败 — ${error.message}`);
        continue;
      }
      const zk = flatKeys(zh).sort();
      const ek = flatKeys(en).sort();
      const onlyZh = zk.filter((k) => !ek.includes(k));
      const onlyEn = ek.filter((k) => !zk.includes(k));
      if (onlyZh.length || onlyEn.length) {
        problems.push(`${tool.key}: zh 独有 [${onlyZh.join(", ")}] / en 独有 [${onlyEn.join(", ")}]`);
      }
    }
    expect(problems, `片段键集合不一致：\n${problems.join("\n")}`).toEqual([]);
  });

  it("单一真相：片段提供的键不得同时存在于手写字典", () => {
    const problems = [];
    for (const tool of fragmentTools()) {
      for (const locale of LOCALES) {
        if (!fs.existsSync(tool.files[locale])) continue;
        const fragment = readJson(tool.files[locale]);
        // 只查**叶子键**：外层容器（toolbox / toolbox.registry）是共享结构，两处共存是正常的。
        for (const leaf of flatKeys(fragment)) {
          if (get(RAW[locale], leaf) !== undefined) {
            problems.push(`${tool.key}[${locale}] ${leaf}：片段与手写字典同时定义（两处真相）`);
          }
        }
      }
    }
    expect(problems, `出现两处真相：\n${problems.join("\n")}`).toEqual([]);
  });

  it("生成物 tools.generated.js 与片段现状一致（改了片段就要跑 npm run gen:i18n）", () => {
    const { errors, stale } = checkI18n({ root: ROOT });
    expect(errors, `扫描/合并失败：${errors.join("; ")}`).toEqual([]);
    expect(stale, `与片段不一致的生成物：${stale.join(", ")}`).toEqual([]);
  });

  it("合并后的消息不丢键：合并结果 == 手写字典 ∪ 片段", () => {
    const { fragmentKeys, errors } = buildI18n({ root: ROOT });
    expect(errors).toEqual([]);
    for (const locale of LOCALES) {
      const base = new Set(flatKeys(RAW[locale]));
      const union = new Set([...base, ...fragmentKeys[locale]]);
      const merged = flatKeys(MERGED[locale]);
      expect([...merged].sort(), `${locale} 合并结果与「字典 ∪ 片段」不一致`).toEqual([...union].sort());
      // 规模下限：合并确实扩了键（防空转——若片段为空，两边都会「相等」）
      expect(merged.length, `${locale} 合并后键数`).toBeGreaterThan(base.size);
    }
  });

  it("规模合理（注册表/片段空转不能假装全绿）", () => {
    const { toolMessages, fragmentKeys } = buildI18n({ root: ROOT });
    expect(flatKeys(MERGED["zh-CN"]).length).toBeGreaterThan(5000);
    expect(fragmentKeys["zh-CN"].length).toBeGreaterThan(90);
    // 生成物只含工具词条：不应把整份字典也塞进来
    expect(flatKeys(toolMessages["zh-CN"]).length).toBeLessThan(flatKeys(MERGED["zh-CN"]).length);
  });
});

// ---- 迁移安全性（硬要求）----
//
// 把词条从 JSON 里手术式删除，最怕的是「顺手多删了一行」——界面只会显示键名、测试毫无反应。
// 这里冻结了一份迁移前快照（src/i18n/preMigrationKeys.json，取自 git HEAD 的字典）：
//   · zhKeys           —— 迁移前 zh 字典的扁平键集合（含 pdf 词条）
//   · *MessagesSha256  —— 迁移前后两种语言「键→值」摘要，用于抓「改了值」
// 断言合并后的键集合与它**完全相等**（不少键、不多键），且两种语言的值摘要未变。
describe("迁移安全性：合并结果 == 迁移前字典", () => {
  it("快照自身是可信的（规模下限，防空转）", () => {
    expect(baseline.count).toBe(baseline.zhKeys.length);
    expect(baseline.count).toBeGreaterThan(5000);
    expect(new Set(baseline.zhKeys).size).toBe(baseline.count);
  });

  it("合并后的 zh 扁平键集合与迁移前完全相等（不许少键、不许多键）", () => {
    expect(flatKeys(MERGED["zh-CN"]).sort()).toEqual(baseline.zhKeys);
  });

  it("合并后的 en 扁平键集合与迁移前同集合（中英对齐另有 i18n.test 兜底）", () => {
    expect(flatKeys(MERGED["en-US"]).sort()).toEqual(baseline.zhKeys);
  });

  it("合并后两种语言的值摘要与迁移前一致（不许改值）", () => {
    expect(messagesHash(MERGED["zh-CN"])).toBe(baseline.zhMessagesSha256);
    expect(messagesHash(MERGED["en-US"])).toBe(baseline.enMessagesSha256);
  });
});
