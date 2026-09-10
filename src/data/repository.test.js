// 数据访问层单测：内存后端模拟 Rust 侧 load/save_data_versioned 的乐观锁语义。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { addSubTask } from "../tasks.js";

const syncMock = vi.hoisted(() => ({
  markTombstone: vi.fn(async () => {}),
  clearTombstone: vi.fn(async () => {}),
  enqueueSync: vi.fn(async () => {}),
}));
vi.mock("../sync/index.js", () => syncMock);

const store = new Map();
const revision = (value) => "r" + (JSON.stringify(value ?? null) ?? "null").length;
let beforeVersionedSave = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd, args = {}) => {
    if (cmd === "load_data") return store.has(args.key) ? store.get(args.key) : [];
    if (cmd === "load_data_versioned") {
      const value = store.has(args.key) ? store.get(args.key) : [];
      return { data: value, revision: revision(value) };
    }
    if (cmd === "save_data") {
      store.set(args.key, args.data);
      return undefined;
    }
    if (cmd === "save_data_versioned") {
      if (beforeVersionedSave) {
        const hook = beforeVersionedSave;
        beforeVersionedSave = null;
        hook();
      }
      const current = store.has(args.key) ? store.get(args.key) : [];
      if (revision(current) !== String(args.expected_revision)) {
        throw new Error("数据已被其他页面或后台任务更新，本次保存已拒绝；请重新进入页面后再修改");
      }
      store.set(args.key, args.data);
      return revision(args.data);
    }
    throw new Error("unknown command " + cmd);
  }),
}));

