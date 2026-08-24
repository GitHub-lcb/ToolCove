import { describe, expect, it } from "vitest";
import { groupToolboxTools, searchToolboxTools, TOOLBOX_GROUPS, TOOLBOX_TOOLS } from "./toolboxTools.js";

describe("searchToolboxTools", () => {
  it("可按工具名称和英文名称搜索", () => {
    expect(searchToolboxTools("数据转换").map((tool) => tool.key)).toEqual(["convert"]);
    expect(searchToolboxTools("JSON").map((tool) => tool.key)).toEqual(["convert", "json", "generator"]);
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

  it("按五个明确大类分组，每个工具只出现一次", () => {
    const groups = groupToolboxTools();
    expect(groups.map((group) => group.label)).toEqual(["数据与文本", "网络与接口", "文件与媒体", "开发调试", "AI 助手"]);
    expect(groups.map((group) => group.tools.map((tool) => tool.key))).toEqual([
      ["convert", "diff", "time", "json", "generator"],
      ["network", "request"],
      ["file", "image"],
      ["crypto", "db"],
      ["chat"],
    ]);
    const groupedKeys = groups.flatMap((group) => group.tools.map((tool) => tool.key));
    expect(groupedKeys).toHaveLength(TOOLBOX_TOOLS.length);
    expect(new Set(groupedKeys).size).toBe(TOOLBOX_TOOLS.length);
    expect(TOOLBOX_GROUPS).toHaveLength(5);
  });

  it("可按 AI 对话的关键词搜索", () => {
    for (const keyword of ["AI", "对话", "Chat", "提示词", "GPT"]) {
      expect(searchToolboxTools(keyword).map((tool) => tool.key)).toContain("chat");
    }
  });
});
