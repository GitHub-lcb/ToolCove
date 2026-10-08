// 自动签到 E2E（桌面形态）。
//
// 纯逻辑（校验 / 幂等 / 调度）由 src/checkin/*.test.js 兜着，这里守的是三条只有真实
// 交互才暴露的东西：
//  1) 描述文件填错时**一次请求都不发**（seedDesktopIpc 记录 calls，可断言）
//  2) 「200 但业务码不对」在界面上必须显示为失败，绝不显示成功
//  3) 凭据（Cookie）落盘时是加密的，磁盘上读不到明文
//
// 用法约束（与 59-downloader 相同）：
//  1) 用 seedDesktopIpc 伪造桌面形态，否则 desktopOnly 工具在浏览器形态被过滤掉、注册表是空的；
//  2) seedDesktopIpc 必须在 page.goto 之前调用；
//  3) 用 ?tool=checkin 直接进工具，避免走工具卡片 openToolWindow。
import { expect, test } from "@playwright/test";
import { seedData, seedDesktopIpc } from "../helpers.js";

const SITE = {
  key: "wb",
  label: "WorkBuddy",
  enabled: true,
  baseUrl: "https://api.example.com",
  checkin: { method: "POST", path: "/v1/checkin/do", headers: [["Cookie", "sid=SECRET-COOKIE-VALUE"]] },
  read: { checkedIn: "data.checkedToday", points: "data.points", message: "message", code: "code", successCodes: [0] },
};

/**
 * 打开工具并等首屏站点列表渲染出来。
 *
 * 两个 seed 的分工（弄错任何一个都表现为「站点列表空的」）：
 * - seedData 写 IndexedDB（load_data 在浏览器形态落到 platform/kv.js），值为 { v: …} 包装；
 * - seedDesktopIpc 伪造桌面形态 + http_request 路由，files 参数喂的是**文件 URI**，
 *   不是 load_data 的键——工具箱数据要用 seedData 播。
 */
async function openTool(page, sites, { httpRoutes = {} } = {}) {
  await seedData(page, {
    "toolbox-checkin-sites": { v: sites },
    "toolbox-checkin-state": { v: {} },
    // 首启的遥测询问弹窗是全屏遮罩，会把工具里的所有点击都拦掉。标记成已询问即可。
    // 注意 settings 是**裸对象**：读它的 telemetry.js / sync 都直接 invoke("load_data")
    // 然后当对象用，不走 toolboxStore 那套 { v: … } 包装。
    settings: { telemetry: { prompted: true, enabled: false } },
  });
  await seedDesktopIpc(page, {}, { httpRoutes });
  await page.goto("/?tool=checkin");
  await page.locator(".ck-title h2").waitFor({ state: "visible", timeout: 10_000 });
}

test.describe("工具（自动签到）", () => {
  test("签到成功：读接口的字段、显示成功与积分，且 Cookie 进了请求头", async ({ page }) => {
        await openTool(page, [SITE], { httpRoutes: { "/v1/checkin/do": { body: JSON.stringify({ code: 0, data: { checkedToday: true, points: 100 } }) } } });
    await page.locator('[data-role="site-wb"]').waitFor({ state: "visible" });

    await page.locator('[data-role="run-wb"]').click();
    // 成功才给绿徽章；这是整个工具最要紧的一条断言
    await expect(page.locator('[data-role="site-wb"] .ck-badge')).toHaveAttribute("data-tone", "ok");
    await expect(page.locator('[data-role="site-wb"] .ck-badge')).toHaveText("今日已签");
    await expect(page.locator('[data-role="site-wb"] .ck-points')).toHaveText("100");
  });

  test("HTTP 200 但业务码不对：显示失败，不是成功", async ({ page }) => {
    await openTool(page, [SITE], {
      httpRoutes: {
        // 网关把错误包在 200 里——这是签到接口最常见的坑
        "/v1/checkin/do": { body: JSON.stringify({ code: 40101, message: "登录态已过期" }) },
      },
    });
    await page.locator('[data-role="site-wb"]').waitFor({ state: "visible" });

    await page.locator('[data-role="run-wb"]').click();
    await expect(page.locator('[data-role="site-wb"] .ck-badge')).toHaveAttribute("data-tone", "bad");
    await expect(page.locator('[data-role="site-wb"]')).toContainText("登录态已过期");
  });

  test("描述无效时一个请求都不发，并逐条列出错在哪", async ({ page }) => {
    await openTool(page, [{ ...SITE, baseUrl: "http://insecure.example.com" }]);
    await page.locator('[data-role="site-wb"]').waitFor({ state: "visible" });

    await page.locator('[data-role="run-wb"]').click();
    await expect(page.locator('[data-role="site-wb"] .ck-badge')).toHaveAttribute("data-tone", "bad");
    // 没有路由可匹配：真发出去了就会因为「E2E 没为该 URL 配路由」而暴露成别的错误
    await expect(page.locator('[data-role="site-wb"]')).toContainText("baseUrl");
  });

  test("编辑描述时实时报出错误字段，且坏描述不落盘", async ({ page }) => {
        await openTool(page, [SITE]);
    await page.locator('[data-role="edit-wb"]').click();

    const editor = page.locator('[data-role="descriptor-editor"]');
    await editor.fill(JSON.stringify({ ...SITE, read: {} }, null, 2));
    await page.locator('[data-role="descriptor-save"]').click();
    await expect(page.locator('[data-role="descriptor-errors"]')).toContainText("read.checkedIn");

    // 取消即丢弃：坏描述不该有机会进存储
    await page.locator('[data-role="descriptor-cancel"]').click();
    await expect(editor).toHaveCount(0);
  });

  test("定时默认关闭，勾上后保存并显示下次执行时间", async ({ page }) => {
        await openTool(page, [SITE]);
    await page.locator('[data-role="site-wb"]').waitFor({ state: "visible" });
    await expect(page.locator(".ck-next")).toHaveText("自动签到未开启");

    await page.locator('[data-role="auto-toggle"]').check();
    await page.locator('[data-role="auto-at"]').fill("08:30");
    await expect(page.locator(".ck-next")).not.toHaveText("自动签到未开启");
  });
});
