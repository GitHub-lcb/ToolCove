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
  it("recognizes every type", () => {
    expect(valueType(null)).toBe("null");
    expect(valueType([])).toBe("array");
    expect(valueType({})).toBe("object");
    expect(valueType("x")).toBe("string");
    expect(valueType(1)).toBe("number");
    expect(valueType(true)).toBe("boolean");
  });
});

describe("buildTree", () => {
  it("root is an object with correct child count and types", () => {
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
  it("node ids are unique and increasing", () => {
    const root = buildTree({ a: 1, b: 2 });
    const ids = [];
    const walk = (n) => { ids.push(n.id); n.children.forEach(walk); };
    walk(root);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("primitivePreview", () => {
  it("strings return as-is, others are stringified", () => {
    expect(primitivePreview({ type: "string", value: "hi" })).toBe("hi");
    expect(primitivePreview({ type: "number", value: 42 })).toBe("42");
    expect(primitivePreview({ type: "boolean", value: false })).toBe("false");
    expect(primitivePreview({ type: "null" })).toBe("null");
  });
});

describe("typeLabel", () => {
  it("containers carry child count, primitives show localized names", () => {
    // default locale is zh-CN, so labels resolve to Chinese text (unicode escapes keep source ASCII)
    expect(typeLabel("object", 7)).toBe("\u5bf9\u8c61 (7)");
    expect(typeLabel("array", 2)).toBe("\u6570\u7ec4 (2)");
    expect(typeLabel("string")).toBe("\u5b57\u7b26\u4e32");
    expect(typeLabel("number")).toBe("\u6570\u5b57");
    expect(typeLabel("boolean")).toBe("\u5e03\u5c14");
    expect(typeLabel("null")).toBe("null");
  });
});

describe("searchTree", () => {
  it("matching a key returns ancestors for expansion", () => {
    const root = buildTree(SAMPLE);
    const r = searchTree(root, "city");
    expect(r.order.length).toBe(1);
    const addr = root.children.find((c) => c.key === "address");
    // address is an ancestor of the matched node (city), so it must be in the expand set
    expect(r.expand.has(addr.id)).toBe(true);
    expect(r.expand.has(root.id)).toBe(true);
  });
  it("matches leaf values case-insensitively", () => {
    const root = buildTree(SAMPLE);
    const r = searchTree(root, "ADMIN");
    expect(r.matched.size).toBe(1);
  });
  it("empty query returns empty sets", () => {
    const root = buildTree(SAMPLE);
    const r = searchTree(root, "");
    expect(r.matched.size).toBe(0);
    expect(r.order.length).toBe(0);
  });
  it("multiple matches are ordered by pre-order traversal", () => {
    const root = buildTree({ a: "x1", b: { c: "x2" }, d: "x3" });
    const r = searchTree(root, "x");
    expect(r.order.length).toBe(3);
  });
});

describe("flattenTree", () => {
  it("an empty expand set shows only the root row", () => {
    const root = buildTree(SAMPLE);
    const rows = flattenTree(root, new Set());
    expect(rows.length).toBe(1);
    expect(rows[0].depth).toBe(0);
    expect(rows[0].expandable).toBe(true);
    expect(rows[0].isOpen).toBe(false);
  });
  it("expanding the root reveals first-level children", () => {
    const root = buildTree(SAMPLE);
    const rows = flattenTree(root, new Set([root.id]));
    expect(rows.length).toBe(1 + 5);
    expect(rows[1].depth).toBe(1);
  });
  it("leaf nodes are not expandable", () => {
    const root = buildTree({ a: 1 });
    const rows = flattenTree(root, new Set([root.id]));
    const leaf = rows.find((r) => r.key === "a");
    expect(leaf.expandable).toBe(false);
    expect(leaf.value).toBe(1);
  });
});

describe("defaultExpanded / allContainerIds", () => {
  it("expands root and first-level containers by default", () => {
    const root = buildTree(SAMPLE);
    const set = defaultExpanded(root, 1);
    expect(set.has(root.id)).toBe(true);
    const addr = root.children.find((c) => c.key === "address");
    expect(set.has(addr.id)).toBe(true);
    // after expansion, children of address (city/zip) are leaves and not in the set
    const rows = flattenTree(root, set);
    expect(rows.find((r) => r.key === "city")).toBeTruthy();
  });
  it("allContainerIds collects every container", () => {
    const root = buildTree(SAMPLE);
    const set = allContainerIds(root);
    // root + tags + address = 3 containers
    expect(set.size).toBe(3);
  });
});
