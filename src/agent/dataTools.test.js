// Agent 数据工具单测：内存后端模拟 Rust 侧读写，重点覆盖「摘要截断不超 token」与验收场景。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store = new Map();
const revision = (value) => "r" + (JSON.stringify(value ?? null) ?? "null").length;

const syncMock = vi.hoisted(() => ({
  markTombstone: vi.fn(async () => {}),
  clearTombstone: vi.fn(async () => {}),
  enqueueSync: vi.fn(async () => {}),
}));
vi.mock("../sync/index.js", () => syncMock);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd, args = {}) => {
    const current = (key) => (store.has(key) ? store.get(key) : []);
    if (cmd === "load_data") return current(args.key);
    if (cmd === "load_data_versioned") {
      const value = current(args.key);
      return { data: value, revision: revision(value) };
    }
    if (cmd === "save_data") {
      store.set(args.key, args.data);
      return undefined;
    }
    if (cmd === "save_data_versioned") {
      if (revision(current(args.key)) !== String(args.expected_revision)) throw new Error("数据已被其他页面或后台任务更新");
      store.set(args.key, args.data);
      return revision(args.data);
    }
    throw new Error("unknown command " + cmd);
  }),
}));

/** 每个用例一份新的 repository 实例：读缓存 TTL 1s，跨用例复用会读到上个用例的数据 */
async function freshTools() {
  vi.resetModules();
  const { createDataTools } = await import("./dataTools.js");
  return createDataTools();
}
const byName = (tools, name) => tools.find((t) => t.name === name);

