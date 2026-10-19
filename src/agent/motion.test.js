import { describe, expect, it } from "vitest";
import { motionKind } from "./motion.js";

describe("motionKind 动作原型", () => {
  it("读取 / 解析类走扫描", () => {
    for (const name of ["file.read_text", "table.parse", "json.parse", "file.md5", "text.diff", "file.stat"]) {
      expect(motionKind(name), name).toBe("scan");
    }
  });

  it("转换 / 编码类走流动", () => {
    for (const name of ["table.convert", "json.format", "base64.encode", "base64.decode", "image.transform"]) {
      expect(motionKind(name), name).toBe("flow");
    }
  });

  it("写入 / 落盘类走落章（优先于 extract 的扫描词）", () => {
    for (const name of ["file.write_text", "file.modify_md5", "pdf.merge", "pdf.split", "pdf.extract_pages", "file.save"]) {
      expect(motionKind(name), name).toBe("stamp");
    }
  });

  it("数据库 / HTTP 类走拉取", () => {
    for (const name of ["db.query_readonly", "data.query", "http.request", "https.fetch", "data.get"]) {
      expect(motionKind(name), name).toBe("stream");
    }
  });

  it("未知动作不硬套动画", () => {
    expect(motionKind("agent.ask_user")).toBe("");
    expect(motionKind("")).toBe("");
    expect(motionKind(null)).toBe("");
  });
});
