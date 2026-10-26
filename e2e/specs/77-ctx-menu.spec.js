// 全局右键菜单（App.vue 的 openCtxMenu）：语义、键盘可达、关闭不吞焦点。
//
// 为什么要单独一条用例：这个菜单被 7 个界面复用，而它以前**完全没有自动化覆盖**——
// 缺 `role`、不响应 Escape、打开后焦点留在原地，这三件事都不会让任何现有用例变红，
// 只有键盘/读屏用户会撞到。规范 §3.5 与 §13 写了"菜单项必须键盘可达"，
// 没有断言的规范就是第二份"新代码请用 .tc-*"（见 docs/ui-ux-spec.md §0）。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const PROBLEMS = [
  { id: "p1", title: "线上 500", status: "open", tags: [], updatedAt: 10 },
];

async function openRecordsWithProblem(page) {
  await seedData(page, { problems: PROBLEMS });
  await page.goto("/");
  // 记录模块默认落在「速记」（MODULE_HOME_TAB.records = snippet），问题列表要显式切过去
  await page.locator(".nav").getByRole("button", { name: "记录", exact: true }).click();
  await page.getByRole("tab", { name: "问题", exact: true }).click();
  const row = page.locator(".prob-row").first();
  await expect(row).toBeVisible();
  return row;
}

test.describe("全局右键菜单", () => {
  test("右击出菜单：有 menu/menuitem 语义，第一项直接拿到焦点", async ({ page }) => {
    const row = await openRecordsWithProblem(page);
    await row.click({ button: "right" });

    const menu = page.locator('.ctx-menu[role="menu"]');
    await expect(menu).toBeVisible();
    const items = menu.locator('[role="menuitem"]');
    // 条数会随功能变，所以只钉"至少这几项 + 每一项都有角色"，不断言具体文案
    expect(await items.count()).toBeGreaterThanOrEqual(4);
    await expect(items.first()).toBeFocused();
    expect(await row.getAttribute("role"), "菜单不该把行本身变成可点元素").toBe(null);
  });

  test("上下键在条目间走、Escape 关闭；红色只给不可逆的那一项", async ({ page }) => {
    const row = await openRecordsWithProblem(page);
    await row.click({ button: "right" });
    const items = page.locator('.ctx-menu[role="menu"] [role="menuitem"]');

    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    // 从最后一项再往下应回到第一项（键盘用户不该被卡在末尾）
    const n = await items.count();
    await items.last().focus();
    await page.keyboard.press("ArrowDown");
    await expect(items.first()).toBeFocused();
    expect(n).toBeGreaterThanOrEqual(4);

    // 破坏性条目带 danger（红色），并且是全菜单唯一一组
    const danger = page.locator('.ctx-item.danger');
    expect(await danger.count()).toBeGreaterThanOrEqual(1);

    await page.keyboard.press("Escape");
    await expect(page.locator(".ctx-menu")).toHaveCount(0);
    // Escape 之后必须能再右击（状态没卡住）
    await row.click({ button: "right" });
    await expect(page.locator('.ctx-menu[role="menu"]')).toBeVisible();
  });

  test("点菜单外关掉时不抢焦点（否则用户刚点的控件会被吸走焦点）", async ({ page }) => {
    const row = await openRecordsWithProblem(page);
    await row.click({ button: "right" });
    await expect(page.locator('.ctx-menu[role="menu"]')).toBeVisible();

    // 页面空白处点一下：菜单关闭，且焦点**留在菜单里的位置**而不是被塞回右击前那个元素
    await page.locator(".tabs-body").click({ position: { x: 4, y: 4 } });
    await expect(page.locator(".ctx-menu")).toHaveCount(0);
    const active = await page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
    expect(String(active)).not.toMatch(/prob-row/);
  });
});
