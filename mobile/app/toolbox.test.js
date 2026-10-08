import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS, TOOL_BY_KEY, TOOL_GROUPS, progressOf, toolsOfGroup } from "./toolbox.js";

/**
 * 桌面独占、不迁到手机端的工具。
 *
 * 为什么需要这份名单：下面那条「全部已迁移」的断言是随工具逐个迁移长出来的，它守的是
 * 「别忘了把工具搬到手机上」。但有些工具**在安卓上就是做不到**——不是忘了迁，是平台没有
 * 那个能力（下载器要在磁盘上摊开十几 GB 的分片再合并，SAF 给不出可随机写的目录句柄）。
 * 把它们混进 ready:false 会让断言分不清「忘了迁」和「迁不了」，等于把这条断言废掉。
 *
 * 所以：进名单的工具必须写明降级原因（note），且必须是桌面端 desktopOnly；
 * 不在名单里的工具一条都不许 ready:false。
 */
const DESKTOP_ONLY_TOOLS = new Set([
  "downloader",
  // 自动签到：桌面端的价值一半在「常驻 + 开机自启的每日定时」，安卓既没有托盘常驻也没有
  // 开机自启的等价物，这半边能力在手机上做不出来；剩下的一半（手动点一次）不值得再做一个页面。
  "checkin",
  // 抓包：要连目标应用的调试端口、还要把进程拉起来重���，这两件事在安卓上都不成立——
  // 手机里要么根本没有那个应用，要么它跑在别的设备上，抓回来的请求也用不上。
  "netcapture",
]);

