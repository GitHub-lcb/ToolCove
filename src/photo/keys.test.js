import { describe, expect, it } from "vitest";
import { DEFAULT_PREFIX, buildObjectKey, extensionFor, formatStamp, generateDeviceId, isValidPrefix, normalizePrefix, parseObjectKey } from "./keys.js";

const AT = new Date(2026, 9, 13, 16, 30, 0); // 本地时间 2026-10-13 16:30:00
const DEVICE = "ab12cd";
const RND = new Uint8Array([0x9f, 0x3e]);

describe("buildObjectKey", () => {
  it("生成 <prefix>/YYYY/MM/DD/时间戳_设备_随机.后缀", () => {
    const key = buildObjectKey({ capturedAt: AT, deviceId: DEVICE, ext: "jpg", prefix: "photos", rnd: RND });
    expect(key).toBe("photos/2026/10/13/20261013T163000_ab12cd_9f3e.jpg");
  });

  it("自定义前缀与嵌套前缀原样保留", () => {
    expect(buildObjectKey({ capturedAt: AT, deviceId: DEVICE, ext: "png", prefix: "my/pics", rnd: RND })).toBe(
      "my/pics/2026/10/13/20261013T163000_ab12cd_9f3e.png"
    );
  });

  it("设备 id 不合法时现场生成六位十六进制（不同照片不共用一个错值）", () => {
    const key = buildObjectKey({ capturedAt: AT, deviceId: "", ext: "jpg", prefix: "photos", rnd: RND });
    expect(key).toMatch(/^photos\/2026\/10\/13\/20261013T163000_[0-9a-f]{6}_9f3e\.jpg$/);
  });

  it("同一天内字典序 = 时间序（云端列表天然按拍摄时间排列）", () => {
    const early = buildObjectKey({ capturedAt: new Date(2026, 9, 13, 8, 15, 30), deviceId: DEVICE, ext: "jpg", prefix: "photos", rnd: RND });
    const late = buildObjectKey({ capturedAt: new Date(2026, 9, 13, 9, 0, 0), deviceId: DEVICE, ext: "jpg", prefix: "photos", rnd: RND });
    expect(early < late).toBe(true);
  });

  it("字符集受限：不含需要转义的字符（签名与 XML 解析依赖这个前提）", () => {
    const key = buildObjectKey({ capturedAt: AT, deviceId: DEVICE, ext: "jpg", prefix: "photos", rnd: RND });
    expect(key).toMatch(/^[A-Za-z0-9/._-]+$/);
  });
});

describe("parseObjectKey", () => {
  it("与 buildObjectKey 往返一致", () => {
    const key = buildObjectKey({ capturedAt: AT, deviceId: DEVICE, ext: "jpeg", prefix: "photos", rnd: RND });
    const parsed = parseObjectKey(key, "photos");
    expect(parsed).toEqual({
      date: "2026-10-13",
      stamp: "20261013T163000",
      device: DEVICE,
      ext: "jpeg",
      file: "20261013T163000_ab12cd_9f3e.jpeg",
    });
  });

  it("不是本工具命名的对象一律返回 null（桌面归档如实跳过，不猜日期）", () => {
    expect(parseObjectKey("photos/readme.txt", "photos")).toBeNull();
    expect(parseObjectKey("photos/2026/10/13/微信图片_2026.jpg", "photos")).toBeNull();
    expect(parseObjectKey("other/2026/10/13/20261013T163000_ab12cd_9f3e.jpg", "photos")).toBeNull();
    expect(parseObjectKey("", "photos")).toBeNull();
    expect(parseObjectKey(null, "photos")).toBeNull();
  });

  it("目录日期与文件名日期不一致时拒绝（key 被人改过，宁可跳过）", () => {
    expect(parseObjectKey("photos/2026/10/13/20261012T163000_ab12cd_9f3e.jpg", "photos")).toBeNull();
  });

  it("前缀与生成时一致才解析（不同前缀的照片互不误认）", () => {
    const key = buildObjectKey({ capturedAt: AT, deviceId: DEVICE, ext: "jpg", prefix: "trip/2026", rnd: RND });
    expect(parseObjectKey(key, "trip/2026")).toBeTruthy();
    expect(parseObjectKey(key, "photos")).toBeNull();
  });
});

describe("extensionFor", () => {
  it("优先原文件名后缀", () => {
    expect(extensionFor("IMG_0001.JPG", "")).toBe("jpg");
    expect(extensionFor("photo.webp", "image/jpeg")).toBe("webp");
  });

  it("文件名没有后缀时按 MIME 映射", () => {
    expect(extensionFor("photo", "image/png")).toBe("png");
    expect(extensionFor("photo", "image/heic")).toBe("heic");
    expect(extensionFor("", "image/jpeg; charset=binary")).toBe("jpg");
  });

  it("都识别不了时兜底 jpg（不认识的类型也要能存下去）", () => {
    expect(extensionFor("blob", "application/octet-stream")).toBe("jpg");
    expect(extensionFor(undefined, undefined)).toBe("jpg");
  });
});

describe("前缀与设备 id", () => {
  it("前缀规范化：去空白与首尾斜杠，空值回到默认", () => {
    expect(normalizePrefix("  /trip/  ")).toBe("trip");
    expect(normalizePrefix("")).toBe(DEFAULT_PREFIX);
    expect(normalizePrefix(undefined)).toBe(DEFAULT_PREFIX);
  });

  it("前缀校验：只接受字母数字与 /._-，且不允许空段", () => {
    expect(isValidPrefix("photos")).toBe(true);
    expect(isValidPrefix("my/pics-2026")).toBe(true);
    expect(isValidPrefix("photos//x")).toBe(false);
    expect(isValidPrefix("照片")).toBe(false);
    expect(isValidPrefix("-leading")).toBe(false);
  });

  it("设备 id 六位十六进制，注入字节可复现", () => {
    expect(generateDeviceId(new Uint8Array([0x00, 0x1a, 0xff]))).toBe("001aff");
    expect(generateDeviceId()).toMatch(/^[0-9a-f]{6}$/);
  });

  it("formatStamp 固定宽度（月日时分秒都补零）", () => {
    expect(formatStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102T030405");
  });
});