beforeEach(() => {
  store.clear();
  syncMock.markTombstone.mockClear();
  syncMock.enqueueSync.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("data.query", () => {
  it("按 kind 返回 {total, items}，按 updatedAt 倒序，total 是过滤后总数而非当页条数", async () => {
    store.set("snippets", [
      { id: "s1", title: "旧", content: "a", updatedAt: 100 },
      { id: "s2", title: "新", content: "b", updatedAt: 300 },
      { id: "s3", title: "中", content: "c", updatedAt: 200 },
    ]);
    const query = byName(await freshTools(), "data.query");
    const all = await query.execute({ kind: "snippets" });
    expect(all.kind).toBe("snippets");
    expect(all.total).toBe(3);
    expect(all.items.map((x) => x.id)).toEqual(["s2", "s3", "s1"]);

    const page = await query.execute({ kind: "snippets", limit: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
  });

  it("keyword / status / tag 过滤透传仓库查询", async () => {
    store.set("problems", [
      { id: "p1", title: "线上 500", status: "open", tags: ["线上"], updatedAt: 10 },
      { id: "p2", title: "线上超时", status: "done", tags: ["线上"], updatedAt: 20 },
      { id: "p3", title: "会议纪要", status: "open", tags: ["会议"], updatedAt: 30 },
    ]);
    const query = byName(await freshTools(), "data.query");
    expect((await query.execute({ kind: "problems", keyword: "线上" })).items.map((x) => x.id)).toEqual(["p2", "p1"]);
    expect((await query.execute({ kind: "problems", status: "open" })).items.map((x) => x.id)).toEqual(["p3", "p1"]);
    expect((await query.execute({ kind: "problems", tag: "线上" })).items.map((x) => x.id)).toEqual(["p2", "p1"]);
  });

  it("长文本截断到 400 字符并标记 truncated；对象数组降级为条数", async () => {
    store.set("problems", [
      {
        id: "p1",
        title: "线上 500",
        status: "open",
        note: "n".repeat(1000),
        logs: [{ at: 1, text: "a" }, { at: 2, text: "b" }],
        tags: ["线上", "紧急"],
        updatedAt: 10,
      },
    ]);
    const query = byName(await freshTools(), "data.query");
    const item = (await query.execute({ kind: "problems" })).items[0];
    expect(item.note).toHaveLength(400);
    expect(item.truncated).toBe(true);
    expect(item.logs).toBeUndefined();
    expect(item.logsCount).toBe(2);
    expect(item.tags).toEqual(["线上", "紧急"]);
    expect(item.title).toBe("线上 500");
  });

  it("未截断的记录不带 truncated 标记", async () => {
    store.set("snippets", [{ id: "s1", title: "短", content: "abc", updatedAt: 1 }]);
    const query = byName(await freshTools(), "data.query");
    const item = (await query.execute({ kind: "snippets" })).items[0];
    expect(item.truncated).toBeUndefined();
  });

  it("未知 kind 直接报错，不会静默返回空列表", async () => {
    const query = byName(await freshTools(), "data.query");
    await expect(query.execute({ kind: "nope" })).rejects.toThrow(/未知数据类别/);
  });
});

describe("data.get", () => {
  it("返回完整记录（不被 query 的 400 字符截断影响）", async () => {
    store.set("snippets", [{ id: "s1", title: "长文", content: "c".repeat(3000), updatedAt: 1 }]);
    const get = byName(await freshTools(), "data.get");
    const record = await get.execute({ kind: "snippets", id: "s1" });
    expect(record.content).toHaveLength(3000);
    expect(record.truncated).toBeUndefined();
  });

  it("记录不存在时报「未找到」，而不是返回 null", async () => {
    const get = byName(await freshTools(), "data.get");
    await expect(get.execute({ kind: "snippets", id: "missing" })).rejects.toThrow(/未找到记录/);
  });

  it("超大记录降级截断并标记 truncated，序列化后不再超限", async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      id: "i" + i,
      logs: Array.from({ length: 30 }, () => "x".repeat(100)),
    }));
    store.set("iterations", [{ id: "it1", title: "大迭代", items, updatedAt: 1 }]);
    const get = byName(await freshTools(), "data.get");
    const record = await get.execute({ kind: "iterations", id: "it1" });
    expect(record.truncated).toBe(true);
    expect(record.items).toHaveLength(50);
    expect(record.items[0].logs).toMatch(/30 项/);
    expect(JSON.stringify(record).length).toBeLessThan(24000);
  });

  it("releases 的 active/archived 拍平后可按 id 取到归档记录", async () => {
    store.set("release-pools", {
      active: [{ id: "r1", name: "v1.0", updatedAt: 5 }],
      archived: [{ id: "r2", name: "v0.9", updatedAt: 4 }],
    });
    const get = byName(await freshTools(), "data.get");
    expect(await get.execute({ kind: "releases", id: "r2" })).toMatchObject({ name: "v0.9" });
  });
});

describe("工具定义与注册", () => {
  it("参数越界 / 未知参数 / 非法 kind 被 schema 拦住", async () => {
    const { validateArgs } = await import("./runtime.js");
    const query = byName(await freshTools(), "data.query");
    expect(() => validateArgs(query.inputSchema, { kind: "snippets", limit: 200 })).toThrow(/超出范围/);
    expect(() => validateArgs(query.inputSchema, { kind: "snippets", owner: "me" })).toThrow(/未知参数/);
    expect(() => validateArgs(query.inputSchema, { kind: "tasks" })).toThrow(/不在允许值中/);
    expect(() => validateArgs(query.inputSchema, {})).toThrow(/Missing required/);
    validateArgs(query.inputSchema, { kind: "snippets", limit: 50, keyword: "redis" });
  });

  it("两个读工具都注册进 registry，桌面端与浏览器端一致，且受停用清单约束", async () => {
    const { buildAgentRegistry, listAgentTools, AGENT_TOOL_NAMES } = await import("./tools.js");
    for (const env of [{ desktop: true }, { desktop: false }]) {
      vi.stubGlobal("window", env.desktop ? { __TAURI_INTERNALS__: {} } : {});
      const names = (await buildAgentRegistry(null)).list().map((t) => t.name);
      expect(names).toContain("data.query");
      expect(names).toContain("data.get");
      expect(AGENT_TOOL_NAMES).toContain("data.query");
    }
    const cfg = { disabledTools: ["data.query"] };
    expect((await buildAgentRegistry(cfg)).list().map((t) => t.name)).not.toContain("data.query");
    const listed = listAgentTools(cfg);
    expect(listed.find((t) => t.name === "data.query").enabled).toBe(false);
    expect(listed.find((t) => t.name === "data.get")).toMatchObject({ risk: "read", enabled: true });
  });
});

