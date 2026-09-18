// 工具箱第三批 E2E：请求工具 + 铁路大亨回归。
//
// 请求工具在手机端走**浏览器 fetch**（platform/invoke 的浏览器分支），不走桌面 IPC，
// 所以这里用 Playwright 的 page.route 拦截真实网络请求——被测的仍是生产路径：
// RequestToolView → invoke("http_request") → browserHttpRequest → fetch。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";
const API = "http://e2e.test/api";

const goToolbox = async (page) => {
  await page.locator(".m-tab[data-tab='toolbox']").click();
  await expect(page.locator(".m-toolbox")).toBeVisible();
};

const openTool = async (page, key) => {
  await page.locator(`.m-item[data-tool="${key}"] .m-item-main`).click();
  await expect(page.locator(`.m-tool[data-tool="${key}"]`)).toBeVisible();
};

/** 拦截 API 请求并回放响应。返回记录到的请求，供断言"请求头/方法/请求体真的带出去了"。 */
async function routeApi(page, handler) {
  const seen = [];
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    seen.push({ url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() });
    const reply = typeof handler === "function" ? handler(request) : handler;
    await route.fulfill({
      status: reply.status ?? 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        // 跨域响应的**自定义头默认对 JS 不可见**（只有 safelist 里的才可见）。
        // 这里显式放开，才能断言页面真的把响应头列了出来。
        "access-control-expose-headers": "*",
        ...(reply.headers || {}),
      },
      body: reply.body ?? "",
    });
  });
  return seen;
}

