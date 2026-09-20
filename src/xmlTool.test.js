// XML 工具的纯逻辑单测。
//
// 解析器是自己写的，所以**它本身是最大的风险点**：真实报文里的 CDATA、实体、
// 属性值里的 `>`、混合内容、错误定位，都必须逐条钉住。
import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  encodeEntities,
  formatXml,
  jsonToXml,
  minifyXml,
  parseXml,
  queryXPath,
  serializeXml,
  statsXml,
  textOf,
  validateXml,
  xmlToJson,
} from "./xmlTool.js";

/** 取根元素的子元素（测试里常用）。 */
const childrenOf = (xml) => parseXml(xml).root.children.filter((node) => node.type === "element");

describe("解析", () => {
  it("基本元素与文本", () => {
    const { root } = parseXml("<a>你好</a>");
    expect(root.name).toBe("a");
    expect(textOf(root)).toBe("你好");
  });

  it("属性（单引号与双引号都认）", () => {
    const { root } = parseXml(`<a x="1" y='2'/>`);
    expect(root.attrs).toEqual([
      { name: "x", value: "1" },
      { name: "y", value: "2" },
    ]);
    expect(root.selfClosing).toBe(true);
  });

  it("属性值里的 > 不是标签结束（容易写错的一处）", () => {
    const { root } = parseXml(`<a cond="x > 1"/>`);
    expect(root.attrs[0].value).toBe("x > 1");
  });

  it("嵌套与同名子元素", () => {
    const list = childrenOf("<r><i>1</i><i>2</i></r>");
    expect(list.map((node) => textOf(node))).toEqual(["1", "2"]);
  });

  it("注释、处理指令、DOCTYPE 都保留", () => {
    const xml = `<?xml version="1.0"?>\n<!-- 注释 -->\n<!DOCTYPE r SYSTEM "r.dtd">\n<r/>`;
    const { children } = parseXml(xml);
    expect(children.map((node) => node.type)).toEqual(["pi", "text", "comment", "text", "doctype", "text", "element"]);
    expect(children[0].value).toBe('xml version="1.0"');
    expect(children[2].value).toBe(" 注释 ");
  });

  it("CDATA 内容不解析（里面的尖括号是文本）", () => {
    const { root } = parseXml("<a><![CDATA[if (x < 1) { y > 2; }]]></a>");
    expect(root.children[0].type).toBe("cdata");
    expect(root.children[0].value).toBe("if (x < 1) { y > 2; }");
  });

  it("CDATA 里的实体不解码", () => {
    const { root } = parseXml("<a><![CDATA[&amp;]]></a>");
    expect(root.children[0].value).toBe("&amp;");
  });

  it("命名空间前缀当作名字的一部分", () => {
    const { root } = parseXml('<ns:r xmlns:ns="http://x"><ns:i>1</ns:i></ns:r>');
    expect(root.name).toBe("ns:r");
    expect(root.attrs[0]).toEqual({ name: "xmlns:ns", value: "http://x" });
    expect(root.children[0].name).toBe("ns:i");
  });

  it("BOM 必须去掉（否则第一个标签名会带看不见的字符）", () => {
    expect(parseXml("\uFEFF<a/>").root.name).toBe("a");
  });

  it("混合内容保留文本节点顺序", () => {
    const { root } = parseXml("<p>前<b>粗</b>后</p>");
    expect(root.children.map((node) => node.type)).toEqual(["text", "element", "text"]);
    expect(root.children[0].value).toBe("前");
  });

  it("记录行号（界面据此定位）", () => {
    const { root } = parseXml("<a>\n  <b/>\n  <c/>\n</a>");
    expect(root.line).toBe(1);
    expect(root.children.filter((n) => n.type === "element")[1].line).toBe(3);
  });

  it("空输入返回空根（不崩）", () => {
    const { root, children } = parseXml("");
    expect(root).toBeNull();
    expect(children).toEqual([]);
    expect(parseXml(null).root).toBeNull();
  });

  it("多个根元素报错（XML 只允许一个根）", () => {
    const issues = validateXml("<a/><b/>");
    expect(issues[0].code).toBe("multipleRoots");
  });
});

