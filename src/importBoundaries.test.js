// 分层边界守卫：把「谁可以 import 谁」从人工自觉变成红灯。
//
// 为什么需要它：这三条约定此前只写在评审文档里，`eslint.config.js` 一条 import 边界规则都没有，
// 于是全项目**唯一**一条 `agent → tools` 依赖边（`agent/executors.js` 借一个 `yaml.js`）
// 与 `tools → agent` 的两条边凑成了一个跨区环，存在了很久都没人发现。
// 环本身不影响运行，影响的是「改 tools/ 时会不会炸到 Agent」这种判断。
//
// 为什么用单测而不是 eslint 的 no-restricted-imports：
// eslint 只能按**写法字面量**（`../tools/yaml.js`）匹配 glob，不能解析路径——
// 同一个目标从不同目录写出来是不同字符串，规则要么漏判要么误伤（`../Icon.vue` 与 `../../Icon.vue`
// 得各写一条，将来根目录分区还要全部重写）。这里按**解析后的真实路径**判定，一次写准。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", "build", "out", "release-out", "test-results", "playwright-report", ".toolchain"]);
const SCAN_DIRS = ["src", "mobile/app"];

function sourceFiles(abs, out = []) {
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
    const p = path.join(abs, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    // 测试文件里的假 import 不算运行期依赖
    else if (/\.(vue|js)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) out.push(p);
  }
  return out;
}

const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)[^;'"]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 解析成仓库相对路径（posix 分隔），非相对写法返回 null 交由调用方跳过。 */
function resolveTarget(file, spec) {
  if (!spec.startsWith(".")) return null;
  const abs = path.resolve(path.dirname(file), spec).replace(/\\/g, "/");
  return path.relative(ROOT, abs).replace(/\\/g, "/");
}

const edges = [];
for (const dir of SCAN_DIRS) {
  for (const file of sourceFiles(path.join(ROOT, dir))) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    for (const re of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const to = resolveTarget(file, m[1]);
        if (to && !to.startsWith("..")) edges.push({ from: rel, to });
      }
    }
  }
}

const violations = (test) => edges.filter(test).map((e) => `${e.from} → ${e.to}`);

