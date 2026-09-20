// Markdown 工具的纯逻辑单测。
//
// 重点覆盖两类容易错的地方：
//   1. **代码块内的内容不是 Markdown**——```bash 里的 `# 注释` 被当成标题、代码里的空行被规范化掉，
//      都是"看着对、结果错"的典型；
//   2. **中英混排的宽度**——中日韩字符占两列，不这样算表格对齐后仍然参差不齐。
import { describe, expect, it } from "vitest";
import {
  displayWidth,
  escapeHtml,
  formatTables,
  lint,
  normalize,
  outline,
  scanLines,
  slugify,
  splitTableRow,
  stats,
  stripInline,
  toHtmlDocument,
  toToc,
} from "./markdownTool.js";

describe("逐行扫描（区分代码块内外）", () => {
  it("识别围栏代码块范围", () => {
    const { flags } = scanLines("正文\n```js\ncode\n```\n正文2");
    expect(flags.map((f) => f.inCode)).toEqual([false, true, true, true, false]);
  });

  it("波浪号围栏也算", () => {
    const { flags } = scanLines("~~~\ncode\n~~~");
    expect(flags.every((f) => f.inCode)).toBe(true);
  });

  it("短围栏不能闭合长围栏", () => {
    // ```` 开启的块里，``` 只是内容
    const { flags, unclosed } = scanLines("````\n```\nstill code\n````");
    expect(flags[2].inCode).toBe(true);
    expect(unclosed).toBe(false);
  });

  it("未闭合的围栏被标记出来", () => {
    expect(scanLines("```js\ncode").unclosed).toBe(true);
    expect(scanLines("```js\ncode\n```").unclosed).toBe(false);
  });
});

describe("大纲", () => {
  const md = ["# 标题一", "正文", "## 子标题", "```bash", "# 这是代码里的注释，不是标题", "```", "### 三级"].join("\n");

  it("提取标题层级与行号", () => {
    const list = outline(md);
    expect(list.map((h) => [h.level, h.text])).toEqual([
      [1, "标题一"],
      [2, "子标题"],
      [3, "三级"],
    ]);
  });

  it("代码块里的 # 不算标题（关键：否则大纲全错）", () => {
    expect(outline(md).some((h) => h.text.includes("注释"))).toBe(false);
  });

  it("井号后没有空格的不算标题（多数渲染器不认）", () => {
    expect(outline("#标题\n# 标题")).toHaveLength(1);
    expect(outline("#标题")[0]).toBeUndefined();
  });

  it("去掉行内标记后再取标题文本", () => {
    const list = outline("# **粗体** 与 `代码` 与 [链接](http://x)");
    expect(list[0].text).toBe("粗体 与 代码 与 链接");
  });

  it("同名标题的锚点加序号（否则锚点冲突）", () => {
    const list = outline("# 说明\n# 说明\n# 说明");
    expect(list.map((h) => h.slug)).toEqual(["说明", "说明-1", "说明-2"]);
  });

  it("maxLevel 过滤深层标题", () => {
    expect(outline("# a\n### b", { maxLevel: 2 }).map((h) => h.text)).toEqual(["a"]);
  });

  it("中文标题也能生成锚点", () => {
    expect(slugify("第一 章：入门")).toBe("第一-章入门");
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("!!!")).toBe("section");
  });
});

describe("目录", () => {
  it("按层级嵌套（以最小层级为基准缩进）", () => {
    const toc = toToc(outline("# 一\n## 二\n### 三\n# 四"));
    expect(toc.split("\n")).toEqual(["- [一](#一)", "  - [二](#二)", "    - [三](#三)", "- [四](#四)"]);
  });

  it("文档从 h2 开始时不多缩进一层", () => {
    const toc = toToc(outline("## 甲\n### 乙"));
    expect(toc.split("\n")).toEqual(["- [甲](#甲)", "  - [乙](#乙)"]);
  });

  it("可生成有序列表", () => {
    expect(toToc(outline("# a\n# b"), { ordered: true }).split("\n")).toEqual(["1. [a](#a)", "1. [b](#b)"]);
  });

  it("没有标题时返回空串", () => {
    expect(toToc([])).toBe("");
    expect(toToc(outline("只有正文"))).toBe("");
  });
});

