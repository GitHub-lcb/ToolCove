// 面试刷题 E2E（浏览器形态、工具箱内嵌）。
//
// 题库契约、进度回路、导入解析都有单测兜着，这里守的是**刷起来的那条路**：
// 搜到题 → 打开 → 答案默认是折着的 → 展开看到题解与出处 → 自评 → 统计跟着涨 → 刷新还在。
// 另外锁三条最容易悄悄坏掉的规则：答案必须先折着；换题要重新折起来；导入失败要说出原因而不是静默。
import { expect, test } from "@playwright/test";

/** 打开面试刷题工具。搜「刷题」而不是「面试」——后者会同时命中别的东西。 */
async function openTool(page) {
  await page.locator(".nav-item", { hasText: "工具箱" }).click();
  // 用 .toolbox-search input 而不是 getByRole("searchbox")：工具卡片里也有 type="search" 的输入框，
  // 按角色取会命中多个（其余工具用例同样按这个类名定位）。
  await page.locator(".toolbox-search input").fill("刷题");
  const card = page.locator(".tool-item", { hasText: "面试刷题" });
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.click();
  await page.locator('[data-role="question-list"]').waitFor({ state: "visible", timeout: 10_000 });
}

/** 列表里第一道题的 data-role 值，用来在刷新后断言「还是同一道题」。 */
async function firstQuestionRole(page) {
  const value = await page.locator('[data-role="question-list"] [data-role^="q-"]').first().getAttribute("data-role");
  // 取到的是 data-role 的**值**（如 q-backend-jvm-runtime-areas），要拼回属性选择器再用
  return `[data-role="${value}"]`;
}

