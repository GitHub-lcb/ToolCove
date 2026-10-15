// 技能库端到端：沉淀 → 注入 → 停用 → 删除。
//
// 为什么值得单独一套：技能是 Agent 唯一的「可增长」部分，而它此前只有单测覆盖引擎与整形层，
// 界面上「按钮点了会怎样、开关真的会改变注入内容」没有任何自动化验证（一直是人工待验项）。
//
// 断言口径说明：技能命中进入 prompt 的内容是从**桩收到的请求**里读的（aiCalls），
// 而不是看界面文案——这才真正回答「关掉技能之后，模型还能不能看到它」。
//
// 三期位置变更：技能库原先常驻在对话右栏（`.rail`），导航重构后与工具开关一起搬进
// 「设置 → Agent」。技能库本身仍是独立存储键（skillStore），不受设置保存路径影响。
import { expect, test } from "@playwright/test";
import { aiCalls, final, mockAI, openAgentSettings, runGoal, seedWithAI, toolCall } from "../helpers.js";

/** 同一段目标与工具链：第二次运行与第一次足够相似，技能必然命中。 */
const GOAL = "读取 order.json 找出重复字段并导出 csv";
const FLOW = [toolCall("json.parse", { text: '{"a":1}' }, "c1"), final("已完成：找到 2 个重复字段")];

/** 从桩收到的请求里取出所有 prompt 文本（历史与技能都在这段文本里）。 */
async function promptText(page) {
  const calls = await aiCalls(page);
  return calls.map((c) => String(c.messages?.at(-1)?.content ?? "")).join("\n");
}

test("跑成功 → 沉淀为技能 → 出现在技能库 → 下次命中并注入 prompt", async ({ page }) => {
  test.setTimeout(60_000);
  await seedWithAI(page);
  await mockAI(page, { responses: FLOW });
  await page.goto("/");
  await runGoal(page, GOAL);
  await expect(page.locator(".answer-card")).toContainText("已完成", { timeout: 20_000 });

  // 1) 沉淀：最终答复卡上的按钮
  const promote = page.getByRole("button", { name: "沉淀为技能" });
  await expect(promote).toBeVisible();
  await promote.click();
  // 提示语里带技能名（名字取目标首行），用它确认「存的是这一条」
  await expect(page.locator(".toast, .tc-toast").first()).toContainText(GOAL.slice(0, 8), { timeout: 10_000 });

  // 2) 技能库出现在「设置 → Agent」，且里面有这一条（列表直接平铺，没有折叠头）
  const sect = await openAgentSettings(page);
  const skillName = GOAL.slice(0, 20);
  const skills = sect.locator(".agent-skills");
  await expect(skills.locator(".agent-tool-name", { hasText: skillName }).first()).toBeVisible();

  // 3) 下一次同类目标：技能正文进 prompt
  await seedWithAI(page); // 重新播种设置（技能库是独立键，不受影响）
  await mockAI(page, { responses: FLOW });
  await page.goto("/");
  await runGoal(page, GOAL);
  await expect(page.locator(".answer-card")).toContainText("已完成", { timeout: 20_000 });
  const withSkill = await promptText(page);
  expect(withSkill, "命中技能时 prompt 里应有技能段").toContain("【技能】");

  // 4) 停用技能后：不再注入（这是开关真正的语义）
  // 点 label 而不是原生 input：.switch input 是 display:none（视觉由 .track 承担），
  // 对不可见元素做 check/uncheck 会被 Playwright 拒掉。点击包裹它的 label 才是真实交互路径。
  await page.goto("/");
  const skills2 = (await openAgentSettings(page)).locator(".agent-skills");
  const skillRow = skills2.locator(".agent-tool-row", { hasText: skillName }).first();
  await expect(skillRow.locator(".switch input")).toBeChecked();
  await skillRow.locator(".switch").click();
  await expect(skillRow.locator(".switch input")).not.toBeChecked();
  await mockAI(page, { responses: FLOW });
  await page.locator(".new-chat").click(); // 回 Agent 主区
  await runGoal(page, GOAL);
  await expect(page.locator(".answer-card")).toContainText("已完成", { timeout: 20_000 });
  const afterDisable = await promptText(page);
  expect(afterDisable, "停用后 prompt 里不该再有技能段").not.toContain("【技能】");

  // 5) 删除：技能库回到空态
  await page.goto("/");
  const skills3 = (await openAgentSettings(page)).locator(".agent-skills");
  await skills3.locator(".agent-tool-row", { hasText: skillName }).first().locator(".link-btn.danger").click();
  await expect(skills3.locator(".agent-tool-row", { hasText: skillName })).toHaveCount(0);
  await expect(skills3).toContainText("还没有技能");
});

test("不成功的运行不会出现可沉淀的技能（按钮点了也只提示不能沉淀）", async ({ page }) => {
  test.setTimeout(60_000);
  await seedWithAI(page);
  // 只有 ask_user 没有工具调用 → extractSkill 判为不可沉淀
  await mockAI(page, { responses: [{ type: "ask_user", question: "请提供文件路径" }] });
  await page.goto("/");
  await runGoal(page, "比较两个文件");

  // 提问卡出现即为运行中；不回答，直接确认此时没有最终答复卡（也就没有沉淀入口）
  await expect(page.locator(".confirm")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".answer-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "沉淀为技能" })).toHaveCount(0);
});
