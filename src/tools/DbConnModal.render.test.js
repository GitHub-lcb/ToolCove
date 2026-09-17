// DbConnModal 渲染冒烟：node 环境用 SSR 渲染，兜住视图层回归。
// 曾经写成 `v-for="t in DB_TYPES"` 后又在循环里调用 `t(...)`（即 i18n 的 t），
// 渲染时抛 TypeError: t is not a function —— 弹窗整个不出现，用户看到的是「点新建/连接没反应」。
import { describe, it, expect } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import DbConnModal from "./DbConnModal.vue";
import { DB_TYPES, defaultConn } from "../db.js";

const t = (key, params) => i18n.global.t(key, params);

async function render(overrides = {}) {
  const app = createSSRApp({
    render: () =>
      h(DbConnModal, {
        editing: defaultConn("mysql"),
        editingNew: true,
        ...overrides,
      }),
  });
  app.use(i18n);
  return renderToString(app);
}

describe("DbConnModal 渲染", () => {
  it("渲染出标题与动作按钮", async () => {
    const html = await render();
    expect(html).toContain(t("toolbox.db.connNew"));
    expect(html).toContain(t("toolbox.db.testConn"));
    expect(html).toContain(t("toolbox.db.save"));
  });

  it("每种数据库类型都渲染出本地化名称，而不是裸键", async () => {
    const html = await render();
    expect(DB_TYPES.length).toBeGreaterThan(0);
    for (const type of DB_TYPES) {
      const key = "toolbox.db." + type.labelKey;
      const label = t(key);
      expect(label, `${type.type} 缺词条 ${key}`).not.toBe(key);
      expect(html, type.type).toContain(label);
    }
  });

  it("每种类型的「库名」字段标签也是本地化文案", async () => {
    for (const type of DB_TYPES) {
      const html = await render({ editing: defaultConn(type.type) });
      const key = "toolbox.db." + type.dbLabelKey;
      const label = t(key);
      expect(label, `${type.type} 缺词条 ${key}`).not.toBe(key);
      expect(html, `${type.type} ${key}`).toContain(label);
    }
  });

  it("sqlite 走文件行，其它类型走主机/端口/账号", async () => {
    const sqlite = await render({ editing: defaultConn("sqlite") });
    expect(sqlite).toContain(t("toolbox.db.dbFile"));

    const mysql = await render({ editing: defaultConn("mysql") });
    expect(mysql).toContain(t("toolbox.db.host"));
    expect(mysql).toContain(t("toolbox.db.port"));
    expect(mysql).toContain(t("toolbox.db.rememberPwd"));
  });
});