describe("data.create", () => {
  it("按 kind 校验必填字段，缺字段直接报错且不落盘", async () => {
    const create = byName(await freshTools(), "data.create");
    await expect(create.execute({ kind: "snippets", draft: { content: "只有内容" } })).rejects.toThrow(/缺少必填字段：title/);
    await expect(create.execute({ kind: "iterations", draft: { title: "缺版本" } })).rejects.toThrow(/缺少必填字段：version/);
    await expect(create.execute({ kind: "pools", draft: { name: "缺领域" } })).rejects.toThrow(/缺少必填字段：domainId/);
    expect(store.size).toBe(0);
  });

  it("id/时间戳由仓库生成，draft 里的同名字段被忽略", async () => {
    const create = byName(await freshTools(), "data.create");
    const { id, record } = await create.execute({
      kind: "snippets",
      draft: { id: "hack", createdAt: 1, updatedAt: 2, title: "新速记", content: "x" },
    });
    expect(id).not.toBe("hack");
    expect(record.createdAt).not.toBe(1);
    expect(store.get("snippets")).toHaveLength(1);
    expect(store.get("snippets")[0]).toMatchObject({ id, title: "新速记", content: "x" });
  });

  it("超大 draft 被拒绝（模型可能塞进超长内容）", async () => {
    const create = byName(await freshTools(), "data.create");
    await expect(create.execute({ kind: "snippets", draft: { title: "x", content: "c".repeat(20000) } })).rejects.toThrow(/过大/);
    await expect(create.execute({ kind: "snippets", draft: "文本" })).rejects.toThrow(/必须是字段对象/);
  });

  it("枚举外的取值被拒绝且不落盘，合法取值放行", async () => {
    const create = byName(await freshTools(), "data.create");
    await expect(create.execute({ kind: "problems", draft: { title: "脏类型", type: "线上" } })).rejects.toThrow(/problems.type 只能是/);
    await expect(create.execute({ kind: "problems", draft: { title: "脏状态", status: "resolved" } })).rejects.toThrow(/problems.status 只能是/);
    await expect(create.execute({ kind: "iterations", draft: { title: "迭代", version: "1.0", status: "进行中" } })).rejects.toThrow(/iterations.status 只能是/);
    expect(store.size).toBe(0);

    await create.execute({ kind: "problems", draft: { title: "正常", type: "online", status: "open" } });
    await create.execute({ kind: "iterations", draft: { title: "迭代", version: "1.0", status: "dev" } });
    expect(store.get("problems")[0]).toMatchObject({ type: "online", status: "open" });
    expect(store.get("iterations")[0].status).toBe("dev");
  });

  it("新建 sync 类记录后入队云同步", async () => {
    const create = byName(await freshTools(), "data.create");
    await create.execute({ kind: "problems", draft: { title: "线上 500", status: "open" } });
    await vi.waitFor(() => expect(syncMock.enqueueSync).toHaveBeenCalledWith(["problems"]));
  });
});

