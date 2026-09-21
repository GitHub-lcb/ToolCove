// 表格工具的纯逻辑单测。
//
// 重点覆盖**真实脏数据**：Excel 导出的 BOM、字段里的逗号与换行、引号转义、
// 混合行尾、重复列名——这些是"看着对、实际解析错"的高发区。
import { describe, expect, it } from "vitest";
import {
  DELIMITERS,
  MAP_MIN_SCORE,
  MAP_NO_TARGET,
  MAX_ROWS,
  buildHeaderMapRequest,
  dedupeKeys,
  dedupeRows,
  detectDelimiter,
  filterRows,
  parseDelimited,
  parseHeaderMapResponse,
  parseTargetFields,
  removeEmptyRows,
  renameHeaders,
  selectColumns,
  sortRows,
  stats,
  toDelimited,
  toJson,
  toMarkdown,
  toSqlInsert,
} from "./tableTool.js";

describe("解析分隔文本", () => {
  it("基本解析", () => {
    const { rows } = parseDelimited("a,b,c\n1,2,3");
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("引号里的分隔符不当分隔符（Excel 导出的地址列就是这样）", () => {
    const { rows } = parseDelimited('name,address\n张三,"北京市,朝阳区,100号"');
    expect(rows[1]).toEqual(["张三", "北京市,朝阳区,100号"]);
  });

  it("引号转义（两个引号 = 一个字面引号）", () => {
    const { rows } = parseDelimited('a\n"他说""你好"""');
    expect(rows[1][0]).toBe('他说"你好"');
  });

  it("字段里含换行（多行单元格）", () => {
    const { rows } = parseDelimited('a,b\n"第一行\n第二行",x');
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe("第一行\n第二行");
    expect(rows[1][1]).toBe("x");
  });

  it("CRLF 与 LF 混用都算一次换行", () => {
    const { rows } = parseDelimited("a,b\r\n1,2\n3,4\r\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("以换行结尾不会多出一个空行", () => {
    expect(parseDelimited("a,b\n1,2\n").rows).toHaveLength(2);
    expect(parseDelimited("a,b\n1,2").rows).toHaveLength(2);
  });

  it("BOM 必须去掉（Excel 另存 CSV 必带，不去掉第一列会多个看不见的字符）", () => {
    const { rows } = parseDelimited("\uFEFFid,name\n1,张三");
    expect(rows[0][0]).toBe("id");
    // 关键：不能是 "\uFEFFid"
    expect(rows[0][0].length).toBe(2);
  });

  it("字段中间的引号是普通字符（不是引用开始）", () => {
    const { rows } = parseDelimited('a\nab"cd');
    expect(rows[1][0]).toBe('ab"cd');
  });

  it("空字段与空行都保留结构", () => {
    const { rows } = parseDelimited("a,,c\n,,");
    expect(rows[0]).toEqual(["a", "", "c"]);
    expect(rows[1]).toEqual(["", "", ""]);
  });

  it("空输入返回空表（不崩）", () => {
    expect(parseDelimited("").rows).toEqual([]);
    expect(parseDelimited(null).rows).toEqual([]);
    expect(parseDelimited(undefined).rows).toEqual([]);
  });

  it("超长输入被截断并标记（不让界面卡死）", () => {
    const text = Array.from({ length: MAX_ROWS + 50 }, (_, i) => `${i},x`).join("\n");
    const result = parseDelimited(text);
    expect(result.rows).toHaveLength(MAX_ROWS);
    expect(result.truncated).toBe(true);
    // totalRows 仍报真实行数，界面据此提示"还有多少没显示"
    expect(result.totalRows).toBe(MAX_ROWS + 50);
  });

  it("支持制表符与分号（TSV / 欧洲区 CSV）", () => {
    expect(parseDelimited("a\tb\n1\t2", "\t").rows[1]).toEqual(["1", "2"]);
    expect(parseDelimited("a;b\n1;2", ";").rows[1]).toEqual(["1", "2"]);
  });
});

describe("嗅探分隔符", () => {
  it("逗号", () => {
    expect(detectDelimiter("a,b,c\n1,2,3\n4,5,6")).toBe(",");
  });

  it("制表符（从 Excel 复制粘贴过来最常见）", () => {
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });

  it("分号与竖线", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a|b|c\n1|2|3")).toBe("|");
  });

  it("内容里的逗号不该误导嗅探（引号包裹的地址列）", () => {
    // 这个输入用制表符分隔，但内容里有大量逗号——按"数出现次数"会误判成逗号
    const text = 'name\taddress\n张三\t"北京市,朝阳区"\n李四\t"上海市,浦东新区"';
    expect(detectDelimiter(text)).toBe("\t");
  });

  it("单列文本回落到逗号（没有分隔符可嗅探）", () => {
    expect(detectDelimiter("只有一列\n第二行")).toBe(",");
    expect(detectDelimiter("")).toBe(",");
  });

  it("候选列表非空且都只有一个字符", () => {
    expect(DELIMITERS.length).toBeGreaterThan(3);
    for (const item of DELIMITERS) expect(item.char.length).toBe(1);
  });
});

describe("序列化回分隔文本", () => {
  it("含分隔符/引号/换行的字段会被加引号（否则解析不回来）", () => {
    const rows = [["a", "b,c", 'd"e', "f\ng"]];
    expect(toDelimited(rows)).toBe('a,"b,c","d""e","f\ng"');
  });

  it("往返一致：解析 → 序列化 → 再解析，结果相同", () => {
    const original = 'name,note\n张三,"含,逗号"\n李四,"含""引号"""\n王五,"含\n换行"';
    const first = parseDelimited(original).rows;
    const again = parseDelimited(toDelimited(first)).rows;
    expect(again).toEqual(first);
  });

  it("可指定行尾与结尾换行", () => {
    expect(toDelimited([["a"], ["b"]], { eol: "\r\n" })).toBe("a\r\nb");
    expect(toDelimited([["a"]], { trailingNewline: true })).toBe("a\n");
    expect(toDelimited([], { trailingNewline: true })).toBe("");
  });
});

describe("表头去重", () => {
  it("空列名给占位，重名加序号（否则后一列会静默覆盖前一列）", () => {
    expect(dedupeKeys(["id", "", "name", "id", "id"])).toEqual(["id", "col2", "name", "id_2", "id_3"]);
  });

  it("列名两端空白会被去掉", () => {
    expect(dedupeKeys([" id ", "name "])).toEqual(["id", "name"]);
  });
});

describe("转 JSON", () => {
  it("表头当键名，输出对象数组", () => {
    const rows = [
      ["id", "name"],
      ["1", "张三"],
    ];
    expect(JSON.parse(toJson(rows))).toEqual([{ id: "1", name: "张三" }]);
  });

  it("重名列不会丢数据（去重后各占一个键）", () => {
    const rows = [
      ["id", "id"],
      ["1", "2"],
    ];
    expect(JSON.parse(toJson(rows))).toEqual([{ id: "1", id_2: "2" }]);
  });

  it("缺列的行补空串（而不是 undefined）", () => {
    const rows = [
      ["a", "b", "c"],
      ["1"],
    ];
    expect(JSON.parse(toJson(rows))).toEqual([{ a: "1", b: "", c: "" }]);
  });

  it("header=false 时输出二维数组", () => {
    expect(JSON.parse(toJson([["1", "2"]], { header: false }))).toEqual([["1", "2"]]);
  });

  it("空表输出空数组", () => {
    expect(toJson([])).toBe("[]");
    expect(toJson([["a", "b"]])).toBe("[]"); // 只有表头没有数据
  });
});

describe("转 Markdown", () => {
  it("生成表头分隔行与数据行", () => {
    const md = toMarkdown([
      ["id", "name"],
      ["1", "张三"],
    ]);
    expect(md.split("\n")).toEqual(["| id | name |", "| --- | --- |", "| 1 | 张三 |"]);
  });

  it("竖线与换行要转义（否则表格错列）", () => {
    const md = toMarkdown([
      ["a", "b"],
      ["x|y", "p\nq"],
    ]);
    expect(md).toContain("x\\|y");
    expect(md).toContain("p q");
  });

  it("列数不齐时按最宽的行补齐", () => {
    const md = toMarkdown([
      ["a", "b", "c"],
      ["1"],
    ]);
    expect(md.split("\n")[2]).toBe("| 1 |  |  |");
  });

  it("空表返回空串", () => {
    expect(toMarkdown([])).toBe("");
  });
});

describe("转 SQL INSERT", () => {
  it("生成带列名的插入语句", () => {
    const sql = toSqlInsert(
      [
        ["id", "name"],
        ["1", "张三"],
      ],
      { table: "users" }
    );
    expect(sql).toContain("INSERT INTO `users` (`id`, `name`) VALUES");
    expect(sql).toContain("('1', '张三')");
  });

  it("单引号要转义（否则 SQL 注入 + 语法错）", () => {
    const sql = toSqlInsert([["name"], ["O'Brien"]], { table: "t", header: false });
    expect(sql).toContain("'O''Brien'");
  });

  it("值一律按字符串处理（不推断类型——推断会把 007 变成 7、空串变成 NULL）", () => {
    const sql = toSqlInsert([["a", "b"], ["007", ""]], { table: "t" });
    expect(sql).toContain("('007', '')");
    expect(sql).not.toContain("NULL");
  });

  it("非法表名被替换成安全值（表名无法参数化）", () => {
    const sql = toSqlInsert([["a"], ["1"]], { table: "users; DROP TABLE x", header: false });
    expect(sql).toContain("INSERT INTO `t`");
    expect(sql).not.toContain("DROP TABLE");
  });

  it("分批插入（避免单条语句过长）", () => {
    const rows = [["a"], ...Array.from({ length: 250 }, (_, i) => [String(i)])];
    const sql = toSqlInsert(rows, { table: "t", batchSize: 100 });
    expect(sql.match(/INSERT INTO/g)).toHaveLength(3); // 100 + 100 + 50
  });

  it("空表返回空串", () => {
    expect(toSqlInsert([])).toBe("");
  });
});

describe("统计", () => {
  it("行/列/空单元格/重复行都算出来", () => {
    const rows = [
      ["id", "name"],
      ["1", "张三"],
      ["1", "张三"],
      ["2", ""],
    ];
    const result = stats(rows);
    expect(result.rows).toBe(3);
    expect(result.columns).toBe(2);
    expect(result.empty).toBe(1);
    expect(result.duplicates).toBe(1);
  });

  it("header=false 时数据行包含第一行", () => {
    expect(stats([["1", "a"]], { header: false }).rows).toBe(1);
    expect(stats([["1", "a"]], { header: true }).rows).toBe(0);
  });

  it("记录最长单元格长度（判断有没有超长字段）", () => {
    expect(stats([["a"], ["12345"]], { header: false }).longest).toBe(5);
  });
});

describe("排序", () => {
  const rows = [
    ["name", "count"],
    ["b", "9"],
    ["a", "10"],
    ["c", ""],
  ];

  it("文本升序", () => {
    const sorted = sortRows(rows, 0, "asc");
    expect(sorted.slice(1).map((r) => r[0])).toEqual(["a", "b", "c"]);
  });

  it("数字列按数值比（否则 10 会排在 9 前面）", () => {
    const sorted = sortRows(rows, 1, "asc", { numeric: true });
    // 空值恒在最后
    expect(sorted.slice(1).map((r) => r[1])).toEqual(["9", "10", ""]);
  });

  it("降序", () => {
    expect(sortRows(rows, 0, "desc").slice(1).map((r) => r[0])).toEqual(["c", "b", "a"]);
  });

  it("表头保持在第一行（不参与排序）", () => {
    expect(sortRows(rows, 0, "desc")[0]).toEqual(["name", "count"]);
  });

  it("不改动原数组（纯函数）", () => {
    const before = JSON.stringify(rows);
    sortRows(rows, 0, "desc");
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("去重与清洗", () => {
  it("去重保留首次出现，表头不动", () => {
    const rows = [
      ["id"],
      ["1"],
      ["2"],
      ["1"],
    ];
    expect(dedupeRows(rows)).toEqual([["id"], ["1"], ["2"]]);
  });

  it("删全空行（导出文件尾部常见噪声）", () => {
    const rows = [
      ["id", "name"],
      ["1", "a"],
      ["", ""],
      ["  ", ""],
      ["2", "b"],
    ];
    expect(removeEmptyRows(rows)).toEqual([
      ["id", "name"],
      ["1", "a"],
      ["2", "b"],
    ]);
  });

  it("按列裁剪保留列序", () => {
    const rows = [
      ["a", "b", "c"],
      ["1", "2", "3"],
    ];
    expect(selectColumns(rows, [2, 0])).toEqual([
      ["c", "a"],
      ["3", "1"],
    ]);
  });

  it("裁剪时越界索引被忽略（不产生 undefined 列）", () => {
    expect(selectColumns([["a"]], [0, 9])).toEqual([["a", ""]]);
  });
});

describe("过滤", () => {
  const rows = [
    ["name", "city"],
    ["张三", "北京"],
    ["李四", "上海"],
    ["王五", ""],
  ];

  it("包含匹配（大小写不敏感）", () => {
    expect(filterRows(rows, { columnIndex: 1, op: "contains", value: "北" }).slice(1)).toEqual([["张三", "北京"]]);
  });

  it("等值匹配", () => {
    expect(filterRows(rows, { columnIndex: 1, op: "equals", value: "上海" }).slice(1)).toEqual([["李四", "上海"]]);
  });

  it("非空匹配（清洗空值时用）", () => {
    expect(filterRows(rows, { columnIndex: 1, op: "notEmpty" }).slice(1)).toHaveLength(2);
  });

  it("表头不参与过滤", () => {
    expect(filterRows(rows, { columnIndex: 0, op: "contains", value: "name" })[0]).toEqual(["name", "city"]);
  });
});

// ———— 表头语义映射（Jev 的 Choice 逐列一问）————
// 断言口径：只验**请求形状与解析规则**，模型答得准不准不在单测里（那要靠真实端点跑）。
describe("表头语义映射", () => {
  const headers = ["客户联系", "下单金额(RMB)", "uid", "备注"];
  const body = [
    ["13800001111", "12.50", "u-9", "先发货"],
    ["zhang@example.com", "1,200", "u-10", ""],
    ["", "0.00", "u-11", "同上"],
  ];
  const targets = ["email", "amount", "user_id"];

  it("目标字段清单：多种分隔符都认，去空去重限量", () => {
    expect(parseTargetFields("email, amount；user_id\nemail | ")).toEqual(["email", "amount", "user_id"]);
    expect(parseTargetFields("a,b;c", 2)).toEqual(["a", "b"]);
    expect(parseTargetFields("   ")).toEqual([]);
  });

  it("每列一问，选项键是 t0/t1… 而不是字段原文", () => {
    const built = buildHeaderMapRequest({ headers, rows: body, targets });
    const question = built.body.questions["map::0"];
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria)).toEqual(["t0", "t1", "t2", MAP_NO_TARGET]);
    expect(question.criteria.t0).toContain("email");
    // 出口必须有：Choice 概率总和恒为 1，没有「都不对应」就必然硬选一个
    expect(question.criteria[MAP_NO_TARGET]).toBeTruthy();
    expect(question.instructions).toContain("state.columns[0]");
  });

  it("样本进 state：判断「这列是什么」靠的是值，不是列名", () => {
    const built = buildHeaderMapRequest({ headers, rows: body, targets });
    expect(built.body.state.columns[0].samples).toEqual(["13800001111", "zhang@example.com"]);
    expect(built.body.state.columns[0].header).toBe("客户联系");
    // 第三行与表头同名的值不算样本
    expect(built.body.state.columns[3].samples).toEqual(["先发货", "同上"]);
  });

  it("没表头或没目标字段就不发请求", () => {
    expect(buildHeaderMapRequest({ headers: [], rows: body, targets })).toBe(null);
    expect(buildHeaderMapRequest({ headers, rows: body, targets: [] })).toBe(null);
    expect(buildHeaderMapRequest()).toBe(null);
  });

  it("列数与目标数都有上限（超了分批，而不是把 token 顶穿）", () => {
    const many = Array.from({ length: 40 }, (_, i) => `列${i}`);
    const built = buildHeaderMapRequest({ headers: many, rows: [], targets });
    expect(built.columns).toHaveLength(24);
    expect(Object.keys(built.body.questions)).toHaveLength(24);
    const wide = Array.from({ length: 30 }, (_, i) => `f${i}`);
    expect(buildHeaderMapRequest({ headers, rows: body, targets: wide }).targets).toHaveLength(16);
  });

  const choiceAnswer = (map) => ({
    answers: Object.fromEntries(
      Object.entries(map).map(([index, [choice, score]]) => [
        `map::${index}`,
        { type: "choice", choice, probabilities: { [choice]: score } },
      ])
    ),
  });

  it("解析成 { index, from, to, score }，只采纳明确对上的列", () => {
    const built = buildHeaderMapRequest({ headers, rows: body, targets });
    const map = parseHeaderMapResponse(built, choiceAnswer({ 0: ["t0", 0.93], 2: ["t2", 0.8] }));
    expect(map).toEqual([
      { index: 0, from: "客户联系", to: "email", score: 0.93 },
      { index: 2, from: "uid", to: "user_id", score: 0.8 },
    ]);
  });

  it("「都不对应」、低于下限、没答、答了未知键——一律不改", () => {
    const built = buildHeaderMapRequest({ headers, rows: body, targets });
    expect(parseHeaderMapResponse(built, choiceAnswer({ 0: [MAP_NO_TARGET, 0.6], 1: ["t1", MAP_MIN_SCORE - 0.1], 3: ["t9", 0.99] }))).toEqual([]);
    expect(parseHeaderMapResponse(built, { answers: {} })).toEqual([]);
    expect(parseHeaderMapResponse(built, null)).toEqual([]);
    // 概率缺失只算 0：没有证据就不改名
    expect(parseHeaderMapResponse(built, { answers: { "map::0": { type: "choice", choice: "t0" } } })).toEqual([]);
  });

  it("改成同一个目标名的两列会被去重，否则导出 JSON 会丢列", () => {
    const built = buildHeaderMapRequest({ headers, rows: body, targets });
    const map = parseHeaderMapResponse(built, choiceAnswer({ 0: ["t0", 0.95], 3: ["t0", 0.9] }));
    expect(map).toHaveLength(2);
    expect(dedupeKeys(renameHeaders([headers, ...body], map)[0])).toEqual(renameHeaders([headers, ...body], map)[0]);
  });

  it("renameHeaders 只动表头行，数据一字不变", () => {
    const rows = [headers, ...body];
    const next = renameHeaders(rows, [{ index: 1, to: "amount" }, { index: 99, to: "ghost" }]);
    expect(next[0]).toEqual(["客户联系", "amount", "uid", "备注"]);
    expect(next.slice(1)).toEqual(body);
    expect(rows[0]).toEqual(headers); // 原数组不被改
  });

  it("没有表头的数据不做映射", () => {
    expect(renameHeaders(body, [{ index: 0, to: "x" }], { header: false })).toEqual(body);
  });

  it("默认下限是个真实门槛（0.5），不是随手写的小数", () => {
    expect(MAP_MIN_SCORE).toBeGreaterThanOrEqual(0.4);
  });
});
