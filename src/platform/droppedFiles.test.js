import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./invoke.js", () => ({ invoke: vi.fn() }));

const { invoke } = await import("./invoke.js");
const { base64Bytes, fileFromBase64Result, filesFromPaths } = await import("./droppedFiles.js");

describe("拖放路径 → File", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("base64 解成字节（跳过空白）", () => {
    expect([...base64Bytes("AQID")]).toEqual([1, 2, 3]);
    expect([...base64Bytes("AQ ID\n")]).toEqual([1, 2, 3]);
  });

  it("用文件名推断 mime，未知扩展名不假装是图片", () => {
    const png = fileFromBase64Result({ name: "a.png", base64: "AQID" });
    expect(png).toBeInstanceOf(File);
    expect(png.name).toBe("a.png");
    expect(png.type).toBe("image/png");
    expect(png.size).toBe(3);
    expect(fileFromBase64Result({ name: "a.unknown", base64: "AQID" }).type).toBe("application/octet-stream");
  });

  it("读不到的路径被跳过，其余照常返回", async () => {
    invoke.mockImplementation(async (_command, { path }) => {
      if (path === "bad") throw new Error("源文件超过 20 MB 限制");
      return { name: "b.jpg", base64: "AQID" };
    });
    const { files, errors } = await filesFromPaths(["bad", "good"]);
    expect(invoke).toHaveBeenCalledWith("file_tool_read_base64", { path: "good" });
    expect(files.map((f) => f.name)).toEqual(["b.jpg"]);
    expect(files[0].type).toBe("image/jpeg");
    // 原因要带回去：全都失败时界面不能把"文件太大"说成"没检测到图片"
    expect(errors).toEqual(["源文件超过 20 MB 限制"]);
  });
});
