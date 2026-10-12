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
    // 浏览器实现已从 invoke.js 抽到 platform/backends/browser.js（invoke.js 只管分发），
    // 所以这里要读实现文件本身——读分发器会一个 handler 都找不到，用例会因为「找错地方」而红。
    const handlers = read("src/platform/backends/browser.js");

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
    //
    // 形态变了、守卫不变：回退逻辑从 invoke() 内联分支抽成了 invokeMobile()，
    // 所以这里改为盯住那个函数体，而不是「if (isMobile) 到 if (isDesktop) 之间」——
    // 后者在抽取之后只剩一行转发，断言会静默失去意义（红不了，也守不住）。
    const source = read("src/platform/invoke.js");
    const start = source.indexOf("async function invokeMobile");
    expect(start, "invoke.js 里应有 invokeMobile 回退函数").toBeGreaterThan(-1);
    const end = source.indexOf("export async function invoke(");
    const mobileBranch = source.slice(start, end > start ? end : undefined);
    expect(mobileBranch, "手机端分支里必须有 try/catch 回退").toMatch(/try\s*\{/);
    expect(mobileBranch, "回退时要落到 browserHandlers").toMatch(/browserHandlers\[command\]/);
    // 且只对"桥不认识"的命令回退（真实错误不该被掩盖）
    expect(mobileBranch, "回退要有条件，不能吞掉真实错误").toMatch(/isBridgeUnsupported/);
  });

  it("桌面端的导航模块在手机端都有入口", () => {
    // 手机端把 work 的子模块做成工作台的分段（概览/迭代/领域/发布），
    // 速记/问题并入「记录」，所以按"是否有入口"比对：
    // 记录 / 工作台（含 4 个分段）/ 工具箱 / Agent / 设置 覆盖桌面端的全部模块。
    const nav = read("src/app/navConfig.js");
    const desktopModules = [...nav.matchAll(/key:\s*"([a-z]+)",\s*\n?\s*labelKey:\s*"nav\./g)].map((m) => m[1]);
    const topLevel = ["records", "work", "toolbox", "agent", "settings"];
    // work 的子模块：手机端是工作台分段。domain 与 release 已补齐（见 DomainPanel/ReleasePanel）
    const workChildren = ["overview", "domain", "iteration", "requirement", "release", "task"];
    const snippetProblem = ["snippet", "problem"];

    const covered = new Set([...topLevel, ...workChildren, ...snippetProblem]);
    const uncovered = desktopModules.filter((key) => !covered.has(key));
    expect(uncovered, `桌面端模块在手机端没有归属：${uncovered.join(", ")}`).toEqual([]);

    // 工作台的四个分段必须在代码里真实存在（不能只在上面这个白名单里"声明"覆盖）
    const workView = read("mobile/app/WorkView.vue");
    const sections = [...workView.matchAll(/key:\s*"([a-z]+)",\s*labelKey:\s*"nav\./g)].map((m) => m[1]);
    expect(sections.sort(), "工作台分段与桌面端 work 的子模块不一致").toEqual(["domain", "iterations", "overview", "release"].sort());
    // 领域与发布面板要真实存在且被引用
    for (const [file, component] of [["mobile/app/work/DomainPanel.vue", "DomainPanel"], ["mobile/app/work/ReleasePanel.vue", "ReleasePanel"]]) {
      expect(() => read(file), `${file} 不存在`).not.toThrow();
      expect(workView, `WorkView 没有引用 ${component}`).toContain(component);
    }
  });

  // 底部标签栏此前自己硬编码了一份「标签 + 图标」，而桌面端另有一份 navConfig.js，
  // 于是同一个模块在两端可以悄悄不一致（图标还退化成了文本字符 ☰ ▤ ⚒ ✦ ⚙）。
  // 现在 Shell.vue 直接复用 NAV_MODULES，所以这条守的是「别把它改回各自的清单」。
  it("手机端标签栏复用桌面导航表，且图标走共享 Icon 组件", async () => {
    const shell = read("mobile/app/Shell.vue");
    expect(shell, "Shell.vue 应导入桌面导航表").toMatch(/import\s*\{[^}]*NAV_MODULES[^}]*\}\s*from\s*["'][^"']*navConfig\.js["']/);
    expect(shell, "Shell.vue 应导入共享 Icon 组件").toMatch(/import\s+Icon\s+from\s*["'][^"']*Icon\.vue["']/);
    // 标签用 <Icon :name> 渲染，而不是插值一个字符
    expect(shell, "标签图标应由 Icon 组件渲染").toMatch(/<Icon[^>]*:name=/);
    // 不该再有把图标当文本的写法（aria-hidden 的纯文本 span）
    expect(shell, "不该再把图标当文本字符渲染").not.toMatch(/m-tab-ico[^>]*>\{\{/);

    // 标签集合 = NAV_MODULES 的 key + settings，且顺序与桌面侧边栏一致
    const { NAV_MODULES } = await import("../../src/app/navConfig.js");
    expect(NAV_MODULES.length, "桌面导航表至少四项").toBeGreaterThanOrEqual(4);
    expect(shell, "Shell.vue 的 TABS 应由 NAV_MODULES 展开而来").toMatch(/\.\.\.NAV_MODULES\.map\(/);
    expect(shell, "Shell.vue 应在导航表之后追加 settings 标签").toMatch(/key:\s*"settings",\s*labelKey:\s*"nav\.settings"/);
    // 每个桌面模块都必须有对应的手机端视图分支——
    // 否则桌面上加一个模块，手机端会**静默渲染成空白页**（模板是 v-if/v-else-if 链，落不进任何分支）。
    for (const module of [...NAV_MODULES, { key: "settings" }]) {
      expect(shell, `Shell.vue 没有为模块 "${module.key}" 挂视图`).toMatch(
        new RegExp(`current\\.key\\s*===\\s*['"]${module.key}['"]`)
      );
    }
  });

  it("手机端标签的图标名都在共享 Icon 组件里存在", async () => {
    const { NAV_MODULES } = await import("../../src/app/navConfig.js");
    const iconSource = read("src/ui/Icon.vue");
    for (const module of [...NAV_MODULES, { icon: "settings" }]) {
      expect(iconSource, `Icon.vue 里没有 icon 名 "${module.icon}"`).toContain(`name === '${module.icon}'`);
    }
  });
});
