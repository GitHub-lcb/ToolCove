// 技能匹配评测：在同一份标注集上比较「关键词」与「TypeSafe 语义」两条路径，输出 precision/recall。
//
// 为什么需要它：语义匹配的默认阈值（gate/floor/置信度分档）都是从文档示例借来的起点值。
// 没有标注集，调阈值就是凭感觉，换形状（Choice → 逐条 Noul）也说不清是变好还是变坏。
// 这个脚本把「前后对比」变成可重复动作：改完实现再跑一遍，diff --json 的输出。
//
// 用法：
//   node scripts/eval-skill-match.mjs                    # 离线：请求形状体检 + 关键词基线
//   node scripts/eval-skill-match.mjs --mode=keyword      # 只跑关键词基线
//   node scripts/eval-skill-match.mjs --mode=live         # 真打 TypeSafe（需 TYPESAFE_API_KEY）
//   node scripts/eval-skill-match.mjs --mode=live --json  # 机器可比对的输出，用于前后 diff
// 可选：--base=<接口地址> --model=<模型名> --k=<取前几条> --sleep=<每条间隔 ms>
//
// 离线模式**测不出准确率**：没有模型回答，就没有语义判断的结果。它只回答「请求长得对不对」
// （候选全不全、正文进没进 state、总量有没有爆预算），准确率必须 live 模式。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractSkill, matchSkills } from "../src/agent/skills.js";
import { buildSuggestRequest, shortlistSkills, suggestSkills } from "../src/agent/skillSuggest.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf("=");
  return eq < 0 ? true : hit.slice(eq + 1);
};
const mode = flag("mode", "offline");
const K = Number(flag("k", 3)) || 3;
const SLEEP = Number(flag("sleep", 300)) || 0;
const BASE = flag("base", "https://api.typesafe.ai/v1") || "https://api.typesafe.ai/v1";
const MODEL = flag("model", "") || "";
const AS_JSON = flag("json", false);
// 形状：rerank（每条一个 Noul，默认）/ choice（一次多选一）/ both（同一批用例并排比，换形状前后可 diff）
const SHAPE = flag("shape", "rerank");
const SHAPES = SHAPE === "both" ? ["rerank", "choice"] : [String(SHAPE)];
if (SHAPES.some((s) => s !== "rerank" && s !== "choice")) {
  console.error(`--shape 只支持 rerank|choice|both，收到 ${SHAPE}`);
  process.exit(1);
}

const library = readJson("eval/skill-match/runs.json").runs
  .map((run, i) => extractSkill({ ...run, status: "success" }, { id: run.id, now: 1000 + i }))
  .filter(Boolean);
const cases = readJson("eval/skill-match/cases.json").cases;

if (!library.length) {
  console.error("技能库为空：检查 eval/skill-match/runs.json");
  process.exit(1);
}

/** 一条用例的判定：期望集合 vs 实际带上的技能。 */
function grade(item, returned) {
  const ids = returned.map((m) => m.skill.id);
  const expect = item.expect || [];
  const tp = ids.filter((id) => expect.includes(id)).length;
  const wrong = ids.filter((id) => !expect.includes(id));
  const graded = {
    id: item.id,
    goal: item.goal,
    expect,
    returned: ids,
    hit1: ids.length > 0 && expect.includes(ids[0]),
    hitK: ids.some((id) => expect.includes(id)),
    precision: ids.length ? tp / ids.length : expect.length ? 0 : 1,
    recall: expect.length ? tp / expect.length : ids.length ? 0 : 1,
    // 「不该带却带了」是独立于准确率的指标：宁少勿滥是本项目的取向
    overInject: !expect.length && ids.length > 0,
    wrongIds: wrong,
  };
  return graded;
}