describe("分层边界", () => {
  it("扫描规模合理（守卫自己扫空了不能假装全绿）", () => {
    const scanned = new Set(edges.map((e) => e.from));
    expect(scanned.size, "解析到依赖关系的源文件数").toBeGreaterThan(150);
    expect(edges.length, "相对 import 边数").toBeGreaterThan(400);
  });

  it("agent/ 不导入 tools/（工具的共享逻辑在根级，不是反向依赖）", () => {
    expect(violations((e) => e.from.startsWith("src/agent/") && e.to.startsWith("src/tools/"))).toEqual([]);
  });

  it("platform/ 不导入任何上层（它是最低的一层）", () => {
    const upper = /^(src\/(tools|agent|data|sync|checkin|screenshot|views|ui|contracts)\/|src\/[A-Z][A-Za-z]*\.vue$|mobile\/)/;
    expect(violations((e) => e.from.startsWith("src/platform/") && upper.test(e.to))).toEqual([]);
  });

  it("contracts/ 是纯数据层：不导入目录外的任何模块（生成聚合器例外：只许 re-export 工具包契约）", () => {
    // 契约要同时被首屏（toolboxTools/catalog 投影）与手机端对齐测试（原生 Node ESM 直接 import）
    // 消费——一旦它开始 import i18n/平台/实现层，两边都会炸（见 toolboxIcons.test.js 记载的 ESM 坑）。
    // 唯一例外是生成的聚合器 src/contracts/index.generated.js：注册模型是「目录即注册」，
    // 它必须 re-export 各工具包的 contract.js——放行 src/tools/<key>/contract.js 这一种目标。
    const outsideContracts = (e) => e.from.startsWith("src/contracts/") && !e.to.startsWith("src/contracts/");
    const generatedAggregator = (e) => e.from === "src/contracts/index.generated.js" && /^src\/tools\/[^/]+\/contract\.js$/.test(e.to);
    expect(violations((e) => outsideContracts(e) && !generatedAggregator(e))).toEqual([]);
  });

  it("工具包的契约纯数据：只能导入本包内文件或 contracts/ 的共享小件", () => {
    // 一个工具 = 一个包（src/tools/<key>/）。包内其他文件（logic/executor/View）可以有依赖，
    // 但 contract.js 必须与旧的 contracts/ 契约同等纯净——它要能被原生 Node 直接 import。
    const bad = edges
      .filter((e) => {
        const m = /^src\/tools\/([^/]+)\/contract\.js$/.exec(e.from);
        if (!m) return false;
        return !e.to.startsWith(`src/tools/${m[1]}/`) && !e.to.startsWith("src/contracts/");
      })
      .map((e) => `${e.from} → ${e.to}`);
    expect(bad).toEqual([]);
  });

  it("agent/ 不得导入工具包的界面或任何视图（只能经生成注册表消费工具包）", () => {
    // 包模型下 agent → tools/<key>/executor.js 是**预期方向**（工具就是 Agent 的动作空间），
    // 但 agent 永远不该碰界面层：那样会把整个 UI 依赖树拖进引擎的加载面。
    const bad = edges
      .filter((e) => e.from.startsWith("src/agent/") && (/^src\/tools\/[^/]+\/View\.vue$/.test(e.to) || e.to.startsWith("src/views/")))
      .map((e) => `${e.from} → ${e.to}`);
    expect(bad).toEqual([]);
  });

  it("tools/ 不导入应用视图（工具只依赖共享纯逻辑与 UI 原子）", () => {
    // 视图搬到 src/views/ 之前这条写的是 `^src/[A-Z]*View.vue$`——
    // 分区后如果忘了改，它会因为"匹配不到任何东西"而永远通过。
    // 所以下面那条「判据必须还能匹配到东西」的规模断言同样要跟着维护。
    expect(violations((e) => e.from.startsWith("src/tools/") && /^src\/views\//.test(e.to))).toEqual([]);
  });

  it("data/ 不导入视图与工具（仓库层在数据侧，不在界面侧）", () => {
    const upper = /^(src\/views\/|src\/tools\/|src\/[A-Z][A-Za-z]*\.vue$)/;
    expect(violations((e) => e.from.startsWith("src/data/") && upper.test(e.to))).toEqual([]);
  });

  it("ui/ 是原子层：只依赖 vue、i18n 与彼此，不回头依赖视图/工具/Agent/手机端", () => {
    // Icon.vue 此前住在 src/ 根、被 58 个文件导入，其中 35 个是 tools/——
    // 一个图标组件住在应用视图层，等于强迫每个工具跨区取它。搬进 src/ui/ 之后，
    // 这条断言保证它不会又长回上层的依赖。
    const upper = /^(src\/views\/|src\/tools\/|src\/agent\/|src\/data\/|mobile\/)/;
    expect(violations((e) => e.from.startsWith("src/ui/") && upper.test(e.to))).toEqual([]);
  });

  it("shared/ 是最底下一层：只依赖自己的分模块、i18n、platform 与 highlight", () => {
    // shared.js 拆成 src/shared/{dates,hours,xlsx,pkg,markdown,links,errors,workMeta}.js 之后，
    // "谁都能塞进 shared" 这个坏习惯必须被拦住——一旦它开始 import 视图或工具，
    // 就又变回那个 564 行、横跨五个领域的杂物间。
    const allowed = /^src\/(shared\/|i18n\/|platform\/|highlight\.js)/;
    expect(violations((e) => e.from.startsWith("src/shared/") && !allowed.test(e.to))).toEqual([]);
  });

  it("interview 题库自成目录（24 个分片不再平铺在 src/tools/）", () => {
    expect(fs.existsSync(path.join(ROOT, "src/tools/interview/interviewBankParts.js"))).toBe(true);
    const strays = edges
      .filter((e) => /^src\/tools\/interview[^/]*\.js$/.test(e.to))
      .map((e) => `${e.from} → ${e.to}`);
    expect(strays, `仍指向旧平铺路径：${strays.join(", ")}`).toEqual([]);
  });
});

describe("共享纯逻辑的位置", () => {
  it("yaml 在根级共享层（agent 与 JSON 工具都要用它，放 tools/ 会造出跨区环）", () => {
    expect(fs.existsSync(path.join(ROOT, "src/yaml.js"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "src/tools/yaml.js"))).toBe(false);
  });

  it("JSON 只有一份实现（曾有两份同名不同内容的 json.js，Agent 与工具各跑一边）", () => {
    expect(fs.existsSync(path.join(ROOT, "src/json.js"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "src/tools/json.js"))).toBe(false);
    const users = edges.filter((e) => /(^|\/)(json|yaml)\.js$/.test(e.to)).map((e) => e.from);
    // 第二波后 json.parse/format/yaml.to_json 的下沉进 src/tools/json/executor.js，
    // Agent 引擎不再直接 import 根级 json.js（它经工具包 executor 消费），故原先「Agent 走根级」的
    // 断言已不成立。防重复的意图保持不变：根级只有一份，且工具包 executor 与 yaml 序列化器都走它；
    // 反向再钉一条——Agent 引擎不得自带第二份 json/yaml 实现，要用就走工具包。
    expect(users.some((f) => f.startsWith("src/tools/")), "JSON 工具走根级实现").toBe(true);
    expect(users.includes("src/yaml.js"), "yaml 复用根级 json（单一实现链）").toBe(true);
    expect(users.some((f) => f.startsWith("src/agent/")), "Agent 引擎不自带第二份 json/yaml（实现下沉进工具包 executor）").toBe(false);
  });
});
