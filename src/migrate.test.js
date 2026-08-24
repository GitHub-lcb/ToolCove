// migrate.js 纯转换函数单测：结构升级 + 幂等性
import { describe, it, expect } from "vitest";
import { migrateIterationsV1, migrateIterationsV2, migrateIterationsV3, migrateIterationsV4, migrateSnippetsV3, migrateSnippetsV4, migrateProblemsV1, migrateReleasesV1, migrateLegacyProjectToPools, SCHEMA_VERSION } from "./migrate.js";

describe("SCHEMA_VERSION", () => {
  it("是正整数", () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });
});

describe("migrateIterationsV1", () => {
  it("domainId 单值转 domainIds 数组并清理旧字段", () => {
    const its = [{ id: "1", title: "迭代", domainId: "d1", items: [] }];
    migrateIterationsV1(its);
    expect(its[0].domainIds).toEqual(["d1"]);
    expect("domainId" in its[0]).toBe(false);
  });

  it("补齐 docs / items 内 url·subtasks·logs·questions / subtask 内 url·code", () => {
    const its = [
      {
        id: "1",
        title: "迭代",
        items: [{ name: "需求", subtasks: [{ name: "子", hours: 1 }] }],
      },
    ];
    migrateIterationsV1(its);
    const it = its[0];
    expect(it.docs).toEqual([]);
    expect(it.domainIds).toEqual([]);
    const r = it.items[0];
    expect(r.url).toBe("");
    expect(Array.isArray(r.logs)).toBe(true);
    expect(Array.isArray(r.questions)).toBe(true);
    expect(r.subtasks[0].url).toBe("");
    expect(r.subtasks[0].code).toBe("");
  });

  it("幂等：已是新结构时二次执行不变", () => {
    const its = [{ id: "1", title: "迭代", domainIds: ["d1"], docs: [], items: [] }];
    migrateIterationsV1(its);
    const once = JSON.stringify(its);
    migrateIterationsV1(its);
    expect(JSON.stringify(its)).toBe(once);
  });

  it("非数组原样返回", () => {
    expect(migrateIterationsV1(null)).toBeNull();
  });
});

describe("migrateIterationsV2", () => {
  it("待确认问题补 images 数组", () => {
    const its = [
      {
        id: "1",
        title: "迭代",
        items: [{ name: "需求", questions: [{ id: "q1", text: "问题", status: "open" }] }],
      },
    ];
    migrateIterationsV2(its);
    expect(its[0].items[0].questions[0].images).toEqual([]);
  });

  it("幂等：已有 images 时不动", () => {
    const its = [
      {
        id: "1",
        title: "迭代",
        items: [{ name: "需求", questions: [{ id: "q1", text: "问题", images: [{ id: "i1", name: "a.png" }] }] }],
      },
    ];
    migrateIterationsV2(its);
    const once = JSON.stringify(its);
    migrateIterationsV2(its);
    expect(JSON.stringify(its)).toBe(once);
    expect(its[0].items[0].questions[0].images).toHaveLength(1);
  });

  it("非数组原样返回", () => {
    expect(migrateIterationsV2(null)).toBeNull();
  });
});

describe("migrateIterationsV3", () => {
  it("需求补 bugs 数组", () => {
    const its = [{ id: "1", title: "迭代", items: [{ name: "需求" }] }];
    migrateIterationsV3(its);
    expect(its[0].items[0].bugs).toEqual([]);
  });
  it("幂等：已有 bugs 时不动", () => {
    const its = [{ id: "1", title: "迭代", items: [{ name: "需求", bugs: [{ id: "b1", url: "x" }] }] }];
    migrateIterationsV3(its);
    const once = JSON.stringify(its);
    migrateIterationsV3(its);
    expect(JSON.stringify(its)).toBe(once);
    expect(its[0].items[0].bugs).toHaveLength(1);
  });
  it("非数组原样返回", () => {
    expect(migrateIterationsV3(null)).toBeNull();
  });
});

describe("migrateIterationsV4", () => {
  it("需求补预估人天，保留有效值", () => {
    const its = [{ items: [{ name: "未评估" }, { name: "已评估", estimateDays: "12.5" }] }];
    migrateIterationsV4(its);
    expect(its[0].items[0].estimateDays).toBeNull();
    expect(its[0].items[1].estimateDays).toBe(12.5);
  });

  it("无效值归一为空且迁移幂等", () => {
    const its = [{ items: [{ estimateDays: 0 }, { estimateDays: -1 }] }];
    migrateIterationsV4(its);
    const once = JSON.stringify(its);
    migrateIterationsV4(its);
    expect(JSON.stringify(its)).toBe(once);
    expect(its[0].items.every((r) => r.estimateDays === null)).toBe(true);
  });
});

