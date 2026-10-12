// i18n 键存在性守卫：组件里写的每个 t("...") 词条键都必须在 zh 与 en 里真实存在。
//
// 为什么需要它：vue-i18n 对未知键**不报错**，而是原样返回键名。于是把
// `mobile.deploy_auto` 顺手写成 `mobile.deployAuto`、或把 `mobile.fileName`
// 写成 `toolbox.file.fileName`（那是另一个命名空间），界面上就会**直接把键名
// 显示给用户**——双语都不对，但测试全绿、控制台只有一行 [intlify] 警告。
// 这类错字没有编译期或运行期兜底，只能靠静态扫描钉住。
//
// 本仓实测过 6 处：common.edit / common.delete（两个手机面板共 6 处调用）、
// mobile.fileName / mobile.fileSize、mobile.deployAuto、settings.errAgentTools。
//
// 只认**静态字面量**调用。动态形态刻意放过，因为它们的键在运行期才拼出来：
//   t("toolbox.request." + keyByType[ct])   ← 前缀拼接（以 . 结尾）
//   t(`mobile.deploy_${type}`)              ← 模板插值
//   t("common.copied", { defaultValue: … }) ← 自带兜底文案，缺键也能正常显示
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zh from "./i18n/zh-CN.json";
import en from "./i18n/en-US.json";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["src", "mobile"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "release-out", "test-results", "playwright-report"]);

/** t("k") / $t("k") / t('k') —— 只取单双引号的静态字面量，模板反引号另判。 */
const CALL = /(?<![\w$.])\$?t\(\s*(?<quote>["'])(?<key>[^"'\\]*)\k<quote>/g;
/** t(`k`) 形态：键里有 ${ 的是插值，跳过；没有的当静态键。 */
const CALL_TEMPLATE = /(?<![\w$.])\$?t\(\s*`(?<key>[^`\\]*)`/g;

function sourceFiles(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(rel, out);
    // 测试文件本身会故意用假键做夹具，不参与扫描
    else if (/\.(vue|js)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** 去掉注释，避免把注释里举例的键名当成真实调用。 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function get(obj, dotPath) {
  return dotPath.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

function collectHits() {
  const hits = [];
  let scanned = 0;

  for (const file of SCAN_DIRS.flatMap((dir) => sourceFiles(dir))) {
    const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
    const code = stripComments(raw);
    scanned++;
    const lineOf = (index) => code.slice(0, index).split("\n").length;

    for (const re of [CALL, CALL_TEMPLATE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code))) {
        const key = m.groups.key.trim();
        if (!key || !key.includes(".")) continue;
        // 动态拼接：以 . 结尾（前缀 + 变量），或紧接着一个 + 号
        if (key.endsWith(".")) continue;
        if (/^\s*\+/.test(code.slice(m.index + m[0].length))) continue;
        // 模板插值
        if (key.includes("${")) continue;
        // 自带 defaultValue 的调用，缺键也会显示兜底文案
        if (/^\s*,\s*\{[^}]*defaultValue/.test(code.slice(m.index + m[0].length))) continue;
        if (get(zh, key) === undefined || get(en, key) === undefined) {
          hits.push(`${file}:${lineOf(m.index)}  ${key}`);
        }
      }
    }
  }
  return { hits, scanned };
}

describe("组件引用的 i18n 键都真实存在", () => {
  it("t(\"...\") 的静态键在 zh 与 en 里都有定义", () => {
    const { hits, scanned } = collectHits();
    expect(scanned, "没扫到任何源文件，检查扫描目录配置").toBeGreaterThan(50);
    expect(
      hits,
      `以下键在字典里不存在，界面上会把键名原样显示给用户（vue-i18n 对未知键不报错）：\n\n${hits.join("\n")}\n`,
    ).toEqual([]);
  });
});
