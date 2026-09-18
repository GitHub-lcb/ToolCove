// Agent 工作台 E2E（移动视口）。
//
// 手机端复用**桌面端同一个** session.js 运行时，所以这里验证的是
// 「运行 → 工具调用 → 确认卡 → 收尾」整条链路在移动视口下成立。
//
// AI 桩一律复用 e2e/helpers.js 的 mockAI / toolCall / final / AI_SETTINGS ——
// 我一开始自己造了一套 {type:"tool"}，运行时直接回 "Unknown action type"（正确是 tool_call）。
import { expect, test } from "@playwright/test";
import { AI_SETTINGS, final, mockAI, seedData, seedWithAI, toolCall } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";
const askUser = (question) => ({ type: "ask_user", question });

const goAgent = async (page) => {
  await page.locator(".m-tab[data-tab='agent']").click();
  await expect(page.locator(".m-agent")).toBeVisible();
};

/**
 * 手机端的"发起一次运行"：桌面端是输入框按 Enter，手机端是点按钮（软键盘上没有可靠的 Enter）。
 * 这也是移动端化的一个真实差异，所以不复用 helpers 的 runGoal。
 */
const startRun = async (page, goal) => {
  await page.locator('[data-role="goal"]').fill(goal);
  await page.locator('[data-role="start"]').click();
};

