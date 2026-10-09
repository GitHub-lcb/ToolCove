import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { groupToolboxTools, searchToolboxTools, toolKeywords, TOOLBOX_GROUPS, TOOLBOX_TOOLS } from "./toolboxTools.js";
import { i18n } from "./i18n/index.js";

describe("searchToolboxTools", () => {
  it("可按工具名称和英文名称搜索", () => {
    expect(searchToolboxTools("数据转换").map((tool) => tool.key)).toEqual(["convert"]);
    // XML 工具的关键词含「转 JSON」，所以搜 JSON 也会命中它——这是合理的（它确实做 XML→JSON）
    expect(searchToolboxTools("JSON").map((tool) => tool.key)).toEqual(["convert", "table", "xml", "schema", "json", "generator"]);
  });

  it("可按分类和能力描述搜索", () => {
    expect(searchToolboxTools("网络工具").map((tool) => tool.key)).toEqual(["network", "request"]);
    expect(searchToolboxTools("Base64").map((tool) => tool.key)).toEqual(["convert", "file"]);
  });

  it("可按数据生成的小功能关键词搜索", () => {
    for (const keyword of ["数据生成", "UUID v7", "ULID", "NanoID", "随机数", "测试数据", "Mock 数据", "CSV", "SQL INSERT", "订单模板"]) {
      expect(searchToolboxTools(keyword).map((tool) => tool.key)).toContain("generator");
    }
  });

  it("可按图片处理的小功能关键词搜索", () => {
    for (const keyword of ["图片处理", "WebP", "图片压缩", "裁剪", "批量图片", "颜色提取", "调色板", "HSL", "AI 图标", "多尺寸图标", "EXIF", "清除元数据"]) {
      expect(searchToolboxTools(keyword).map((tool) => tool.key)).toContain("image");
    }
  });

  it("可按结构化数据的小功能关键词搜索", () => {
    for (const keyword of ["YAML", "YML", "YAML 校验", "YAML 格式化", "YAML 转 JSON", "JSON 转 YAML"]) {
      expect(searchToolboxTools(keyword).map((tool) => tool.key)).toContain("json");
    }
  });

  it("忽略首尾空白和大小写，空关键词不返回结果", () => {
    expect(searchToolboxTools("  ping ").map((tool) => tool.key)).toEqual(["network"]);
    expect(searchToolboxTools("  ")).toEqual([]);
  });

  it("注册表中的工具 key 唯一", () => {
    expect(new Set(TOOLBOX_TOOLS.map((tool) => tool.key)).size).toBe(TOOLBOX_TOOLS.length);
  });

  // 搜索的匹配面只有 key/名称/分组/描述/关键词，而描述是一句话——用户按「具体算法名、
  // 具体数据库名」搜时，只有 keywordsKey 能命中。之前 crypto 与 db 漏了这个字段，
  // 搜 MD5 / SHA256 / MySQL / Oracle 都找不到工具，所以按字段本身锁一条。
  it("每个工具都有关键词，新工具不能只靠一句描述被搜到", () => {
    for (const tool of TOOLBOX_TOOLS) {
      expect(tool.keywordsKey, `${tool.key} 缺 keywordsKey`).toBeTruthy();
      expect(toolKeywords(tool).length, `${tool.key} 关键词为空`).toBeGreaterThan(0);
    }
  });

  it("可按加密与校验、数据库的具体能力名搜索", () => {
    for (const keyword of ["MD5", "SHA256", "SHA-512", "HMAC", "AES", "RSA", "密码生成", "校验值"]) {
      expect(searchToolboxTools(keyword).map((tool) => tool.key)).toContain("crypto");
    }
    for (const keyword of ["数据库", "MySQL", "PostgreSQL", "SQLite", "Oracle", "表结构", "DDL"]) {
      expect(searchToolboxTools(keyword).map((tool) => tool.key)).toContain("db");
    }
  });

  it("按七个明确大类分组，每个工具只出现一次", () => {
    const groups = groupToolboxTools();
    expect(groups.map((group) => i18n.global.t(group.labelKey))).toEqual(["数据与文本", "网络与接口", "文件与媒体", "开发调试", "AI 助手", "游戏辅助", "面试刷题"]);
    expect(groups.map((group) => group.tools.map((tool) => tool.key))).toEqual([
      ["convert", "table", "markdown", "xml", "diff", "schema", "time", "json", "generator"],
      ["network", "request", "downloader", "netcapture"],
      ["file", "image", "pdf", "label"],
      ["crypto", "db"],
      ["chat", "checkin"],
      ["rail"],
      ["interview"],
    ]);
    const groupedKeys = groups.flatMap((group) => group.tools.map((tool) => tool.key));
    expect(groupedKeys).toHaveLength(TOOLBOX_TOOLS.length);
    expect(new Set(groupedKeys).size).toBe(TOOLBOX_TOOLS.length);
    expect(TOOLBOX_GROUPS).toHaveLength(7);
  });

  it("可按 AI 对话的关键词搜索", () => {
    for (const keyword of ["AI", "对话", "Chat", "提示词", "GPT"]) {
      expect(searchToolboxTools(keyword).map((tool) => tool.key)).toContain("chat");
    }
  });

  it("可按自动签到的关键词搜索", () => {
    for (const keyword of ["签到", "打卡", "积分", "check-in", "checkin", "daily check in"]) {
      expect(searchToolboxTools(keyword).map((tool) => tool.key)).toContain("checkin");
    }
  });

  it("自动签到是桌面独占：接口要带 Cookie 且不开 CORS，定时还依赖托盘常驻", () => {
    expect(TOOLBOX_TOOLS.find((tool) => tool.key === "checkin")?.desktopOnly).toBe(true);
  });

  it("可按抓包的关键词搜索", () => {
    for (const keyword of ["抓包", "抓取", "接口", "请求", "capture", "packet", "API", "DevTools"]) {
      expect(searchToolboxTools(keyword).map((tool) => tool.key)).toContain("netcapture");
    }
  });

  it("抓包是桌面独占：要连本机调试端口并拉起目标进程", () => {
    expect(TOOLBOX_TOOLS.find((tool) => tool.key === "netcapture")?.desktopOnly).toBe(true);
  });

  it("可按标签打印的关键词搜索", () => {
    for (const keyword of ["标签打印", "标签机", "热敏打印", "TSPL", "条码", "二维码", "吊牌", "价签", "GP-2120TF", "佳博"]) {
      expect(searchToolboxTools(keyword).map((tool) => tool.key)).toContain("label");
    }
  });

  it("标签打印是桌面独占工具（依赖本机打印队列）", () => {
    expect(TOOLBOX_TOOLS.find((tool) => tool.key === "label")?.desktopOnly).toBe(true);
  });

  it("可按铁路大亨的关键词搜索", () => {
    for (const keyword of ["铁路大亨", "火车大亨", "诡秘之主", "跑商", "站点推断", "序列"]) {
      expect(searchToolboxTools(keyword).map((tool) => tool.key)).toContain("rail");
    }
  });

  it("站点推断是纯前端工具，浏览器端也可见", () => {
    expect(TOOLBOX_TOOLS.find((tool) => tool.key === "rail")?.desktopOnly).toBeFalsy();
  });

  it("可按面试刷题的关键词搜索", () => {
    for (const keyword of ["面试", "刷题", "八股", "题库", "LeetCode", "系统设计", "复习"]) {
      expect(searchToolboxTools(keyword).map((tool) => tool.key)).toContain("interview");
    }
  });

  it("面试刷题是纯前端工具，浏览器端也可见", () => {
    expect(TOOLBOX_TOOLS.find((tool) => tool.key === "interview")?.desktopOnly).toBeFalsy();
  });
});

describe("桌面端窗口权限", () => {
  // 每个工具都在自己的窗口（tool-<key>）里打开；capability 未登记的窗口会被 Tauri 拒绝调用
  // dialog / window 等权限（表现为 “dialog.save not allowed on window …”），新增工具时必须同步登记。
  it("所有工具窗口都登记在 Tauri capability 中", () => {
    const capability = JSON.parse(readFileSync(resolve(process.cwd(), "src-tauri/capabilities/default.json"), "utf8"));
    const labels = TOOLBOX_TOOLS.map((tool) => `tool-${tool.key}`);
    expect(capability.windows).toEqual(expect.arrayContaining(["main", ...labels]));
  });

  it("capability 里的工具窗口都对应真实工具，避免僵尸条目", () => {
    const capability = JSON.parse(readFileSync(resolve(process.cwd(), "src-tauri/capabilities/default.json"), "utf8"));
    const known = new Set(["main", ...TOOLBOX_TOOLS.map((tool) => `tool-${tool.key}`)]);
    for (const label of capability.windows) expect(known.has(label), label).toBe(true);
  });
});
