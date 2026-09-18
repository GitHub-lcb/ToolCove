// 原生能力自检 E2E（移动视口）。
//
// 自检的意义是"让真机验证变成一次点击"，所以它必须在两种环境下都表现正确：
//   · 浏览器形态（没有桥）：存储/HTTP/TCP 走浏览器实现，应当通过；加密等桌面能力应当如实报失败；
//   · 真机形态（有桥）：走桥的路径，通过则说明设备上这项真的能用。
// 用例用 seedMobileBridge 提供假桥来覆盖后者。
import { expect, test } from "@playwright/test";
import { seedData, seedMobileBridge } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

const openAbout = async (page) => {
  await page.locator(".m-tab[data-tab='settings']").click();
  await expect(page.locator(".m-settings")).toBeVisible();
  await page.locator('.m-settings [data-nav="about"]').click();
  await expect(page.locator('[data-role="run-selftest"]')).toBeVisible({ timeout: 10_000 });
};

test.describe("手机端设置（原生能力自检）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("浏览器形态：跑自检得到逐项结果（不崩、有结论）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openAbout(page);

    await page.locator('[data-role="run-selftest"]').click();
    const results = page.locator('[data-role="selftest-results"]');
    await expect(results).toBeVisible({ timeout: 20_000 });

    // 六个检查项都要有结果（漏一项就少验一块）
    for (const key of ["store", "http", "tcp", "crypto", "filePicker", "sqlite"]) {
      await expect(results.locator(`[data-check="${key}"]`)).toBeVisible();
    }
    // 存储走浏览器实现（IndexedDB），应当通过
    await expect(results.locator('[data-check="store"]')).toHaveAttribute("data-status", "pass");
    // 需要用户点选文件的两项标成 manual，不自动跑
    await expect(results.locator('[data-check="filePicker"]')).toHaveAttribute("data-status", "manual");
    await expect(results.locator('[data-check="sqlite"]')).toHaveAttribute("data-status", "manual");
    // 汇总要有数字
    await expect(page.locator('[data-role="selftest-summary"]')).toContainText(/\d/);
  });

  test("真机形态（有桥）：存储与加密走桥并通过", async ({ page }) => {
    await seedData(page, { settings: {} });
    // 提供一个实现了存储与加密的桥
    await page.addInitScript(() => {
      const store = new Map();
      window.ToolCove = {
        isMobile: true,
        invoke(cmd, argsJson) {
          const args = argsJson ? JSON.parse(argsJson) : {};
          const ok = (value) => JSON.stringify(value);
          if (cmd === "save_data") {
            store.set(args.key, args.data);
            return "null";
          }
          if (cmd === "load_data") return ok(store.get(args.key) ?? []);
          if (cmd === "encrypt_text") return ok({ cipher: `v1:${btoa(String(args.plain))}zz` });
          if (cmd === "decrypt_text") {
            const inner = String(args.cipher).replace(/^v1:/, "").replace(/zz$/, "");
            return ok({ plain: atob(inner) });
          }
          return JSON.stringify({ __error: `未实现：${cmd}`, __code: "unsupported" });
        },
      };
    });
    await page.goto(MOBILE);
    await openAbout(page);

    await page.locator('[data-role="run-selftest"]').click();
    const results = page.locator('[data-role="selftest-results"]');
    await expect(results).toBeVisible({ timeout: 20_000 });

    // 存储：桥不认 load_data/save_data 时会回退浏览器实现，所以照样通过
    await expect(results.locator('[data-check="store"]')).toHaveAttribute("data-status", "pass");
    // 加密：桥实现了，走桥并通过（这是真机上 Keystore 那条路的等价验证）
    await expect(results.locator('[data-check="crypto"]')).toHaveAttribute("data-status", "pass");
    await expect(results.locator('[data-check="crypto"]')).toContainText(/往返一致/);
  });

  test("桥把加密退化成明文时，自检必须报失败（最危险的静默失败）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.addInitScript(() => {
      window.ToolCove = {
        isMobile: true,
        invoke(cmd, argsJson) {
          const args = argsJson ? JSON.parse(argsJson) : {};
          const ok = (value) => JSON.stringify(value);
          // 明文当密文返回——这正是"Keystore 没接上、退化成直通"的表现
          if (cmd === "encrypt_text") return ok({ cipher: String(args.plain) });
          if (cmd === "decrypt_text") return ok({ plain: String(args.cipher) });
          if (cmd === "save_data") return "null";
          if (cmd === "load_data") return ok([]);
          return JSON.stringify({ __error: `未实现：${cmd}`, __code: "unsupported" });
        },
      };
    });
    await page.goto(MOBILE);
    await openAbout(page);

    await page.locator('[data-role="run-selftest"]').click();
    const crypto = page.locator('[data-check="crypto"]');
    await expect(crypto).toBeVisible({ timeout: 20_000 });
    await expect(crypto).toHaveAttribute("data-status", "fail");
    await expect(crypto).toContainText(/明文/);
  });

  test("复制报告：拿到含结论的纯文本", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openAbout(page);

    await page.locator('[data-role="run-selftest"]').click();
    await expect(page.locator('[data-role="selftest-results"]')).toBeVisible({ timeout: 20_000 });

    await page.locator('[data-role="copy-report"]').click();
    await expect(page.locator('[data-role="report-copied"]')).toBeVisible();

    const report = await page.evaluate(() => navigator.clipboard.readText());
    // 报告要能直接发出去定位问题：含标题、构建时间、桥状态、逐项结论
    expect(report).toContain("原生能力自检");
    expect(report).toContain("store");
    expect(report).toContain("构建：");
    expect(report).toMatch(/全部通过|失败 \d+ 项/);
  });

  test("需要选文件的项：不自动跑，单独点按钮才跑", async ({ page }) => {
    await seedData(page, { settings: {} });
    // 桥提供文件选择与 SQLite
    await seedMobileBridge(page, {
      pick: "content://x/test.db",
      files: { "content://x/test.db": "SQLite format 3" },
      db: { tables: ["orders", "users"], columns: {} },
    });
    await page.goto(MOBILE);
    await openAbout(page);

    await page.locator('[data-role="run-selftest"]').click();
    await expect(page.locator('[data-role="selftest-results"]')).toBeVisible({ timeout: 20_000 });

    // 单独跑文件选择器
    await page.locator('[data-role="run-filePicker"]').click();
    await expect(page.locator('[data-check="filePicker"]')).toHaveAttribute("data-status", "pass");

    // 单独跑 SQLite
    await page.locator('[data-role="run-sqlite"]').click();
    await expect(page.locator('[data-check="sqlite"]')).toHaveAttribute("data-status", "pass");
    await expect(page.locator('[data-check="sqlite"]')).toContainText(/张表/);
  });
});