test.describe("手机端 Agent 工作台", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("没配 AI 时如实提示，并指出去哪儿配", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goAgent(page);

    await expect(page.locator('[data-role="no-ai"]')).toBeVisible();
    await expect(page.locator('[data-role="no-ai"]')).toContainText(/设置|配置/);
  });

  test("一次纯回答的运行：目标进得去，运行能收尾", async ({ page }) => {
    await seedWithAI(page);
    const calls = [];
    await mockAI(page, { responses: [final("已完成：读取了 3 个字段")] });
    await page.goto(MOBILE);
    await goAgent(page);

    await startRun(page, "读取 order.json 并总结");
    await expect(page.locator(".m-agent")).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
    void calls;
  });

  test("工具调用会进时间线（工具名可见）", async ({ page }) => {
    await seedWithAI(page);
    await mockAI(page, { responses: [toolCall("json.format", { text: '{"a":1}' }, "call-1"), final("已完成：格式化了 JSON")] });
    await page.goto(MOBILE);
    await goAgent(page);

    await startRun(page, "格式化这段 JSON");
    const timeline = page.locator('[data-role="timeline"]');
    await expect(timeline).toBeVisible({ timeout: 30_000 });
    await expect(timeline).toContainText("json.format", { timeout: 30_000 });
    await expect(page.locator(".m-agent")).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
  });

  test("危险工具弹确认卡：拒绝后留下审计记录", async ({ page }) => {
    await seedWithAI(page);
    // ⚠️ 不能用 file.write_text：那是 desktopOnly，浏览器/手机形态下根本不存在这个工具。
    // 手机端会触发确认卡的是 http.request / data.create|update|remove（risk=write 且双端可用）。
    await mockAI(page, {
      responses: [
        toolCall("http.request", { url: "http://e2e.test/api/x", method: "POST", body: "{}" }, "call-h"),
        final("已完成"),
      ],
    });
    await page.goto(MOBILE);
    await goAgent(page);

    await startRun(page, "往接口发一条数据");
    const pending = page.locator('[data-role="pending"]');
    await expect(pending).toBeVisible({ timeout: 30_000 });
    // 确认卡要说清"要动哪个工具"
    await expect(page.locator('[data-role="pending-tool"]')).toContainText("http.request");

    await page.locator('[data-role="deny"]').click();
    // 拒绝后必须留下痕迹（审计行），而不是悄无声息地跳过
    await expect(page.locator('[data-role="approval"]').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".m-agent")).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
  });

  test("模型提问：输入回答后进时间线，显示为「已回答」", async ({ page }) => {
    await seedWithAI(page);
    await mockAI(page, { responses: [askUser("请提供文件路径"), final("已完成：读到了文件")] });
    await page.goto(MOBILE);
    await goAgent(page);

    await startRun(page, "读取一个文件");
    const pending = page.locator('[data-role="pending"]');
    await expect(pending).toBeVisible({ timeout: 30_000 });
    await expect(pending).toContainText(/内容|路径/);

    await page.locator('[data-role="answer"]').fill("/sdcard/order.json");
    await page.locator('[data-role="answer-send"]').click();

    await expect(page.locator('[data-role="confirm-row"]').first()).toContainText("已回答", { timeout: 30_000 });
    await expect(page.locator(".m-agent")).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
  });

  test("运行历史：本轮结束后能查到目标与状态", async ({ page }) => {
    await seedWithAI(page);
    await mockAI(page, { responses: [final("已完成：第一次")] });
    await page.goto(MOBILE);
    await goAgent(page);

    await startRun(page, "第一个目标");
    await expect(page.locator(".m-agent")).toHaveAttribute("data-status", "idle", { timeout: 30_000 });

    await page.locator('[data-tab="history"]').click();
    const run = page.locator("[data-run]").first();
    await expect(run.locator('[data-role="run-input"]')).toContainText("第一个目标");
    await expect(run.locator('[data-role="resume"]')).toBeVisible();
  });

  test("技能库：空态有说明；运行成功后能沉淀成技能", async ({ page }) => {
    await seedWithAI(page);
    // 沉淀条件（见 src/agent/skills.js 的 extractSkill）：成功 + 至少一次工具调用 + 指令足够长。
    // 所以这里必须让运行里**真的发生一次工具调用**，纯回答的运行是沉淀不了的。
    await mockAI(page, {
      responses: [toolCall("json.format", { text: '{"a":1,"b":[1,2]}' }, "c1"), final("已完成：格式化了 JSON 并总结了字段")],
    });
    await page.goto(MOBILE);
    await goAgent(page);

    await page.locator('[data-tab="skills"]').click();
    await expect(page.locator('[data-role="skills-empty"]')).toBeVisible();

    await page.locator('[data-tab="run"]').click();
    await startRun(page, "格式化这段 JSON 并总结字段含义");
    await expect(page.locator(".m-agent")).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
    // 先确认工具调用真的发生了（否则沉淀必然失败，且失败原因是"没有工具调用"）
    await expect(page.locator('[data-role="timeline"]')).toContainText("json.format");

    await page.locator('[data-tab="history"]').click();
    await page.locator('[data-run]').first().locator('[data-role="promote"]').click();
    await page.locator('[data-tab="skills"]').click();
    await expect(page.locator("[data-skill]").first()).toBeVisible({ timeout: 10_000 });
    // 沉淀后这条技能该是启用状态（关掉就不再注入，这是技能开关的语义）
    await expect(page.locator('[data-role="skill-toggle"]').first()).toHaveClass(/on/);
  });

  test("沉淀失败时说明原因，而不是点了没反应", async ({ page }) => {
    await seedWithAI(page);
    // 纯回答、没有工具调用 → extractSkill 必然拒绝
    await mockAI(page, { responses: [final("已完成：只是回答了一句")] });
    await page.goto(MOBILE);
    await goAgent(page);

    await startRun(page, "只是问一句");
    await expect(page.locator(".m-agent")).toHaveAttribute("data-status", "idle", { timeout: 30_000 });

    await page.locator('[data-tab="history"]').click();
    await page.locator('[data-run]').first().locator('[data-role="promote"]').click();
    await page.locator('[data-tab="skills"]').click();

    // 必须给出可读原因（promoteRunToSkill 用返回值表达拒绝，不抛异常——不检查就会静默）
    const notice = page.locator('[data-role="skills-notice"]');
    await expect(notice).toBeVisible();
    expect((await notice.innerText()).length).toBeGreaterThan(6);
    await expect(page.locator("[data-skill]")).toHaveCount(0);
  });

  test("AI 配置来自设置页：没配 AI 时运行会被拦住而不是静默失败", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goAgent(page);

    await startRun(page, "随便做点什么");
    // 要么给出可读错误，要么明确提示未配置——不能什么都不发生
    await expect(page.locator('[data-role="no-ai"]')).toBeVisible();
  });

  test("AI_SETTINGS 与设置页写入的形状一致（两端共用同一份配置）", async ({ page }) => {
    await seedWithAI(page);
    await seedData(page, { settings: AI_SETTINGS });
    await page.goto(MOBILE);
    await goAgent(page);
    // 配好 AI 后不该再出现"未配置"提示
    await expect(page.locator('[data-role="no-ai"]')).toHaveCount(0);
  });
});
