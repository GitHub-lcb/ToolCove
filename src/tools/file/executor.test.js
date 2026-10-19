import { describe, expect, it, vi, beforeEach } from "vitest";

const desktopInvoke = vi.hoisted(() => vi.fn());
vi.mock("../../nativeInvoke.js", () => ({ desktopInvoke }));

import executor from "./executor.js";

beforeEach(() => {
  desktopInvoke.mockReset();
});

describe("文件工具的哈希动作", () => {
  it("file.md5 走原生流式计算命令（二进制文件也能算）", async () => {
    desktopInvoke.mockResolvedValue({ path: "E:/a.pdf", md5: "d41d8cd98f00b204e9800998ecf8427e", size: 12 });
    const result = await executor["file.md5"].execute({ path: "E:/a.pdf" });
    expect(desktopInvoke).toHaveBeenCalledWith("file_tool_calculate_md5", { path: "E:/a.pdf" });
    expect(result.md5).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });

  it("file.modify_md5 传源路径与输出路径，不留改写源文件的入口", async () => {
    desktopInvoke.mockResolvedValue({ originalMd5: "a", newMd5: "b" });
    await executor["file.modify_md5"].execute({ sourcePath: "E:/a.pdf", outputPath: "E:/a_md5.pdf" });
    expect(desktopInvoke).toHaveBeenCalledWith("file_tool_modify_md5", {
      sourcePath: "E:/a.pdf",
      outputPath: "E:/a_md5.pdf",
    });
  });
});
