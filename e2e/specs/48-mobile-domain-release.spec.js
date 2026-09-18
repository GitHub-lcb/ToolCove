// 领域与发布 E2E（移动视口）。
//
// 这两个面板是工作台的后两个分段（与桌面端 work 模块的入口对应）。
// 数据模型与纯逻辑与桌面端共用：domains / pools 两个集合、release-pools 的 {active, archived}
// 对象，状态徽标与步骤进度直接用 src/publishState.js——所以这里断言的判定口径与桌面端一致。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

const DOMAINS = [
  { id: "d1", name: "仓储域", note: "WMS 相关", createdAt: 1, updatedAt: 1 },
  { id: "d2", name: "订单域", note: "", createdAt: 1, updatedAt: 1 },
];

const POOLS = [
  { id: "p1", domainId: "d1", name: "warehouse.wms.outward.api", note: "出库接口", path: "C:\\code\\wms", createdAt: 1, updatedAt: 1 },
  { id: "p2", domainId: "d1", name: "warehouse.wms.inward.api", note: "", path: "", createdAt: 1, updatedAt: 1 },
  { id: "p3", domainId: "d2", name: "order.core.api", note: "", path: "", createdAt: 1, updatedAt: 1 },
];

/**
 * 发布池的存储键是 **`release-pools`**（repository 的 releases 类别 → key: "release-pools"），
 * 不是 `releases`——seedData 把 entries 的键原样写进 IndexedDB，所以这里必须用真实键名。
 * （我一开始传 `releases`，结果是"列表 0 条"，排查了一轮。）
 */
const RELEASES = {
  active: [
    { id: "r1", name: "online.wms.outward", deployType: "container", createdAt: 1, updatedAt: 1, lastRelease: { status: "done", steps: [{ key: "pack", done: true }, { key: "upload", done: true }, { key: "release", done: true }, { key: "verify", done: true }] } },
    { id: "r2", name: "wms.inward", deployType: "host", createdAt: 1, updatedAt: 1, lastRelease: { status: "doing", steps: [{ key: "pack", done: true }, { key: "upload", done: false }] } },
    { id: "r3", name: "order.core", createdAt: 1, updatedAt: 1 },
  ],
  archived: [{ id: "r9", name: "old.service", createdAt: 1, updatedAt: 1 }],
};

/** 种发布池：用真实存储键。 */
const seedReleases = (page, value = RELEASES) => seedData(page, { "release-pools": value });

const goSection = async (page, key) => {
  await page.locator(".m-tab[data-tab='work']").click();
  await expect(page.locator(".m-work")).toBeVisible();
  await page.locator(`.m-work [data-nav="${key}"]`).click();
};

