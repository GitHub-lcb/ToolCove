// DbTableTree 渲染冒烟：node 环境用 SSR 渲染，兜住视图层回归。
// 曾经写成 `v-for="t in group"` 后又在循环里调用 `t(...)`（即 i18n 的 t），
// 渲染时抛 TypeError: t is not a function —— 连接成功后表结构树整块不出现。
import { describe, it, expect } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import DbTableTree from "./DbTableTree.vue";

const t = (key, params) => i18n.global.t(key, params);
const noop = () => {};

function render(overrides = {}) {
  const app = createSSRApp({
    render: () =>
      h(DbTableTree, {
        meta: { tables: ["users"], columns: {}, loading: false, error: "" },
        tableFilter: "",
        filteredTables: ["users"],
        tableGroups: { table: [{ name: "users", kind: "table" }], view: [] },
        expanded: {},
        loadingCols: {},
        activeConn: { type: "mysql", name: "本地测试库" },
        toggleTable: noop,
        onTreeNameClick: noop,
        quickQuery: noop,
        onTreeCtx: noop,
        openDetail: noop,
        onColCtx: noop,
        insertColumn: noop,
        loadTables: noop,
        ...overrides,
      }),
  });
  app.use(i18n);
  return renderToString(app);
}

describe("DbTableTree 渲染", () => {
  it("渲染出标题与表名，而不是裸键", async () => {
    const html = await render();
    expect(html).toContain(t("toolbox.db.treeTitle"));
    expect(html).toContain(t("toolbox.db.groupTable"));
    expect(html).toContain(t("toolbox.db.filterPh"));
    expect(html).toContain("users");
  });

  it("展开表后渲染列结构与主键标记", async () => {
    const html = await render({
      expanded: { users: true },
      meta: {
        tables: ["users"],
        columns: { users: [{ name: "id", type: "bigint", pk: true, comment: "主键" }] },
        loading: false,
        error: "",
      },
    });
    expect(html).toContain("id");
    expect(html).toContain("bigint");
    expect(html).toContain(t("toolbox.db.pk"));
  });

  it("视图分组与空表列表各自渲染出提示文案", async () => {
    const empty = await render({
      meta: { tables: [], columns: {}, loading: false, error: "" },
      filteredTables: [],
      tableGroups: { table: [], view: [] },
    });
    expect(empty).toContain(t("toolbox.db.noTables"));

    const views = await render({
      tableGroups: { table: [], view: [{ name: "v_sum", kind: "view" }] },
      filteredTables: ["v_sum"],
      meta: { tables: ["v_sum"], columns: {}, loading: false, error: "" },
    });
    expect(views).toContain(t("toolbox.db.groupView"));
    expect(views).toContain("v_sum");
  });
});