describe("手机端工具箱目录", () => {
  it("每个工具的分组都在已定义的分组里（写错分组会让它在界面上消失）", () => {
    const known = new Set(TOOL_GROUPS.map((g) => g.key));
    for (const tool of TOOLS) expect(known.has(tool.group), `${tool.key} 的分组 ${tool.group} 未定义`).toBe(true);
  });

  it("key 不重复，且能按 key 取回同一条", () => {
    const keys = TOOLS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const tool of TOOLS) expect(TOOL_BY_KEY[tool.key]).toBe(tool);
  });

  it("每个分组都有工具（空分组会在界面上留下一片空白）", () => {
    for (const group of TOOL_GROUPS) expect(toolsOfGroup(group.key).length, `${group.key} 是空的`).toBeGreaterThan(0);
  });

  it("工具箱已全部迁移完成，没有未迁移项", () => {
    // 这条用例原本是「未迁移的必须带降级说明」，随着工具逐个迁移，它按自己的提示
    // 变成了现在这条：**断言全部可用**。这样"迁移完成"是一个被测试守住的事实，
    // 而不是靠人记得。
    //
    // 唯一的例外是 DESKTOP_ONLY_TOOLS：那些工具在安卓上做不到（平台限制），不是忘了迁。
    // 例外必须由名单显式声明，不能靠 ready:false 蒙混——否则"忘了迁"也会被当成合理豁免。
    const pending = TOOLS.filter((tool) => !tool.ready && !DESKTOP_ONLY_TOOLS.has(tool.key));
    expect(pending.map((tool) => tool.key), "还有未迁移的工具").toEqual([]);
    expect(progressOf().ready + DESKTOP_ONLY_TOOLS.size).toBe(TOOLS.length);
  });

  it("桌面独占的工具不进进度分母（否则进度条永远停在 95% 让人以为还差一把）", () => {
    const progress = progressOf();
    expect(progress.total).toBe(TOOLS.length - DESKTOP_ONLY_TOOLS.size);
    expect(progress.pct).toBe(100);
    for (const key of DESKTOP_ONLY_TOOLS) {
      expect(TOOL_BY_KEY[key].desktopOnly, `${key} 标了 ready:false 却没标 desktopOnly`).toBe(true);
    }
  });

  it("桌面独占名单里的工具必须写明降级原因，且在桌面端确实标了 desktopOnly", () => {
    // 白名单本身要被审：随便往里加就能绕过上面那条断言，等于给"忘了迁"开后门。
    // 所以要求每一条都有 note（界面上要如实告诉用户为什么这里没有），
    // 并且桌面端注册表里真的标了 desktopOnly（防止名不副实）。
    const desktop = readFileSync(resolve(process.cwd(), "src/toolboxTools.js"), "utf8");
    for (const key of DESKTOP_ONLY_TOOLS) {
      const entry = TOOL_BY_KEY[key];
      expect(entry, `白名单里的 ${key} 不在手机端清单里`).toBeTruthy();
      expect(entry.ready, `${key} 在白名单里就不该再标 ready:false 之外的其它状态`).toBe(false);
      expect(entry.note, `${key} 缺降级说明，界面上会变成一个没原因的空入口`).toBeTruthy();
      expect(desktop, `${key} 在桌面端没有标 desktopOnly，与白名单矛盾`).toMatch(
        new RegExp(`key:\\s*"${key}",[\\s\\S]{0,300}?desktopOnly:\\s*true`)
      );
    }
  });

  it("工具清单与桌面端一一对应（防漏：少一个工具就是功能没对齐）", () => {
    // 为什么要读桌面端的注册表：手机端目录是手写的，**漏掉一个工具不会有任何报错**——
    // 界面上只是少一个入口。实际发生过：15 个工具里漏了「AI 对话」，
    // 而我当时按自己目录里的条数报成了"14/14 满格"。这条断言就是为了不再发生。
    const desktop = readFileSync(resolve(process.cwd(), "src/toolboxTools.js"), "utf8");
    const desktopKeys = [...desktop.matchAll(/key:\s*"([a-z]+)",\s*\n?\s*labelKey:\s*"toolbox\.registry\.tool/g)].map((m) => m[1]);
    expect(desktopKeys.length, "桌面端注册表没解析出来，正则要跟着改").toBeGreaterThan(10);

    const mobileKeys = TOOLS.map((tool) => tool.key);
    const missing = desktopKeys.filter((key) => !mobileKeys.includes(key));
    expect(missing, `手机端缺少工具：${missing.join(", ")}`).toEqual([]);
    // 反过来也不该多出桌面端没有的工具（那说明名字写错了）
    const extra = mobileKeys.filter((key) => !desktopKeys.includes(key));
    expect(extra, `手机端多出工具：${extra.join(", ")}`).toEqual([]);
  });

  it("已迁移但能力受限的工具仍要带说明（可用 ≠ 和桌面一样）", () => {
    // 网络（TCP 降级）、文件（SAF 语义）、数据库（只有 SQLite）、标签（无 RAW 打印队列）
    // 这四类在手机端都可用，但与桌面端不完全等价，说明必须留着。
    for (const key of ["network", "file", "db", "label"]) {
      const tool = TOOL_BY_KEY[key];
      expect(tool.ready, `${key} 应已可用`).toBe(true);
      expect(tool.note, `${key} 缺少能力差异说明`).toBeTruthy();
    }
  });

  it("部分降级的工具（已可用但能力受限）也要带说明", () => {
    // 网络诊断就是这种：URL/CIDR/UA 三块完全可用，端口检测是降级实现——
    // 「可用」与「和桌面一样」不是一回事，note 就是用来交代这个差别的
    const network = TOOL_BY_KEY.network;
    expect(network.ready).toBe(true);
    expect(network.note, "部分降级的能力必须写清差别").toBeTruthy();
  });

  it("未迁移的工具不该被当成可用", () => {
    for (const tool of TOOLS.filter((t) => t.ready === false)) {
      expect(tool.note, `${tool.key} 未迁移却没有说明`).toBeTruthy();
    }
  });

  it("进度按已可用数量计算", () => {
    expect(progressOf([])).toEqual({ ready: 0, total: 0, pct: 0 });
    expect(progressOf([{ ready: true }, { ready: false }])).toEqual({ ready: 1, total: 2, pct: 50 });
    // 真实清单：至少有一个已可用（否则说明清单写错了）
    expect(progressOf().ready).toBeGreaterThan(0);
  });

  it("toolsOfGroup 保持清单顺序（新增工具后这里要同步，否则界面顺序会漂）", () => {
    expect(toolsOfGroup("data").map((t) => t.key)).toEqual(["json", "xml", "schema", "markdown", "table", "convert", "diff", "time"]);
    expect(toolsOfGroup("development").map((t) => t.key)).toEqual(["crypto", "generator", "db"]);
    expect(toolsOfGroup("network").map((t) => t.key)).toEqual(["request", "downloader", "network", "netcapture"]);
    expect(toolsOfGroup("game").map((t) => t.key)).toEqual(["rail"]);
  });
});