describe("解析错误（带行号与原因码）", () => {
  const codeOf = (xml) => validateXml(xml)[0];

  it("标签不匹配", () => {
    const issue = codeOf("<a><b></c></a>");
    expect(issue.code).toBe("mismatchedTag");
    expect(issue.params).toEqual({ expected: "b", actual: "c" });
  });

  it("元素未闭合", () => {
    expect(codeOf("<a><b></b>").code).toBe("unclosedElement");
    expect(codeOf("<a><b></b>").params).toEqual({ name: "a" });
  });

  it("多余的结束标签", () => {
    expect(codeOf("<a/></b>").code).toBe("strayEndTag");
  });

  it("属性没有值 / 值没加引号", () => {
    expect(codeOf("<a x/>").code).toBe("attributeWithoutValue");
    expect(codeOf("<a x=1/>").code).toBe("attributeNotQuoted");
  });

  it("属性值里的裸 < 是非法字符", () => {
    expect(codeOf('<a x="1 < 2"/>').code).toBe("ltInAttribute");
  });

  it("文本里的裸 < 报错（未转义的尖括号）", () => {
    expect(codeOf("<a>1 < 2</a>").code).toBe("ltInText");
  });

  it("注释 / CDATA / 声明未闭合", () => {
    expect(codeOf("<a><!-- 没闭合</a>").code).toBe("unclosedComment");
    expect(codeOf("<a><![CDATA[没闭合</a>").code).toBe("unclosedCdata");
    expect(codeOf('<a><?pi 没闭合</a>').code).toBe("unclosedPi");
  });

  it("非法标签名", () => {
    expect(codeOf("<1a/>").code).toBe("invalidTagName");
  });

  it("错误带行号与列号", () => {
    const issue = codeOf("<a>\n  <b></c>\n</a>");
    expect(issue.line).toBe(2);
    expect(issue.column).toBeGreaterThan(1);
  });

  it("合法报文没有问题", () => {
    expect(validateXml('<?xml version="1.0"?><r><a x="1">t</a><b/></r>')).toEqual([]);
  });
});

describe("实体", () => {
  it("解码五个预定义实体", () => {
    expect(decodeEntities("&amp;&lt;&gt;&quot;&apos;")).toBe(`&<>"'`);
  });

  it("解码十进制与十六进制数字实体", () => {
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
    expect(decodeEntities("&#x4e2d;")).toBe("中");
  });

  it("不认识的实体原样保留（不猜）", () => {
    expect(decodeEntities("&nbsp;&unknown;")).toBe("&nbsp;&unknown;");
  });

  it("非法码点原样保留", () => {
    expect(decodeEntities("&#xFFFFFFF;")).toBe("&#xFFFFFFF;");
  });

  it("编码时转义 & < >", () => {
    expect(encodeEntities("a&b<c>d")).toBe("a&amp;b&lt;c&gt;d");
  });

  it("文本里的实体在解析时解码", () => {
    expect(textOf(parseXml("<a>&lt;tag&gt; &amp; &#65;</a>").root)).toBe("<tag> & A");
  });
});

