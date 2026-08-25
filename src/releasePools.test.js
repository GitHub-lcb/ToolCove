import { describe, it, expect } from "vitest";
import { parsePoolLines, splitNewPools, localPoolNames, splitProjectHits, makeLocalPool, nameConflict, poolDeployMode } from "./releasePools.js";

describe("parsePoolLines", () => {
  it("按行拆分并去除空白与空行", () => {
    expect(parsePoolLines("  云仓  \n\nops-yuncang\n \t\nabc")).toEqual(["云仓", "ops-yuncang", "abc"]);
  });
  it("大小写不敏感去重，保留首次出现", () => {
    expect(parsePoolLines("Abc\nabc\nABC")).toEqual(["Abc"]);
  });
  it("空输入返回空数组", () => {
    expect(parsePoolLines("")).toEqual([]);
    expect(parsePoolLines(null)).toEqual([]);
  });
  it("支持 CRLF 换行", () => {
    expect(parsePoolLines("a\r\nb")).toEqual(["a", "b"]);
  });
});

describe("splitNewPools", () => {
  it("按已有名称大小写不敏感拆分", () => {
    const { addable, skipped } = splitNewPools(["云仓", "ops-yuncang", "新池"], ["OPS-YUNCANG", "旧池"]);
    expect(addable).toEqual(["云仓", "新池"]);
    expect(skipped).toEqual(["ops-yuncang"]);
  });
  it("已有名称为空时全部可新增", () => {
    const { addable, skipped } = splitNewPools(["a", "b"], []);
    expect(addable).toEqual(["a", "b"]);
    expect(skipped).toEqual([]);
  });
  it("容忍已有名称里的空字符串与 null", () => {
    const { addable } = splitNewPools(["a"], ["", null, "  "]);
    expect(addable).toEqual(["a"]);
  });
});

describe("localPoolNames", () => {
  it("只返回临时 Pool 名称，领域同名不会进入冲突集合", () => {
    expect(localPoolNames([{ name: "临时池" }], [{ name: "归档池" }])).toEqual(["临时池", "归档池"]);
  });
});

describe("splitProjectHits", () => {
  it("唯一命中自动选择，多命中保留候选且不默认选择", () => {
    expect(splitProjectHits(["p1", "p1"])).toEqual({ selected: "p1", candidates: [] });
    expect(splitProjectHits(["p1", "p2", "p1"])).toEqual({ selected: "", candidates: ["p1", "p2"] });
    expect(splitProjectHits([])).toEqual({ selected: "", candidates: [] });
  });
});

describe("makeLocalPool", () => {
  it("组装新记录并清理空白", () => {
    const p = makeLocalPool("  云仓 ", " ops-yuncang ", " 云仓仓库 ");
    expect(p.name).toBe("云仓");
    expect(p.codingProject).toBe("ops-yuncang");
    expect(p.codingProjectName).toBe("云仓仓库");
    expect(p.id).toBeTruthy();
    expect(p.createdAt).toBeGreaterThan(0);
    expect(p.createdAt).toBe(p.updatedAt);
    expect(p.archivedAt).toBeUndefined();
  });
});

describe("nameConflict", () => {
  const list = [{ id: "a", name: "云仓" }, { id: "b", name: "ops-yuncang" }];
  it("检测到同名冲突", () => {
    expect(nameConflict("云仓", list, "x")).toBe(true);
    expect(nameConflict("OPS-YUNCANG", list, "x")).toBe(true);
  });
  it("忽略自身 id", () => {
    expect(nameConflict("云仓", list, "a")).toBe(false);
  });
  it("空名不视为冲突", () => {
    expect(nameConflict("  ", list, "x")).toBe(false);
  });
});

describe("poolDeployMode", () => {
  it("显式配置优先：container/host 直接生效，不受名称影响", () => {
    expect(poolDeployMode({ name: "warehouse.wms.api", deployType: "container" })).toBe("container");
    expect(poolDeployMode({ name: "online.base.api", deployType: "host" })).toBe("host");
  });
  it("auto 或缺省时按命名约定：online 前缀视为容器化", () => {
    expect(poolDeployMode({ name: "online.base.a.service", deployType: "auto" })).toBe("container");
    expect(poolDeployMode({ name: "Online.Gateway" })).toBe("container");
    expect(poolDeployMode({ name: "warehouse.wms.api" })).toBe("host");
    expect(poolDeployMode({ name: "warehouse.wms.api", deployType: "auto" })).toBe("host");
  });
  it("非法/未知 deployType 退化为命名推断", () => {
    expect(poolDeployMode({ name: "online.x", deployType: "weird" })).toBe("container");
    expect(poolDeployMode({ name: "abc", deployType: "weird" })).toBe("host");
  });
  it("空对象/缺失字段安全兜底为 host", () => {
    expect(poolDeployMode(null)).toBe("host");
    expect(poolDeployMode({})).toBe("host");
  });
});
