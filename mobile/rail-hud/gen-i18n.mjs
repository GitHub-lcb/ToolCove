// 手机版 HUD 的 i18n 抽取器：从主程序的两份字典里取出铁路大亨用到的词条，
// 生成一个零依赖的 i18n.gen.js。
//
// 为什么不直接把 zh-CN.json 整个搬过去：那份字典里还有 2000+ 条其它工具的文案，
// 手机端只渲染这一个工具，整包搬过来会让产物里 95% 是无用字符串。
//
// 为什么不手抄一份：手抄的文案会和主程序漂移——改一句建议文案，手机端还是旧的，
// 而这种漂移不会有任何报错。抽取 + 单测比对（i18n.test.js）是这里唯一的护栏。
//
// 用法：node mobile/rail-hud/gen-i18n.mjs   （也挂在 npm run build:mobile 里）

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

/** 只抽这一个命名空间：铁路大亨的全部界面文案都在 toolbox.rail.* 下面。 */
const NAMESPACE = "toolbox.rail";
const LOCALES = ["zh-CN", "en-US"];

/**
 * 取出 namespace 下的子树（保留嵌套结构）。
 * 保留嵌套而不是拍平成点分键：点分键在注释里读不出层级，且渲染器还要再拆回来。
 */
function pick(dict, path) {
  return path.split(".").reduce((node, key) => {
    if (!node || typeof node !== "object" || !(key in node)) {
      throw new Error(`字典里找不到 ${path}（缺在 "${key}"）`);
    }
    return node[key];
  }, dict);
}

function load(locale) {
  const file = join(root, "src", "i18n", `${locale}.json`);
  return JSON.parse(readFileSync(file, "utf8"));
}

const messages = {};
for (const locale of LOCALES) {
  messages[locale] = pick(load(locale), NAMESPACE);
}

// 两种语言的键必须完全一致。不一致说明主程序字典本身有问题（那边有单测拦着），
// 但这里也挡一道：生成出一份「英文缺键」的产物，手机端只会静默渲染出空字符串。
const flat = (node, prefix = "") =>
  Object.entries(node).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" ? flat(v, key) : [key];
  });
const zhKeys = flat(messages["zh-CN"]).sort();
const enKeys = flat(messages["en-US"]).sort();
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  const onlyZh = zhKeys.filter((k) => !enKeys.includes(k));
  const onlyEn = enKeys.filter((k) => !zhKeys.includes(k));
  throw new Error(`中英词条不对齐：仅中文 ${JSON.stringify(onlyZh)}，仅英文 ${JSON.stringify(onlyEn)}`);
}

const stamp = new Date().toISOString().slice(0, 10);
const out = `// 本文件由 mobile/rail-hud/gen-i18n.mjs 自动生成，请勿手改。
// 源：src/i18n/{${LOCALES.join(",")}}.json 的 ${NAMESPACE}.* 子树（共 ${zhKeys.length} 条）。
// 改文案请改源字典后重新执行 npm run build:mobile。
// 生成时间：${stamp}

export const MESSAGES = ${JSON.stringify(messages, null, 2)};

export const MESSAGE_COUNT = ${zhKeys.length};
`;

const target = join(here, "i18n.gen.js");
writeFileSync(target, out, "utf8");
console.log(`[gen-i18n] ${NAMESPACE} → ${zhKeys.length} 条词条 × ${LOCALES.length} 种语言 → i18n.gen.js`);
