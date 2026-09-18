// 手机端备份/恢复的单测。
//
// 这一层是纯逻辑（打包、校验、恢复），所以能在 node 环境完整测掉——
// 需要 IndexedDB 的部分由 kv.js 负责，这里用替身注入。
import { beforeEach, describe, expect, it, vi } from "vitest";

// kv.js 依赖 IndexedDB，单测里用内存替身（只 mock 我们用到的那三个函数）
const store = new Map();
vi.mock("../../src/platform/kv.js", () => ({
  kvGet: async (key) => (store.has(key) ? store.get(key) : null),
  kvSet: async (key, value) => {
    store.set(key, value);
  },
  kvKeys: async () => [...store.keys()],
}));

const { BACKUP_FORMAT, BACKUP_VERSION, applyBackup, buildBackup, describeBackup, validateBackup } = await import("./backup.js");

describe("手机端备份与恢复", () => {
  beforeEach(() => {
    store.clear();
  });

  it("打包出带格式与版本的文件头（将来换格式能识别旧文件）", async () => {
    store.set("toolcove.snippets", [{ id: "1", title: "速记" }]);
    const backup = await buildBackup();
    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.platform).toBe("android");
    expect(backup.entries["toolcove.snippets"]).toHaveLength(1);
    expect(backup.stats.keys).toBe(1);
    expect(new Date(backup.createdAt).getTime()).toBeGreaterThan(0);
  });

  it("空数据也能备份（不该报错，只是没有条目）", async () => {
    const backup = await buildBackup();
    expect(backup.stats.keys).toBe(0);
    expect(validateBackup(backup).ok).toBe(true);
  });

  it("跳过读不到的键（备份里出现 null 会在恢复时误删真实数据）", async () => {
    store.set("a", { x: 1 });
    store.set("b", undefined); // 读出来是 undefined
    const backup = await buildBackup();
    expect(Object.keys(backup.entries)).toEqual(["a"]);
    expect(backup.stats.missing).toBe(1);
  });

  it("恢复：把条目写回存储", async () => {
    const backup = {
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      entries: { "toolcove.snippets": [{ id: "9" }], "toolcove.settings": { aiModel: "gpt" } },
    };
    const result = await applyBackup(backup);
    expect(result.written).toBe(2);
    expect(store.get("toolcove.snippets")).toEqual([{ id: "9" }]);
    expect(store.get("toolcove.settings")).toEqual({ aiModel: "gpt" });
  });

  it("校验：不是备份文件时给出各自的原因（而不是笼统失败）", () => {
    expect(validateBackup(null).reason).toBe("notObject");
    expect(validateBackup("string").reason).toBe("notObject");
    expect(validateBackup({}).reason).toBe("notBackup");
    // 桌面端的 zip 解出来不会是 JSON；万一用户选错文件要能说清
    expect(validateBackup({ format: "something-else" }).reason).toBe("wrongFormat");
    expect(validateBackup({ format: BACKUP_FORMAT }).reason).toBe("noVersion");
    // 更高版本：不能假装能读（会丢字段）
    expect(validateBackup({ format: BACKUP_FORMAT, version: 99 }).reason).toBe("tooNew");
    expect(validateBackup({ format: BACKUP_FORMAT, version: 1 }).reason).toBe("noEntries");
  });

  it("恢复非法备份时抛错且不改动存储", async () => {
    store.set("existing", { keep: true });
    await expect(applyBackup({ format: "nope" })).rejects.toThrow();
    expect(store.get("existing")).toEqual({ keep: true });
  });

  it("往返一致：备份 → 清空 → 恢复 → 数据相同", async () => {
    store.set("toolcove.snippets", [{ id: "1", title: "甲" }]);
    store.set("toolcove.problems", [{ id: "2", title: "乙" }]);
    store.set("toolcove.settings", { aiModel: "m", syncUrl: "http://x" });
    const backup = await buildBackup();
    const snapshot = JSON.parse(JSON.stringify(backup.entries));

    store.clear();
    expect(store.size).toBe(0);

    await applyBackup(backup);
    expect(store.get("toolcove.snippets")).toEqual(snapshot["toolcove.snippets"]);
    expect(store.get("toolcove.problems")).toEqual(snapshot["toolcove.problems"]);
    expect(store.get("toolcove.settings")).toEqual(snapshot["toolcove.settings"]);
  });

  it("describeBackup 给出恢复前要展示的信息（键数、时间）", async () => {
    store.set("a", 1);
    const backup = await buildBackup();
    const info = describeBackup(backup);
    expect(info.ok).toBe(true);
    expect(info.keys).toBe(1);
    expect(info.createdAt).toBe(backup.createdAt);

    const bad = describeBackup({ format: "x" });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("wrongFormat");
  });

  it("图片（base64 存在键里）也能往返", async () => {
    // 图片走 save_image/load_image，最终也是 IndexedDB 里的键，所以备份天然涵盖
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    store.set("img:chat-1.png", dataUrl);
    const backup = await buildBackup();
    store.clear();
    await applyBackup(backup);
    expect(store.get("img:chat-1.png")).toBe(dataUrl);
  });
});
