// 回归：ask_user 要的是**文本**答案，不是允许/拒绝。
// 用户实测反馈的原始现象：让它比较两个文件，它问「请提供两个文件的绝对路径」，点「允许」之后
// 它还是问路径，界面上始终没有地方能输入路径——因为当时提问复用了布尔确认卡。
import { expect, test } from "@playwright/test";
import { aiCalls, final, mockAI, runGoal, seedWithAI } from "../helpers.js";

const ASK = { type: "ask_user", question: "请提供两个文件的绝对路径（例如 C:\\a.txt）" };
const FILE = String.raw`C:\Users\e2e\a.txt`;

test("提问卡是输入框而不是允许/拒绝，回答会作为文本回灌给模型", async ({ page }) => {
  await seedWithAI(page);
  await mockAI(page, {
    responses: [
      ASK,
      // 模型拿到路径后收尾；用最终答复把「它到底收到了什么」暴露在界面上
      (() => final("收到路径，已开始比较"))(),
    ],
  });
  await page.goto("/");
  await runGoal(page, "比较两个文本文件的差异");

  // 1) 出现的是提问卡：有输入框，且没有「允许 / 拒绝」两个按钮
  const card = page.locator(".confirm");
  await expect(card).toBeVisible();
  await expect(card).toContainText("请提供两个文件的绝对路径");
  const answerBox = card.locator("textarea.cf-answer");
  await expect(answerBox).toBeVisible();
  await expect(card.getByRole("button", { name: "允许" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "拒绝" })).toHaveCount(0);

  // 2) 空回答不发：按钮禁用，提示不要填空白
  await expect(card.getByRole("button", { name: "发送回答" })).toBeDisabled();

  // 3) 填入文本 → 发送 → 运行继续到收尾
  await answerBox.fill(FILE);
  await card.getByRole("button", { name: "发送回答" }).click();
  await expect(page.locator(".answer-card")).toContainText("收到路径，已开始比较", { timeout: 20_000 });

  // 4) 关键断言：模型第二次调用时，历史里 ask_user 的 answer **就是那段文本**（不是 true/false）。
  //    提示词里的历史是「JSON 套 JSON」，字符串匹配会被多层转义坑住，所以解析后取值。
  const calls = await aiCalls(page);
  expect(calls.length).toBeGreaterThanOrEqual(2);
  const prompt = String(calls[1].messages.at(-1)?.content ?? "");
  const historyBlock = prompt.slice(prompt.indexOf("历史：") + "历史：".length).trim();
  const parsed = JSON.parse(historyBlock);
  const answers = [];
  const collect = (node) => {
    if (!node || typeof node !== "object") return;
    if (Object.hasOwn(node, "answer")) answers.push(node.answer);
    for (const value of Object.values(node)) collect(value);
  };
  collect(parsed);
  expect(answers, "历史里应带上用户填的路径原文").toContain(FILE);
  expect(answers, "不该把它当成布尔同意").not.toContain(true);

  // 5) 时间线里也记了这次回答（kind=ask 的确认行）
  await expect(page.locator(".timeline")).toContainText(FILE);
});

test("跳过提问 = 放弃这次目标（不会偷偷继续）", async ({ page }) => {
  await seedWithAI(page);
  await mockAI(page, { responses: [ASK, final("不应该走到这里")] });
  await page.goto("/");
  await runGoal(page, "比较两个文本文件的差异");

  const card = page.locator(".confirm");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "跳过并结束" }).click();

  // 顶部状态回到「已取消」，且不会出现那条最终答复
  await expect(page.locator(".st-chip").first()).toHaveText(/已取消/, { timeout: 20_000 });
  await expect(page.locator(".answer-card")).toHaveCount(0);
});