describe("统计", () => {
  const md = ["# 标题", "", "这是一段中文正文。", "", "```js", "const a = 1; // 代码不算字数", "```", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", "[链接](http://x) ![图](http://y)"].join("\n");

  it("标题/代码块/表格/链接/图片都数对", () => {
    const result = stats(md);
    expect(result.headings).toBe(1);
    expect(result.codeBlocks).toBe(1);
    expect(result.tables).toBe(1);
    expect(result.links).toBe(1);
    expect(result.images).toBe(1);
  });

  it("代码块里的内容不计入字数（否则代码里的符号会被算成正文）", () => {
    const withCode = stats("```\nconst aaaa = 1;\n```");
    expect(withCode.words).toBe(0);
  });

  it("中文与英文分别计数", () => {
    const result = stats("中文四个字 hello world");
    expect(result.cjk).toBe(5);
    expect(result.words).toBe(2);
  });

  it("阅读时长至少 1 分钟（有内容时不该显示 0）", () => {
    expect(stats("很短").readMinutes).toBe(1);
    expect(stats("").readMinutes).toBe(0);
  });

  it("未闭合围栏会被统计出来", () => {
    expect(stats("```js\ncode").unclosed).toBe(true);
  });

  it("记录最深层级（判断标题是否用得太深）", () => {
    expect(stats("# a\n#### b").maxHeading).toBe(4);
  });
});

describe("表格对齐", () => {
  it("补齐空格让源码里也对齐", () => {
    const md = ["| a | bbb |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    const out = formatTables(md);
    expect(out.split("\n")).toEqual(["| a   | bbb |", "| --- | --- |", "| 1   | 2   |"]);
  });

  it("中日韩字符按两列算宽度（否则中文表格仍然参差）", () => {
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("ab")).toBe(2);
    const md = ["| 名称 | x |", "| --- | --- |", "| 甲 | 1 |"].join("\n");
    const out = formatTables(md).split("\n");
    // 「名称」(4) 与「甲」(2) 宽度不同，靠补空格对齐
    expect(out[0]).toBe("| 名称 | x   |");
    expect(out[2]).toBe("| 甲   | 1   |");
  });

  it("保留对齐标记（:---:）", () => {
    const md = ["| a | b | c |", "| :-- | :-: | --: |", "| 1 | 2 | 3 |"].join("\n");
    const out = formatTables(md).split("\n")[1];
    expect(out).toContain(":--");
    expect(out).toContain(":-:");
    expect(out).toContain("--:");
  });

  it("不碰代码块里的表格样文本", () => {
    const md = ["```", "| a | b |", "| --- | --- |", "```"].join("\n");
    expect(formatTables(md)).toBe(md);
  });

  it("非表格行原样保留", () => {
    const md = "正文\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n结尾";
    const out = formatTables(md);
    expect(out.startsWith("正文")).toBe(true);
    expect(out.endsWith("结尾")).toBe(true);
  });

  it("拆行时不动转义的竖线", () => {
    expect(splitTableRow("| a\\|b | c |")).toEqual(["a\\|b", "c"]);
  });
});

describe("规范化", () => {
  it("标题井号后补空格", () => {
    expect(normalize("#标题")).toContain("# 标题");
  });

  it("全角空格缩进换成半角（中文输入法常见）", () => {
    expect(normalize("\u3000正文")).toContain(" 正文");
    expect(normalize("\u3000正文")).not.toContain("\u3000");
  });

  it("列表标记统一为 -", () => {
    expect(normalize("* 甲\n+ 乙")).toBe("- 甲\n- 乙\n");
  });

  it("去掉单个行尾空格，但保留两个（Markdown 里是强制换行）", () => {
    expect(normalize("正文 \n下一行")).toBe("正文\n下一行\n");
    // 两个空格是硬换行，必须保留——但只在**文档中间**有意义，
    // 文档末尾的尾随空格一律去掉（那里没有"下一行"可换）
    expect(normalize("第一行  \n第二行")).toContain("第一行  ");
    expect(normalize("正文  \n")).toBe("正文\n");
  });

  it("连续空行压成一个", () => {
    expect(normalize("a\n\n\n\nb")).toBe("a\n\nb\n");
  });

  it("标题前后补空行（紧贴正文会与上一段粘连）", () => {
    const out = normalize("正文\n## 标题\n正文2");
    expect(out).toBe("正文\n\n## 标题\n\n正文2\n");
  });

  it("代码块内部原样保留（代码里的空行与缩进有意义）", () => {
    const md = ["```", "", "", "   缩进的代码", "", "```"].join("\n");
    const out = normalize(md);
    expect(out).toContain("\n\n\n   缩进的代码");
  });

  it("结果以单个换行结尾", () => {
    expect(normalize("a")).toBe("a\n");
    expect(normalize("a\n\n\n")).toBe("a\n");
  });
});

describe("检查", () => {
  it("未闭合代码块", () => {
    expect(lint("```js\ncode").map((i) => i.code)).toContain("unclosedFence");
  });

  it("标题层级跳跃（h1 → h3）", () => {
    const issues = lint("# a\n### b");
    expect(issues.map((i) => i.code)).toContain("headingJump");
    expect(issues.find((i) => i.code === "headingJump").params).toEqual({ from: 1, to: 3 });
  });

  it("重复标题（锚点冲突）", () => {
    expect(lint("# 说明\n# 说明").map((i) => i.code)).toContain("duplicateHeading");
  });

  it("空标题", () => {
    expect(lint("#\n# a").map((i) => i.code)).toContain("emptyHeading");
  });

  it("井号后缺空格", () => {
    expect(lint("#标题").map((i) => i.code)).toContain("noSpaceAfterHash");
  });

  it("空链接", () => {
    expect(lint("[文字]()").map((i) => i.code)).toContain("emptyLink");
  });

  it("全角空格缩进", () => {
    expect(lint("\u3000正文").map((i) => i.code)).toContain("fullWidthSpace");
  });

  it("代码块里的问题不报（代码不是 Markdown）", () => {
    const issues = lint("```bash\n#注释\n\t缩进\n```");
    expect(issues.map((i) => i.code)).not.toContain("noSpaceAfterHash");
    expect(issues.map((i) => i.code)).not.toContain("tabIndent");
  });

  it("问题带行号（界面据此定位）", () => {
    const issues = lint("正文\n#标题");
    expect(issues.find((i) => i.code === "noSpaceAfterHash").line).toBe(2);
  });

  it("干净文档没有问题", () => {
    expect(lint("# 标题\n\n正文\n\n## 子标题\n\n正文")).toEqual([]);
  });
});

describe("导出 HTML", () => {
  it("注入渲染器时用渲染结果", () => {
    const html = toHtmlDocument("# 标题", { render: (md) => `<h1>${md.slice(2)}</h1>`, title: "我的文档" });
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<title>我的文档</title>");
    expect(html).toContain("<!doctype html>");
  });

  it("标题被转义（防止注入到 title 标签里）", () => {
    const html = toHtmlDocument("x", { render: () => "", title: '<script>alert(1)</script>' });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("没有渲染器时兜底转义原文（不输出未转义内容）", () => {
    const html = toHtmlDocument("<img onerror=alert(1)>");
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;img");
  });

  it("自带样式与深色模式", () => {
    expect(toHtmlDocument("x", { render: () => "" })).toContain("color-scheme: light");
    expect(toHtmlDocument("x", { render: () => "", dark: true })).toContain("color-scheme: dark");
  });

  it("escapeHtml 覆盖五个字符", () => {
    expect(escapeHtml(`&<>"`)).toBe("&amp;&lt;&gt;&quot;");
  });
});

describe("行内标记剥离", () => {
  it("粗体/行内码/链接/删除线/图片都去掉标记", () => {
    expect(stripInline("**粗** `码` [链](u) ~~删~~ ![图](u)")).toBe("粗 码 链 删 图");
  });

  it("普通文本不变", () => {
    expect(stripInline("普通文本")).toBe("普通文本");
  });
});
