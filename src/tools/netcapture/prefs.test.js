import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, normalizePrefs, parseEnvText } from "./prefs.js";

describe("环境变量解析", () => {
  // 有些应用不接受命令行参数、只认环境变量，这已是实测到的第二种
  // （Qoder 的 CDP_PORT、WorkBuddy 的 WORKBUDDY_REMOTE_DEBUGGING_PORT）。
  it("解析每行一个 KEY=VALUE", () => {
    expect(parseEnvText("WORKBUDDY_REMOTE_DEBUGGING_PORT=9223\nFOO=bar")).toEqual({
      WORKBUDDY_REMOTE_DEBUGGING_PORT: "9223",
      FOO: "bar",
    });
  });

  it("忽略空行与 # 注释", () => {
    expect(parseEnvText("\n# 注释\nA=1\n\n")).toEqual({ A: "1" });
  });

  it("值里可以有 = 号（URL、base64 都常见）", () => {
    expect(parseEnvText("URL=https://x.test?a=b")).toEqual({ URL: "https://x.test?a=b" });
  });

  it("只有键没有等号的行丢掉，不猜成空值", () => {
    // 猜成 FOO="" 会让应用拿到一个「开关开了但值是空」的变量，行为难以预料
    expect(parseEnvText("FOO")).toEqual({});
    expect(parseEnvText("=value")).toEqual({});
  });

  it("键名不合法的丢掉，避免把乱七八糟的东西塞进子进程环境", () => {
    expect(parseEnvText("1BAD=x")).toEqual({});
    expect(parseEnvText("has space=x")).toEqual({});
    expect(parseEnvText("OK_1=x")).toEqual({ OK_1: "x" });
  });

  it("值两端空白去掉，空输入给空对象", () => {
    expect(parseEnvText("  A = 1  ")).toEqual({ A: "1" });
    expect(parseEnvText("")).toEqual({});
    expect(parseEnvText(undefined)).toEqual({});
  });
});

describe("偏好归一化", () => {
  it("空输入给出一组可直接用的默认值", () => {
    expect(normalizePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs({})).toEqual(DEFAULT_PREFS);
  });

  it("原样保留正常填写的路径（含空格与中文）", () => {
    const path = "C:\\Users\\chenbo.li\\AppData\\Local\\Qoder CN\\Qoder CN Launcher\\Qoder CN Launcher.exe";
    expect(normalizePrefs({ exePath: path }).exePath).toBe(path);
    // 两端空白要去掉：多出来的一格在命令里会变成另一个文件名
    expect(normalizePrefs({ exePath: `  ${path}  ` }).exePath).toBe(path);
  });

  it("端口必须是 1-65535 的整数，非法值退回默认", () => {
    expect(normalizePrefs({ port: 9222 }).port).toBe(9222);
    expect(normalizePrefs({ port: "9333" }).port).toBe(9333);
    expect(normalizePrefs({ port: 0 }).port).toBe(DEFAULT_PREFS.port);
    expect(normalizePrefs({ port: 70000 }).port).toBe(DEFAULT_PREFS.port);
    expect(normalizePrefs({ port: "abc" }).port).toBe(DEFAULT_PREFS.port);
    expect(normalizePrefs({ port: null }).port).toBe(DEFAULT_PREFS.port);
  });

  it("端口做四舍五入，不做截断（9222.6 不该变成 9222）", () => {
    expect(normalizePrefs({ port: 9222.6 }).port).toBe(9223);
  });

  it("超长值被截断，避免手滑粘进一整段文本", () => {
    expect(normalizePrefs({ exePath: "x".repeat(5000) }).exePath).toHaveLength(1024);
    expect(normalizePrefs({ filterText: "y".repeat(5000) }).filterText).toHaveLength(200);
  });

  it("只保留认识的字段，多余的丢掉", () => {
    const out = normalizePrefs({ exePath: "a.exe", port: 1, hack: "rm -rf", requests: [1, 2] });
    expect(Object.keys(out).sort()).toEqual(["envText", "exePath", "filterText", "port"]);
    expect(out.hack).toBeUndefined();
    expect(out.requests).toBeUndefined();
  });

  it("数组不是合法偏好对象，退回默认值而不是当成对象遍历", () => {
    expect(normalizePrefs([1, 2, 3])).toEqual(DEFAULT_PREFS);
  });

  it("每次返回新对象，调用方改返回值不会污染默认值", () => {
    const out = normalizePrefs({});
    out.exePath = "changed";
    expect(DEFAULT_PREFS.exePath).toBe("");
  });
});
