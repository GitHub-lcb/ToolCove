import { describe, expect, it } from "vitest";
import { APPROVAL_MODES, canonicalJson, collapseKey, createApprovalPolicy, evaluate, normalizeMode } from "./approval.js";

const tool = (over = {}) => ({ name: "file.write_text", risk: "write", ...over });

describe("normalizeMode", () => {
  it("三种合法策略原样通过", () => {
    for (const mode of APPROVAL_MODES) expect(normalizeMode(mode)).toBe(mode);
  });

  it("脏值（用户手改 settings）一律落回 risky", () => {
    for (const mode of [undefined, null, "", "yolo", "ALWAYS", 1, {}]) expect(normalizeMode(mode)).toBe("risky");
  });
});

describe("canonicalJson / collapseKey", () => {
  it("键序不同视为同一份参数（JSON.stringify 会算成两个键，等于没折叠）", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(collapseKey("t", { a: 1, b: 2 })).toBe(collapseKey("t", { b: 2, a: 1 }));
  });

  it("数组顺序保留：语义上有序，[1,2] 与 [2,1] 是不同参数", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("嵌套对象的键也递归排序", () => {
    expect(collapseKey("t", { o: { x: 1, y: 2 } })).toBe(collapseKey("t", { o: { y: 2, x: 1 } }));
  });

  it("循环引用不抛错（算不出折叠键不该让工具调用失败）", () => {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).not.toThrow();
    expect(canonicalJson(cyclic)).toContain("circular");
  });

  it("工具名不同则折叠键不同", () => {
    expect(collapseKey("a", {})).not.toBe(collapseKey("b", {}));
  });

  // 折叠键决定「要不要问人」，所以**不同参数绝不能撞成同一个键**——撞了就等于误放行。
  // 下面每组都曾是真实碰撞：JSON.stringify 会把它们压成同一个串。
  describe("不碰撞（碰撞的代价是误放行）", () => {
    it("undefined 不能与键缺失或 null 混同", () => {
      // JSON.stringify 会省略 undefined 属性 → {x:undefined} 与 {} 撞键
      expect(canonicalJson({ x: undefined })).not.toBe(canonicalJson({}));
      expect(canonicalJson({ x: undefined })).not.toBe(canonicalJson({ x: null }));
    });

    it("NaN / Infinity 不能退化成 null", () => {
      // JSON.stringify(NaN) === "null" 且 JSON.stringify(null) === "null"
      expect(canonicalJson({ x: NaN })).not.toBe(canonicalJson({ x: null }));
      expect(canonicalJson({ x: Infinity })).not.toBe(canonicalJson({ x: null }));
      expect(canonicalJson({ x: Infinity })).not.toBe(canonicalJson({ x: -Infinity }));
    });

    it("两个不同 Date 不能撞键（JSON.stringify 会把它们都压成 {}）", () => {
      expect(canonicalJson({ d: new Date(0) })).not.toBe(canonicalJson({ d: new Date(1000) }));
      expect(canonicalJson({ d: new Date(0) })).not.toBe(canonicalJson({ d: {} }));
    });

    it("false / 0 / 空串各不相同", () => {
      const keys = [false, 0, "", null, undefined].map((v) => canonicalJson({ x: v }));
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("共享引用（非循环）按值各自展开，不误报 circular", () => {
      const shared = { x: 1 };
      const out = canonicalJson({ a: shared, b: shared });
      expect(out).not.toContain("circular");
      expect(out).toBe(canonicalJson({ a: { x: 1 }, b: { x: 1 } }));
    });
  });
});

describe("evaluate 三档策略", () => {
  const policy = (mode) => createApprovalPolicy({ mode });

  it("risky：写类要问，只读/转换不问", () => {
    const p = policy("risky");
    expect(p.decide(tool(), {}).ask).toBe(true);
    expect(p.decide(tool(), {}).reason).toBe("risky-write");
    expect(p.decide({ name: "json.parse", risk: "transform" }, {}).ask).toBe(false);
    expect(p.decide({ name: "file.read_text", risk: "read" }, {}).ask).toBe(false);
    expect(p.decide({ name: "db.query_readonly", risk: "database" }, {}).ask).toBe(true);
  });

  it("always：连只读工具也要问", () => {
    expect(policy("always").decide({ name: "json.parse", risk: "transform" }, {}).ask).toBe(true);
  });

  it("never：一概不问", () => {
    expect(policy("never").decide(tool(), {}).ask).toBe(false);
    expect(policy("never").decide(tool(), {}).reason).toBe("mode-never");
  });

  it("confirm === 'always' 的工具不受 never 影响", () => {
    const remove = { name: "data.remove", risk: "write", confirm: "always" };
    expect(policy("never").decide(remove, {}).ask).toBe(true);
    expect(policy("never").decide(remove, {}).reason).toBe("always-confirm");
  });

  it("非法模式按 risky 处理", () => {
    expect(policy("yolo").mode).toBe("risky");
    expect(policy("yolo").decide(tool(), {}).ask).toBe(true);
  });

  it("缺 tool 时不问，也不崩", () => {
    expect(evaluate({ mode: "risky", isApproved: () => false }, null, {}).ask).toBe(false);
  });
});

describe("逐次批准的记账", () => {
  it("批准后只有同工具同参数被折叠，换参数要重新问", () => {
    const p = createApprovalPolicy({ mode: "risky" });
    const t = tool();
    const first = p.decide(t, { path: "a.txt" });
    expect(first.ask).toBe(true);
    p.record(first.collapseKey, true);

    // 同工具同参数：沿用上一次批准，且来源标成 human（这不是「策略放行」）
    const repeat = p.decide(t, { path: "a.txt" });
    expect(repeat.ask).toBe(false);
    expect(repeat.reason).toBe("repeated-call");
    expect(repeat.source).toBe("human");

    // 同工具换参数：必须重新问 —— 旧实现这里会直接放行，是本次改造的核心
    expect(p.decide(t, { path: "b.txt" }).ask).toBe(true);
  });

  it("被拒绝的调用记账为拒绝，同一调用不再追问", () => {
    const p = createApprovalPolicy({ mode: "risky" });
    const t = tool();
    const d = p.decide(t, { path: "a.txt" });
    expect(d.ask).toBe(true);
    p.record(d.collapseKey, false);

    const repeat = p.decide(t, { path: "a.txt" });
    expect(repeat.ask).toBe(false);
    expect(repeat.reason).toBe("denied-before");
    expect(p.isDenied(d.collapseKey)).toBe(true);
    expect(p.deniedCount).toBe(1);

    // 换参数是另一次调用，仍然要问
    expect(p.decide(t, { path: "b.txt" }).ask).toBe(true);
  });

  it("denied-before 优先于 confirm:'always'，被拒的删除不会拿同一张卡反复追问", () => {
    const p = createApprovalPolicy({ mode: "never" });
    const remove = { name: "data.remove", risk: "write", confirm: "always" };
    const first = p.decide(remove, {});
    expect(first.reason).toBe("always-confirm");
    p.record(first.collapseKey, false);
    expect(p.decide(remove, {}).reason).toBe("denied-before");
  });

  it("record 空键是 no-op，不会污染计数", () => {
    const p = createApprovalPolicy({ mode: "risky" });
    p.record("", true);
    p.record("", false);
    expect(p.approvedCount).toBe(0);
    expect(p.deniedCount).toBe(0);
  });

  it("always 模式下同参数也折叠，避免对着同一个卡片反复点", () => {
    const p = createApprovalPolicy({ mode: "always" });
    const t = { name: "json.parse", risk: "transform" };
    const d = p.decide(t, { text: "{}" });
    expect(d.ask).toBe(true);
    p.record(d.collapseKey, true);
    expect(p.decide(t, { text: "{}" }).reason).toBe("repeated-call");
    expect(p.decide(t, { text: "{a:1}" }).ask).toBe(true);
  });

  it("approvedCount 反映已折叠数量", () => {
    const p = createApprovalPolicy({ mode: "risky" });
    expect(p.approvedCount).toBe(0);
    p.record("k", true);
    expect(p.approvedCount).toBe(1);
  });
});