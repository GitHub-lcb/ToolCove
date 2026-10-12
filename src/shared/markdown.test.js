// src/shared/markdown.js 的纯函数单测（从原 508 行的 shared.test.js 按领域拆出来）。
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown.js";describe("renderMarkdown", () => {
  it("转义 HTML 防注入", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("标题降级：# 渲染为 h3，封顶 h6", () => {
    expect(renderMarkdown("# 标题")).toContain("<h3>标题</h3>");
    expect(renderMarkdown("#### 四级")).toContain("<h6>四级</h6>");
  });
  it("粗体与行内代码", () => {
    const html = renderMarkdown("**粗** 与 `码`");
    expect(html).toContain("<strong>粗</strong>");
    expect(html).toContain("<code>码</code>");
  });
  it("有序列表支持点号 / 括号分隔（后接空格）", () => {
    expect(renderMarkdown("1. 第一")).toContain("<ol>");
    expect(renderMarkdown("1) 第一")).toContain("<li>第一</li>");
  });
  it("围栏代码块", () => {
    const html = renderMarkdown("```\nconst a = 1;\n```");
    expect(html).toContain('<pre class="md-code">');
  });
  it("表格：表头 + 分隔行 + 数据行", () => {
    const html = renderMarkdown("| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 梨 | 5 |");
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain("<th>名称</th>");
    expect(html).toContain("<td>苹果</td>");
  });
  it("表格：无分隔行时按段落输出不丢内容", () => {
    const html = renderMarkdown("| a | b |\n| c | d |");
    expect(html).not.toContain("<table");
    expect(html).toContain("<p>a | b</p>");
  });
  it("围栏代码块语言标注与高亮选项", () => {
    const plain = renderMarkdown("```js\nconst a = 1;\n```");
    expect(plain).toContain('<pre class="md-code">');
    expect(plain).not.toContain("hljs");
    const hl = renderMarkdown("```js\nconst a = 1;\n```", { highlight: true });
    expect(hl).toContain('<pre class="md-code" data-lang="js">');
    expect(hl).toContain('class="md-copy"');
    expect(hl).toContain("hljs");
  });
  it("highlight 默认关闭，不影响既有调用", () => {
    const html = renderMarkdown("**粗**");
    expect(html).toContain("<strong>粗</strong>");
  });
  it("高亮输出仍防注入（代码内 HTML 被转义）", () => {
    const hl = renderMarkdown("```html\n<script>alert(1)</script>\n```", { highlight: true });
    expect(hl).not.toContain("<script>alert");
  });
  it("空输入返回空串", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown(null)).toBe("");
  });
});
