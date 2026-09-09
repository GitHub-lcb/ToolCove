import { describe, it, expect } from "vitest";
import {
  AGENT_FEATURE,
  FREE_LIMITS,
  PRO_LIMITS,
  FREE_MAX_STEPS,
  PRO_RISK_LEVELS,
  resolveLimits,
  resolveRunOptions,
  buildAgentRegistry,
  listAgentTools,
  isProRisk,
} from "./entitlements.js";
import { AGENT_TOOL_NAMES } from "./builtins.js";
import { FREE_DAILY_RUNS, FREE_DAILY_STEPS } from "./quota.js";

const FREE_STATUS = { pro: false };
const PRO_STATUS = { pro: true, features: [AGENT_FEATURE] };
const ALL = AGENT_TOOL_NAMES.length; // 14
// 按风险级别派生，而不是写死工具名：将来新增写入类工具时这条断言自动跟上
const WRITES = listAgentTools(PRO_STATUS, {}).filter((t) => t.risk === "write").map((t) => t.name);

describe("resolveLimits：授权态 → 额度", () => {
  it("只有 features 里含 agent-pro 才算 Pro，pro:true 本身不够", () => {
    expect(resolveLimits(PRO_STATUS)).toBe(PRO_LIMITS);
    expect(resolveLimits({ pro: true, features: ["cloud-sync"] })).toBe(FREE_LIMITS);
    expect(resolveLimits(FREE_STATUS)).toBe(FREE_LIMITS);
    expect(resolveLimits(null)).toBe(FREE_LIMITS);
    expect(resolveLimits(undefined)).toBe(FREE_LIMITS);
  });

  it("免费档有次数/步数上限且锁写入，Pro 档无限制且不锁", () => {
    expect(FREE_LIMITS).toEqual(expect.objectContaining({
      pro: false, dailyRuns: FREE_DAILY_RUNS, dailySteps: FREE_DAILY_STEPS,
      maxSteps: FREE_MAX_STEPS, proRisks: PRO_RISK_LEVELS,
    }));
    expect(FREE_LIMITS.confirmPolicies).not.toContain("never");
    expect(PRO_LIMITS.dailyRuns).toBe(Infinity);
    expect(PRO_LIMITS.dailySteps).toBe(Infinity);
    expect(PRO_LIMITS.proRisks).toEqual([]);
    expect(PRO_LIMITS.confirmPolicies).toContain("never");
    expect(PRO_RISK_LEVELS).toEqual(["write"]);
    expect(isProRisk("write")).toBe(true);
    expect(isProRisk("database")).toBe(false);
  });
});

describe("层 1 能力移除：免费档 registry 里根本没有写入工具", () => {
  it("免费 13 个工具且不含 file.write_text，Pro 14 个全在", () => {
    const free = buildAgentRegistry({}, () => FREE_STATUS);
    const pro = buildAgentRegistry({}, () => PRO_STATUS);
    expect(ALL).toBe(14);
    expect(WRITES).toEqual(["file.write_text"]);
    expect(free.list()).toHaveLength(ALL - WRITES.length);
    expect(pro.list()).toHaveLength(ALL);
    expect(free.get("file.write_text")).toBeUndefined();
    expect(pro.get("file.write_text")).toBeDefined();
    // list() 是 planner prompt 的唯一工具来源，所以模型在免费档无从提议写入
    expect(free.list().some((t) => t.name === "file.write_text")).toBe(false);
    // 免费能力不被削弱：读取/转换/数据库全在
    for (const name of ["file.read_text", "file.preview_write", "db.query_readonly", "json.format"]) {
      expect(free.get(name)).toBeDefined();
    }
  });

  it("用户停用清单精确移除指定工具", () => {
    const reg = buildAgentRegistry({ disabledTools: ["json.parse"] }, () => PRO_STATUS);
    expect(reg.list()).toHaveLength(ALL - 1);
    expect(reg.get("json.parse")).toBeUndefined();
    expect(reg.get("json.format")).toBeDefined();
  });

  it("停用清单里的未知工具名被忽略（不减少可用能力）", () => {
    const reg = buildAgentRegistry({ disabledTools: ["nope", "rm -rf"] }, () => PRO_STATUS);
    expect(reg.list()).toHaveLength(ALL);
  });

  it("cfg 非法时退回默认配置", () => {
    expect(buildAgentRegistry(null, () => PRO_STATUS).list()).toHaveLength(ALL);
    expect(buildAgentRegistry(undefined, undefined).list()).toHaveLength(ALL - WRITES.length);
  });

  it("getStatus 抛异常按免费处理（fail closed）", () => {
    const reg = buildAgentRegistry({}, () => { throw Error("boom"); });
    expect(reg.get("file.write_text")).toBeUndefined();
  });
});

