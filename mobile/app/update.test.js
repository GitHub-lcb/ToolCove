import { beforeEach, describe, expect, it, vi } from "vitest";

// 桥不存在时（node 环境）invoke 会去找 window —— 先 mock 掉，用例只关心判断逻辑与调用形状。
vi.mock("../../src/platform/invoke.js", () => ({ invoke: vi.fn() }));

import { invoke } from "../../src/platform/invoke.js";
import { APK_MANIFEST_URL, compareVersions, currentVersion, decideUpdate, downloadApk, fetchManifest, installApk, parseManifest } from "./platform/update.js";

const GOOD = {
  version: "1.1.0",
  versionCode: 10100,
  url: "https://github.com/GitHub-lcb/ToolCove/releases/download/apk-v1.1.0/toolcove-release.apk",
  sha256: "a".repeat(64),
  size: 1486848,
};

// 用 vi.clearAllMocks() 而不是 invoke.mockReset()：后者会把上一次用例里那个被拒的 promise
// 留在 mock 簿记里，测试结束时以「未处理的 rejection」形式报出来——产品代码明明 catch 了，
// 用例却红（排查起来会让人怀疑 catch 没生效）。仓库里 session.test / index.test 也是这个写法。
beforeEach(() => vi.clearAllMocks());

describe("parseManifest（清单是唯一外部输入，所以按最严的来）", () => {
  it("合法清单原样解析", () => {
    expect(parseManifest(GOOD)).toMatchObject({ version: "1.1.0", versionCode: 10100, sha256: "a".repeat(64), size: 1486848 });
    expect(parseManifest(JSON.stringify(GOOD))).toMatchObject({ version: "1.1.0" });
  });

  it("缺哈希 / 哈希畸形 / 非 https / 版本不像版本 —— 一律 null", () => {
    expect(parseManifest({ ...GOOD, sha256: "" })).toBe(null);
    expect(parseManifest({ ...GOOD, sha256: "abc" })).toBe(null);
    expect(parseManifest({ ...GOOD, sha256: "z".repeat(64) })).toBe(null);
    expect(parseManifest({ ...GOOD, url: GOOD.url.replace("https://", "http://") })).toBe(null);
    expect(parseManifest({ ...GOOD, version: "latest" })).toBe(null);
    expect(parseManifest({ ...GOOD, version: "1.1" })).toBe(null);
    expect(parseManifest("{}")).toBe(null);
    expect(parseManifest("不是 json")).toBe(null);
    expect(parseManifest(null)).toBe(null);
    expect(parseManifest([])).toBe(null);
  });

  it("体积离谱（0 或 >200MB）当坏清单，不下这个包", () => {
    expect(parseManifest({ ...GOOD, size: 0 })).toBe(null);
    expect(parseManifest({ ...GOOD, size: 500 * 1024 * 1024 })).toBe(null);
    // 没给 size 是可以的（旧清单），只是不显示体积
    expect(parseManifest({ ...GOOD, size: undefined })).toMatchObject({ version: "1.1.0", size: 0 });
  });

  it("哈希大小写归一", () => {
    expect(parseManifest({ ...GOOD, sha256: "B".repeat(64) }).sha256).toBe("b".repeat(64));
  });
});

