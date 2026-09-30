// interviewImport 的测试。
//
// 导入是**用户可控输入**，也是最容易「看起来成功、其实一道题都没进来」的地方。
// 所以这里既测解析正确的写法，也逐条测各种写错时给出的原因——
// 报错文案本身就是功能的一部分（用户得知道该改哪里）。
import { describe, expect, it } from "vitest";
import { CATEGORY_KEYS } from "./interviewBank.js";
import { exportBankJson, parseBank, parseJsonBank, parseMarkdownBank } from "./interviewImport.js";

const MD = [
  "# 我的题解集",
  "",
  "> 方向: backend",
  "> 主题: JVM",
  "> 难度: 2",
  "",
  "## JVM 内存结构分几块？",
  "",
  "堆、方法区、虚拟机栈、本地方法栈、程序计数器。",
  "",
  "- 要点：堆与栈的区别；方法区存什么；哪些是线程私有",
  "- 标签：JVM, 内存",
  "- 追问：元空间和永久代有什么区别？",
  "",
  "## 什么情况下会 OOM？",
  "",
  "堆不够、元空间不够、线程栈不够都会。",
  "",
  "- 要点：堆 OOM；元空间 OOM；栈溢出",
].join("\n");

describe("parseMarkdownBank", () => {
  it("把 ## 标题当题目、正文当题解，文件头的默认值下发到每一题", () => {
    const result = parseMarkdownBank(MD);
    expect(result.error).toBe("");
    expect(result.questions).toHaveLength(2);
    const [first, second] = result.questions;
    expect(first.question).toBe("JVM 内存结构分几块？");
    expect(first.category).toBe("backend");
    expect(first.topic).toBe("JVM");
    expect(first.difficulty).toBe(2);
    expect(first.answer).toContain("程序计数器");
    expect(first.tags).toEqual(["JVM", "内存"]);
    expect(first.points).toHaveLength(3);
    expect(first.follow).toContain("元空间");
    expect(first.custom, "导入题必须带 custom 标记").toBe(true);
    expect(second.question).toBe("什么情况下会 OOM？");
  });

  it("答案里不留结构化字段的行（要点/标签/追问不该混进题解正文）", () => {
    const first = parseMarkdownBank(MD).questions[0];
    expect(first.answer).not.toContain("要点");
    expect(first.answer).not.toContain("追问");
    expect(first.answer).not.toContain("标签");
  });

  it("一级标题是文件标题，不会被当成题目", () => {
    expect(parseMarkdownBank(MD).questions.map((q) => q.question)).not.toContain("我的题解集");
  });

  it("支持 **题目** 与 Q: 两种博客式写法", () => {
    const result = parseMarkdownBank(["**什么是 CAP？**", "一致性、可用性、分区容错三选二。", "", "Q: 什么是幂等？", "同一操作执行多次结果一致。"].join("\n"), { category: "system" });
    expect(result.error).toBe("");
    expect(result.questions.map((q) => q.question)).toEqual(["什么是 CAP？", "什么是幂等？"]);
    expect(result.questions[0].category).toBe("system");
  });

  it("单题可以用 [难度:3] 覆盖文件头", () => {
    const result = parseMarkdownBank(["> 方向: algo", "", "## 手写快排 [难度:3]", "分区加递归。", "", "## 二分查找", "注意边界。"].join("\n"));
    expect(result.questions[0].difficulty).toBe(3);
    expect(result.questions[0].question).toBe("手写快排");
    expect(result.questions[1].difficulty).toBe(2);
  });

  it("文件头没写方向时用调用方选的方向", () => {
    const result = parseMarkdownBank("## 题目\n正文内容在这里。", { category: "frontend", topic: "CSS" });
    expect(result.questions[0].category).toBe("frontend");
    expect(result.questions[0].topic).toBe("CSS");
  });

  it("同名题目共存（后缀去重，不能静默吞掉一道）", () => {
    const result = parseMarkdownBank(["> 方向: algo", "", "## 两数之和", "哈希表。", "", "## 两数之和", "双指针。"].join("\n"));
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0].id).not.toBe(result.questions[1].id);
  });

  it("空内容的章节被跳过，不造出没有题解的题", () => {
    const result = parseMarkdownBank(["> 方向: algo", "", "## 有答案的", "正文。", "", "## 只有标题的", "", "## 又一道", "正文。"].join("\n"));
    expect(result.questions.map((q) => q.question)).toEqual(["有答案的", "又一道"]);
  });

  it("空输入报 empty，而不是返回空数组假装成功", () => {
    expect(parseMarkdownBank("").error).toBe("empty");
    expect(parseMarkdownBank("   \n  ").error).toBe("empty");
    expect(parseMarkdownBank(null).error).toBe("empty");
  });

  it("一道题都没解析出来时报 noQuestion", () => {
    expect(parseMarkdownBank("就是一段普通文字，没有任何标题。").error).toBe("noQuestion");
  });

  it("没有方向时报 noCategory（方向决定题目进哪个页签，不能猜）", () => {
    expect(parseMarkdownBank("## 题目\n正文。").error).toBe("noCategory");
  });

  it("文件头写了非法方向时按「没写」处理，而不是塞一个不存在的方向", () => {
    expect(parseMarkdownBank(["> 方向: devops", "", "## 题目", "正文。"].join("\n")).error).toBe("noCategory");
  });
});

