// 临时探针（用完即删）：mock 行数为 0 的原因。
import { describe, expect, it } from "vitest";
import { formatMockOutput, generateMockRows, mockFieldTypes } from "../../../src/generatorTool.js";

describe("探针：mock 生成", () => {
  it("字段定义与行数", () => {
    const types = mockFieldTypes();
    console.log("候选类型前 6 个:", JSON.stringify(types.slice(0, 6).map((t) => t.key)));
    const fields = types.slice(0, 3).map((t) => ({ name: t.key, type: t.key }));
    console.log("字段定义:", JSON.stringify(fields));
    const rows = generateMockRows(fields, 5, {});
    console.log("行数:", rows.length);
    console.log("首行:", JSON.stringify(rows[0]));
    console.log("CSV:", JSON.stringify(formatMockOutput(rows, "csv")));
    // 单个字段也试一下，定位是不是某个类型有问题
    for (const type of types.slice(0, 6)) {
      try {
        const one = generateMockRows([{ name: type.key, type: type.key }], 1, {});
        console.log(`  单独 ${type.key}: rows=${one.length}`, JSON.stringify(one[0]));
      } catch (e) {
        console.log(`  单独 ${type.key}: THROW ${e?.message || e}`);
      }
    }
    expect(true).toBe(true);
  });
});
