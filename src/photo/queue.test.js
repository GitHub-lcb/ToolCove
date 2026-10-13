import { describe, expect, it } from "vitest";
import { PhotoQueue, QUEUE_STATE } from "./queue.js";
import { createMemoryStore } from "./idb.js";
import { parseObjectKey } from "./keys.js";
import { validatePhotoConfig } from "./config.js";

const CONFIG = validatePhotoConfig({
  provider: "s3",
  endpoint: "cos.ap-guangzhou.myqcloud.com",
  region: "ap-guangzhou",
  bucket: "b-1250000000",
  accessKey: "AKID",
  secretKey: "SECRET",
  prefix: "photos",
  deviceId: "ab12cd",
}).config;

function makeFile(name = "IMG_0001.jpg", extra = {}) {
  return { blob: new Uint8Array([1, 2, 3]), name, type: "image/jpeg", size: 3, capturedAt: Date.UTC(2026, 9, 13, 8, 30, 0), ...extra };
}

function makeQueue({ uploader, store = createMemoryStore(), maxDone } = {}) {
  const updates = [];
  const queue = new PhotoQueue({
    store,
    uploader: uploader || (async () => ({ etag: "etag-1" })),
    onUpdate: (item) => updates.push(item),
    maxDone,
  });
  return { queue, store, updates };
}

describe("PhotoQueue 基础流", () => {
  it("入队即落盘：key 格式正确、记录带 blob", async () => {
    const { queue, store } = makeQueue();
    await queue.init();
    const [item] = await queue.addFiles([makeFile()], { config: CONFIG });

    const parsed = parseObjectKey(item.key, "photos");
    expect(parsed).toBeTruthy();
    expect(parsed.device).toBe("ab12cd");
    expect(item.status).toBe(QUEUE_STATE.pending);

    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].blob).toBeTruthy();
  });

  it("pump 串行上传：成功后置 done、删本地二进制、留 ETag 记录", async () => {
    const order = [];
    const uploader = async ({ item }) => {
      order.push(item.id);
      return { etag: "etag-1" };
    };
    const { queue, store } = makeQueue({ uploader });
    await queue.init();
    await queue.addFiles([makeFile("a.jpg"), makeFile("b.jpg")], { config: CONFIG });
    queue.setConfig(CONFIG);
    await queue.pump();

    expect(order).toHaveLength(2);
    expect(order[0]).not.toBe(order[1]); // 串行：一个传完才到下一个
    expect(queue.stats()).toEqual({ pending: 0, uploading: 0, done: 2, error: 0, total: 2 });
    const rows = await store.list();
    for (const row of rows) {
      expect(row.status).toBe(QUEUE_STATE.done);
      expect(row.blob).toBeUndefined();
      expect(row.etag).toBe("etag-1");
    }
  });

  it("配置不合法时保持 pending 不动作（照片已安全落盘，等配置补全）", async () => {
    const { queue } = makeQueue();
    await queue.init();
    await queue.addFiles([makeFile()], { config: CONFIG });
    queue.setConfig({}); // 未配置
    await queue.pump();
    expect(queue.stats()).toEqual({ pending: 1, uploading: 0, done: 0, error: 0, total: 1 });
  });

  it("失败进 error 态、保留 blob；重试成功后才清", async () => {
    let fail = true;
    const uploader = async () => {
      if (fail) throw new Error("SignatureDoesNotMatch: 密钥不对");
      return { etag: "ok" };
    };
    const { queue, store } = makeQueue({ uploader });
    await queue.init();
    const [item] = await queue.addFiles([makeFile()], { config: CONFIG });
    queue.setConfig(CONFIG);
    await queue.pump();

    expect(item.status).toBe(QUEUE_STATE.error);
    expect(item.error).toContain("SignatureDoesNotMatch");
    expect((await store.list())[0].blob).toBeTruthy(); // 失败不丢原图

    fail = false;
    await queue.retry(item.id);
    expect(item.status).toBe(QUEUE_STATE.done);
    expect(item.attempts).toBe(2);
    expect((await store.list())[0].blob).toBeUndefined();
  });

  it("重启恢复：新队列实例（同 store）能看到 pending 并续传", async () => {
    const store = createMemoryStore();
    const first = makeQueue({ store });
    await first.queue.init();
    await first.queue.addFiles([makeFile()], { config: CONFIG });
    // 模拟"传之前页面被关掉"：不 pump，直接换实例
    const second = makeQueue({ store });
    await second.queue.init();
    expect(second.queue.stats().pending).toBe(1);
    second.queue.setConfig(CONFIG);
    await second.queue.pump();
    expect(second.queue.stats().done).toBe(1);
  });

  it("在传的项不能被删除（先等结果，避免状态机里留下悬空上传）", async () => {
    let release;
    const uploader = () => new Promise((resolve) => (release = () => resolve({ etag: "x" })));
    const { queue } = makeQueue({ uploader });
    await queue.init();
    const [item] = await queue.addFiles([makeFile()], { config: CONFIG });
    queue.setConfig(CONFIG);
    const pumping = queue.pump();
    await Promise.resolve();
    await queue.remove(item.id);
    expect(queue.items.some((row) => row.id === item.id)).toBe(true);
    release();
    await pumping;
    await queue.remove(item.id);
    expect(queue.items.some((row) => row.id === item.id)).toBe(false);
  });

  it("retryAllErrors 把失败项一起重跑", async () => {
    let fail = true;
    const uploader = async () => {
      if (fail) throw new Error("network down");
      return { etag: "ok" };
    };
    const { queue } = makeQueue({ uploader });
    await queue.init();
    await queue.addFiles([makeFile("a.jpg"), makeFile("b.jpg")], { config: CONFIG });
    queue.setConfig(CONFIG);
    await queue.pump();
    expect(queue.stats().error).toBe(2);
    fail = false;
    await queue.retryAllErrors();
    expect(queue.stats()).toEqual({ pending: 0, uploading: 0, done: 2, error: 0, total: 2 });
  });

  it("clearDone 清历史；remove 删单条", async () => {
    const { queue, store } = makeQueue();
    await queue.init();
    await queue.addFiles([makeFile("a.jpg"), makeFile("b.jpg")], { config: CONFIG });
    queue.setConfig(CONFIG);
    await queue.pump();
    expect((await store.list())).toHaveLength(2);
    await queue.clearDone();
    expect(await store.list()).toHaveLength(0);
    expect(queue.items).toHaveLength(0);
  });

  it("已完成记录只留 maxDone 条（回看用，不无限涨）", async () => {
    const { queue, store } = makeQueue({ maxDone: 2 });
    await queue.init();
    await queue.addFiles([makeFile("1.jpg"), makeFile("2.jpg"), makeFile("3.jpg")], { config: CONFIG });
    queue.setConfig(CONFIG);
    await queue.pump();
    expect(queue.stats().done).toBe(2);
    expect((await store.list())).toHaveLength(2);
  });

  it("配置缺 deviceId 时本次会话内固定生成一个（同批照片设备段一致）", async () => {
    const { queue } = makeQueue();
    await queue.init();
    const cfg = { ...CONFIG, deviceId: "" };
    const items = await queue.addFiles([makeFile("1.jpg"), makeFile("2.jpg")], { config: cfg });
    const devices = items.map((item) => parseObjectKey(item.key, "photos").device);
    expect(devices[0]).toBe(devices[1]);
    expect(queue.generatedDeviceId).toMatch(/^[0-9a-f]{6}$/);
  });
});
