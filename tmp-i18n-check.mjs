// 静态复查：main.js / view.js 里所有 t("...") 的键，是否都能在生成的 i18n.gen.js 里找到。
// 找不到时 t() 会返回键名本身（界面显示裸键），不抛错——所以必须静态查。
import { readFileSync } from "node:fs";
import { MESSAGES } from "./mobile/rail-hud/i18n.gen.js";

const prefix = "toolbox.rail.";
const resolve = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), MESSAGES["zh-CN"]);

const files = ["mobile/rail-hud/main.js", "mobile/rail-hud/view.js"];
const used = new Map();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/\bt\(\s*["'`]([^"'`]+)["'`]/g)) {
    used.set(m[1], (used.get(m[1]) ?? []).concat(f));
  }
  // 动态键：t(`adv.${key}.${name}`) 这类，单独列出来人工确认
  for (const m of src.matchAll(/\bt\(\s*`([^`]*\$\{[^`]*)`/g)) {
    used.set("[动态] " + m[1], (used.get("[动态] " + m[1]) ?? []).concat(f));
  }
}

let missing = 0;
console.log("=== main.js / view.js 引用的词条键 ===");
for (const [key, where] of [...used].sort()) {
  if (key.startsWith("[动态]")) {
    console.log(`  ${key}   (${[...new Set(where)].join(", ")})`);
    continue;
  }
  const ok = resolve(key) !== undefined;
  if (!ok) missing += 1;
  console.log(`  ${ok ? "OK  " : "缺!!"} ${key}`);
}
console.log(`\n共 ${used.size} 个键，缺失 ${missing} 个`);

// 反向：gen 里有多少键、是否与源字典一致（构建期生成，理论上一致）
const flat = (n, p = "") =>
  Object.entries(n).flatMap(([k, v]) => {
    const key = p ? `${p}.${k}` : k;
    return v && typeof v === "object" ? flat(v, key) : [key];
  });
console.log(`i18n.gen.js 里 zh-CN 共 ${flat(MESSAGES["zh-CN"]).length} 条、en-US 共 ${flat(MESSAGES["en-US"]).length} 条`);
console.log("main.js 是否引用了 gen 里没有的顶层分组:", ["adv"].map((g) => `${g}=${resolve(g) !== undefined}`).join(" "));
