import { describe, expect, it } from "vitest";
import {
  ATTACH_MAX,
  attachmentIcon,
  attachmentKind,
  attachmentPromptLine,
  basename,
  createAttachment,
  formatBytes,
  mergeAttachments,
  normalizeAttachments,
} from "./attachments.js";

describe("附件元信息", () => {
  it("路径末段两种分隔符都认，扩展名小写", () => {
    expect(basename("E:\\docs\\plan.md")).toBe("plan.md");
    expect(basename("/home/x/a.tar.gz")).toBe("a.tar.gz");
    expect(basename("")).toBe("");
    expect(basename("name.txt")).toBe("name.txt");
  });

  it("类别按扩展名判定，目录优先", () => {
    expect(attachmentKind("a.md")).toBe("text");
    expect(attachmentKind("a.PNG")).toBe("image");
    expect(attachmentKind("a.xlsx")).toBe("file");
    expect(attachmentKind("any", true)).toBe("folder");
    expect(attachmentIcon("image")).toBe("image");
    expect(attachmentIcon("folder")).toBe("folder");
    expect(attachmentIcon("file")).toBe("box");
  });

  it("体积格式化：0 不显示，KB/MB 保留一位", () => {
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 * 3)).toBe("3.0 MB");
  });

  it("createAttachment 兜住空路径 / 非法体积 / 超长正文", () => {
    const a = createAttachment({ path: "E:\\a\\b.txt", size: -1, content: "x".repeat(20000) });
    expect(a.name).toBe("b.txt");
    expect(a.kind).toBe("text");
    expect(a.size).toBe(0);
    expect(a.content.length).toBe(6000);
    expect(a.truncated).toBe(true);
    // 名字与路径都缺 = 无效附件，交给归一化丢弃
    expect(createAttachment({ path: "" }).name).toBe("");
  });
});

describe("附件合并", () => {
  it("按路径去重，重复与超限都进 rejected", () => {
    const first = mergeAttachments([], [{ path: "E:\\a.md" }, { path: "E:\\b.json" }]);
    expect(first.list.length).toBe(2);
    const second = mergeAttachments(first.list, [{ path: "e:\\A.md" }, { path: "E:\\c.txt" }]);
    expect(second.added.map((x) => x.name)).toEqual(["c.txt"]);
    expect(second.rejected).toEqual([{ name: "A.md", reason: "duplicate" }]);
  });

  it("上限之外的不再进入列表", () => {
    const many = Array.from({ length: ATTACH_MAX + 2 }, (_, i) => ({ path: `E:\\f${i}.txt` }));
    const result = mergeAttachments([], many);
    expect(result.list.length).toBe(ATTACH_MAX);
    expect(result.rejected.every((r) => r.reason === "limit")).toBe(true);
  });

  it("归一化会丢掉非对象与空名条目，并去重", () => {
    const list = normalizeAttachments([null, "x", { name: "" }, { name: "  " }, { path: "E:\\a.md" }, { path: "E:\\a.md" }]);
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("a.md");
  });
});

describe("附件提示词", () => {
  it("无附件时是空串（调用方据此保持提示词不变）", () => {
    expect(attachmentPromptLine([])).toBe("");
    expect(attachmentPromptLine(null)).toBe("");
  });

  it("路径 + 体积 + 类别进提示词，并说明可直接读取", () => {
    const line = attachmentPromptLine([
      { path: "E:\\docs\\plan.md", size: 2048 },
      { path: "E:\\data\\sales.xlsx", size: 1024 * 1024 * 2 },
    ]);
    expect(line).toContain("E:\\docs\\plan.md");
    expect(line).toContain("2.0 KB");
    expect(line).toContain("二进制");
    expect(line).toContain("file.read_text");
    expect(line).toContain("file.md5");
    expect(line).not.toContain("<附件");
    // 用户实测反馈：附了文件还被追问路径。指令必须直说，并且给出「附件与目标对不上」时的做法
    expect(line).toContain("不要再向用户索要这些文件的路径");
    expect(line).toContain("先用一句话说明附件是哪份文件");
  });

  it("没有路径时内联正文，并标注截断", () => {
    const line = attachmentPromptLine([{ name: "粘贴.txt", content: "a".repeat(7000) }]);
    expect(line).toContain('<附件 name="粘贴.txt">');
    expect(line).toContain("内容已截断");
    // 没有路径就不提 file.* 工具：网页端这些工具被 desktopOnly 剔除了，提了只会诱导模型去调
    expect(line).not.toContain("file.read_text");
    // 正文按单文件预算截断，不会把 7000 字全塞进去
    expect(line.length).toBeLessThan(6800);
  });

  it("只有文件名时如实说明，不假装能读", () => {
    const line = attachmentPromptLine([{ name: "photo.png" }]);
    expect(line).toContain("只有文件名");
  });
});