describe("层 2 调用时复检：运行途中停用授权", () => {
  it("Pro 建的 registry 在授权翻成免费后抛 FORBIDDEN，且不产生副作用", async () => {
    let status = PRO_STATUS;
    const reg = buildAgentRegistry({}, () => status);
    const write = reg.get("file.write_text");
    expect(write).toBeDefined();
    status = FREE_STATUS; // 用户在另一个窗口停用了授权
    await expect(write.execute({ path: "C:/tmp/x.txt", text: "hi" }, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("授权仍在时门禁放行（之后的失败来自桌面 IPC 不可用，与门禁无关）", async () => {
    const reg = buildAgentRegistry({}, () => PRO_STATUS);
    const err = await reg.get("file.write_text").execute({ path: "C:/tmp/x.txt", text: "hi" }, {}).then(() => null, (e) => e);
    expect(err).toBeTruthy();
    expect(err.code).not.toBe("FORBIDDEN");
  });

  it("免费风险工具不被包装，授权态无关", async () => {
    const reg = buildAgentRegistry({}, () => FREE_STATUS);
    expect(await reg.get("json.parse").execute({ text: '{"a":1}' })).toEqual({ a: 1 });
  });
});

describe("层 3 参数钳制：settings.agent 永不信任", () => {
  it("免费档把 maxSteps 钳到 8，即使设置里写了 50", () => {
    expect(resolveRunOptions({ maxSteps: 50 }, FREE_LIMITS).maxSteps).toBe(FREE_MAX_STEPS);
    expect(resolveRunOptions({ maxSteps: 3 }, FREE_LIMITS).maxSteps).toBe(3);
    expect(resolveRunOptions({ maxSteps: 50 }, PRO_LIMITS).maxSteps).toBe(50);
    expect(resolveRunOptions({ maxSteps: 999 }, PRO_LIMITS).maxSteps).toBe(PRO_LIMITS.maxSteps);
  });

  it("免费档把「从不确认」降级为「危险才确认」，always 保留", () => {
    expect(resolveRunOptions({ requireConfirmation: "never" }, FREE_LIMITS).requireConfirmation).toBe("risky");
    expect(resolveRunOptions({ requireConfirmation: "always" }, FREE_LIMITS).requireConfirmation).toBe("always");
    expect(resolveRunOptions({ requireConfirmation: "never" }, PRO_LIMITS).requireConfirmation).toBe("never");
    expect(resolveRunOptions({ requireConfirmation: "risky" }, PRO_LIMITS).requireConfirmation).toBe("risky");
  });

  it("缺失或非法设置值落回默认（12 步 / 1 次重试 / risky）", () => {
    expect(resolveRunOptions(undefined, FREE_LIMITS)).toEqual({ maxSteps: FREE_MAX_STEPS, retries: 1, requireConfirmation: "risky" });
    expect(resolveRunOptions({}, PRO_LIMITS)).toEqual({ maxSteps: 12, retries: 1, requireConfirmation: "risky" });
    expect(resolveRunOptions({ maxSteps: "50", retries: -2, requireConfirmation: "yolo" }, FREE_LIMITS))
      .toEqual({ maxSteps: FREE_MAX_STEPS, retries: 1, requireConfirmation: "risky" });
  });

  it("重试次数钳到 3", () => {
    expect(resolveRunOptions({ retries: 99 }, PRO_LIMITS).retries).toBe(3);
    expect(resolveRunOptions({ retries: 0 }, PRO_LIMITS).retries).toBe(0);
  });

  it("limits 非法时按免费档钳制", () => {
    expect(resolveRunOptions({ maxSteps: 50, requireConfirmation: "never" }, null).maxSteps).toBe(FREE_MAX_STEPS);
    expect(resolveRunOptions({ requireConfirmation: "never" }, {}).requireConfirmation).toBe("risky");
  });
});

describe("listAgentTools：能力面板数据源", () => {
  it("始终返回全部工具，locked 由授权态决定、enabled 由用户开关决定", () => {
    const free = listAgentTools(FREE_STATUS, {});
    const pro = listAgentTools(PRO_STATUS, { disabledTools: ["json.parse"] });
    expect(free).toHaveLength(ALL);
    expect(pro).toHaveLength(ALL);
    expect(free.filter((t) => t.locked).map((t) => t.name)).toEqual(WRITES);
    expect(pro.filter((t) => t.locked)).toEqual([]);
    expect(pro.find((t) => t.name === "json.parse").enabled).toBe(false);
    expect(pro.find((t) => t.name === "json.format").enabled).toBe(true);
  });

  it("每行都带 UI 需要的风险、本地化描述键与工具箱联动键", () => {
    for (const row of listAgentTools(PRO_STATUS, {})) {
      expect(["read", "transform", "write", "database"]).toContain(row.risk);
      expect(row.descriptionKey).toMatch(/^agent\.tool/);
      expect(row.toolKey).toBeTruthy();
    }
    expect(listAgentTools(PRO_STATUS, {}).find((t) => t.name === "db.query_readonly").toolKey).toBe("db");
  });

  it("cfg 非法时全部视为启用", () => {
    expect(listAgentTools(null, null).every((t) => t.enabled)).toBe(true);
  });
});