describe("compareVersions", () => {
  it("逐段数字比较，缺位补 0", () => {
    expect(compareVersions("1.1.0", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.10", "1.0.9")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.9.9", "1.0.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("", "0.0.0")).toBe(0);
  });
});

describe("decideUpdate（「什么时候算有新版」只有一处口径）", () => {
  const at = (versionName, code = 0) => ({ versionName, code });

  it("有新版 / 已最新 / 同版本", () => {
    expect(decideUpdate(GOOD, at("1.0.0", 10000))).toEqual({ state: "available", target: "1.1.0" });
    expect(decideUpdate(GOOD, at("1.1.0", 10100))).toEqual({ state: "uptodate", target: "1.1.0" });
    expect(decideUpdate(GOOD, at("1.2.0", 10200))).toEqual({ state: "uptodate", target: "1.1.0" });
  });

  it("同版本号但 versionCode 递增（重发包）也算有新版", () => {
    expect(decideUpdate({ ...GOOD, versionCode: 10101 }, at("1.1.0", 10100))).toEqual({ state: "available", target: "1.1.0" });
  });

  it("坏清单必须是 invalid，不能显示成「已是最新」", () => {
    // 这一条是整个模块里最要紧的判断：发版时忘了更新通道，界面若报"已是最新"，
    // 用户会永远停在旧版本而没人察觉
    expect(decideUpdate(null, at("1.0.0"))).toEqual({ state: "invalid" });
    expect(decideUpdate({ version: "1.1" }, at("1.0.0"))).toEqual({ state: "invalid" });
  });

  it("拿不到当前版本时不猜（网页形态）", () => {
    expect(decideUpdate(GOOD, at(""))).toEqual({ state: "unknown", target: "1.1.0" });
    expect(decideUpdate(GOOD, undefined)).toEqual({ state: "unknown", target: "1.1.0" });
  });
});

describe("fetchManifest / currentVersion（走普通 http 与桥命令）", () => {
  it("按固定地址取清单，并解析成对象", async () => {
    invoke.mockResolvedValue({ status: 200, body: JSON.stringify(GOOD) });
    expect(await fetchManifest()).toMatchObject({ version: "1.1.0" });
    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe("http_request");
    expect(args.url).toBe(APK_MANIFEST_URL);
    expect(APK_MANIFEST_URL).toContain("/releases/download/apk-latest/");
    // 桌面端 updater 占着 releases/latest/download/latest.json，安卓不能抢
    expect(APK_MANIFEST_URL).not.toContain("releases/latest");
  });

  it("清单没发布（404）时返回 null，让上层判成「清单不可用」", async () => {
    invoke.mockResolvedValue({ status: 404, body: "Not Found" });
    expect(await fetchManifest()).toBe(null);
    // 关键链路：404 → null → invalid，而不是被显示成"已是最新"
    expect(decideUpdate(null, { versionName: "1.0.0", code: 10000 }).state).toBe("invalid");
  });

  it("桥没有 app_version 时算「未知」，不报错", async () => {
    invoke.mockRejectedValue(new Error("unsupported"));
    expect(await currentVersion()).toMatchObject({ versionName: "", supported: false });
  });

  it("读得到原生版本与安装授权状态", async () => {
    invoke.mockResolvedValue({ versionName: "1.0.0", versionCode: 10000, canInstall: true });
    expect(await currentVersion()).toMatchObject({ versionName: "1.0.0", code: 10000, canInstall: true, supported: true });
  });
});

describe("downloadApk / installApk", () => {
  it("下载只把 url 与 sha256 交给原生（校验与域名白名单在 Kotlin 侧兜底）", async () => {
    invoke.mockResolvedValue({ path: "/cache/apk/toolcove-update.apk", size: 10 });
    await downloadApk(GOOD);
    expect(invoke.mock.calls[0]).toEqual(["update_download", { url: GOOD.url, sha256: GOOD.sha256 }]);
  });

  it("清单不合法时拒绝下载，不产生桥调用", async () => {
    await expect(downloadApk({ version: "1.1", url: "http://x", sha256: "" })).rejects.toThrow(/清单/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("把安装结果原样交回（ok / need_unknown_sources 都要能被界面区分）", async () => {
    invoke.mockResolvedValue({ ok: false, reason: "need_unknown_sources", launched: true });
    expect(await installApk("/cache/apk/a.apk")).toMatchObject({ ok: false, reason: "need_unknown_sources" });
    expect(invoke.mock.calls[0]).toEqual(["update_install", { path: "/cache/apk/a.apk" }]);
  });
});
