// 自然语言找工具 E2E：字面检索空手而归时，语义推荐要把用户领到对的工具。
//
// 为什么值得单独一套：工具箱的检索是「整串 includes」（toolboxTools.searchToolboxTools），
// 一整句诉求几乎永远不会是任何工具名/描述/关键词的子串，于是必然落在空结果页上。
// 语义匹配是这条路径上唯一的补救，而它同时带有「配了但失败」与「没配」两种静默状态——
// 单测能证明纯函数正确，证明不了界面接线（防抖、只问一次、失败时说什么）。
import { expect, test } from "@playwright/test";
import { applicableKey, mockTypeSafe, seedWithAI, typeSafeCalls, TYPESAFE_SETTINGS } from "../helpers.js";

/** 与任何工具字段都没有共同子串的一句诉求：字面检索必定 0 命中。 */
const GOAL = "这份订单数据想换成能直接在 Excel 里看的形态";

/** 按请求的实际问句造一份逐条 Noul 的回答：top 那条给高概率，其余压到下限以下。 */
function rankAnswer(top, { value = 0.91, rest = 0.04 } = {}) {
  return (body) => ({
    answers: Object.fromEntries(
      Object.keys(body.questions).map((id) => [id, { type: "noul", noul: applicableKey(id) === top ? value : rest }])
    ),
    usage: { input_tokens: 420, output_tokens: 12 },
  });
}

async function search(page, text) {
  const box = page.locator(".toolbox-search input");
  await box.waitFor({ state: "visible", timeout: 10_000 });
  await box.fill(text);
}

async function gotoToolbox(page) {
  await page.goto("/");
  await page.locator(".nav-item", { hasText: "工具箱" }).click();
}

test.describe("自然语言找工具", () => {
  test("字面检索为空时给出语义推荐，点它能直接打开那个工具", async ({ page }) => {
    test.setTimeout(60_000);
    await seedWithAI(page, TYPESAFE_SETTINGS);
    await mockTypeSafe(page, { answer: rankAnswer("table") });
    await gotoToolbox(page);
    await search(page, GOAL);

    // 空结果页被换成了推荐列表（而不是「没有找到匹配的工具」）
    const list = page.locator(".semantic-list");
    await expect(list).toBeVisible({ timeout: 15_000 });
    await expect(list.locator(".semantic-item")).toHaveCount(1);
    await expect(list.locator(".semantic-item").first()).toContainText("表格处理");
    // 概率原样展示：这是模型的把握，不是匹配度百分比
    await expect(list.locator(".semantic-score").first()).toHaveText("0.91");

    // 请求确实把全部工具当候选送了出去，且说明在 state 里（问句只能靠路径定位自己那条）
    const calls = await typeSafeCalls(page);
    expect(calls).toHaveLength(1);
    const questions = Object.keys(calls[0].questions);
    expect(questions.length).toBeGreaterThanOrEqual(10);
    expect(questions.some((id) => applicableKey(id) === "table")).toBe(true);
    expect(calls[0].state.request).toBe(GOAL);
    expect(calls[0].state.tools.table).toContain("表格处理");

    // 点了就真的打开：输入区出现即证明走的是 openTool 而不是只渲染了一张卡片
    await list.locator(".semantic-item").first().click();
    await expect(page.locator('[data-role="input"], [data-role="table"]').first()).toBeVisible({ timeout: 15_000 });
  });

  test("同一句话只问一次（改词来回不该重复打端点）", async ({ page }) => {
    await seedWithAI(page, TYPESAFE_SETTINGS);
    await mockTypeSafe(page, { answer: rankAnswer("json") });
    await gotoToolbox(page);
    await search(page, GOAL);
    await expect(page.locator(".semantic-item")).toHaveCount(1, { timeout: 15_000 });
    // 删掉再打回同一句：命中缓存，不该有第二次请求
    const box = page.locator(".toolbox-search input");
    await box.fill("");
    await search(page, GOAL);
    await page.waitForTimeout(900);
    expect(await typeSafeCalls(page)).toHaveLength(1);
  });

  test("没配 TypeSafe 时保持原样：不问、不推荐、不打扰", async ({ page }) => {
    await seedWithAI(page);
    await gotoToolbox(page);
    await search(page, GOAL);
    await expect(page.locator(".search-empty")).toContainText("没有找到匹配的工具", { timeout: 10_000 });
    await expect(page.locator(".semantic-list")).toHaveCount(0);
    expect(await typeSafeCalls(page)).toHaveLength(0);
  });

  test("端点失败时说一句「语义查找失败」，而不是静默空结果", async ({ page }) => {
    await seedWithAI(page, TYPESAFE_SETTINGS);
    await mockTypeSafe(page, { fail: true });
    await gotoToolbox(page);
    await search(page, GOAL);
    await expect(page.locator(".semantic-note")).toHaveText("语义查找失败，已停止本次推荐", { timeout: 15_000 });
    await expect(page.locator(".semantic-list")).toHaveCount(0);
  });

  test("模型没把握时不推荐（推错工具比推不出更伤信任）", async ({ page }) => {
    await seedWithAI(page, TYPESAFE_SETTINGS);
    await mockTypeSafe(page, { answer: rankAnswer("table", { value: 0.2, rest: 0.1 }) });
    await gotoToolbox(page);
    await search(page, GOAL);
    await expect(page.locator(".semantic-note")).toHaveText("语义匹配没有把握，本次不推荐", { timeout: 15_000 });
    await expect(page.locator(".semantic-list")).toHaveCount(0);
  });

  test("单个关键词不该触发语义请求（子串检索够且更准）", async ({ page }) => {
    await seedWithAI(page, TYPESAFE_SETTINGS);
    await mockTypeSafe(page, { answer: rankAnswer("table") });
    await gotoToolbox(page);
    // 「zzzzzz」够长但没有意义：不配 isSemanticWorthy 的形态（纯 ASCII 且不足三个词）
    await search(page, "zzzzzz");
    await page.waitForTimeout(900);
    await expect(page.locator(".search-empty")).toBeVisible();
    expect(await typeSafeCalls(page)).toHaveLength(0);
  });
});
