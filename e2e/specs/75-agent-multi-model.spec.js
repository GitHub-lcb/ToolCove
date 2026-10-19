// 多模型配置 E2E：
// 1) 输入框可在已保存的多套配置间切换，刷新后保持当前选择
// 2) 设置页可以新增一套配置并设为默认，保存后落盘
// 3) 旧版单模型扁平字段自动迁移成一条配置（老用户升级不丢配置）
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const PROFILES = {
  ai: {
    enabled: true,
    activeId: "main",
    profiles: [
      { id: "main", name: "主力", baseUrl: "https://api.deepseek.com/v1", apiKey: "k1", model: "deepseek-chat", temperature: 0.7, reasoningEffort: "" },
      { id: "backup", name: "备用", baseUrl: "https://api.openai.com/v1", apiKey: "k2", model: "gpt-4o-mini", temperature: 0.7, reasoningEffort: "" },
    ],
  },
};

async function openAI(page) {
  await page.locator(".side-foot button", { hasText: "设置" }).first().click();
  await expect(page.locator(".sv-bar")).toBeVisible();
  await page.locator(".sv-nav", { hasText: "AI 模型" }).first().click();
  await expect(page.locator('[data-role="ai-profile"]').first()).toBeVisible();
}

test("输入框可在多套配置间切换，刷新后保持当前配置", async ({ page }) => {
  await seedData(page, { settings: PROFILES });
  await page.goto("/");
  await expect(page.locator(".model-name")).toHaveText("deepseek-chat");

  await page.locator(".model-btn").click();
  const choices = page.locator('[data-role="profile-choice"]');
  await expect(choices).toHaveCount(2);
  await choices.filter({ hasText: "备用" }).click();
  await expect(page.locator(".model-name")).toHaveText("gpt-4o-mini");

  await page.reload();
  await expect(page.locator(".model-name")).toHaveText("gpt-4o-mini");

  await openAI(page);
  await expect(page.locator('[data-role="ai-profile"]', { hasText: "备用" })).toContainText("默认");
});

test("设置页可以新增模型并设为默认，保存后落盘", async ({ page }) => {
  await seedData(page, { settings: PROFILES });
  // 填完 Key 失焦会自动拉模型列表；这里给一个稳定的端点响应
  await page.route("**/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [{ id: "moonshot-v1-8k" }, { id: "moonshot-v1-32k" }] }),
    });
  });
  await page.goto("/");
  await openAI(page);

  await page.locator('[data-role="ai-profile-add"]').click();
  await page.locator('[data-role="ai-provider"]').selectOption("moonshot");
  await page.getByPlaceholder("粘贴模型服务商的 API Key").fill("k3");

  const newRow = page.locator('[data-role="ai-profile"]', { hasText: "moonshot-v1-8k" });
  await expect(newRow).toBeVisible();
  await newRow.locator('[data-role="ai-profile-use"]').click();
  await expect(newRow).toContainText("默认");

  await page.getByRole("button", { name: /保存/ }).first().click();
  await expect(page.locator(".sv-dirty")).toHaveCount(0, { timeout: 10_000 });

  await page.reload();
  await expect(page.locator(".model-name")).toHaveText("moonshot-v1-8k");
  await openAI(page);
  await expect(page.locator('[data-role="ai-profile"]')).toHaveCount(3);
  await expect(page.locator('[data-role="ai-profile"]', { hasText: "moonshot-v1-8k" })).toContainText("默认");
});

test("填完 Key 失焦后自动拉取模型列表，选中后保存生效", async ({ page }) => {
  await seedData(page, {
    settings: {
      ai: { enabled: true, baseUrl: "https://api.deepseek.com/v1", apiKey: "k", model: "deepseek-chat" },
    },
  });
  await page.route("**/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }, { id: "deepseek-coder" }] }),
    });
  });
  await page.goto("/");
  await openAI(page);

  // 不点「获取模型」，只让 Key 输入框失焦：模型列表应自动出现
  await page.getByPlaceholder("粘贴模型服务商的 API Key").click();
  await page.keyboard.press("Tab");
  const select = page.locator('[data-role="ai-model-select"]');
  await expect(select).toBeVisible({ timeout: 10_000 });
  await expect(select.locator("option")).toHaveCount(3);

  await select.selectOption("deepseek-reasoner");
  await page.getByRole("button", { name: /保存/ }).first().click();
  await expect(page.locator(".sv-dirty")).toHaveCount(0, { timeout: 10_000 });

  await page.reload();
  await expect(page.locator(".model-name")).toHaveText("deepseek-reasoner");
});

test("对话内的模型弹层也会从端点拉取模型列表", async ({ page }) => {
  await seedData(page, { settings: PROFILES });
  await page.route("**/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }, { id: "deepseek-coder" }] }),
    });
  });
  await page.goto("/");
  await expect(page.locator(".model-name")).toHaveText("deepseek-chat");

  await page.locator(".model-btn").click();
  const pop = page.locator(".model-pop");
  // deepseek-coder 只来自端点返回，内置候选里没有它——出现即证明真的拉了列表
  const remote = pop.getByRole("radio", { name: /deepseek-coder/ });
  await expect(remote).toBeVisible({ timeout: 10_000 });
  await remote.click();
  await expect(page.locator(".model-name")).toHaveText("deepseek-coder");
});

test("旧版单模型配置自动迁移成一条配置", async ({ page }) => {
  await seedData(page, {
    settings: {
      ai: { enabled: true, baseUrl: "https://api.deepseek.com/v1", apiKey: "k", model: "deepseek-chat" },
    },
  });
  await page.goto("/");
  await expect(page.locator(".model-name")).toHaveText("deepseek-chat");

  await openAI(page);
  const row = page.locator('[data-role="ai-profile"]');
  await expect(row).toHaveCount(1);
  await expect(row.first()).toContainText("deepseek-chat");
  await expect(row.first()).toContainText("默认");
});
