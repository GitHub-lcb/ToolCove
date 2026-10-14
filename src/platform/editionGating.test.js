// 版本门禁：Node 测试环境默认无 __TOOLCOVE_EDITION__（按个人版处理），这里显式 stub 出
// 企业版态，验证 scope 为 personal 的工具被正确过滤——与 browserGating 的平台维度同构。
import { afterEach, describe, expect, it, vi } from "vitest";

// 注册表在导入时即读取 edition，必须 resetModules 后重新动态导入才能拿到另一版本分支
function stubEdition(value) {
  vi.resetModules();
  vi.stubGlobal("__TOOLCOVE_EDITION__", value);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// 个人版独占工具（契约 scope 标注，取值合法性由 contracts.test.js 强制）
const PERSONAL_TOOLS = ["rail", "interview", "checkin", "photo", "label"];
// 两个版本都可见的通用工具
const BOTH_TOOLS = ["json", "convert", "db"];

describe("版本判定", () => {
  it("无钩子时默认个人版", async () => {
    const env = await import("./env.js");
    expect(env.edition).toBe("personal");
    expect(env.isEnterprise).toBe(false);
  });

  it("stub __TOOLCOVE_EDITION__ 后判定为企业版", async () => {
    stubEdition("enterprise");
    const env = await import("./env.js");
    expect(env.edition).toBe("enterprise");
    expect(env.isEnterprise).toBe(true);
  });

  it("inEdition 判据：个人版隐藏 enterprise 独占，企业版隐藏 personal 独占，both 两边都见", async () => {
    let env = await import("./env.js");
    expect(env.inEdition("personal")).toBe(true);
    expect(env.inEdition("both")).toBe(true);
    expect(env.inEdition("enterprise")).toBe(false);
    // 引擎/业务数据动作（toolKey 为 agent/data）不属于任何工具契约，scope 缺省按可见处理
    expect(env.inEdition(undefined)).toBe(true);

    stubEdition("enterprise");
    env = await import("./env.js");
    expect(env.inEdition("personal")).toBe(false);
    expect(env.inEdition("enterprise")).toBe(true);
    expect(env.inEdition("both")).toBe(true);
    expect(env.inEdition(undefined)).toBe(true);
  });
});

describe("工具箱注册表版本过滤", () => {
  it("个人版（默认环境）保留全部工具，含 rail/interview/photo", async () => {
    const mod = await import("../toolboxTools.js");
    const keys = mod.visibleToolboxTools().map((tool) => tool.key);
    expect(keys).toHaveLength(mod.TOOLBOX_TOOLS.length);
    for (const key of [...PERSONAL_TOOLS, ...BOTH_TOOLS]) expect(keys).toContain(key);
  });

  it("企业版隐藏 rail/interview/checkin/photo/label，保留 json/convert/db 等 both 工具", async () => {
    stubEdition("enterprise");
    const mod = await import("../toolboxTools.js");
    const keys = mod.visibleToolboxTools().map((tool) => tool.key);
    for (const key of PERSONAL_TOOLS) expect(keys).not.toContain(key);
    for (const key of BOTH_TOOLS) expect(keys).toContain(key);
    // 画廊分组同样基于过滤后的列表（比对集合，分组顺序按 category 排列）
    const grouped = mod.groupToolboxTools(mod.visibleToolboxTools()).flatMap((g) => g.tools.map((tool) => tool.key));
    expect([...grouped].sort()).toEqual([...keys].sort());
  });

  it("恢复个人版后回归全量", async () => {
    stubEdition("enterprise");
    const enterpriseKeys = (await import("../toolboxTools.js")).visibleToolboxTools().map((tool) => tool.key);
    expect(enterpriseKeys.length).toBeLessThan(27);

    vi.unstubAllGlobals();
    vi.resetModules();
    const mod = await import("../toolboxTools.js");
    const keys = mod.visibleToolboxTools().map((tool) => tool.key);
    expect(keys).toHaveLength(mod.TOOLBOX_TOOLS.length);
    for (const key of PERSONAL_TOOLS) expect(keys).toContain(key);
  });
});

describe("Agent 工具注册表版本过滤", () => {
  // 当前 5 个个人版工具全部是 agentExempt（无动作），动作集合上暂时观察不到增删；
  // 这里锁住语义——任何 scope 为 personal 的动作都不得进入企业版注册表，
  // 后续给个人版工具接动作时这条过滤路径自动生效。
  it("企业版注册表不含个人版 scope 的动作，both 工具的动作保留", async () => {
    stubEdition("enterprise");
    const { buildAgentRegistry, listAgentTools } = await import("../agent/tools.js");
    const { AGENT_TOOL_BY_NAME } = await import("../agent/catalog.js");

    const names = (await buildAgentRegistry(null)).list().map((tool) => tool.name);
    const personalActions = [...AGENT_TOOL_BY_NAME.values()].filter((meta) => meta.scope === "personal").map((meta) => meta.name);
    for (const name of personalActions) expect(names).not.toContain(name);
    expect(names).toContain("json.parse");
    expect(names).toContain("image.plan");

    const listed = listAgentTools(null).map((tool) => tool.name);
    for (const name of personalActions) expect(listed).not.toContain(name);
    expect(listed).toEqual(names);
  });

  it("个人版（默认环境）与企业版的动作集合一致（个人版工具尚无动作）", async () => {
    const { listAgentTools } = await import("../agent/tools.js");
    const personal = listAgentTools(null).map((tool) => tool.name);
    stubEdition("enterprise");
    const enterprise = (await import("../agent/tools.js")).listAgentTools(null).map((tool) => tool.name);
    // 个人版只隐藏 enterprise 独占动作（当前没有），企业版只隐藏 personal 独占动作
    // （5 个个人版工具全部 agentExempt）——两个集合因此相同；差异出现之日即过滤生效之时。
    expect(enterprise).toEqual(personal);
    expect(personal).toContain("db.query_readonly");
  });
});
