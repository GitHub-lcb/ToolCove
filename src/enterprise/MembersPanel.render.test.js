// 成员/席位管理块的渲染冒烟：node 环境用 SSR 渲染。
// 这一块在设置页「管理」段深处（整体渲染看不到它），所以单独渲染组件来断言，
// 与 report/WeeklySchedulePanel.render.test.js 同一范式。
import { describe, it, expect } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import MembersPanel from "./MembersPanel.vue";

const t = (key, params) => i18n.global.t(key, params);

const MEMBERS = [
  { id: "m1", name: "张三", role: "admin", createdAt: 1 },
  { id: "m2", name: "李四", role: "member", createdAt: 2 },
];

async function render(props) {
  const app = createSSRApp({ render: () => h(MembersPanel, props) });
  app.use(i18n);
  return renderToString(app);
}

/** 统计 needle 出现次数（用于断言「有几个按钮处于禁用态」）。 */
const count = (html, needle) => html.split(needle).length - 1;

describe("MembersPanel 渲染", () => {
  it("管理员视图：标题、说明、添加表单与撤销文案齐全", async () => {
    const html = await render({ members: MEMBERS, isAdmin: true });
    for (const key of ["settings.members", "settings.membersHint", "settings.memberName", "settings.memberRole", "settings.memberAdd", "settings.memberRevoke"]) {
      expect(html, key).toContain(t(key));
    }
  });

  it("名册逐行渲染成员名与角色标签", async () => {
    const html = await render({ members: MEMBERS, isAdmin: true });
    expect(html).toContain("张三");
    expect(html).toContain("李四");
    expect(html).toContain(t("settings.memberRoleAdmin"));
    expect(html).toContain(t("settings.memberRoleMember"));
    // 两个成员 → 两个撤销按钮
    expect(count(html, t("settings.memberRevoke"))).toBe(2);
  });

  it("空态：名册为空时显示空态文案且没有撤销按钮", async () => {
    const html = await render({ members: [], isAdmin: true });
    expect(html).toContain(t("settings.membersEmpty"));
    expect(html).not.toContain(t("settings.memberRevoke"));
  });

  it("非管理员：整块显示原因提示而不是隐藏（不渲染名册与添加表单）", async () => {
    const html = await render({ members: MEMBERS, isAdmin: false });
    expect(html).toContain(t("settings.membersForbidden"));
    expect(html).not.toContain(t("settings.membersHint"));
    expect(html).not.toContain(t("settings.memberAdd"));
    expect(html).not.toContain("张三");
  });

  it("新令牌区：渲染令牌与「只显示一次」提示，并提供复制/关闭", async () => {
    const html = await render({ members: MEMBERS, isAdmin: true, newToken: "tc_abc123" });
    expect(html).toContain(t("settings.memberTokenOnce"));
    expect(html).toContain(t("settings.memberCopyToken"));
    expect(html).toContain(t("settings.memberTokenClose"));
    expect(html).toContain("tc_abc123");
    // 没有令牌时不渲染该区
    const bare = await render({ members: MEMBERS, isAdmin: true });
    expect(bare).not.toContain(t("settings.memberTokenOnce"));
  });

  it("按钮禁用态：name 为空不可添加；撤销自己时禁用该行；busy 时全部禁用", async () => {
    // 初始 name 为空 → 添加按钮禁用；两个成员但都不是自己 → 只有 1 个 disabled
    const empty = await render({ members: MEMBERS, isAdmin: true });
    expect(empty).toContain(t("settings.memberAdd"));
    expect(count(empty, "disabled")).toBe(1);

    // 自身名与其中一个成员一致 → 该行撤销按钮也被禁用（2 个 disabled）
    const self = await render({ members: MEMBERS, isAdmin: true, selfName: "张三" });
    expect(count(self, "disabled")).toBe(2);
    expect(self).toContain(t("settings.memberCannotRevokeSelf"));

    // busy 时添加与两个撤销按钮全部禁用（3 个 disabled）
    const busy = await render({ members: MEMBERS, isAdmin: true, selfName: "张三", busy: true });
    expect(count(busy, "disabled")).toBe(3);
  });

  it("不把未注册的 i18n 键原文漏到界面上", async () => {
    const html = await render({ members: MEMBERS, isAdmin: true, newToken: "tc_x" });
    expect(html).not.toMatch(/settings\.[A-Za-z]/);
    expect(html).not.toContain("undefined");
  });
});
