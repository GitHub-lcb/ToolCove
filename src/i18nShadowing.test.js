// i18n 遮蔽守卫：`useI18n()` 拿到的 t 不能被局部同名变量遮蔽，否则调用点会抛
// `TypeError: t is not a function` —— 编译期不报错，只在渲染/交互那一刻炸，
// 表现是「整块界面空白 / 点了没反应」，控制台只有一行 render function 报错。
//
// 本仓已踩过 7 次，且都是同一个根因（局部变量/形参顺手写成 t，而它其实是「标签 / 表 / 列」这类数据对象）：
//   RequestTool  标签栏 v-for、tabLabel()、deriveName()、标签右键 openCtx()
//   DbTool       标签栏 v-for、onTreeNameClick/onTreeCtx/onColCtx/onTabCtx、gen*Template、copyTableName、补全列表
//   DbTableTree  表树 v-for、DbConnModal 类型下拉
// 所以这里用编译器 AST 从「模板」和「脚本」两个层面一起兜住：
//   1) 模板：v-for / v-slot 绑定的名字，在自己的作用域里被当函数调用；
//   2) 脚本：函数形参里有 t，函数体里又出现 t("something.with.dots") 这种取词条调用。
// 注：@vue/compiler-sfc、@vue/compiler-dom、@babel/parser 都是 vue 自身的依赖，随 vue 版本走。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseSfc } from "@vue/compiler-sfc";
import { parse as parseTemplate } from "@vue/compiler-dom";
import { parse as parseScript } from "@babel/parser";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["src", "mobile"];

const ELEMENT = 1;
const INTERPOLATION = 5;
const DIRECTIVE = 7;

const FUNC_NODES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

/** t("toolbox.xxx") 这种「取词条」形态的调用 */
const I18N_CALL = /\bt\(\s*["'`][\w.]+["'`]/;

/**
 * 刻意例外：这里的 t 就是调用方传进来的 i18n 函数本身（参数名即语义），
 * 不属于「数据对象被误当函数」。改动此处需同步更新本清单。
 */
const ALLOWED_SCRIPT_PARAM = new Set(["src/sync/index.js:syncNowManual"]);

/**
 * 扫描时跳过的目录名（任意层级）：
 *   node_modules —— 第三方代码
 *   dist / build / out —— **构建产物**。手机端（mobile/）下既有 Vite 产物，也有 Gradle 的
 *     build/ 与 APK 的 out/；它们里面是压缩过的 bundle，扫进来只会误报（曾经真的误报过
 *     一条「形参 t 被遮蔽」）。本测试只该看源码。
 * 以 . 开头的目录（.git、.toolchain 等）另行跳过。
 */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "release-out"]);

function sourceFiles(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    // 统一用正斜杠：Windows 下 path.join 给的是反斜杠，会跟白名单/测试名对不上
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(rel, out);
    else if (/\.(vue|js)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// ---------- 模板层：v-for / v-slot 作用域 ----------

function forAliases(directive) {
  const names = [];
  const parsed = directive.forParseResult; // Vue 3.4+
  if (parsed) {
    for (const part of [parsed.value, parsed.key, parsed.index]) {
      if (part && typeof part.content === "string") names.push(...(part.content.match(/[A-Za-z_$][\w$]*/g) || []));
    }
  }
  if (!names.length && directive.exp && typeof directive.exp.content === "string") {
    const m = directive.exp.content.match(/^\s*([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)$/);
    if (m) names.push(...(m[1].match(/[A-Za-z_$][\w$]*/g) || []));
  }
  return [...new Set(names)];
}

function expressionsOf(node) {
  const out = [];
  if (node.type === INTERPOLATION) out.push({ text: String(node.content.content), kind: "插值" });
  for (const prop of node.props || []) {
    if (prop.type === DIRECTIVE && prop.exp && prop.name !== "for" && prop.name !== "slot") {
      out.push({ text: String(prop.exp.content), kind: `v-${prop.name}` });
    }
  }
  return out;
}

function findTemplateShadowing(node, scopes, hits, file) {
  let inner = scopes;
  if (node.type === ELEMENT) {
    for (const prop of node.props || []) {
      if (prop.type !== DIRECTIVE) continue;
      const names =
        prop.name === "for"
          ? forAliases(prop)
          : prop.name === "slot"
            ? [...new Set(String(prop.exp?.content || "").match(/[A-Za-z_$][\w$]*/g) || [])]
            : [];
      if (names.length) inner = [...inner, ...names];
    }
  }
  for (const { text, kind } of expressionsOf(node)) {
    for (const name of inner) {
      if (new RegExp(`(^|[^\\w$.])${name}\\s*\\(`).test(text)) {
        hits.push(`${file}\n    ${kind} 里调用了被遮蔽的 \`${name}\`：${text.trim()}`);
      }
    }
  }
  for (const child of node.children || []) {
    if (child && typeof child.type === "number") findTemplateShadowing(child, inner, hits, file);
  }
  if (node.branches) {
    for (const branch of node.branches) findTemplateShadowing(branch, inner, hits, file);
  }
}

// ---------- 脚本层：形参为 t 又在体内取词条 ----------

function boundNames(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case "Identifier":
      out.push(node.name);
      break;
    case "ObjectPattern":
      for (const prop of node.properties) {
        if (prop.type === "ObjectProperty") boundNames(prop.value, out);
        else if (prop.type === "RestElement") boundNames(prop.argument, out);
      }
      break;
    case "ArrayPattern":
      for (const el of node.elements) boundNames(el, out);
      break;
    case "AssignmentPattern":
      boundNames(node.left, out);
      break;
    case "RestElement":
      boundNames(node.argument, out);
      break;
    default:
      break;
  }
  return out;
}

function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) for (const v of value) walkAst(v, visit);
    else if (value && typeof value === "object" && typeof value.type === "string") walkAst(value, visit);
  }
}