describe("格式化与压缩", () => {
  const messy = `<?xml version="1.0"?><r><a x="1"><b>1</b><b>2</b></a><c/></r>`;

  it("按层级缩进，属性保持一行", () => {
    const out = formatXml(messy).split("\n");
    expect(out[0]).toBe('<?xml version="1.0"?>');
    expect(out[1]).toBe('<r>');
    expect(out[2]).toBe('  <a x="1">');
    expect(out[3]).toBe("    <b>1</b>");
    expect(out[5]).toBe("  </a>");
    expect(out[6]).toBe("  <c/>");
  });

  it("只有文本的元素放在同一行（比拆三行可读）", () => {
    expect(formatXml("<a><b>张三</b></a>")).toContain("<b>张三</b>");
  });

  it("声明与根元素之间不产生空行（空白文本节点不输出）", () => {
    // 源码里声明与根元素之间通常有换行，那个空白文本节点不该变成空行
    const out = formatXml('<?xml version="1.0"?>\n<r><a/></r>').split("\n");
    expect(out[0]).toBe('<?xml version="1.0"?>');
    expect(out[1]).toBe("<r>");
    expect(out).not.toContain("");
  });

  it("混合内容里的空白文本保留（它是内容的一部分）", () => {
    expect(formatXml("<p>前 <b>粗</b> 后</p>")).toContain("前 <b>粗</b> 后");
  });

  it("混合内容不缩进（缩进会改变文本内容）", () => {
    // `<p>前<b>粗</b>后</p>` 加换行会让文本变成 "前\n  粗\n  后"
    expect(formatXml("<p>前<b>粗</b>后</p>")).toContain("<p>前<b>粗</b>后</p>");
  });

  it("缩进宽度可配，0 表示紧凑", () => {
    expect(formatXml("<r><a/></r>", { indent: 4 })).toContain("    <a/>");
    expect(formatXml("<r><a/></r>", { indent: 0 })).toBe("<r><a/></r>");
  });

  it("压缩：去掉标签间空白与注释", () => {
    const out = minifyXml("<r>\n  <!-- 注释 -->\n  <a>1</a>\n  <b/>\n</r>");
    expect(out).toBe("<r><a>1</a><b/></r>");
  });

  it("压缩不改变文本内容", () => {
    expect(minifyXml("<a> 空格 保留 </a>")).toBe("<a> 空格 保留 </a>");
  });

  it("往返一致：格式化 → 解析 → 数据相同", () => {
    const formatted = formatXml(messy);
    expect(xmlToJson(formatted)).toEqual(xmlToJson(messy));
  });

  it("属性值里的引号在序列化时转义", () => {
    const { root } = parseXml(`<a x='say "hi"'/>`);
    expect(serializeXml([root], { indent: 0 })).toBe('<a x="say &quot;hi&quot;"/>');
  });

  it("CDATA 原样保留（不转义）", () => {
    expect(formatXml("<a><![CDATA[x < 1]]></a>")).toContain("<![CDATA[x < 1]]>");
  });
});

describe("XML → JSON", () => {
  it("纯文本元素直接是字符串（最常见报文转出来最干净）", () => {
    expect(xmlToJson("<r><name>张三</name><age>20</age></r>")).toEqual({ r: { name: "张三", age: "20" } });
  });

  it("属性加 @ 前缀", () => {
    expect(xmlToJson('<r><i id="1">甲</i></r>')).toEqual({ r: { i: { "@id": "1", "#text": "甲" } } });
  });

  it("同名子元素重复出现变成数组", () => {
    expect(xmlToJson("<r><i>1</i><i>2</i></r>")).toEqual({ r: { i: ["1", "2"] } });
  });

  it("alwaysArray 让单个元素也是数组", () => {
    expect(xmlToJson("<r><i>1</i></r>", { alwaysArray: true })).toEqual({ r: { i: ["1"] } });
  });

  it("CDATA 进 #text", () => {
    expect(xmlToJson("<r><code><![CDATA[x<1]]></code></r>")).toEqual({ r: { code: "x<1" } });
  });

  it("混合内容的文本进 #text", () => {
    expect(xmlToJson('<r><p>前<b>粗</b></p></r>')).toEqual({ r: { p: { "#text": "前", b: "粗" } } });
  });

  it("空元素是空串", () => {
    expect(xmlToJson("<r><a/></r>")).toEqual({ r: { a: "" } });
  });

  it("空输入返回空对象", () => {
    expect(xmlToJson("")).toEqual({});
  });
});

