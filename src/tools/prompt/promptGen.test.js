import { describe, expect, it } from "vitest";
import {
  buildImagesUrl,
  cloudConfigReady,
  dataUrl,
  DEFAULT_GEN_CONFIG,
  genErrorKeyOf,
  isVideoName,
  mediaName,
  mimeOfName,
  normalizeExt,
  normalizeGenConfig,
  SIZE_OPTIONS,
} from "./promptGen.js";

describe("云端生图：配置归一", () => {
  it("空输入得到完整默认形状", () => {
    const config = normalizeGenConfig(null);
    expect(config.cloud).toEqual(DEFAULT_GEN_CONFIG.cloud);
    expect(config.comfy).toEqual(DEFAULT_GEN_CONFIG.comfy);
  });

  it("baseUrl 去尾斜杠；comfy 地址留空时回退默认", () => {
    const config = normalizeGenConfig({
      cloud: { baseUrl: "https://api.example.com/v1///", apiKey: " k ", model: " m " },
      comfy: { baseUrl: "  " },
    });
    expect(config.cloud.baseUrl).toBe("https://api.example.com/v1");
    expect(config.cloud.apiKey).toBe("k");
    expect(config.cloud.model).toBe("m");
    expect(config.comfy.baseUrl).toBe(DEFAULT_GEN_CONFIG.comfy.baseUrl);
  });

  it("数值越界钳制：n∈[1,4]、steps∈[1,150]、denoise∈[0,1]、尺寸∈[64,4096]", () => {
    const config = normalizeGenConfig({
      cloud: { n: 99, size: "9999x9999" },
      comfy: { steps: 0, cfg: -3, denoise: 5, width: 1, height: 99999, seed: -7 },
    });
    expect(config.cloud.n).toBe(4);
    expect(config.cloud.size).toBe(DEFAULT_GEN_CONFIG.cloud.size);
    expect(config.comfy.steps).toBe(1);
    expect(config.comfy.cfg).toBe(0);
    expect(config.comfy.denoise).toBe(1);
    expect(config.comfy.width).toBe(64);
    expect(config.comfy.height).toBe(4096);
    expect(config.comfy.seed).toBe(0);
  });

  it("size 只收白名单；seedMode 非 fixed 一律 random；sendNegative 默认开", () => {
    const config = normalizeGenConfig({ cloud: { size: SIZE_OPTIONS[1] }, comfy: { seedMode: "weird" } });
    expect(config.cloud.size).toBe(SIZE_OPTIONS[1]);
    expect(config.comfy.seedMode).toBe("random");
    expect(config.cloud.sendNegative).toBe(true);
    expect(normalizeGenConfig({ cloud: { sendNegative: false } }).cloud.sendNegative).toBe(false);
    expect(normalizeGenConfig({ comfy: { seedMode: "fixed" } }).comfy.seedMode).toBe("fixed");
  });

  it("cloudConfigReady 三件套齐全才算就绪", () => {
    expect(cloudConfigReady({})).toBe(false);
    expect(cloudConfigReady({ baseUrl: "https://x/v1", apiKey: "k", model: "m" })).toBe(true);
    expect(cloudConfigReady({ baseUrl: "https://x/v1", apiKey: "", model: "m" })).toBe(false);
    expect(cloudConfigReady(null)).toBe(false);
  });
});

describe("云端生图：地址与命名", () => {
  it("buildImagesUrl 拼接 /images/generations，空 base 返回空串", () => {
    expect(buildImagesUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1/images/generations");
    expect(buildImagesUrl("")).toBe("");
    expect(buildImagesUrl(null)).toBe("");
  });

  it("normalizeExt 接受裸扩展名 / MIME / URL，jpeg 归一为 jpg，未知回退", () => {
    expect(normalizeExt("PNG")).toBe("png");
    expect(normalizeExt("image/jpeg")).toBe("jpg");
    expect(normalizeExt("image/webp;charset=utf-8")).toBe("webp");
    expect(normalizeExt("https://host/a/b.webm?token=1")).toBe("webm");
    expect(normalizeExt("file.mp4#frag")).toBe("mp4");
    expect(normalizeExt("exe")).toBe("png");
    expect(normalizeExt("")).toBe("png");
    expect(normalizeExt("exe", "bin")).toBe("bin");
  });

  it("mediaName 结构固定、时间戳可预测、随机位补零且恒为 4 位", () => {
    const now = new Date(2026, 9, 10, 15, 30, 5).getTime();
    expect(mediaName("image/png", now, () => 0)).toBe("p20261010-153005-0000.png");
    expect(mediaName("mp4", now, () => 1)).toBe("p20261010-153005-zzzz.mp4");
    expect(/^p\d{8}-\d{6}-[0-9a-z]{4}\.(png|mp4)$/.test(mediaName("png", now))).toBe(true);
  });

  it("mimeOfName / isVideoName / dataUrl", () => {
    expect(mimeOfName("a.B.png")).toBe("image/png");
    expect(mimeOfName("v.mp4")).toBe("video/mp4");
    expect(mimeOfName("weird")).toBe("application/octet-stream");
    expect(isVideoName("v.webm")).toBe(true);
    expect(isVideoName("i.png")).toBe(false);
    expect(dataUrl("a.png", "AAA")).toBe("data:image/png;base64,AAA");
  });
});

describe("云端生图：错误映射", () => {
  it("配置缺失 / 无图返回", () => {
    expect(genErrorKeyOf("未配置生图接口地址")).toBe("toolbox.prompt.errConfig");
    expect(genErrorKeyOf(new Error("服务未返回图片"))).toBe("toolbox.prompt.errNoImages");
  });

  it("HTTP 状态分类：401/403 密钥、429 限流、5xx 服务端、其余 4xx 通用", () => {
    expect(genErrorKeyOf("HTTP 401：invalid api key")).toBe("toolbox.prompt.errAuth");
    expect(genErrorKeyOf("HTTP 403：forbidden")).toBe("toolbox.prompt.errAuth");
    expect(genErrorKeyOf("HTTP 429：rate limited")).toBe("toolbox.prompt.errRate");
    expect(genErrorKeyOf("HTTP 500：oops")).toBe("toolbox.prompt.errServer");
    expect(genErrorKeyOf("HTTP 400：bad request")).toBe("toolbox.prompt.errHttp");
  });

  it("网络层：超时、连接失败、未知一律传输层", () => {
    expect(genErrorKeyOf("请求超时（300s）")).toBe("toolbox.prompt.errTimeout");
    expect(genErrorKeyOf("error sending request: connection refused")).toBe("toolbox.prompt.errNetwork");
    expect(genErrorKeyOf("连接不上")).toBe("toolbox.prompt.errNetwork");
    expect(genErrorKeyOf("something weird")).toBe("toolbox.prompt.errTransport");
    expect(genErrorKeyOf(null)).toBe("toolbox.prompt.errTransport");
  });
});
