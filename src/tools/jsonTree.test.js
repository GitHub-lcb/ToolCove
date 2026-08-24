import { describe, it, expect } from "vitest";
import {
  valueType,
  buildTree,
  searchTree,
  flattenTree,
  defaultExpanded,
  allContainerIds,
  primitivePreview,
  typeLabel,
} from "./jsonTree.js";

const SAMPLE = {
  name: "alice",
  age: 30,
  active: true,
  tags: ["admin", "user"],
  address: { city: "hz", zip: null },
};

describe("valueType", () => {
  it("识别各类型", () => {
    expect(valueType(null)).toBe("null");
    expect(valueType([])).toBe("array");
    expect(valueType({})).toBe("object");
    expect(valueType("x")).toBe("string");
    expect(valueType(1)).toBe("number");
    expect(valueType(true)).toBe("boolean");
  });
});

describe("buildTree", () => {
  it("根为对象，含正确子节点数与类型", () => {
    const root = buildTree(SAMPLE);
    expect(root.type).toBe("object");
    expect(root.key).toBe(null);
    expect(root.size).toBe(5);
    expect(root.children.length).toBe(5);
    const tags = root.children.find((c) => c.key === "tags");
    expect(tags.type).toBe("array");
    expect(tags.size).toBe(2);
    expect(tags.children[0].value).toBe("admin");
    const addr = root.children.find((c) => c.key === "address");
    expect(addr.children.find((c) => c.key === "zip").type).toBe("null");
  });
  it("节点 id 唯一递增", () => {
    const root = buildTree({ a: 1, b: 2 });
    const ids = [];
    const walk = (n) => { ids.push(n.id); n.children.forEach(walk); };
    walk(root);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("primitivePreview", () => {
  it("字符串返回原文，其它转字符串", () => {
    expect(primitivePreview({ type: "string", value: "hi" })).toBe("hi");
    expect(primitivePreview({ type: "number", value: 42 })).toBe("42");
    expect(primitivePreview({ type: "boolean", value: false })).toBe("false");
    expect(primitivePreview({ type: "null" })).toBe("null");
  });
});

describe("typeLabel", () => {
  it("容器带子项数，基础类型中文名", () => {
    expect(typeLabel("object", 7)).toBe("对象 (7)");
    expect(typeLabel("array", 2)).toBe("数组 (2)");
    expect(typeLabel("string")).toBe("字符串");
    expect(typeLabel("number")).toBe("数字");
    expect(typeLabel("boolean")).toBe("布尔");
    expect(typeLabel("null")).toBe("null");
  });
});

describe("searchTree", () => {
  it("命中键，返回祖先用于展开", () => {
    const root = buildTree(SAMPLE);
    const r = searchTree(root, "city");
    expect(r.order.length).toBe(1);
    const addr = root.children.find((c) => c.key === "address");
    // address 是命中节点(city)的祖先，应在 expand 集内
    expect(r.expand.has(addr.id)).toBe(true);
    expect(r.expand.has(root.id)).toBe(true);
  });
  it("命中叶子值（大小写不敏感）", () => {
    const root = buildTree(SAMPLE);
    const r = searchTree(root, "ADMIN");
    expect(r.matched.size).toBe(1);
  });
  it("空查询返回空集", () => {
    const root = buildTree(SAMPLE);
    const r = searchTree(root, "");
    expect(r.matched.size).toBe(0);
    expect(r.order.length).toBe(0);
  });
  it("多命中按先序排列", () => {
    const root = buildTree({ a: "x1", b: { c: "x2" }, d: "x3" });
    const r = searchTree(root, "x");
    expect(r.order.length).toBe(3);
  });
});

describe("flattenTree", () => {
  it("空展开集只有根一行", () => {
    const root = buildTree(SAMPLE);
    const rows = flattenTree(root, new Set());
    expect(rows.length).toBe(1);
    expect(rows[0].depth).toBe(0);
    expect(rows[0].expandable).toBe(true);
    expect(rows[0].isOpen).toBe(false);
  });
  it("展开根后可见一级子节点", () => {
    const root = buildTree(SAMPLE);
    const rows = flattenTree(root, new Set([root.id]));
    expect(rows.length).toBe(1 + 5);
    expect(rows[1].depth).toBe(1);
  });
  it("叶子节点 expandable 为 false", () => {
    const root = buildTree({ a: 1 });
    const rows = flattenTree(root, new Set([root.id]));
    const leaf = rows.find((r) => r.key === "a");
    expect(leaf.expandable).toBe(false);
    expect(leaf.value).toBe(1);
  });
});

describe("defaultExpanded / allContainerIds", () => {
  it("默认展开根与一级容器", () => {
    const root = buildTree(SAMPLE);
    const set = defaultExpanded(root, 1);
    expect(set.has(root.id)).toBe(true);
    const addr = root.children.find((c) => c.key === "address");
    expect(set.has(addr.id)).toBe(true);
    // 展开后 address 的子节点(city/zip)是叶子，不在集合内
    const rows = flattenTree(root, set);
    expect(rows.find((r) => r.key === "city")).toBeTruthy();
  });
  it("allContainerIds 收集所有容器", () => {
    const root = buildTree(SAMPLE);
    const set = allContainerIds(root);
    // root + tags + address = 3 个容器
    expect(set.size).toBe(3);
  });
});