describe("parseJsonBank", () => {
  const list = [{ id: "custom-a", category: "algo", question: "两数之和", answer: "哈希表一次遍历", difficulty: 1, tags: ["数组"], points: ["哈希", "一次遍历", "O(n)"] }];

  it("接受数组、{questions:[]} 与 {items:[]} 三种形状", () => {
    expect(parseJsonBank(list).questions).toHaveLength(1);
    expect(parseJsonBank({ questions: list }).questions).toHaveLength(1);
    expect(parseJsonBank({ items: list }).questions).toHaveLength(1);
    expect(parseJsonBank(JSON.stringify(list)).questions).toHaveLength(1);
  });

  it("保留显式 id；没有 id 时按题干生成", () => {
    expect(parseJsonBank(list).questions[0].id).toBe("custom-a");
    expect(parseJsonBank([{ category: "algo", question: "没有 id 的题" }]).questions[0].id).toBe("custom-没有-id-的题");
  });

  it("id 撞车时自动加后缀，两道题都留下", () => {
    const dup = [list[0], { ...list[0], question: "另一道题" }];
    const result = parseJsonBank(dup);
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0].id).not.toBe(result.questions[1].id);
  });

  it("缺 category 时用调用方选的方向；非法 category 也一样", () => {
    expect(parseJsonBank([{ question: "q" }], { category: "frontend" }).questions[0].category).toBe("frontend");
    expect(parseJsonBank([{ question: "q", category: "devops" }], { category: "system" }).questions[0].category).toBe("system");
  });

  it("title 可以当 question 的别名（兼容别人的导出格式）", () => {
    expect(parseJsonBank([{ title: "用 title 写的题", category: "algo" }]).questions[0].question).toBe("用 title 写的题");
  });

  it("跳过没有题干的条目，并在 stats 里记下跳过了几条", () => {
    const result = parseJsonBank([list[0], { category: "algo" }, null, "nope"]);
    expect(result.questions).toHaveLength(1);
    expect(result.stats.skipped).toBe(3);
  });

  it("JSON 语法错误时报 badJson 并带上原因", () => {
    const result = parseJsonBank("{ not json ");
    expect(result.error).toBe("badJson");
    expect(result.stats.detail).toBeTruthy();
  });

  it("结构不认识时报 badShape（不是静默返回空）", () => {
    expect(parseJsonBank({ nope: 1 }).error).toBe("badShape");
    expect(parseJsonBank("42").error).toBe("badShape");
  });

  it("空数组报 noQuestion", () => {
    expect(parseJsonBank([]).error).toBe("noQuestion");
  });

  it("空输入报 empty", () => {
    expect(parseJsonBank("").error).toBe("empty");
  });
});

describe("parseBank 的格式判定", () => {
  it("显式 format 优先", () => {
    expect(parseBank("## 题目\n正文。", { format: "markdown", category: "algo" }).error).toBe("");
    expect(parseBank("[]", { format: "json" }).error).toBe("noQuestion");
  });

  it("不写 format 时按内容猜：以 [ 或 { 开头当 JSON，其余当 Markdown", () => {
    expect(parseBank('[{"category":"algo","question":"q","answer":"a"}]').questions).toHaveLength(1);
    expect(parseBank("## 题目\n正文。", { category: "algo" }).questions).toHaveLength(1);
  });
});

describe("exportBankJson", () => {
  it("导出的 JSON 能原样再导入（往返一致）", () => {
    const source = parseBank(MD).questions;
    const roundTrip = parseJsonBank(exportBankJson(source));
    expect(roundTrip.error).toBe("");
    expect(roundTrip.questions.map((q) => q.question)).toEqual(source.map((q) => q.question));
    expect(roundTrip.questions.map((q) => q.answer)).toEqual(source.map((q) => q.answer));
    expect(roundTrip.questions.map((q) => q.category)).toEqual(source.map((q) => q.category));
    expect(roundTrip.questions.map((q) => q.points)).toEqual(source.map((q) => q.points));
  });

  it("导出里不带 custom 之外的内部字段（存档/进度不该混进题库文件）", () => {
    const parsed = JSON.parse(exportBankJson(parseBank(MD).questions));
    expect(Object.keys(parsed[0]).sort()).toEqual(["answer", "category", "difficulty", "follow", "id", "points", "question", "sources", "tags", "topic"]);
  });
});

describe("方向键与题库一致", () => {
  it("每个合法方向都能被 Markdown 文件头接受", () => {
    for (const key of CATEGORY_KEYS) {
      const result = parseMarkdownBank([`> 方向: ${key}`, "", "## 题目", "正文。"].join("\n"));
      expect(result.error, key).toBe("");
      expect(result.questions[0].category).toBe(key);
    }
  });
});
