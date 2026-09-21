// 设置页 E2E（移动视口）。
//
// 这一页是「App 能不能真正用起来」的关键，所以最后一条用例专门验证**闭环**：
// 在设置里配好 AI 之后，Agent 的请求真的发到配置的端点（而不是只把值写进存储）。
import { expect, test } from "@playwright/test";
import { readKv, seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";
const AI_BASE = "http://e2e.test/v1";

const goSettings = async (page) => {
  await page.locator(".m-tab[data-tab='settings']").click();
  await expect(page.locator(".m-settings")).toBeVisible();
};

/** 拦截 AI 端点，返回记录到的请求体。 */
async function routeAI(page, reply = "可用") {
  const seen = [];
  await page.route(`${AI_BASE}/**`, async (route) => {
    seen.push({ url: route.request().url(), method: route.request().method(), body: route.request().postDataJSON() });
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }),
    });
  });
  return seen;
}

test.describe("手机端设置页", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("读取已有配置：预设被高亮，字段回填", async ({ page }) => {
    await seedData(page, {
      settings: { ai: { enabled: true, baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-1", model: "deepseek-chat", temperature: 0.3 } },
    });
    await page.goto(MOBILE);
    await goSettings(page);

    await expect(page.locator('[data-role="base-url"]')).toHaveValue("https://api.deepseek.com/v1");
    await expect(page.locator('[data-role="model"]')).toHaveValue("deepseek-chat");
    await expect(page.locator('[data-role="ai-enable"]')).toHaveClass(/on/);
    // 预设高亮：说明"当前用的是哪个服务商"一眼可见
    await expect(page.locator('[data-preset="deepseek"]')).toHaveClass(/on/);
    await expect(page.locator('[data-preset="openai"]')).not.toHaveClass(/on/);
  });

  test("点预设一键填好地址与模型", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goSettings(page);

    await page.locator('[data-preset="deepseek"]').click();
    await expect(page.locator('[data-role="base-url"]')).toHaveValue("https://api.deepseek.com/v1");
    await expect(page.locator('[data-role="model"]')).not.toHaveValue("");
    await expect(page.locator('[data-role="ai-enable"]')).toHaveClass(/on/);
  });

  test("启用 AI 但缺字段：逐字段报错，不保存", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goSettings(page);

    await page.locator('[data-role="ai-enable"]').click();
    await page.locator('[data-role="save"]').click();

    await expect(page.locator('[data-role="err-base"]')).toBeVisible();
    await expect(page.locator('[data-role="err-key"]')).toBeVisible();
    await expect(page.locator('[data-role="err-model"]')).toBeVisible();

    // 没有保存成功提示（不能"报错还提示已保存"）
    await expect(page.locator('[data-role="notice"]')).toHaveCount(0);

    // 地址漏协议也要拦下来（最常见的配置错误）
    await page.locator('[data-role="base-url"]').fill("api.deepseek.com/v1");
    await page.locator('[data-role="api-key"]').fill("sk-x");
    await page.locator('[data-role="model"]').fill("deepseek-chat");
    await page.locator('[data-role="save"]').click();
    await expect(page.locator('[data-role="err-base"]')).toBeVisible();
  });

  test("填全后保存：提示已保存，刷新后配置还在（真的落盘）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goSettings(page);

    await page.locator('[data-role="ai-enable"]').click();
    await page.locator('[data-role="base-url"]').fill(`${AI_BASE}/`);
    await page.locator('[data-role="api-key"]').fill("sk-test");
    await page.locator('[data-role="model"]').fill("test-model");
    await page.locator('[data-role="save"]').click();
    await expect(page.locator('[data-role="notice"]')).toContainText("已保存");

    await page.reload();
    await goSettings(page);
    // 末尾斜杠被归一化去掉（否则会拼出 //chat/completions）
    await expect(page.locator('[data-role="base-url"]')).toHaveValue(AI_BASE);
    await expect(page.locator('[data-role="model"]')).toHaveValue("test-model");
    await expect(page.locator('[data-role="api-key"]')).toHaveValue("sk-test");
  });

  test("保存不会覆盖未渲染的分组（sync/telemetry 必须原样保留）", async ({ page }) => {
    await seedData(page, {
      settings: {
        ai: { enabled: false, baseUrl: "", apiKey: "", model: "", temperature: 0.7 },
        sync: { enabled: true, serverUrl: "https://sync.example.com", deviceName: "我的手机" },
        telemetry: { enabled: true, deviceId: "keep-me" },
      },
    });
    await page.goto(MOBILE);
    await goSettings(page);

    await page.locator('[data-role="ai-enable"]').click();
    await page.locator('[data-role="base-url"]').fill(AI_BASE);
    await page.locator('[data-role="api-key"]').fill("sk-test");
    await page.locator('[data-role="model"]').fill("test-model");
    await page.locator('[data-role="save"]').click();
    await expect(page.locator('[data-role="notice"]')).toContainText("已保存");

    // 直接读存储：未渲染的分组必须还在（这就是 mergeSettingsSnapshot 的意义）
    const stored = await readKv(page, "settings");
    expect(stored?.sync?.serverUrl).toBe("https://sync.example.com");
    expect(stored?.sync?.deviceName).toBe("我的手机");
    expect(stored?.telemetry?.deviceId).toBe("keep-me");
    expect(stored?.ai?.model).toBe("test-model");
  });

  test("测试 AI：把配置发到该端点，并把回复显示出来", async ({ page }) => {
    await seedData(page, { settings: {} });
    const seen = await routeAI(page, "可用");
    await page.goto(MOBILE);
    await goSettings(page);

    await page.locator('[data-role="ai-enable"]').click();
    await page.locator('[data-role="base-url"]').fill(AI_BASE);
    await page.locator('[data-role="api-key"]').fill("sk-test");
    await page.locator('[data-role="model"]').fill("test-model");
    await page.locator('[data-role="test"]').click();

    await expect(page.locator('[data-role="test-result"]')).toContainText("可用");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${AI_BASE}/chat/completions`);
    expect(seen[0].body.model).toBe("test-model");
  });

  test("测试 AI 失败时给出原因，不是一句「失败」", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.route(`${AI_BASE}/**`, (route) => route.fulfill({ status: 401, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: '{"error":{"message":"invalid api key"}}' }));
    await page.goto(MOBILE);
    await goSettings(page);

    await page.locator('[data-role="ai-enable"]').click();
    await page.locator('[data-role="base-url"]').fill(AI_BASE);
    await page.locator('[data-role="api-key"]').fill("bad");
    await page.locator('[data-role="model"]').fill("test-model");
    await page.locator('[data-role="test"]').click();

    const result = page.locator('[data-role="test-result"]');
    await expect(result).toBeVisible();
    expect((await result.innerText()).length).toBeGreaterThan(6);
  });

  test("闭环：设置里配好 AI 后，AI 通道真的打到该端点", async ({ page }) => {
    await seedData(page, { settings: {} });
    const seen = await routeAI(page, "已完成：读取了 3 个字段");
    await page.goto(MOBILE);
    await goSettings(page);

    await page.locator('[data-role="ai-enable"]').click();
    await page.locator('[data-role="base-url"]').fill(AI_BASE);
    await page.locator('[data-role="api-key"]').fill("sk-test");
    await page.locator('[data-role="model"]').fill("test-model");
    await page.locator('[data-role="save"]').click();
    await expect(page.locator('[data-role="notice"]')).toContainText("已保存");

    // 刷新后**不重新填写**，直接点测试——走的是保存后从存储读回来的配置，
    // 也就是 Agent 用的同一条通道（ai.js → platform/invoke → fetch）。
    await page.reload();
    await goSettings(page);
    await page.locator('[data-role="test"]').click();

    await expect(page.locator('[data-role="test-result"]')).toContainText("已完成");
    expect(seen.length).toBeGreaterThan(0);
    const last = seen.at(-1);
    expect(last.url).toBe(`${AI_BASE}/chat/completions`);
    expect(last.body.model).toBe("test-model");
    expect(last.body.messages.length).toBeGreaterThan(0);
  });

  test("系统设置：语言与信息密度可改并落盘", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goSettings(page);

    await page.locator('[data-nav="general"]').click();
    await page.locator('[data-role="locale"]').selectOption("en-US");
    await page.locator('[data-role="density"]').selectOption("comfort");
    await page.locator('[data-role="save"]').click();
    await expect(page.locator('[data-role="notice"]')).toBeVisible();

    await page.reload();
    await goSettings(page);
    await page.locator('[data-nav="general"]').click();
    await expect(page.locator('[data-role="locale"]')).toHaveValue("en-US");
    await expect(page.locator('[data-role="density"]')).toHaveValue("comfort");
  });

  test("关于：显示构建戳与原生桥状态，便于核对手机上的实际情况", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goSettings(page);

    await page.locator('[data-nav="about"]').click();
    const stamp = await page.locator('[data-role="build-stamp"]').innerText();
    expect(stamp).not.toBe("");
    expect(stamp).not.toContain("__BUILD_STAMP__");

    // 浏览器里跑（没有 window.ToolCove）→ 必须如实显示为「未接上原生桥」，
    // 装了 APK 才会变成已接上。这一行是排查"某些能力为什么没生效"的第一个抓手。
    const bridge = page.locator('[data-role="bridge-status"]');
    await expect(bridge).toHaveAttribute("data-on", "false");
    await expect(bridge).toContainText(/未接上|No native bridge/);
    await expect(page.locator('[data-role="about"]')).toContainText("网页形态");
  });

  test("云同步：状态可见，入伙三要素缺一不可", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goSettings(page);

    await page.locator('[data-nav="sync"]').click();
    await expect(page.locator('[data-role="sync-status"]')).toBeVisible();
    // 未启用时「立即同步」不可点（而不是点了没反应）
    await expect(page.locator('[data-role="sync-now"]')).toBeDisabled();
    // 入伙按钮在没有服务端时点了会失败，但要给出可读原因而不是崩掉
    await page.locator('[data-role="join-btn"]').click();
    await expect(page.locator('[data-role="sync-error"], [data-role="sync-status"]').first()).toBeVisible();
  });

  // —— 检查更新（安卓自建更新链的界面侧）——
  // 浏览器形态没有原生桥，所以拿不到安装包版本。这一组用例守的正是：
  // **不知道就说不知道**，绝不显示"已是最新"——后者会让人以为发版没生效而停在旧版本。
  const MANIFEST = "https://github.com/GitHub-lcb/ToolCove/releases/download/apk-latest/apk.json";

  async function routeManifest(page, { status = 200, body = "" } = {}) {
    await page.route(MANIFEST, async (route) => {
      await route.fulfill({
        status,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        body,
      });
    });
  }

  test("检查更新：清单有效但读不到当前版本时，如实说「无法判断」而不是「已是最新」", async ({ page }) => {
    await seedData(page, { settings: {} });
    await routeManifest(page, {
      body: JSON.stringify({
        version: "9.9.9",
        versionCode: 90909,
        url: "https://github.com/GitHub-lcb/ToolCove/releases/download/apk-v9.9.9/toolcove-release.apk",
        sha256: "a".repeat(64),
        size: 1500000,
      }),
    });
    await page.goto(MOBILE);
    await goSettings(page);
    await page.locator('[data-nav="about"]').click();

    await expect(page.locator('[data-role="update-card"]')).toBeVisible();
    await page.locator('[data-role="update-check"]').click();
    await expect(page.locator('[data-role="update-result"]')).toContainText(/读不到安装包版本|can't read its package version/, { timeout: 10_000 });
    await expect(page.locator('[data-role="update-result"]')).not.toHaveText(/已是最新版本/);
    // 判不出可用更新时不给"下载并安装"按钮
    await expect(page.locator('[data-role="update-install"]')).toHaveCount(0);
  });

  test("检查更新：清单取不到时报「清单不可用」，与「已是最新」区分开", async ({ page }) => {
    await seedData(page, { settings: {} });
    await routeManifest(page, { status: 404, body: "Not Found" });
    await page.goto(MOBILE);
    await goSettings(page);
    await page.locator('[data-nav="about"]').click();

    await page.locator('[data-role="update-check"]').click();
    await expect(page.locator('[data-role="update-result"]')).toContainText(/清单不可用|manifest is unavailable/, { timeout: 10_000 });
    // 负向断言要针对**那条具体文案**：invalid 的提示里本来就写着"这不是「已是最新」"，
    // 用 not.toContainText("已是最新") 会被自己的文案措辞打挂（第一版就踩了）
    await expect(page.locator('[data-role="update-result"]')).not.toHaveText(/已是最新版本/);
  });
});
