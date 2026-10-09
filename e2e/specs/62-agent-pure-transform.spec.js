// Agent 到底用不用得上表格 / XML / JSON Schema / Markdown 这四类工具。
//
// 为什么要有这一条：catalog/executors 的单测证明的是「函数返回的形状对」，
// 而实现层是**动态 import** 的——只有跑真实构建产物才知道打包后这些工具能不能被装配起来，
// 也只有 e2e 能证明执行结果真的回灌进了下一轮 prompt（模型看不到的工具等于不存在）。
import { expect, test } from "@playwright/test";
import { aiCalls, final, mockAI, runGoal, seedWithAI, toolCall } from "../helpers.js";

const CSV = "name,score\nbob,9\nbob,9\n";

test("table.parse 与 schema.validate 真被执行，结果进下一轮 prompt", async ({ page }) => {
  test.setTimeout(60_000);
  await seedWithAI(page);
  await mockAI(page, {
    responses: [
      toolCall("table.parse", { text: CSV }, "c1"),
      toolCall("schema.validate", { value: '{"a":1}', schemaText: '{"type":"object","required":["b"]}' }, "c2"),
      final("已完成"),
    ],
  });
  await page.goto("/");
  await runGoal(page, "看这段 CSV 有没有重复行，并按 Schema 校验一下这条数据");

  // 1) 两个工具都出现在时间线上，且执行状态是成功（b-ok 而不是 b-error）
  for (const name of ["table.parse", "schema.validate"]) {
    const card = page.locator(".tl-card").filter({ has: page.locator(`.tl-name:text-is("${name}")`) });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator(".tl-head .tl-badge.b-ok")).toBeVisible();
  }

  // 2) 关键：执行结果回灌给了模型——table.parse 的统计（duplicates/totalRows）
  //    与 schema.validate 的错误关键字（required）都要出现在后续 prompt 里
  const calls = await aiCalls(page);
  expect(calls.length, "两次工具调用后还应有一次收尾").toBeGreaterThanOrEqual(3);
  const lastPrompt = String(calls.at(-1).messages.at(-1)?.content ?? "");
  expect(lastPrompt).toContain("table.parse");
  expect(lastPrompt).toContain("duplicates");
  expect(lastPrompt).toContain("totalRows");
  expect(lastPrompt).toContain("schema.validate");
  expect(lastPrompt).toContain("required");

  // 3) 工具清单里带着这九个小工具（description 是给规划器看的，缺了它就选不中）
  const toolList = String(calls[0].messages[0]?.content ?? "");
  for (const name of ["table.convert", "xml.format", "xml.to_json", "xml.validate", "markdown.normalize", "markdown.lint"]) {
    expect(toolList, `工具清单缺少 ${name}`).toContain(`"${name}"`);
  }
});
