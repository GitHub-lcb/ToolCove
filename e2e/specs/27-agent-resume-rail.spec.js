// 回归：重启后打开一条历史运行，续跑入口必须照常渲染且可用。
//
// 为什么只能放在 e2e：resumeMap 里的 registry 是 await 出来的异步值（工具实现层按需加载），
// 视图单测走 SSR 时拿不到它；而漏 await 的表现是「重启后点开历史整块渲染崩掉」——
// 只有真实浏览器里的重启 + 点击才复现得出来。
//
// 入口在二期迁到应用侧边栏（会话列表），三期沿用：主区不再自带「最近任务」列表，
// 历史行是侧边栏的 .task-item，点开后主区进入只读回看并给出续跑按钮。
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

  // 重启：运行记录从磁盘装配回来，侧边栏会话列表带着那条记录
  await page.reload();
  const row = page.locator(".task-item");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("读取");
  await row.click();

  // 点开后进入回看：横幅复述目标，续跑按钮在 registry 就绪后放行（read 类工具的历史可续）
  await expect(page.locator(".view-banner")).toContainText(`读取 ${FILE} 的内容`);
  await expect(page.locator(".view-banner").getByRole("button", { name: "继续运行" })).toBeEnabled();
  // 回看是只读的：输入框不该同时出现（否则会让人以为在编辑历史）
  await expect(page.locator(".goal-box")).toHaveCount(0);
  expect(pageErrors, `渲染期抛错：${pageErrors.join(" | ")}`).toEqual([]);
});