test.describe("工具箱（面试刷题）", () => {
  test("首屏是题库：列表有题、统计在、答案默认折着", async ({ page }) => {
    await page.goto("/");
    await openTool(page);

    await expect(page.locator('[data-role="question-list"] [data-role^="q-"]').first()).toBeVisible();
    await expect(page.locator('[data-role="stats"]')).toBeVisible();
    await expect(page.locator('[data-role="pct"]')).toHaveText("0%");

    // 这是这个工具存在的唯一理由：没点之前不该有题解
    await expect(page.locator('[data-role="answer"]')).toHaveCount(0);
    await expect(page.locator('[data-role="sources"]')).toHaveCount(0);
    await expect(page.locator('[data-role="reveal"]')).toContainText("看题解");
  });

  test("展开题解：出现题解、要点、出处与可点开的仓库链接", async ({ page }) => {
    await page.goto("/");
    await openTool(page);

    await page.locator('[data-role="reveal"]').click();
    await expect(page.locator('[data-role="answer"]')).toBeVisible();
    await expect(page.locator('[data-role="points"]')).toBeVisible();
    await expect(page.locator('[data-role="points"] li')).toHaveCount(3);
    await expect(page.locator('[data-role="sources"]')).toBeVisible();
    // 出处必须是高 star 的开源仓库，且链到 GitHub
    const link = page.locator('[data-role="sources"] .src').first();
    await expect(link).toBeVisible();
    await expect(link).toContainText("★");
  });

  test("自评会推动掌握度与统计，并且落进存档（刷新还在）", async ({ page }) => {
    await page.goto("/");
    await openTool(page);

    const role = await firstQuestionRole(page);
    await page.locator('[data-role="reveal"]').click();
    // 连续两次「会了」才算掌握——这是 interviewProgress 的口径，界面必须与之一致。
    // 断言 data-mastery 而不是 CSS class：class 是表现，data 属性才是契约（改样式不该弄红用例）。
    await expect(page.locator(role)).toHaveAttribute("data-mastery", "0");
    await page.locator('[data-role="rate-good"]').click();
    await expect(page.locator(role)).toHaveAttribute("data-mastery", "1");
    await expect(page.locator('[data-role="pct"]')).toHaveText("0%");
    await page.locator('[data-role="rate-good"]').click();
    await expect(page.locator(role)).toHaveAttribute("data-mastery", "2");
    await expect(page.locator('[data-role="pct"]')).not.toHaveText("0%");
    await expect(page.locator('[data-role="stats"]')).toContainText("1");

    await page.reload();
    await openTool(page);
    await expect(page.locator(role)).toHaveAttribute("data-mastery", "2");
    await expect(page.locator('[data-role="pct"]')).not.toHaveText("0%");
  });

  test("换一道题，答案重新折起来（不能带着上一题的题解）", async ({ page }) => {
    await page.goto("/");
    await openTool(page);

    await page.locator('[data-role="reveal"]').click();
    await expect(page.locator('[data-role="answer"]')).toBeVisible();

    const items = page.locator('[data-role="question-list"] [data-role^="q-"]');
    await items.nth(1).click();
    await expect(page.locator('[data-role="answer"]')).toHaveCount(0);
    await expect(page.locator('[data-role="reveal"]')).toContainText("看题解");
  });

  test("搜索能筛掉不相关的题，且筛选条件叠加后能回到全部", async ({ page }) => {
    await page.goto("/");
    await openTool(page);

    const before = await page.locator('[data-role="question-list"] [data-role^="q-"]').count();
    await page.locator('[data-role="search"]').fill("JVM");
    await expect(page.locator('[data-role="filter-count"]')).toContainText("道题");
    const after = await page.locator('[data-role="question-list"] [data-role^="q-"]').count();
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);

    await page.locator('[data-role="search"]').fill("");
    await expect(page.locator('[data-role="question-list"] [data-role^="q-"]')).toHaveCount(before);
  });

  test("导入：合法 Markdown 进得来，写错了要说清原因", async ({ page }) => {
    await page.goto("/");
    await openTool(page);
    await page.locator('[data-role="tab-manage"]').click();

    // 默认「从文件头读方向」。先给一份既没写方向、也没有任何标题的——必须报错而不是静默成功
    await page.locator('[data-role="import-text"]').fill("就是一段普通文字，没有任何标题。");
    await page.locator('[data-role="import-run"]').click();
    await expect(page.locator('[data-role="import-error"]')).toBeVisible();

    // 有标题但文件头没写方向：报的是「没写方向」那条，而不是笼统的失败
    await page.locator('[data-role="import-text"]').fill("## 一道没有方向的题\n正文。");
    await page.locator('[data-role="import-run"]').click();
    await expect(page.locator('[data-role="import-error"]')).toContainText("方向");

    // 再给一份带方向的
    await page.locator('[data-role="import-text"]').fill("> 方向: backend\n> 主题: E2E\n\n## E2E 导入的题目\n这是导入进来的题解。\n\n- 要点：甲；乙；丙\n");
    await page.locator('[data-role="import-run"]').click();
    await expect(page.locator('[data-role="import-error"]')).toHaveCount(0);
    await expect(page.locator('[data-role="import-count"]')).toContainText("1");

    // 导进来的题要真的出现在题库里
    await page.locator('[data-role="tab-bank"]').click();
    await page.locator('[data-role="search"]').fill("E2E 导入的题目");
    await expect(page.locator('[data-role="question-list"] [data-role^="q-"]')).toHaveCount(1);
  });

  test("模拟面试：四方向配额开一套，自评后自动进入下一题", async ({ page }) => {
    await page.goto("/");
    await openTool(page);
    await page.locator('[data-role="tab-session"]').click();

    await page.locator('[data-role="per-category"]').fill("1");
    await expect(page.locator('[data-role="session"]')).toContainText("4");
    await page.locator('[data-role="start-session"]').click();

    await expect(page.locator('[data-role="session-progress"]')).toContainText("第 1 / 4 道");
    const first = await page.locator('[data-role="session-question"]').innerText();
    await page.locator('[data-role="session-reveal"]').click();
    await expect(page.locator('[data-role="session-answer"]')).toBeVisible();
    await page.locator('[data-role="session-rate-good"]').click();
    await expect(page.locator('[data-role="session-progress"]')).toContainText("第 2 / 4 道");
    await expect(page.locator('[data-role="session-question"]')).not.toHaveText(first);
  });
});