describe("data.update", () => {
  it("白名单外的字段被拒绝，整条 patch 不落盘", async () => {
    store.set("problems", [{ id: "p1", title: "线上 500", status: "open", updatedAt: 1 }]);
    const update = byName(await freshTools(), "data.update");
    await expect(update.execute({ kind: "problems", id: "p1", patch: { images: ["a.png"] } })).rejects.toThrow(/不可修改字段：images/);
    await expect(update.execute({ kind: "problems", id: "p1", patch: { status: "open", title: "改" } })).resolves.toBeTruthy();
    expect(store.get("problems")[0].images).toBeUndefined();
  });

  it("更新成功：字段生效、updatedAt 刷新、返回更新后记录", async () => {
    store.set("problems", [{ id: "p1", title: "线上 500", status: "open", updatedAt: 1 }]);
    const update = byName(await freshTools(), "data.update");
    const { record } = await update.execute({ kind: "problems", id: "p1", patch: { status: "done", resolution: "已发布补丁" } });
    expect(record).toMatchObject({ id: "p1", status: "done", resolution: "已发布补丁" });
    expect(record.updatedAt).toBeGreaterThan(1);
    expect(store.get("problems")[0].status).toBe("done");
  });

  it("空 patch 与不存在的 id 都报错", async () => {
    store.set("problems", [{ id: "p1", title: "线上 500", updatedAt: 1 }]);
    const update = byName(await freshTools(), "data.update");
    await expect(update.execute({ kind: "problems", id: "p1", patch: { id: "x", updatedAt: 9 } })).rejects.toThrow(/patch 为空/);
    await expect(update.execute({ kind: "problems", id: "missing", patch: { title: "x" } })).rejects.toThrow(/记录不存在/);
  });

  it("枚举外的取值被拒绝（视图用取值表直接索引，脏值会让界面渲染抛异常）", async () => {
    store.set("problems", [{ id: "p1", title: "线上 500", status: "open", type: "online", updatedAt: 1 }]);
    store.set("iterations", [{ id: "it1", title: "迭代", version: "1.0", status: "plan", updatedAt: 1 }]);
    const update = byName(await freshTools(), "data.update");
    await expect(update.execute({ kind: "problems", id: "p1", patch: { status: "resolved" } })).rejects.toThrow(/problems.status 只能是：open、done（收到：resolved）/);
    await expect(update.execute({ kind: "problems", id: "p1", patch: { type: "线上" } })).rejects.toThrow(/problems.type 只能是/);
    await expect(update.execute({ kind: "iterations", id: "it1", patch: { status: "doing" } })).rejects.toThrow(/iterations.status 只能是：plan、dev、test、pending、live/);
    expect(store.get("problems")[0]).toMatchObject({ status: "open", type: "online" });
    expect(store.get("iterations")[0].status).toBe("plan");

    await expect(update.execute({ kind: "problems", id: "p1", patch: { status: "done", type: "other" } })).resolves.toBeTruthy();
    await expect(update.execute({ kind: "iterations", id: "it1", patch: { status: "live" } })).resolves.toBeTruthy();
  });
});

describe("data.remove", () => {
  it("删除记录并写墓碑（速记/问题的跨端删除据此传播）", async () => {
    store.set("snippets", [{ id: "s1", title: "旧", updatedAt: 1 }]);
    const remove = byName(await freshTools(), "data.remove");
    await expect(remove.execute({ kind: "snippets", id: "s1" })).resolves.toEqual({ kind: "snippets", id: "s1", removed: true });
    expect(store.get("snippets")).toEqual([]);
    expect(syncMock.markTombstone).toHaveBeenCalledWith("s1", expect.any(Number));
  });

  it("不存在的 id 报错", async () => {
    const remove = byName(await freshTools(), "data.remove");
    await expect(remove.execute({ kind: "snippets", id: "missing" })).rejects.toThrow(/记录不存在/);
  });
});

