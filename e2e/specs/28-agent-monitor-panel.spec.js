// 任务监控面板的「条件出现」回归。
//
// 为什么要单独守：三期的核心取舍就是把常驻右栏撤掉——工具开关搬去设置，
// 右栏只在**运行时**才占位。这条规则的失败方式很安静：面板变成常驻，
// 对话区被挤窄 320px，而所有功能测试照样全绿（没有任何断言在看「它不该在」）。
// 所以这里同时断言两侧：运行中出现、空闲时不在、用户手动收起后不弹回来。
import { expect, test } from "@playwright/test";
import { expectRunFinished, final, mockAI, runGoal, seedWithAI, toolCall } from "../helpers.js";

const FLOW = [toolCall("json.parse", { text: '{"a":1}' }, "c1"), final("解析完成")];

test("任务监控只在运行时出现：空闲不占位、运行中出现、跑完自动收起", async ({ page }) => {
  await seedWithAI(page);
  // 桩延迟 1.5s：留出稳定的「运行中」窗口，否则本地跑得太快，抓不到进行中的状态
  await mockAI(page, { responses: FLOW, delayMs: 1500 });
  await page.goto("/");

  // 空闲：面板整块不渲染，对话区独占整宽
  await expect(page.locator(".monitor")).toHaveCount(0);

  await runGoal(page, "解析这段 JSON");
  // 运行中：面板出现，且带上本次运行的目标与「执行活动」段
  const monitor = page.locator(".monitor");
  await expect(monitor).toBeVisible({ timeout: 20_000 });
  await expect(monitor).toContainText("任务监控");
  await expect(monitor).toContainText("解析这段 JSON");
  await expect(monitor).toContainText("执行活动");
  // 面板里给出「工具开关在设置页」的指路，而不是把目录塞回来
  await expect(monitor).toContainText("设置 → Agent");
  await page.screenshot({ path: "tmp/shots/42-monitor-running.png" });

  await expectRunFinished(page);
  // 终态无产物：面板自动收起，不再白占一列
  await expect(page.locator(".monitor")).toHaveCount(0);
});

test("顶栏「任务监控」按钮可手动收起，收起后运行中也不弹回来", async ({ page }) => {
  await seedWithAI(page);
  await mockAI(page, { responses: FLOW, delayMs: 1500 });
  await page.goto("/");

  // 手动收起（此时本来就没面板，按的是意图开关）
  await page.getByRole("button", { name: "任务监控" }).click();
  await runGoal(page, "解析这段 JSON");

  // 运行中也不该出现：面板自己冒出来比少一个面板更烦人
  await expect(page.locator(".answer-card, .tl-card").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".monitor")).toHaveCount(0);
  await expectRunFinished(page);
});
