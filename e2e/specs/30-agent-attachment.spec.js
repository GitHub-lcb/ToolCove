// 回归：输入框附上的文件必须带着真实路径进到规划器提示词。
//
// 用户实测反馈：附了 invoice_detail_repair_simple.sql，Agent 仍然追问「文件在哪」。
// 视图层的 chip 只证明「界面上看得见」；这里把断言顶到模型请求体：路径与「不要再索要路径」
// 的指令都得在场。文件选择器由 seedDesktopIpc 的 dialogs 队列替身应答。
import { expect, test } from "@playwright/test";
import { aiCalls, expectRunFinished, final, runGoal, seedDesktopIpc, seedWithAI } from "../helpers.js";

const FILE = String.raw`C:\Users\e2e\invoice_detail_repair_simple.sql`;

test("从 + 选择文件后，附件路径进入提示词，附件在提交后清空", async ({ page }) => {
  // 桌面形态首启会弹一次遥测授权；本用例要点按钮，先把「已询问」种进去免得被遮罩挡住
  await seedWithAI(page, { telemetry: { prompted: true, enabled: false } });
  await seedDesktopIpc(
    page,
    { [FILE]: "select 1" },
    { dialogs: [FILE], responses: [final("收到")] }
  );
  await page.goto("/");

  await page.locator(".add-btn").click();
  await page.locator('.menu-pop [data-cmd="file"]').click();
  await expect(page.locator(".att-row .att-name")).toHaveText("invoice_detail_repair_simple.sql");

  await runGoal(page, "看看这个 SQL");
  await expectRunFinished(page);

  const calls = await aiCalls(page);
  expect(calls.length).toBeGreaterThan(0);
  const prompt = calls[0].messages[0].content;
  expect(prompt).toContain(FILE);
  expect(prompt).toContain("不要再向用户索要这些文件的路径");
  // 别忘了「附件与目标对不上时先说清楚附件是什么」这条，它是本次反馈的直接修正
  expect(prompt).toContain("先用一句话说明附件是哪份文件");

  // 提交后输入框里的附件要清空，不能跟着下一条目标再次发送
  await expect(page.locator(".att-row")).toHaveCount(0);
});