describe("确认策略：data.remove 强制确认", () => {
  const plannerRemove = (id) => async ({ history }) => {
    const done = history.some((h) => h.result || h.error);
    return done ? { type: "final", answer: "完成" } : { type: "tool_call", tool: "data.remove", args: { kind: "problems", id } };
  };

  it("用户选择「从不确认」时，删除仍弹确认；拒绝则记录保留", async () => {
    store.set("problems", [{ id: "p1", title: "线上 500", updatedAt: 1 }]);
    const { createToolRegistry, runAgent } = await import("./runtime.js");
    const registry = createToolRegistry(await freshTools());
    const confirm = vi.fn(async () => false);
    const run = await runAgent("删掉那条问题", { registry, planner: plannerRemove("p1"), requireConfirmation: "never", confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
    // 拒绝不取消整个目标：拒绝作为反馈回灌，模型改用 final 收尾；删除从未执行
    expect(run.status).toBe("completed");
    expect(run.answer).toBe("完成");
    expect(store.get("problems")).toHaveLength(1);
    expect(syncMock.markTombstone).not.toHaveBeenCalled();
  });

  it("确认后执行删除", async () => {
    store.set("problems", [{ id: "p1", title: "线上 500", updatedAt: 1 }]);
    const { createToolRegistry, runAgent } = await import("./runtime.js");
    const registry = createToolRegistry(await freshTools());
    const run = await runAgent("删掉那条问题", {
      registry,
      planner: plannerRemove("p1"),
      requireConfirmation: "never",
      confirm: async () => true,
    });
    expect(run.status).toBe("completed");
    expect(store.get("problems")).toEqual([]);
    expect(syncMock.markTombstone).toHaveBeenCalledWith("p1", expect.any(Number));
  });

  it("普通写工具仍服从「从不确认」策略（强制确认只给 data.remove）", async () => {
    const { createToolRegistry, runAgent } = await import("./runtime.js");
    const registry = createToolRegistry(await freshTools());
    const confirm = vi.fn(async () => true);
    const planner = async ({ history }) => (history.some((h) => h.result)
      ? { type: "final", answer: "完成" }
      : { type: "tool_call", tool: "data.create", args: { kind: "snippets", draft: { title: "会议纪要" } } });
    const run = await runAgent("记一条速记", { registry, planner, requireConfirmation: "never", confirm });
    expect(confirm).not.toHaveBeenCalled();
    expect(run.status).toBe("completed");
    expect(store.get("snippets")[0].title).toBe("会议纪要");
  });
});

describe("验收：Agent 用数据工具回答业务问题", () => {
  it("「我有几个未完成的线上问题」与「最近三条速记是什么」", async () => {
    store.set("problems", [
      { id: "p1", title: "登录 500", status: "open", updatedAt: 10 },
      { id: "p2", title: "超时", status: "open", updatedAt: 20 },
      { id: "p3", title: "已修复", status: "done", updatedAt: 30 },
      { id: "p4", title: "缓存穿透", status: "open", updatedAt: 40 },
    ]);
    store.set("snippets", [
      { id: "s1", title: "最早", updatedAt: 100 },
      { id: "s2", title: "第二", updatedAt: 200 },
      { id: "s3", title: "第三", updatedAt: 300 },
      { id: "s4", title: "最新", updatedAt: 400 },
    ]);
    const { createToolRegistry, runAgent } = await import("./runtime.js");
    const registry = createToolRegistry(await freshTools());
    // 确定性规划器：第一步调 data.query，第二步把结果原样作为答案（不依赖模型）
    const plannerFor = (args) => async ({ history }) => {
      const last = [...history].reverse().find((h) => h.result);
      if (!last) return { type: "tool_call", tool: "data.query", args };
      return { type: "final", answer: JSON.stringify(last.result) };
    };

    const problems = await runAgent("我有几个未完成的线上问题", {
      registry,
      planner: plannerFor({ kind: "problems", status: "open" }),
    });
    expect(problems.status).toBe("completed");
    const p = JSON.parse(problems.answer);
    expect(p.total).toBe(3);
    expect(p.items.map((x) => x.title)).toEqual(["缓存穿透", "超时", "登录 500"]);

    const snippets = await runAgent("最近三条速记是什么", {
      registry,
      planner: plannerFor({ kind: "snippets", limit: 3 }),
    });
    const s = JSON.parse(snippets.answer);
    expect(s.total).toBe(4);
    expect(s.items.map((x) => x.title)).toEqual(["最新", "第三", "第二"]);
  });
});