describe("JSON → XML", () => {
  it("基本往返", () => {
    const xml = jsonToXml({ name: "张三", age: "20" }, { root: "r", declaration: false });
    expect(xml).toContain("<r>");
    expect(xml).toContain("<name>张三</name>");
    expect(xml).toContain("<age>20</age>");
  });

  it("@ 前缀变回属性，#text 变回文本", () => {
    const xml = jsonToXml({ i: { "@id": "1", "#text": "甲" } }, { root: "r", declaration: false, indent: 0 });
    expect(xml).toBe('<r><i id="1">甲</i></r>');
  });

  it("数组变回重复元素", () => {
    const xml = jsonToXml({ i: ["1", "2"] }, { root: "r", declaration: false, indent: 0 });
    expect(xml).toBe("<r><i>1</i><i>2</i></r>");
  });

  it("null 变空元素", () => {
    expect(jsonToXml({ a: null }, { root: "r", declaration: false, indent: 0 })).toBe("<r><a/></r>");
  });

  it("特殊字符被转义", () => {
    const xml = jsonToXml({ a: "x<1 & y>2" }, { root: "r", declaration: false, indent: 0 });
    expect(xml).toContain("x&lt;1 &amp; y&gt;2");
  });

  it("带声明时加上 XML 头", () => {
    expect(jsonToXml({ a: "1" }, { root: "r" })).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
  });

  it("往返一致：XML → JSON → XML → JSON", () => {
    const source = '<r><i id="1">甲</i><i id="2">乙</i><n>20</n></r>';
    const json = xmlToJson(source);
    const back = jsonToXml(json, { root: "r" });
    expect(xmlToJson(back)).toEqual(json);
  });
});

describe("XPath 子集", () => {
  const xml = `<r>
    <dept name="仓储">
      <emp id="1">张三</emp>
      <emp id="2">李四</emp>
    </dept>
    <dept name="订单">
      <emp id="3">王五</emp>
    </dept>
  </r>`;

  it("绝对路径", () => {
    expect(queryXPath(xml, "/r/dept").length).toBe(2);
  });

  it("任意深度 //", () => {
    expect(queryXPath(xml, "//emp").map(textOf)).toEqual(["张三", "李四", "王五"]);
  });

  it("取属性值", () => {
    expect(queryXPath(xml, "//emp/@id")).toEqual(["1", "2", "3"]);
  });

  it("属性条件", () => {
    expect(queryXPath(xml, '//emp[@id="2"]').map(textOf)).toEqual(["李四"]);
  });

  it("子元素文本条件", () => {
    expect(queryXPath(xml, "//dept[emp='王五']").map((node) => node.attrs[0].value)).toEqual(["订单"]);
  });

  it("通配符", () => {
    expect(queryXPath(xml, "/r/*").length).toBe(2);
  });

  it("位置下标（XPath 从 1 开始）", () => {
    expect(queryXPath(xml, "//emp[1]").map(textOf)).toEqual(["张三"]);
  });

  it("找不到返回空数组（不抛错）", () => {
    expect(queryXPath(xml, "//nope")).toEqual([]);
    expect(queryXPath(xml, "")).toEqual([]);
  });

  it("带命名空间前缀的元素名能查到", () => {
    const ns = '<ns:r xmlns:ns="http://x"><ns:i>1</ns:i></ns:r>';
    expect(queryXPath(ns, "//ns:i").map(textOf)).toEqual(["1"]);
  });
});

describe("统计", () => {
  const xml = '<r a="1"><x>文本</x><x/><y><z/></y></r>';

  it("元素/属性/深度/不同名称都算对", () => {
    const result = statsXml(xml);
    expect(result.elements).toBe(5); // r, x, x, y, z
    expect(result.attributes).toBe(1);
    expect(result.depth).toBe(3); // r > y > z
    expect(result.distinctNames).toBe(4); // r, x, y, z
    expect(result.names.sort()).toEqual(["r", "x", "y", "z"]);
  });

  it("文本长度包含 CDATA", () => {
    expect(statsXml("<r><a><![CDATA[12345]]></a></r>").textLength).toBe(5);
  });
});