test.describe("手机端工作台（领域 / 发布）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  // ---------- 领域 ----------
  test("领域列表：显示名称与 Pool 数量", async ({ page }) => {
    await seedData(page, { domains: DOMAINS, pools: POOLS });
    await page.goto(MOBILE);
    await goSection(page, "domain");

    const list = page.locator('[data-role="domains"]');
    await expect(list).toBeVisible();
    await expect(list.locator(".m-item")).toHaveCount(2);
    await expect(list).toContainText("仓储域");
    // Pool 数量按 domainId 统计：d1 有 2 个、d2 有 1 个
    await expect(list.locator('[data-domain="d1"]')).toContainText("2");
    await expect(list.locator('[data-domain="d2"]')).toContainText("1");
  });

  test("下钻到领域：只显示该领域的 Pool，返回键回到领域列表", async ({ page }) => {
    await seedData(page, { domains: DOMAINS, pools: POOLS });
    await page.goto(MOBILE);
    await goSection(page, "domain");

    await page.locator('[data-domain="d1"] [data-role="domain-name"]').click();
    await expect(page.locator(".m-domain")).toHaveAttribute("data-level", "domain");
    await expect(page.locator('[data-role="pools"] .m-item')).toHaveCount(2);
    await expect(page.locator('[data-role="pools"]')).toContainText("warehouse.wms.outward.api");
    // 别的领域的 Pool 不能出现在这里
    await expect(page.locator('[data-role="pools"]')).not.toContainText("order.core.api");

    // 界面上的返回按钮
    await page.locator('[data-role="back"]').click();
    await expect(page.locator(".m-domain")).toHaveAttribute("data-level", "list");

    // 系统返回键同样能回退（Shell 的 popstate → WorkView.goBack → 面板的 goBack）
    await page.locator('[data-domain="d2"] [data-role="domain-name"]').click();
    await expect(page.locator(".m-domain")).toHaveAttribute("data-level", "domain");
    await page.evaluate(() => history.back());
    await page.waitForTimeout(200);
    await expect(page.locator(".m-domain")).toHaveAttribute("data-level", "list");
  });

  test("新建领域：落盘且刷新后仍在", async ({ page }) => {
    await seedData(page, { domains: [], pools: [] });
    await page.goto(MOBILE);
    await goSection(page, "domain");

    await expect(page.locator('[data-role="empty-add-domain"]')).toBeVisible();
    await page.locator('[data-role="empty-add-domain"]').click();
    await page.locator('[data-role="domain-name-input"]').fill("新建的领域");
    await page.locator('[data-role="domain-note-input"]').fill("备注内容");
    await page.locator('[data-role="save-domain"]').click();

    await expect(page.locator('[data-role="domains"]')).toContainText("新建的领域");

    await page.reload();
    await goSection(page, "domain");
    await expect(page.locator('[data-role="domains"]')).toContainText("新建的领域");
  });

  test("删除领域会连同它的 Pool 一起删（不留孤儿数据）", async ({ page }) => {
    await seedData(page, { domains: DOMAINS, pools: POOLS });
    await page.goto(MOBILE);
    await goSection(page, "domain");

    await page.locator('[data-domain="d1"] [data-role="remove-domain"]').click();
    await expect(page.locator('[data-role="confirm"]')).toBeVisible();
    await page.locator('[data-role="confirm-ok"]').click();

    await expect(page.locator('[data-role="domains"] .m-item')).toHaveCount(1);
    // 关键：d1 的 Pool 也必须消失（否则它们成了界面上再也看不到的孤儿数据）
    const stored = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("toolcove");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return await new Promise((resolve) => {
        const tx = db.transaction("kv", "readonly");
        const get = tx.objectStore("kv").get("pools");
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => resolve(null);
      });
    });
    const remaining = Array.isArray(stored) ? stored : stored?.value || [];
    expect(remaining.filter((pool) => pool.domainId === "d1")).toHaveLength(0);
  });

  test("新建 Pool：归属当前领域", async ({ page }) => {
    await seedData(page, { domains: DOMAINS, pools: [] });
    await page.goto(MOBILE);
    await goSection(page, "domain");

    await page.locator('[data-domain="d2"] [data-role="domain-name"]').click();
    await expect(page.locator('[data-role="no-pools"]')).toBeVisible();
    await page.locator('[data-role="add-pool"]').click();
    await page.locator('[data-role="pool-name-input"]').fill("order.new.api");
    await page.locator('[data-role="save-pool"]').click();

    await expect(page.locator('[data-role="pools"]')).toContainText("order.new.api");
    // 不能跑到别的领域去
    await page.locator('[data-role="back"]').click();
    await expect(page.locator('[data-domain="d1"]')).toContainText("0");
  });

  // ---------- 发布 ----------
  test("发布列表：状态徽标与步骤进度与桌面端同一判定", async ({ page }) => {
    await seedReleases(page);
    await page.goto(MOBILE);
    await goSection(page, "release");

    const list = page.locator('[data-role="releases"]');
    await expect(list.locator(".m-item")).toHaveCount(3);
    // done → success；doing → deploying；无记录 → 无徽标
    await expect(list.locator('[data-release="r1"] [data-role="badge"]')).toHaveAttribute("data-badge", "success");
    await expect(list.locator('[data-release="r2"] [data-role="badge"]')).toHaveAttribute("data-badge", "deploying");
    await expect(list.locator('[data-release="r3"] [data-role="badge"]')).toHaveCount(0);
    // 步骤进度：r2 只完成了 pack（1/4）
    await expect(list.locator('[data-release="r2"]')).toContainText("1/4");
    // 部署方式按名字前缀推断（online 开头 → 容器）
    await expect(list.locator('[data-release="r1"]')).toContainText("容器");
    await expect(list.locator('[data-release="r2"]')).toContainText("主机");
  });

  test("展开发布池：勾选步骤会自动推进状态", async ({ page }) => {
    await seedReleases(page);
    await page.goto(MOBILE);
    await goSection(page, "release");

    await page.locator('[data-release="r2"] [data-role="release-name"]').click();
    const steps = page.locator('[data-release="r2"] [data-role="steps"]');
    await expect(steps).toBeVisible();
    // pack 已勾、upload 未勾
    await expect(steps.locator('[data-role="step-pack"]')).toBeChecked();
    await expect(steps.locator('[data-role="step-upload"]')).not.toBeChecked();

    // 勾完剩下三步 → 状态自动变成 done（徽标变成功）
    await steps.locator('[data-role="step-upload"]').check();
    await steps.locator('[data-role="step-release"]').check();
    await steps.locator('[data-role="step-verify"]').check();
    await expect(page.locator('[data-release="r2"] [data-role="badge"]')).toHaveAttribute("data-badge", "success");
  });

  test("标记状态：失败徽标与「进行中」都能记录", async ({ page }) => {
    await seedReleases(page);
    await page.goto(MOBILE);
    await goSection(page, "release");

    await page.locator('[data-release="r3"] [data-role="release-name"]').click();
    await page.locator('[data-release="r3"] [data-role="mark-doing"]').click();
    await expect(page.locator('[data-release="r3"] [data-role="badge"]')).toHaveAttribute("data-badge", "deploying");

    await page.locator('[data-release="r3"] [data-role="mark-failed"]').click();
    await expect(page.locator('[data-release="r3"] [data-role="badge"]')).toHaveAttribute("data-badge", "failed");
  });

  test("归档与恢复：切换分页且落盘", async ({ page }) => {
    await seedReleases(page);
    await page.goto(MOBILE);
    await goSection(page, "release");

    await expect(page.locator('[data-role="releases"] .m-item')).toHaveCount(3);
    await page.locator('[data-release="r3"] [data-role="toggle-archive"]').click();
    await expect(page.locator('[data-role="releases"] .m-item')).toHaveCount(2);

    // 面板内部标签用 data-release-tab（不复用工作台分段的 data-nav，避免选择器歧义）
    await page.locator('[data-release-tab="archived"]').click();
    await expect(page.locator('[data-role="releases"] .m-item')).toHaveCount(2); // r9 + 刚归档的 r3
    await expect(page.locator('[data-role="releases"]')).toContainText("order.core");

    await page.locator('[data-release="r3"] [data-role="toggle-archive"]').click();
    await expect(page.locator('[data-role="releases"] .m-item')).toHaveCount(1);
  });

  test("新建发布池：重名会被拦下（与桌面端同一规则）", async ({ page }) => {
    await seedReleases(page);
    await page.goto(MOBILE);
    await goSection(page, "release");

    await page.locator('[data-role="add-release"]').click();
    await page.locator('[data-role="release-name-input"]').fill("wms.inward");
    await page.locator('[data-role="save-release"]').click();
    // 重名（大小写无关）必须报错，而不是悄悄建两条同名的
    await expect(page.locator('[data-role="error"]')).toContainText(/wms.inward/);
    await expect(page.locator('[data-role="release-form"]')).toBeVisible();
  });

  test("如实标注：手机端只做状态记录（不假装能触发部署）", async ({ page }) => {
    await seedReleases(page);
    await page.goto(MOBILE);
    await goSection(page, "release");

    await expect(page.locator(".m-release")).toContainText(/构建机|记录/);
  });

  test("四个分段都在，且与桌面端 work 模块的入口对应", async ({ page }) => {
    await seedData(page, {});
    await page.goto(MOBILE);
    await page.locator(".m-tab[data-tab='work']").click();

    const sections = page.locator('.m-work [data-nav]');
    await expect(sections).toHaveCount(4);
    for (const key of ["overview", "iterations", "domain", "release"]) {
      await expect(page.locator(`.m-work [data-nav="${key}"]`)).toBeVisible();
    }
  });
});
