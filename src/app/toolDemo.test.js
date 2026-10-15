// 演示脚本纯逻辑单测：脚本生成只做一件事——把「这次调用给了什么参数」翻成能真实回放的步骤，
// 且**参数不全的交互步骤必须丢**（演一个「填了空值」的假动作比不演更糟）。
import { describe, expect, it } from "vitest";
import { actionDemo, buildDemoScript, clipValue, isPlayable, replayLines, STEP_ACTIONS } from "./toolDemo.js";

describe("从契约取演示声明", () => {
  it("表工具的两个动作都声明了脚本（样板必须真的接上了，否则这层机制等于空转）", () => {
    for (const name of ["table.parse", "table.convert"]) {
      const demo = actionDemo("table", name);
      expect(demo, `${name} 没有 demo`).toBeTruthy();
      expect(demo.steps.length).toBeGreaterThan(0);
    }
  });

  it("真实动作参数 → 可播放脚本（端到端口径：这就是点「看它怎么操作」时会发生的事）", () => {
    const script = buildDemoScript(actionDemo("table", "table.convert"), { text: "name,city\n张三,北京", format: "json" });
    // 参数里没有 delimiter，那一步被丢掉；其余三步按契约顺序排好
    expect(script.map((s) => [s.anchor, s.action])).toEqual([
      ["input", "fill"],
      ["export-format", "select"],
      ["export-output", "reveal"],
    ]);
    expect(script[0].value).toBe("name,city\n张三,北京");
    expect(script[1].value).toBe("json");
  });

  it("pdf 三个动作共用同一段纯 reveal 脚本（它的产物是磁盘文件，工具里能指的只有那两处）", () => {
    for (const name of ["pdf.merge", "pdf.extract_pages", "pdf.split"]) {
      const script = buildDemoScript(actionDemo("pdf", name), { path: "/tmp/a.pdf", output: "/tmp/b.pdf" });
      expect(script.map((s) => [s.anchor, s.action])).toEqual([
        ["file-chip", "reveal"],
        ["source-panel", "reveal"],
      ]);
      // 纯 reveal 不代表做过什么：挑文件是原生对话框，是人的环节
      expect(script.every((s) => s.value === null)).toBe(true);
    }
  });

  it("没有声明 / 工具不存在时返回 null", () => {
    expect(actionDemo("table", "table.nope")).toBeNull();
    expect(actionDemo("__nope__", "table.parse")).toBeNull();
  });
});

describe("生成脚本", () => {
  const demo = {
    steps: [
      { anchor: "input", action: "fill", from: "text" },
      { anchor: "format", action: "select", from: "format" },
      { anchor: "output", action: "reveal" },
    ],
  };

  it("参数齐备时三步全在", () => {
    const script = buildDemoScript(demo, { text: "a,b", format: "json" });
    expect(script.map((s) => s.anchor)).toEqual(["input", "format", "output"]);
    expect(script[0].value).toBe("a,b");
    expect(script[2].value).toBeNull(); // reveal 不需要值
  });

  it("参数缺失的交互步骤被丢掉（宁可少演一步，也不演假动作）", () => {
    const script = buildDemoScript(demo, { text: "a,b" });
    expect(script.map((s) => s.anchor)).toEqual(["input", "output"]);
  });

  it("参数是空串也算缺失", () => {
    expect(buildDemoScript(demo, { text: "", format: "json" }).map((s) => s.anchor)).toEqual(["format", "output"]);
  });

  it("显式 value 常量不依赖参数", () => {
    const script = buildDemoScript({ steps: [{ anchor: "x", action: "select", value: "json" }] }, {});
    expect(script[0].value).toBe("json");
  });

  it("未知动作类型 / 缺锚点的步骤直接跳过（契约写错不该把演示整段毁掉）", () => {
    const script = buildDemoScript(
      { steps: [{ anchor: "a", action: "dance" }, { action: "fill", from: "text" }, { anchor: "b", action: "reveal" }, null, "x"] },
      { text: "t" }
    );
    expect(script.map((s) => s.anchor)).toEqual(["b"]);
  });

  it("没有 captionKey 时回退到通用文案键", () => {
    const script = buildDemoScript({ steps: [{ anchor: "a", action: "click" }] }, {});
    expect(script[0].captionKey).toBe("toolbox.demo.step_click");
    expect(STEP_ACTIONS).toContain("click");
  });

  it("空声明返回空脚本（调用方据此不显示「看它怎么操作」）", () => {
    expect(buildDemoScript(null, { text: "x" })).toEqual([]);
    expect(buildDemoScript({ steps: [] }, { text: "x" })).toEqual([]);
    expect(isPlayable([])).toBe(false);
    expect(isPlayable([{ anchor: "a", action: "reveal" }])).toBe(true);
  });
});

describe("复现步骤文本", () => {
  const script = buildDemoScript({ steps: [{ anchor: "input", action: "fill", from: "text" }, { anchor: "out", action: "reveal" }] }, { text: "name,city\n张三,北京" });

  it("带值步骤把值一起写出来，纯指引步骤只写文案", () => {
    const lines = replayLines(script, { t: (key) => key });
    expect(lines[0]).toBe("1. toolbox.demo.step_fill：name,city 张三,北京");
    expect(lines[1]).toBe("2. toolbox.demo.step_reveal");
  });

  it("值里的换行被压平（清单是给人读的一行）", () => {
    expect(clipValue("a\n\nb   c")).toBe("a b c");
  });

  it("超长值截断并加省略号", () => {
    expect(clipValue("x".repeat(60), 10)).toBe(`${"x".repeat(10)}…`);
  });

  it("对象值退化为 JSON 文本，不渲染成 [object Object]", () => {
    expect(clipValue({ a: 1 })).toBe('{"a":1}');
  });
});