test.describe("手机端工具箱（请求 / 铁路大亨）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("请求：发一次 JSON 请求，状态/耗时/大小与响应体都呈现", async ({ page }) => {
    await seedData(page, { settings: {} });
    await routeApi(page, { body: '{"id":7,"name":"lcb","roles":["dev","ops"]}' });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "request");

    const tool = page.locator('[data-tool="request"]');
    await tool.locator('[data-role="url"]').fill(`${API}/user`);
    await tool.locator('[data-role="send"]').click();

    await expect(page.locator('[data-role="status"]')).toContainText("200");
    // 耗时与大小都展示出来（排查时最先看这两个）
    await expect(page.locator('[data-role="meta"]')).toContainText("ms");
    // 响应体是 JSON：应美化（有换行与缩进）
    const body = await page.locator('[data-role="resp-body"]').inputValue();
    expect(body).toContain('"name": "lcb"');
    expect(body.split("\n").length).toBeGreaterThan(3);
  });

  test("请求：切换响应头视图能看到头列表", async ({ page }) => {
    await seedData(page, { settings: {} });
    await routeApi(page, { status: 201, body: "ok", headers: { "x-request-id": "abc123", "content-type": "text/plain" } });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "request");

    const tool = page.locator('[data-tool="request"]');
    await tool.locator('[data-role="url"]').fill(`${API}/headers`);
    await tool.locator('[data-role="send"]').click();
    await expect(page.locator('[data-role="status"]')).toContainText("201");

    await tool.locator('[data-role="tab-headers"]').click();
    await expect(page.locator('[data-role="resp-headers"]')).toContainText("x-request-id");
    await expect(page.locator('[data-role="resp-headers"]')).toContainText("abc123");
  });

  test("请求：自定义请求头会被带出去；URL 为空时不发请求", async ({ page }) => {
    await seedData(page, { settings: {} });
    const seen = await routeApi(page, { body: "ok" });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "request");

    const tool = page.locator('[data-tool="request"]');
    // URL 为空：不该发出去（按钮禁用）
    await expect(tool.locator('[data-role="send"]')).toBeDisabled();

    await tool.locator('[data-role="url"]').fill(`${API}/echo`);
    await tool.locator(".m-card .m-op", { hasText: "＋" }).click();
    await tool.locator('[data-role="header-name"]').fill("X-Token");
    await tool.locator('[data-role="header-value"]').fill("secret");
    await tool.locator('[data-role="send"]').click();
    await expect(page.locator('[data-role="status"]')).toContainText("200");

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].headers["x-token"]).toBe("secret");
  });

  test("请求：POST 带请求体，方法也传对了", async ({ page }) => {
    await seedData(page, { settings: {} });
    const seen = await routeApi(page, { body: '{"ok":true}' });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "request");

    const tool = page.locator('[data-tool="request"]');
    await tool.locator('[data-role="method"]').selectOption("POST");
    await tool.locator('[data-role="url"]').fill(`${API}/create`);
    await tool.locator('[data-role="body"]').fill('{"name":"x"}');
    await tool.locator('[data-role="send"]').click();
    await expect(page.locator('[data-role="status"]')).toContainText("200");

    expect(seen[0].method).toBe("POST");
    expect(seen[0].body).toBe('{"name":"x"}');
  });

  test("请求：失败时把原因说出来，并如实标注 CORS 现状", async ({ page }) => {
    await seedData(page, { settings: {} });
    // 不注册任何 API 路由 → 真实 fetch 打不出去
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "request");

    const tool = page.locator('[data-tool="request"]');
    await tool.locator('[data-role="url"]').fill("http://127.0.0.1:1/unreachable");
    await tool.locator('[data-role="send"]').click();

    const error = page.locator('[data-role="error"]');
    await expect(error).toBeVisible();
    await expect(error).toContainText(/失败|Failed/);
    // 不能是空白或只有四个字的泛化提示
    expect((await error.innerText()).length).toBeGreaterThan(6);
    // 并且要如实说明当前的 CORS 现状（这是手机端与桌面端的已知差异）
    await expect(tool.locator(".m-hint-sm").last()).toContainText(/CORS|跨域/);
  });

  test("请求：curl 粘贴能解析出方法/头/体/URL", async ({ page }) => {
    await seedData(page, { settings: {} });
    await routeApi(page, { body: "ok" });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "request");

    const tool = page.locator('[data-tool="request"]');
    await tool.locator(".m-btn", { hasText: "导入" }).click();
    await tool.locator('[data-role="curl"]').fill(`curl -X POST '${API}/echo' -H 'Content-Type: application/json' -d '{"a":1}'`);
    await tool.locator(".m-btn", { hasText: "解析" }).click();

    await expect(tool.locator('[data-role="method"]')).toHaveValue("POST");
    await expect(tool.locator('[data-role="url"]')).toHaveValue(`${API}/echo`);
    await expect(tool.locator('[data-role="header-name"]').first()).toHaveValue("Content-Type");
    await expect(tool.locator('[data-role="body"]')).toHaveValue('{"a":1}');
  });

  test("铁路大亨：开局给出下一站结论与实操提示", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "rail");

    // 16 站一览应在（一格一站）
    await expect(page.locator('[data-role="stations"] .m-station')).toHaveCount(16);
    // 开局光标在始发站
    await expect(page.locator('[data-role="cursor"]')).toContainText("始发");
    // 下一站结论：开局三选一 → 显示"尚不能确定"
    await expect(page.locator('[data-role="verdict-text"]')).toContainText("尚不能确定");
    // 建议卡非空（共享层开局会给 origin/backToBack/rhythm 三条）
    expect(await page.locator('[data-role="advice"] li').count()).toBeGreaterThan(0);
  });

  test("铁路大亨：录入类型与提示后能被求解器用上", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "rail");

    const tool = page.locator('[data-tool="rail"]');
    // 站点一览是 1-based：nth(1) 是下标 1，也就是「第 2 站」（nth(0) 是始发站）
    await tool.locator('[data-role="stations"] .m-station').nth(1).click();
    await expect(tool.locator('[data-role="cursor"]')).toContainText("第 2 站");
    // 记类型 = 酒庄
    await tool.locator('.m-chip[data-type="winery"]').click();
    // 记提示 = 数量相同
    await tool.locator('.m-chip[data-hint="same"]').click();

    // 站点格里能看到刚记的类型
    await expect(tool.locator('[data-role="stations"] .m-station').nth(1)).toContainText("酒庄");
    // 建议卡可见
    await expect(tool.locator('[data-role="advice"]')).toBeVisible();
    // 再点一次同一类型 = 取消记录（手机上误触要能撤回）
    await tool.locator('.m-chip[data-type="winery"]').click();
    await expect(tool.locator('[data-role="stations"] .m-station').nth(1)).not.toContainText("酒庄");
  });

  test("铁路大亨：清空必须确认，确认后回到始发站", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "rail");

    const tool = page.locator('[data-tool="rail"]');
    await tool.locator('[data-role="stations"] .m-station').nth(3).click();
    await tool.locator('.m-chip[data-type="trade"]').click();
    await expect(tool.locator('[data-role="stations"] .m-station').nth(3)).toContainText("商行");

    await tool.locator('[data-role="reset"]').click();
    await expect(page.locator(".m-modal")).toBeVisible();
    await page.locator(".m-modal-cancel").click();
    await expect(tool.locator('[data-role="stations"] .m-station').nth(3)).toContainText("商行");

    await tool.locator('[data-role="reset"]').click();
    await page.locator('[data-role="reset-ok"]').click();
    await expect(tool.locator('[data-role="stations"] .m-station').nth(3)).not.toContainText("商行");
    await expect(tool.locator('[data-role="cursor"]')).toContainText("始发");
  });

  test("迁移进度：请求与铁路大亨已可用，进度与页面条目数一致", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);

    for (const key of ["request", "rail"]) {
      await expect(page.locator(`.m-item[data-tool="${key}"]`)).toHaveAttribute("data-ready", "true");
    }
    // 只断言形态与一致性，不写死数字也不写死"哪个工具未迁移"
    // （这两样都随每批推进而变，写死会让用例不断失效——已经改过三次）
    const text = await page.locator('[data-role="tool-progress"]').innerText();
    const ready = await page.locator('.m-item[data-ready="true"]').count();
    expect(Number(text.match(/(\d+)\s*\//)[1])).toBe(ready);
  });
});