function findScriptShadowing(code, file, offsetLine, hits) {
  const ast = parseScript(code, { sourceType: "module", errorRecovery: true, plugins: ["jsx"] });
  walkAst(ast, (node) => {
    if (!FUNC_NODES.has(node.type)) return;
    if (!(node.params || []).flatMap((p) => boundNames(p, [])).includes("t")) return;
    const body = node.body;
    if (!body || typeof body.start !== "number" || typeof body.end !== "number") return;
    if (!I18N_CALL.test(code.slice(body.start, body.end))) return;

    const name = node.key?.name || node.id?.name || "(匿名函数)";
    if (ALLOWED_SCRIPT_PARAM.has(`${file}:${name}`)) return;
    const line = code.slice(0, node.start).split("\n").length + offsetLine;
    hits.push(`${file}:${line}  ${name}() 形参含 t，函数体里又调用了 t("...")`);
  });
}

describe("i18n 的 t 不被局部变量遮蔽", () => {
  it("模板：v-for / v-slot 的局部变量没有遮蔽并调用 t", () => {
    const hits = [];
    let scanned = 0;

    for (const file of SCAN_DIRS.flatMap((dir) => sourceFiles(dir)).filter((f) => f.endsWith(".vue"))) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      const { descriptor } = parseSfc(source, { filename: file });
      if (!descriptor.template) continue;
      scanned++;
      findTemplateShadowing(parseTemplate(descriptor.template.content, { comments: false }), [], hits, file);
    }

    expect(scanned, "没扫到任何模板，检查扫描目录配置").toBeGreaterThan(20);
    expect(hits, `发现模板作用域遮蔽（渲染期会抛 TypeError: t is not a function）：\n\n${hits.join("\n\n")}\n`).toEqual([]);
  });

  it("脚本：形参为 t 的函数体内没有再调用 t(\"...\") 取词条", () => {
    const hits = [];
    let scanned = 0;

    for (const file of SCAN_DIRS.flatMap((dir) => sourceFiles(dir))) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      if (file.endsWith(".vue")) {
        const { descriptor } = parseSfc(source, { filename: file });
        for (const block of [descriptor.scriptSetup, descriptor.script]) {
          if (!block) continue;
          scanned++;
          findScriptShadowing(block.content, file, block.loc.start.line - 1, hits);
        }
      } else {
        scanned++;
        findScriptShadowing(source, file, 0, hits);
      }
    }

    expect(scanned, "没扫到任何脚本块，检查扫描目录配置").toBeGreaterThan(20);
    expect(hits, `发现脚本作用域遮蔽（调用时抛 TypeError: t is not a function）：\n\n${hits.join("\n")}\n`).toEqual([]);
  });
});
