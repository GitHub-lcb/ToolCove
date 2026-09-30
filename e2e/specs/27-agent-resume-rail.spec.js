// 回归：重启后打开「最近任务」，续跑入口必须照常渲染且可用。
//
// 为什么只能放在 e2e：resumeMap 里的 registry 是 await 出来的异步值（工具实现层按需加载），
// 视图单测走 SSR 时默认停在「能力」tab，够不到这条分支；而漏 await 的表现是
// 「重启后点开历史列表整块渲染崩掉」——只有真实浏览器里的重启 + 点击才复现得出来。
import { expect, test } from "@playwright/test";
import { expectRunFinished, final, runGoal, seedDesktopIpc, seedWithAI, toolCall } from "../helpers.js";

const FILE = String.raw`C:\Users\e2e\notes.txt`;

test("跑过一次带工具调用的任务后，重启仍能查看并继续", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));

  await seedWithAI(page);
  await seedDesktopIpc(page, { [FILE]: "订单号 A1001" }, {
    responses: [toolCall("file.read_text", { path: FILE }, "c1"), final("读完了")],
  });
  await page.goto("/");
  await runGoal(page, `读取 ${FILE} 的内容`);
  await expectRunFinished(page);

  // 重启：运行记录从磁盘装配回来，history 里带着那条 tool_call
  await page.reload();
  await page.getByRole("button", { name: /最近任务/ }).click();

  const row = page.locator(".run-item");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(`读取 ${FILE} 的内容`);
  // registry 就绪后 read 类工具的历史应当放行续跑（而不是崩、也不是一律灰着）
  await expect(row.getByRole("button", { name: "继续运行" })).toBeEnabled();
  expect(pageErrors, `渲染期抛错：${pageErrors.join(" | ")}`).toEqual([]);
});
