// 网络工具 E2E（移动视口）。
//
// 重点在**纯逻辑那三块**（URL / CIDR / UA）——它们不依赖任何原生能力，手机端必须完全正确。
// 端口检测是降级实现，所以断言的是"如实标注差异"而不是假装与桌面一致。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

const goToolbox = async (page) => {
  await page.locator(".m-tab[data-tab='toolbox']").click();
  await expect(page.locator(".m-toolbox")).toBeVisible();
};

const openTool = async (page, key) => {
  await page.locator(`.m-item[data-tool="${key}"] .m-item-main`).click();
  await expect(page.locator(`.m-tool[data-tool="${key}"]`)).toBeVisible();
};

test.describe("手机端工具箱（网络）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("URL 解析：拆出协议/主机/端口/路径/参数", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "network");

    const tool = page.locator('[data-tool="network"]');
    await tool.locator('[data-role="url"]').fill("https://user@example.com:8443/a/b?x=1&y=2#frag");
    await tool.locator('[data-role="parse-url"]').click();

    const parts = tool.locator('[data-role="url-parts"]');
    await expect(parts).toContainText("https");
    await expect(parts).toContainText("example.com");
    await expect(parts).toContainText("8443");
    await expect(parts).toContainText("/a/b");
    await expect(parts).toContainText("#frag");
    await expect(parts).toContainText("user");
  });

  test("URL 参数可编辑并拼回：删掉追踪参数后 URL 变了", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "network");

    const tool = page.locator('[data-tool="network"]');
    await tool.locator('[data-role="url"]').fill("https://example.com/p?utm_source=ad&keep=1");
    await tool.locator('[data-role="parse-url"]').click();

    const before = await tool.locator('[data-role="rebuilt"]').inputValue();
    expect(before).toContain("utm_source=ad");

    // 删掉第一个参数（utm_source）
    await tool.locator(".m-op.danger").first().click();
    const after = await tool.locator('[data-role="rebuilt"]').inputValue();
    expect(after).not.toContain("utm_source");
    expect(after).toContain("keep=1");
  });

  test("CIDR 计算：/24 的网络地址、广播地址与可用主机数", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "network");

    const tool = page.locator('[data-tool="network"]');
    await tool.locator('[data-tab="cidr"]').click();
    await tool.locator('[data-role="cidr"]').fill("192.168.1.10/24");

    await expect(tool.locator('[data-role="cidr-network"]')).toHaveText("192.168.1.0/24");
    await expect(tool.locator('[data-role="cidr-usable"]')).toHaveText("254");
    await expect(tool.locator('[data-role="cidr-result"]')).toContainText("192.168.1.255"); // 广播
    await expect(tool.locator('[data-role="cidr-result"]')).toContainText("192.168.1.1"); // 首个可用
    await expect(tool.locator('[data-role="cidr-result"]')).toContainText("255.255.255.0"); // 掩码
  });

  test("CIDR：非法输入给出可读原因", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "network");

    const tool = page.locator('[data-tool="network"]');
    await tool.locator('[data-tab="cidr"]').click();
    await tool.locator('[data-role="cidr"]').fill("192.168.1.1/40");
    await expect(tool.locator('[data-role="error"]')).toBeVisible();
    await expect(tool.locator('[data-role="cidr-result"]')).toHaveCount(0);
  });

  test("UA 解析：默认填本机 UA，能解析出浏览器与系统", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "network");

    const tool = page.locator('[data-tool="network"]');
    await tool.locator('[data-tab="ua"]').click();
    // 默认值就是本机 UA（手机端最常用来排查 WebView 内核）
    const ua = await tool.locator('[data-role="ua"]').inputValue();
    expect(ua.toLowerCase()).toContain("mozilla");

    const browser = await tool.locator('[data-role="ua-browser"]').innerText();
    expect(browser).not.toContain("toolbox."); // 不能渲染出词条 key
    expect(browser.trim().length).toBeGreaterThan(1);

    // 换成一段已知 UA：应解析出 Chrome 与 Windows
    await tool.locator('[data-role="ua"]').fill("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    await expect(tool.locator('[data-role="ua-browser"]')).toContainText("Chrome");
    await expect(tool.locator('[data-role="ua-result"]')).toContainText("Windows");
  });

  test("端口检测：如实标注与桌面端的差异（不是假装一样）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "network");

    const tool = page.locator('[data-tool="network"]');
    await tool.locator('[data-tab="tcp"]').click();
    // 说明必须点出"只能测 Web 端口 / 无法区分关闭与拦截"，否则用户会误信结论
    const note = tool.locator('[data-role="tcp-note"]');
    await expect(note).toBeVisible();
    await expect(note).toContainText(/Web 端口|原生 TCP/);

    // 空主机名：给出可读提示而不是发一个无意义的请求
    await tool.locator('[data-role="check"]').click();
    await expect(tool.locator('[data-role="error"]')).toContainText(/主机|host/i);
  });

  test("URL 与 CIDR 是离线可算的（不发任何网络请求）", async ({ page }) => {
    const requests = [];
    page.on("request", (r) => {
      const url = r.url();
      if (!url.startsWith("http://127.0.0.1:") && !url.startsWith("data:")) requests.push(url);
    });
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "network");

    const tool = page.locator('[data-tool="network"]');
    await tool.locator('[data-role="url"]').fill("https://example.com/a?x=1");
    await tool.locator('[data-role="parse-url"]').click();
    await tool.locator('[data-tab="cidr"]').click();
    await tool.locator('[data-role="cidr"]').fill("10.0.0.1/8");
    await expect(tool.locator('[data-role="cidr-network"]')).toHaveText("10.0.0.0/8");

    expect(requests, `不该有外部请求，实际有：${requests.join(", ")}`).toEqual([]);
  });

  test("迁移进度：网络已可用，且带降级说明", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);

    const network = page.locator('.m-item[data-tool="network"]');
    await expect(network).toHaveAttribute("data-ready", "true");
    // 部分降级：说明文字必须还在（否则用户会以为和桌面一样）
    await expect(network).toContainText(/TCP|原生/);

    // 仍未迁移的文件工具要说明"为什么不能做"
    const file = page.locator('.m-item[data-tool="file"]');
    await expect(file).toHaveAttribute("data-ready", "false");
    await expect(file).toContainText(/SAF|文件选择器/);
  });
});
