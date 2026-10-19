// 会话基础操作 E2E：重命名 / 置顶 / 归档 / 取消归档，以及刷新后的落盘保留。
// 另外守住顶栏标题：长目标必须被压成主题，不能把右侧操作区挤出屏幕。
import { expect, test } from "@playwright/test";
import { seedWithAI } from "../helpers.js";
import { conversationTitle } from "../../src/app/taskListItems.js";

const run = (id, input, over = {}) => ({
  id,
  input,
  status: "completed",
  steps: [{ type: "final", answer: "完成", ts: 1 }],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 1 },
  createdAt: 1,
  updatedAt: Date.now(),
  ...over,
});

/** 只种一次：刷新页面时保留用户改过的标题 / 置顶 / 归档（否则 addInitScript 会覆盖它们）。 */
async function seedRuns(page, runs) {
  await page.addInitScript((data) => {
    if (!localStorage.getItem("toolbox-agentRuns")) localStorage.setItem("toolbox-agentRuns", JSON.stringify(data));
  }, runs);
}

const row = (page, text) => page.locator('[data-role="session-row"]', { hasText: text });

test.describe("会话基础操作", () => {
  test("重命名、置顶、归档与恢复，刷新后仍保留", async ({ page }) => {
    await seedWithAI(page);
    await seedRuns(page, [
      run("r3", "第三条会话", { updatedAt: Date.now() }),
      run("r2", "第二条会话", { updatedAt: Date.now() - 1000 }),
      run("r1", "第一条会话", { updatedAt: Date.now() - 2000 }),
    ]);
    await page.goto("/");

    // 重命名：更多 → 重命名 → 行内输入 → Enter
    await row(page, "第二条会话").hover();
    await row(page, "第二条会话").getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("button", { name: "重命名", exact: true }).click();
    await page.locator(".task-rename").fill("发布检查清单");
    await page.locator(".task-rename").press("Enter");
    await expect(row(page, "发布检查清单")).toBeVisible();
    await expect(row(page, "第二条会话")).toHaveCount(0);

    // 置顶：单独成组并排到最前
    await row(page, "第一条会话").hover();
    await row(page, "第一条会话").getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("button", { name: "置顶", exact: true }).click();
    await expect(page.locator(".list-group").filter({ hasText: "置顶" })).toBeVisible();
    await expect(page.locator('[data-role="session-row"]').first()).toContainText("第一条会话");

    // 归档：从当前列表消失，收进「已归档」；取消归档后回到列表
    await row(page, "发布检查清单").hover();
    await row(page, "发布检查清单").getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("button", { name: "归档", exact: true }).click();
    await expect(row(page, "发布检查清单")).toHaveCount(0);
    await page.locator(".archived-head").click();
    const archived = page.locator('[data-role="archived-row"]', { hasText: "发布检查清单" });
    await expect(archived).toBeVisible();
    await archived.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("button", { name: "取消归档", exact: true }).click();
    await expect(row(page, "发布检查清单")).toBeVisible();

    // 刷新：改名与置顶来自落盘，不是内存态
    await page.reload();
    await expect(row(page, "发布检查清单")).toBeVisible();
    await expect(page.locator('[data-role="session-row"]').first()).toContainText("第一条会话");
  });

  test("长目标在顶栏被压成主题，不挤压右侧操作区", async ({ page }) => {
    await seedWithAI(page);
    const long =
      "用 table.convert 把下面这段数据转成 SQL 的 INSERT 语句，再用 table.parse 解析校验一下结果：" +
      "并统计每个城市的人数。".repeat(8);
    await seedRuns(page, [run("r1", long)]);
    await page.goto("/");
    await page.locator('[data-role="session-row"]').first().click();

    const title = page.locator(".page-title h1");
    await expect(title).toHaveText(conversationTitle(long));
    const titleBox = await title.boundingBox();
    const actionsBox = await page.locator(".top-actions").boundingBox();
    // 标题不越界压到操作区；整个操作区也不越过窗口右缘
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(actionsBox.x + 1);
    expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(1440);
  });
});