function summarize(rows, label, extra = {}) {
  const withExpect = rows.filter((r) => r.expect.length);
  const noneCases = rows.filter((r) => !r.expect.length);
  const mean = (list, pick) => (list.length ? list.reduce((sum, r) => sum + pick(r), 0) / list.length : 0);
  return {
    matcher: label,
    cases: rows.length,
    hit1: mean(withExpect, (r) => (r.hit1 ? 1 : 0)),
    hitK: mean(withExpect, (r) => (r.hitK ? 1 : 0)),
    precision: mean(withExpect, (r) => r.precision),
    recall: mean(withExpect, (r) => r.recall),
    // none 用例：正确 = 一条都不带；过度注入率是它的反面
    noneCorrect: mean(noneCases, (r) => (r.overInject ? 0 : 1)),
    overInject: mean(noneCases, (r) => (r.overInject ? 1 : 0)),
    ...extra,
  };
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const fmt = (row) =>
  `  ${row.id.padEnd(5)} hit@1=${row.hit1 ? "Y" : "."} hit@${K}=${row.hitK ? "Y" : "."} ` +
  `P=${row.precision.toFixed(2)} R=${row.recall.toFixed(2)} 带上[${row.returned.join(", ") || "-"}]` +
  (row.wrongIds.length ? ` 误带[${row.wrongIds.join(", ")}]` : "");

// —— 离线：请求形状体检（不需要网络，回答「发出去的东西长什么样」）——
function shapeReport(shape) {
  const stats = cases.map((item) => {
    // 与 suggestSkills 同一条链路：rerank 先预筛再组请求，choice 直接全量
    const pool = shape === "choice" ? library : shortlistSkills(library, item.goal, {});
    const built = buildSuggestRequest(pool, item.goal, { model: MODEL, shape });
    if (!built) return { id: item.id, candidates: 0, stateChars: 0, bodyCount: 0, questionCount: 0 };
    const bodies = built.body.state.skill_bodies || {};
    return {
      id: item.id,
      candidates: built.picks.length,
      questionCount: Object.keys(built.body.questions).length,
      bodyCount: Object.keys(bodies).length,
      stateChars: JSON.stringify(built.body.state).length,
    };
  });
  const maxChars = Math.max(...stats.map((s) => s.stateChars));
  const missingBody = stats.filter((s) => s.bodyCount === 0).length;
  console.log(`\n[${shape}] 技能库 ${library.length} 条 / 用例 ${cases.length} 条 / 每次问 ${stats[0]?.questionCount ?? 0} 句`);
  console.log(`  送进模型的候选：${stats[0]?.candidates} 条${shape === "choice" ? "（全量，无预筛）" : `（预筛后的结果，上限 ${flag("candidates", 10)} 条）`}`);
  console.log(`  state 最大 ${maxChars} 字符${missingBody ? `，其中 ${missingBody} 条用例正文被预算挤掉` : "，正文全部在场"}`);
  return stats;
}

// —— live：真打 TypeSafe ——
async function liveTransport(body) {
  const key = process.env.TYPESAFE_API_KEY;
  const url = `${String(BASE).replace(/\/+$/, "")}/systemone`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}：${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function main() {
  if (!["offline", "keyword", "live"].includes(mode)) {
    console.error(`--mode 只支持 offline|keyword|live，收到 ${mode}`);
    process.exit(1);
  }
  if (mode === "offline") SHAPES.forEach((shape) => shapeReport(shape));
  if (mode === "live" && !process.env.TYPESAFE_API_KEY) {
    console.error("live 模式需要环境变量 TYPESAFE_API_KEY（脚本不读设置库，避免把本地密钥带进评测日志）");
    process.exit(1);
  }

  const keywordRows = cases.map((item) => grade(item, matchSkills(library, item.goal, { limit: K })));
  const groups = [{ label: "keyword", rows: keywordRows, extra: {} }];

  if (mode === "live") {
    for (const shape of SHAPES) {
      const rows = [];
      const diagnostics = [];
      for (const item of cases) {
        const matches = await suggestSkills(library, item.goal, {
          limit: K,
          shape,
          ...(MODEL ? { model: MODEL } : {}),
          transport: liveTransport,
          onResult: (info) => diagnostics.push(info),
          fallback: false,
        });
        rows.push(grade(item, matches));
        if (SLEEP) await new Promise((resolve) => setTimeout(resolve, SLEEP));
      }
      const latencies = diagnostics.map((d) => d.latencyMs).filter(Number.isFinite);
      const tokens = diagnostics.reduce(
        (acc, d) => {
          acc.input += Number(d.usage?.input_tokens ?? d.usage?.prompt_tokens ?? 0);
          acc.output += Number(d.usage?.output_tokens ?? d.usage?.completion_tokens ?? 0);
          return acc;
        },
        { input: 0, output: 0 }
      );
      groups.push({
        label: `typesafe:${shape}`,
        rows,
        extra: {
          avgLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
          tokens,
          skipped: diagnostics.filter((d) => d.matcher !== "typesafe").length,
        },
      });
    }
  }

  const summaries = groups.map((group) => ({ ...summarize(group.rows, group.label, group.extra), label: group.label }));
  if (AS_JSON) {
    console.log(JSON.stringify({ mode, shape: SHAPE, k: K, library: library.length, summaries, cases: groups.map((g) => ({ matcher: g.label, rows: g.rows })) }, null, 2));
    return;
  }
  for (const group of groups) {
    const summary = summaries.find((s) => s.label === group.label);
    console.log(`\n[${summary.matcher}] hit@1=${pct(summary.hit1)} hit@${K}=${pct(summary.hitK)} precision=${pct(summary.precision)} recall=${pct(summary.recall)} 不该带时正确=${pct(summary.noneCorrect)}`);
    if (summary.avgLatencyMs != null) {
      console.log(`  平均耗时 ${summary.avgLatencyMs.toFixed(0)}ms，token in/out ${summary.tokens.input}/${summary.tokens.output}，退回 ${summary.skipped} 次`);
    }
    group.rows.forEach((row) => console.log(fmt(row)));
  }
  const baseline = summaries[0];
  for (const summary of summaries.slice(1)) {
    const delta = (a, b) => `${b >= a ? "+" : ""}${((b - a) * 100).toFixed(1)}`;
    console.log(
      `\n[${summary.matcher}] 相对 ${baseline.matcher}：hit@1 ${delta(baseline.hit1, summary.hit1)}pp，` +
        `precision ${delta(baseline.precision, summary.precision)}pp，recall ${delta(baseline.recall, summary.recall)}pp，` +
        `不该带时正确 ${delta(baseline.noneCorrect, summary.noneCorrect)}pp`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