const listeners = new Map();
function stubWindow() {
  const win = {
    __TAURI_INTERNALS__: {},
    addEventListener: (type, handler) => {
      listeners.set(type, [...(listeners.get(type) || []), handler]);
    },
    removeEventListener: (type, handler) => {
      listeners.set(type, (listeners.get(type) || []).filter((h) => h !== handler));
    },
    dispatchEvent: (event) => {
      for (const handler of listeners.get(event.type) || []) handler(event);
      return true;
    },
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("CustomEvent", class {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  });
}

async function freshRepo() {
  vi.resetModules();
  return await import("./repository.js");
}

beforeEach(() => {
  store.clear();
  listeners.clear();
  beforeVersionedSave = null;
  syncMock.markTombstone.mockClear();
  syncMock.clearTombstone.mockClear();
  syncMock.enqueueSync.mockClear();
  stubWindow();
});
afterEach(() => vi.unstubAllGlobals());

describe("repository 读", () => {
  it("list 支持 keyword/tag/status/ids/limit，并按 updatedAt 倒序", async () => {
    store.set("snippets", [
      { id: "s1", title: "Redis 密码", category: "密码", content: "abc", updatedAt: 100 },
      { id: "s2", title: "部署命令", category: "运维", content: "docker", updatedAt: 300 },
      { id: "s3", title: "Redis 端口", category: "运维", content: "6379", updatedAt: 200 },
    ]);
    const repo = await freshRepo();
    const all = await repo.list("snippets");
    expect(all.total).toBe(3);
    expect(all.items.map((x) => x.id)).toEqual(["s2", "s3", "s1"]);

    expect((await repo.list("snippets", { keyword: "redis" })).items.map((x) => x.id)).toEqual(["s3", "s1"]);
    expect((await repo.list("snippets", { tag: "运维" })).items.map((x) => x.id)).toEqual(["s2", "s3"]);
    expect((await repo.list("snippets", { ids: ["s1"] })).items.map((x) => x.id)).toEqual(["s1"]);
    const limited = await repo.list("snippets", { limit: 2 });
    expect(limited.items).toHaveLength(2);
    expect(limited.total).toBe(3);
  });

  it("problems 支持 status 过滤与 tags；releases 拍平 active/archived", async () => {
    store.set("problems", [
      { id: "p1", title: "线上 500", status: "open", tags: ["线上", "紧急"], updatedAt: 10 },
      { id: "p2", title: "会议纪要", status: "done", tags: ["会议"], updatedAt: 20 },
    ]);
    store.set("release-pools", { active: [{ id: "r1", name: "v1.0", updatedAt: 5 }], archived: [{ id: "r2", name: "v0.9", archivedAt: 1, updatedAt: 4 }] });
    const repo = await freshRepo();
    expect((await repo.list("problems", { status: "open" })).items.map((x) => x.id)).toEqual(["p1"]);
    expect((await repo.list("problems", { tag: "会议" })).items.map((x) => x.id)).toEqual(["p2"]);
    expect((await repo.list("releases")).items.map((x) => x.id)).toEqual(["r1", "r2"]);
    expect(await repo.get("releases", "r2")).toMatchObject({ name: "v0.9" });
  });

  it("缺失键按空数据处理（与 Rust 约定一致）", async () => {
    const repo = await freshRepo();
    expect(await repo.list("iterations")).toEqual({ total: 0, items: [] });
    expect(await repo.get("iterations", "nope")).toBeNull();
  });
});

describe("repository 写", () => {
  it("create 补齐 id/时间戳并落盘；update 刷新 updatedAt 且拒绝改 id/createdAt", async () => {
    const repo = await freshRepo();
    const created = await repo.create("snippets", { title: "新速记", content: "x" });
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeGreaterThan(0);
    expect(store.get("snippets")).toHaveLength(1);

    const updated = await repo.update("snippets", created.id, { id: "hack", createdAt: 1, title: "改过" });
    expect(updated.title).toBe("改过");
    expect(updated.id).toBe(created.id);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    expect(store.get("snippets")[0].title).toBe("改过");
  });

  it("update 传 fields 白名单时拒绝越权字段", async () => {
    const repo = await freshRepo();
    const created = await repo.create("problems", { title: "x" });
    await expect(repo.update("problems", created.id, { images: [] }, { fields: ["title", "status"] })).rejects.toThrow(/不可修改字段：images/);
    await expect(repo.update("problems", "missing-id", { title: "y" })).rejects.toThrow(/记录不存在/);
  });

  it("remove 删记录并写墓碑；restore 清墓碑并整条写回", async () => {
    store.set("snippets", [{ id: "s1", title: "旧", updatedAt: 1 }]);
    const repo = await freshRepo();
    const removed = await repo.remove("snippets", "s1");
    expect(removed.title).toBe("旧");
    expect(store.get("snippets")).toEqual([]);
    expect(syncMock.markTombstone).toHaveBeenCalledWith("s1", expect.any(Number));

    const restored = await repo.restore("snippets", removed);
    expect(syncMock.clearTombstone).toHaveBeenCalledWith("s1");
    expect(store.get("snippets")[0]).toMatchObject({ id: "s1", title: "旧" });
    expect(restored.updatedAt).toBeGreaterThan(1);
  });

  it("非 sync 类 kind 不写墓碑、不入队云同步；sync 类写后入队", async () => {
    const repo = await freshRepo();
    await repo.create("iterations", { title: "迭代", version: "v1" });
    expect(syncMock.enqueueSync).not.toHaveBeenCalled();

    await repo.create("problems", { title: "问题" });
    await vi.waitFor(() => expect(syncMock.enqueueSync).toHaveBeenCalledWith(["problems"]));
    expect(syncMock.markTombstone).not.toHaveBeenCalled();
  });

  it("mutate 冲突重放：他人先写入时不丢改动（修订号变化 → 重读重放）", async () => {
    store.set("snippets", [{ id: "s1", title: "a", updatedAt: 100 }]);
    const repo = await freshRepo();
    // 第一次写入前模拟另一窗口插入 s2：仓库应重读并把本次改动叠加上去
    beforeVersionedSave = () => {
      store.set("snippets", [...store.get("snippets"), { id: "s2", title: "并发方", updatedAt: 200 }]);
    };
    const next = await repo.mutate("snippets", (list) => {
      const target = list.find((x) => x.id === "s1");
      target.title = "本地改";
      target.updatedAt = 300;
      return list;
    });
    expect(next.map((x) => x.id)).toEqual(["s1", "s2"]);
    expect(store.get("snippets").find((x) => x.id === "s2")).toBeTruthy();
    expect(store.get("snippets").find((x) => x.id === "s1").title).toBe("本地改");
  });

  it("真实写失败（修订号未变）立即抛出，不无限重放", async () => {
    const core = await import("@tauri-apps/api/core");
    const original = core.invoke.getMockImplementation();
    core.invoke.mockImplementation(async (cmd, args = {}) => {
      if (cmd === "load_data_versioned") return { data: [], revision: "r0" };
      if (cmd === "save_data_versioned") throw new Error("磁盘只读");
      throw new Error("unknown command " + cmd);
    });
    const repo = await freshRepo();
    await expect(repo.mutate("snippets", (list) => list)).rejects.toThrow("磁盘只读");
    core.invoke.mockImplementation(original);
  });

  it("写后广播 data-changed，携带 kind 与来源；onDataChanged 可订阅与退订", async () => {
    const repo = await freshRepo();
    const seen = [];
    const off = repo.onDataChanged((detail) => seen.push(detail));
    await repo.create("problems", { title: "x" }, { source: "agent" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "problems", source: "agent" });
    expect(seen[0].ids).toHaveLength(1);
    off();
    await repo.create("problems", { title: "y" });
    expect(seen).toHaveLength(1);
  });
});

describe("mergeRecords", () => {
  it("磁盘为底、本地新记录补入、同 id 按 updatedAt 新者胜（相同则本地胜）", async () => {
    const repo = await freshRepo();
    const fresh = [
      { id: "a", title: "磁盘-a", updatedAt: 100 },
      { id: "b", title: "磁盘-b", updatedAt: 500 },
    ];
    const local = [
      { id: "b", title: "本地-b", updatedAt: 200 },
      { id: "c", title: "本地-c", updatedAt: 50 },
    ];
    const merged = repo.mergeRecords(fresh, local);
    expect(merged.map((x) => [x.id, x.title])).toEqual([["a", "磁盘-a"], ["b", "磁盘-b"], ["c", "本地-c"]]);

    const tie = repo.mergeRecords([{ id: "a", title: "磁盘", updatedAt: 100 }], [{ id: "a", title: "本地", updatedAt: 100 }]);
    expect(tie[0].title).toBe("本地");
  });
});

describe("平台命令缺失时降级", () => {
  it("无 load_data_versioned/save_data_versioned 时退回普通读写", async () => {
    const core = await import("@tauri-apps/api/core");
    const original = core.invoke.getMockImplementation();
    core.invoke.mockImplementation(async (cmd, args = {}) => {
      if (cmd === "load_data") return store.has(args.key) ? store.get(args.key) : [];
      if (cmd === "save_data") {
        store.set(args.key, args.data);
        return undefined;
      }
      throw new Error("unknown command " + cmd);
    });
    const repo = await freshRepo();
    const created = await repo.create("domains", { name: "领域" });
    expect(store.get("domains")[0].id).toBe(created.id);
    core.invoke.mockImplementation(original);
  });
});

// P2 验收：iterations 三处写入（迭代页 / 需求大盘 / 任务页）各自保存时不互相覆盖
describe("iterations 三写者收敛", () => {
  const ISO_OLD = new Date(Date.now() - 60000).toISOString();
  const initial = () => [
    {
      id: "it1",
      title: "迭代一",
      version: "v1",
      items: [{ id: "r1", name: "需求一", subtasks: [] }],
      updatedAt: ISO_OLD,
    },
  ];
  const subtask = { id: "s1", name: "写用例", hours: 2, date: "2026-09-10", done: false, logs: [] };

  it("任务页形态（对 fresh 变换）遇上并发写者：CAS 冲突重放后两边改动都在", async () => {
    const repo = await freshRepo();
    store.set("iterations", initial());
    // 并发方（需求大盘形态）在本写者落盘前抢先提交一条新需求
    beforeVersionedSave = () => {
      const list = store.get("iterations");
      list[0].items.push({ id: "r2", name: "并发新增需求", subtasks: [] });
      list[0].updatedAt = new Date().toISOString();
    };
    const result = await repo.mutate("iterations", (fresh) => addSubTask(fresh, "it1", "r1", subtask), { source: "view" });
    expect(result[0].items.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(result[0].items.find((r) => r.id === "r1").subtasks.map((s) => s.id)).toEqual(["s1"]);
    expect(store.get("iterations")).toEqual(result);
  });

  it("迭代页形态（mergeRecords 整表写回）不抹掉磁盘上其他写者新增的迭代", async () => {
    const repo = await freshRepo();
    store.set("iterations", initial());
    const snapshot = JSON.parse(JSON.stringify(store.get("iterations"))); // 迭代页的本地快照（不含后加的 it2）
    snapshot[0].title = "迭代一（改名）";
    snapshot[0].updatedAt = Date.now();
    store.set("iterations", [...initial(), { id: "it2", title: "并发新增迭代", version: "v2", items: [], updatedAt: Date.now() }]);
    const merged = await repo.mutate("iterations", (fresh) => repo.mergeRecords(fresh, snapshot), { source: "view" });
    expect(merged.map((it) => it.id)).toEqual(["it1", "it2"]);
    expect(merged[0].title).toBe("迭代一（改名）");
  });

  it("快照比磁盘旧时磁盘改动不被回退（ISO 与数字时间戳可比）", async () => {
    const repo = await freshRepo();
    store.set("iterations", initial());
    // 快照来自更早的加载：没有磁盘后来写入的子任务
    const stale = JSON.parse(JSON.stringify(initial()));
    // 磁盘已被任务页形态写入：加了子任务，updatedAt 是 ISO 字符串且更新
    await repo.mutate("iterations", (fresh) => addSubTask(fresh, "it1", "r1", subtask), { source: "view" });
    const merged = await repo.mutate("iterations", (fresh) => repo.mergeRecords(fresh, stale), { source: "view" });
    expect(merged[0].items.find((r) => r.id === "r1").subtasks.map((s) => s.id)).toEqual(["s1"]);
    // 本地快照更旧：标题保持磁盘版本
    expect(merged[0].title).toBe("迭代一");
  });

  it("落盘前深拷贝：视图传入的响应式代理不会流到存储层（浏览器 DataCloneError 回归）", async () => {
    const repo = await freshRepo();
    store.set("iterations", initial());
    const { invoke } = await import("@tauri-apps/api/core");
    // Vue 的 reactive() 就是 Proxy：浏览器实测里它让 IDBObjectStore.put 抛 DataCloneError
    const proxyRecord = new Proxy({ id: "s1", name: "代理子任务", hours: 1, date: "2026-09-10" }, {});
    await repo.mutate("iterations", (fresh) => addSubTask(fresh, "it1", "r1", proxyRecord), { source: "view" });
    const payload = invoke.mock.calls.at(-1)[1].data;
    expect(() => structuredClone(payload)).not.toThrow();
    expect(payload[0].items[0].subtasks[0]).toEqual({ id: "s1", name: "代理子任务", hours: 1, date: "2026-09-10" });
  });
});
