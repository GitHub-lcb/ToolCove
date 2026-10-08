// 路径取值与三态判定的单测。
//
// 这里测的不是「能不能取到值」，而是「取不到时会不会被误当成 false」——
// 那正是签到工具谎报状态的起点。
import { describe, expect, it } from "vitest";
import { parsePath, pickPath, pickSegments, toTriState } from "./paths.js";

describe("路径语法", () => {
  it("解析普通段与数组索引", () => {
    expect(parsePath("data.checkedToday")).toEqual(["data", "checkedToday"]);
    expect(parsePath("data.items[0].points")).toEqual(["data", "items", 0, "points"]);
    expect(parsePath("data.list[2][1]")).toEqual(["data", "list", 2, 1]);
  });

  it("空路径与单点表示根节点", () => {
    expect(parsePath("")).toEqual([]);
    expect(parsePath(".")).toEqual([]);
    expect(parsePath("   ")).toEqual([]);
  });

  it("拒绝首尾点号（否则 data..x 会被当成两段）", () => {
    expect(parsePath(".data")).toBeNull();
    expect(parsePath("data.")).toBeNull();
  });

  it("拒绝方括号写错与索引后直接跟字符", () => {
    expect(parsePath("a[0")).toBeNull();
    expect(parsePath("a[]")).toBeNull();
    expect(parsePath("a[-1]")).toBeNull();
    expect(parsePath("a[0]b")).toBeNull();
  });

  it("拒绝原型链上的名字（路径是外部输入）", () => {
    expect(parsePath("__proto__.polluted")).toBeNull();
    expect(parsePath("constructor.name")).toBeNull();
    expect(parsePath("prototype.x")).toBeNull();
  });

  it("拒绝含空格的段名", () => {
    expect(parsePath("data .x")).toBeNull();
    expect(parsePath("a b")).toBeNull();
  });
});

describe("取值", () => {
  const payload = {
    code: 0,
    data: { checkedToday: true, points: 100, items: [{ name: "a" }, { name: "b" }], nested: null },
    empty: {},
  };

  it("按路径取到值", () => {
    expect(pickPath(payload, "data.checkedToday")).toBe(true);
    expect(pickPath(payload, "data.points")).toBe(100);
    expect(pickPath(payload, "data.items[1].name")).toBe("b");
    expect(pickPath(payload, "code")).toBe(0);
  });

  it("空路径返回根节点本身", () => {
    expect(pickPath(payload, "")).toBe(payload);
  });

  it("缺失路径返回 undefined 而不是抛错", () => {
    expect(pickPath(payload, "data.nope")).toBeUndefined();
    expect(pickPath(payload, "data.empty.x")).toBeUndefined();
    expect(pickPath(payload, "nope[0]")).toBeUndefined();
    expect(pickPath(payload, "code.x")).toBeUndefined();
  });

  it("数组索引越界返回 undefined", () => {
    expect(pickPath(payload, "data.items[9].name")).toBeUndefined();
  });

  it("null 中间节点直接终止，不报类型错", () => {
    expect(pickPath(payload, "data.nested.x")).toBeUndefined();
  });

  it("只读自有属性：继承来的字段读不到", () => {
    const parent = { inherited: 1 };
    const child = Object.create(parent);
    expect(pickSegments(child, ["inherited"])).toBeUndefined();
  });

  it("非法路径取值为 undefined", () => {
    expect(pickPath(payload, "bad..path")).toBeUndefined();
    expect(pickPath(payload, "__proto__")).toBeUndefined();
  });

  it("数值 0 不被当成缺失", () => {
    expect(pickPath({ code: 0, flag: false }, "code")).toBe(0);
    expect(pickPath({ flag: false }, "flag")).toBe(false);
  });
});

describe("已签到三态", () => {
  it("true 侧：布尔、1、数字串、布尔串", () => {
    expect(toTriState(true)).toBe(true);
    expect(toTriState(1)).toBe(true);
    expect(toTriState("true")).toBe(true);
    expect(toTriState("1")).toBe(true);
    expect(toTriState("TRUE")).toBe(true);
    expect(toTriState(" true ")).toBe(true);
  });

  it("false 侧", () => {
    expect(toTriState(false)).toBe(false);
    expect(toTriState(0)).toBe(false);
    expect(toTriState("false")).toBe(false);
    expect(toTriState("0")).toBe(false);
  });

  it("看不懂的值是 undefined，与 false 严格区分", () => {
    // 这一条是本文件最要紧的断言：若把 undefined 当 false，
    // 描述文件路径写错时工具会去签，签完还是显示不出状态。
    expect(toTriState(undefined)).toBeUndefined();
    expect(toTriState(null)).toBeUndefined();
    expect(toTriState("")).toBeUndefined();
    expect(toTriState("已领取")).toBeUndefined();
    expect(toTriState({})).toBeUndefined();
  });
});
