// Agent 结果核验 E2E：说「已完成」之后，时间线上要看得见核验结论。
//
// 为什么值得单独一套：核验的全部意义就是「让人知道哪句结论没被证据支持」，
// 所以它必须落到界面上而不是只存在于返回值里。纯函数与 runtime 单测证明不了
// 那一行文案真的渲染出来、也没证明存疑时答案照样交付。
import { expect, test } from "@playwright/test";
import { final, mockAI, mockTypeSafe, runGoal, seedWithAI, TYPESAFE_SETTINGS, typeSafeCalls } from "../helpers.js";

/** 三项检查统一给一个把握（按请求里的问句 id 造回答，不写死问句名）。 */
function verifyAnswer(noul) {
  return (body) => ({ answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul }])) });
}

const FLOW = [
  { type: "tool_call", id: "c1", tool: "base64.encode", args: { text: "hi" } },
  final("已完成：编码结果是 aGk="),
];

async function run(page) {
  await mockAI(page, { responses: FLOW });
  await page.goto("/");
  await runGoal(page, "把 hi 转成 base64");
  await expect(page.locator(".answer-card")).toContainText("已完成", { timeout: 20_000 });
}

test.describe("Agent 结果核验", () => {
  test("核验通过：时间线出现「结论已核验」并带上最低把握", async ({ page }) => {
    test.setTimeout(60_000);
    await seedWithAI(page, TYPESAFE_SETTINGS);
    await mockTypeSafe(page, { answer: verifyAnswer(0.91) });
    await run(page);

    const notes = page.locator(".tl-notice");
    await expect(notes.filter({ hasText: "结论已核验" }).first()).toBeVisible({ timeout: 15_000 });
    await expect(notes.filter({ hasText: "结论已核验" }).first()).toContainText("0.91");

    // 问的是三项，且 state 里带着目标/答案/观察（核验靠的就是这三样）
    const calls = await typeSafeCalls(page);
    const verify = calls.find((body) => Object.keys(body.questions).some((id) => id.startsWith("check::")));
    expect(Object.keys(verify.questions)).toHaveLength(3);
    expect(verify.state.observations.join(" ")).toContain("base64.encode");
    expect(verify.state.answer).toContain("aGk=");
  });

  test("核验存疑：标注需要人工复核，答案照样交付", async ({ page }) => {
    await seedWithAI(page, TYPESAFE_SETTINGS);
    await mockTypeSafe(page, {
      answer: (body) => ({
        answers: Object.fromEntries(
          Object.keys(body.questions).map((id) => [id, { type: "noul", noul: id.includes("grounded") ? 0.12 : 0.9 }])
        ),
      }),
    });
    await run(page);

    const notes = page.locator(".tl-notice");
    await expect(notes.filter({ hasText: "需人工复核" }).first()).toBeVisible({ timeout: 15_000 });
    // 点名是哪一项：只说「分低」等于没说
    await expect(notes.filter({ hasText: "需人工复核" }).first()).toContainText("答案里的具体值是否有出处");
    // 核验不拦运行：答案仍然完整给出
    await expect(page.locator(".answer-card")).toContainText("aGk=");
  });

  test("没配 TypeSafe 时时间线不多这一行（未配置不是每次都该报的异常）", async ({ page }) => {
    await seedWithAI(page);
    await mockTypeSafe(page, { answer: verifyAnswer(0.9) });
    await run(page);
    await expect(page.locator(".tl-notice").filter({ hasText: "结论已核验" })).toHaveCount(0);
    expect(await typeSafeCalls(page)).toHaveLength(0);
  });
});