describe("migrateSnippetsV3", () => {
  it("速记补 images 数组", () => {
    const ss = [{ id: "1", title: "速记", content: "select 1" }];
    migrateSnippetsV3(ss);
    expect(ss[0].images).toEqual([]);
  });

  it("幂等：已有 images 时不动", () => {
    const ss = [{ id: "1", title: "速记", content: "", images: [{ id: "i1", name: "a.png" }] }];
    migrateSnippetsV3(ss);
    const once = JSON.stringify(ss);
    migrateSnippetsV3(ss);
    expect(JSON.stringify(ss)).toBe(once);
    expect(ss[0].images).toHaveLength(1);
  });

  it("非数组原样返回", () => {
    expect(migrateSnippetsV3(null)).toBeNull();
  });
});

describe("migrateSnippetsV4", () => {
  it("速记补 fields 数组", () => {
    const ss = [{ id: "1", title: "速记", content: "select 1" }];
    migrateSnippetsV4(ss);
    expect(ss[0].fields).toEqual([]);
  });

  it("幂等：已有 fields 时不动", () => {
    const ss = [{ id: "1", title: "速记", content: "账号: a", fields: [{ id: "f1", label: "账号", value: "a" }] }];
    migrateSnippetsV4(ss);
    const once = JSON.stringify(ss);
    migrateSnippetsV4(ss);
    expect(JSON.stringify(ss)).toBe(once);
    expect(ss[0].fields).toHaveLength(1);
  });

  it("非数组原样返回", () => {
    expect(migrateSnippetsV4(null)).toBeNull();
  });
});

describe("migrateProblemsV1", () => {
  it("补齐数组字段与 resolution", () => {
    const ps = [{ id: "1", title: "问题" }];
    migrateProblemsV1(ps);
    expect(ps[0].logs).toEqual([]);
    expect(ps[0].images).toEqual([]);
    expect(ps[0].domainIds).toEqual([]);
    expect(ps[0].resolution).toBe("");
  });

  it("幂等", () => {
    const ps = [{ id: "1", title: "问题", logs: [{ date: "2026-07-20", hours: 1 }], images: [], domainIds: ["d1"], resolution: "已修复" }];
    migrateProblemsV1(ps);
    const once = JSON.stringify(ps);
    migrateProblemsV1(ps);
    expect(JSON.stringify(ps)).toBe(once);
  });
});

describe("migrateReleasesV1", () => {
  it("旧 pools 转 items 并移除旧字段", () => {
    const rs = [{ id: "1", pools: [{ name: "poolA", note: "备注", done: true }] }];
    migrateReleasesV1(rs);
    expect("pools" in rs[0]).toBe(false);
    expect(rs[0].items).toHaveLength(1);
    expect(rs[0].items[0]).toMatchObject({ kind: "pool", name: "poolA", note: "备注", done: true, value: "" });
    expect(typeof rs[0].items[0].id).toBe("string");
  });

  it("已有 items 时不动", () => {
    const rs = [{ id: "1", items: [{ id: "x", kind: "sql", name: "脚本", value: "select 1", note: "", done: false }] }];
    migrateReleasesV1(rs);
    expect(rs[0].items).toHaveLength(1);
    expect(rs[0].items[0].kind).toBe("sql");
  });

  it("幂等：二次执行 items 数量不变", () => {
    const rs = [{ id: "1", pools: [{ name: "poolA" }] }];
    migrateReleasesV1(rs);
    const len = rs[0].items.length;
    migrateReleasesV1(rs);
    expect(rs[0].items.length).toBe(len);
  });
});

describe("migrateLegacyProjectToPools", () => {
  it("领域 codingProject 复制给其下未填的 Pool，已填 Pool 不被覆盖", () => {
    const domains = [{ id: "d1", name: "云仓", codingProject: "ops-yuncang" }];
    const pools = [
      { id: "p1", domainId: "d1", name: "warehouse.api" },
      { id: "p2", domainId: "d1", name: "online.api", codingProject: "ops-online" },
      { id: "p3", domainId: "d2", name: "other.api" },
    ];
    migrateLegacyProjectToPools(domains, pools);
    expect(pools[0].codingProject).toBe("ops-yuncang");
    expect(pools[1].codingProject).toBe("ops-online");
    expect(pools[2].codingProject).toBeUndefined();
  });

  it("从领域删除 codingProject 字段", () => {
    const domains = [{ id: "d1", name: "云仓", codingProject: "ops-yuncang" }];
    migrateLegacyProjectToPools(domains, []);
    expect("codingProject" in domains[0]).toBe(false);
  });

  it("幂等：二次执行结果不变", () => {
    const domains = [{ id: "d1", name: "云仓", codingProject: "ops-yuncang" }];
    const pools = [{ id: "p1", domainId: "d1", name: "warehouse.api" }];
    migrateLegacyProjectToPools(domains, pools);
    const once = JSON.stringify([domains, pools]);
    migrateLegacyProjectToPools(domains, pools);
    expect(JSON.stringify([domains, pools])).toBe(once);
  });

  it("非数组原样返回", () => {
    const out = migrateLegacyProjectToPools(null, null);
    expect(out).toEqual([null, null]);
  });
});
