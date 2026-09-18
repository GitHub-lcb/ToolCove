// 手机端 ↔ 桌面端对齐的**结构性断言**（单测，不需要浏览器）。
//
// 动机：手机端目录、命令清单、页面都是手写的，**漏一项不会有任何报错**——
// 界面上只是少一个入口或某个按钮点了没用。实际发生过两次：
//   1) 15 个工具里漏了「AI 对话」，我当时按自己目录的条数报成"14/14 满格"；
//   2) invoke 在桥存在时不回退，导致真机上 load_data/save_data 全废（E2E 测不出，因为
//      E2E 跑在没有桥的浏览器形态）。
//
// 所以这里以**桌面端为基准**做机器比对，把"对齐"变成可执行的检查。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "./toolbox.js";

const root = process.cwd();
const read = (rel) => readFileSync(resolve(root, rel), "utf8");

/** 递归收集文件（跳过构建产物）。 */
function walk(dir, extensions, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (["node_modules", "dist", "target", "build", "out"].includes(name)) continue;
      walk(full, extensions, out);
    } else if (extensions.some((ext) => name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/** 提取源码里所有 invoke("xxx") 的命令名。 */
function invokedCommands(dir) {
  const source = walk(resolve(root, dir), [".js", ".vue"])
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  return new Set(
    [...source.matchAll(/invoke\(\s*"([a-z_]+)"/g)]
      .map((m) => m[1])
      // 跳过文档示例里的占位符（注释中写的 invoke("xxx") 不是真实命令）
      .filter((cmd) => cmd !== "xxx" && cmd !== "foo" && cmd !== "command")
  );
}

/** Kotlin 桥实现的命令（Bridge.dispatch 的 when 分支）。 */
function bridgeCommands() {
  const source = walk(resolve(root, "mobile/android/app/src/main"), [".kt"])
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  return new Set([...source.matchAll(/"([a-z_]+)"\s*->/g)].map((m) => m[1]));
}

describe("手机端与桌面端的功能对齐", () => {
  it("工具箱清单与桌面端一一对应", () => {
    const desktop = read("src/toolboxTools.js");
    const desktopKeys = [...desktop.matchAll(/key:\s*"([a-z]+)",\s*\n?\s*labelKey:\s*"toolbox\.registry\.tool/g)].map((m) => m[1]);
    expect(desktopKeys.length).toBeGreaterThan(10);
    expect(TOOLS.map((tool) => tool.key).sort()).toEqual([...desktopKeys].sort());
  });

  it("手机端调用的每个命令，要么桥实现了、要么能回退到浏览器实现", () => {
    const mobile = invokedCommands("mobile/app");
    const bridge = bridgeCommands();
    const handlers = read("src/platform/invoke.js");

    const needFallback = [...mobile].filter((cmd) => !bridge.has(cmd));
    // 每个桥没实现的命令，浏览器处理器里必须有对应实现——否则真机上点了就报错
    for (const cmd of needFallback) {
      const hasHandler = new RegExp(`\\b${cmd}\\s*[(:]`).test(handlers);
      expect(hasHandler, `${cmd} 既没进桥、也没有浏览器实现 → 真机会失败`).toBe(true);
    }
  });

  it("invoke 在手机端必须保留回退路径（否则桥不认的命令会直接失败）", () => {
    // 这条守的是一个已经发生过的致命 bug：写成 `if (mobileBridge) return mobileBridge.invoke(...)`
    // 会让桥不认的命令把错误直接抛给界面，真机上 load_data/save_data 全废。
    const source = read("src/platform/invoke.js");
    const mobileBranch = source.slice(source.indexOf("if (isMobile)"), source.indexOf("if (isDesktop)"));
    expect(mobileBranch, "手机端分支里必须有 try/catch 回退").toMatch(/try\s*\{/);
    expect(mobileBranch, "回退时要落到 browserHandlers").toMatch(/browserHandlers\[command\]/);
    // 且只对"桥不认识"的命令回退（真实错误不该被掩盖）
    expect(mobileBranch, "回退要有条件，不能吞掉真实错误").toMatch(/isBridgeUnsupported/);
  });

  it("桌面端的导航模块在手机端都有入口", () => {
    // 手机端把 work 的子模块合并进「工作台」标签，所以按"顶层入口"比对：
    // 记录 / 工作台 / 工具箱 / Agent / 设置 五个标签覆盖桌面端的全部模块。
    const nav = read("src/navConfig.js");
    const desktopModules = [...nav.matchAll(/key:\s*"([a-z]+)",\s*\n?\s*labelKey:\s*"nav\./g)].map((m) => m[1]);
    const topLevel = ["records", "work", "toolbox", "agent", "settings"];
    const workChildren = ["overview", "domain", "iteration", "requirement", "release", "task"];
    const snippetProblem = ["snippet", "problem"];

    const covered = new Set([...topLevel, ...workChildren, ...snippetProblem]);
    const uncovered = desktopModules.filter((key) => !covered.has(key));
    expect(uncovered, `桌面端模块在手机端没有归属：${uncovered.join(", ")}`).toEqual([]);
  });
});
