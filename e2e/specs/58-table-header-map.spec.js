// 表头语义映射 E2E：人写的表头 → 目标字段名，改完真的进导出结果。
//
// 为什么值得单独一套：改名是这个工具里唯一「模型输出会直接改用户数据」的动作，
// 纯函数单测只能证明解析规则对，证明不了三件更要紧的事——
// 采纳的建议确实落到表头上、概率不够的那条不会被应用、没配 TypeSafe 时界面不发声。
import { expect, test } from "@playwright/test";
import { mockTypeSafe, seedWithAI, typeSafeCalls, TYPESAFE_SETTINGS } from "../helpers.js";

/** 从报表里粘出来的样子：列名是中文口语，值能看出含义。 */
const TSV = [
  "客户联系\t下单金额(RMB)\t备注",
  "zhang@example.com\t128.00\t加急",
  "li@example.com\t55.00\t",
].join("\n");

/** 逐列一问（每列一个 Choice）：按请求里的问句 id 造回答。 */
function mapAnswer(byColumn) {
  return (body) => ({
    answers: Object.fromEntries(
      Object.keys(body.questions).map((id) => {
        const index = Number(id.split("::")[1]);
        const hit = byColumn[index];
        return hit
          ? [id, { type: "choice", choice: hit[0], probabilities: { [hit[0]]: hit[1] } }]
          : [id, { type: "choice", choice: "t9", probabilities: { t9: 0.9 } }];
      })
    ),
  });
}

async function openTableTool(page) {
  await page.goto("/");
  await page.locator(".nav-item", { hasText: "工具箱" }).click();
  const card = page.locator(".tool-item", { hasText: "表格处理" });
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.click();
  await page.locator('[data-role="input"]').first().waitFor({ state: "visible", timeout: 10_000 });
}

test.describe("表头语义映射", () => {
  test("识别 → 展示把握 → 应用后表头与导出 JSON 都改了", async ({ page }) => {
    test.setTimeout(60_000);
    await seedWithAI(page, TYPESAFE_SETTINGS);
    // t0=email / t1=amount / t2=user_id；第 0 列把握 0.93、第 2 列只给 0.4（低于下限不该采纳）
    await mockTypeSafe(page, { answer: mapAnswer({ 0: ["t0", 0.93], 2: ["t2", 0.4] }) });
    await openTableTool(page);
    await page.locator('[data-role="input"]').fill(TSV);

    await page.locator('[data-role="open-map"]').click();
    await page.locator('[data-role="map-targets"]').fill("email, amount, user_id");
    await page.locator('[data-role="map-run"]').click();

    const list = page.locator('[data-role="map-list"]');
    await expect(list).toBeVisible({ timeout: 15_000 });
    // 只有有把握的那一列被列出来
    await expect(list.locator(".tt-map-row")).toHaveCount(1);
    await expect(list.locator('[data-role="map-from"]')).toHaveText("客户联系");
    await expect(list.locator(".tt-map-to")).toHaveText("email");
    await expect(list.locator(".tt-map-score")).toHaveText("0.93");

    // 送出去的请求：每列一问，样本进 state（判断靠的是值而不是列名）
    const calls = await typeSafeCalls(page);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions)).toEqual(["map::0", "map::1", "map::2"]);
    expect(calls[0].state.columns[0].samples[0]).toContain("@");
    expect(calls[0].state.targets).toEqual(["email", "amount", "user_id"]);

    await page.locator('[data-role="map-apply"]').click();
    const heads = page.locator('[data-role="table"] thead th');
    // 表头里出现改名后的字段（第 0 列被采纳）
    await expect(heads.filter({ hasText: "email" })).toHaveCount(1, { timeout: 10_000 });
    // 没被采纳的那列保持原名——「猜错比不改更糟」要在界面上成立
    await expect(heads.filter({ hasText: "备注" })).toHaveCount(1);
    await expect(heads.filter({ hasText: "user_id" })).toHaveCount(0);

    // 导出也跟着变：说明改的是数据本身，不是只改了显示。
    // textarea 的内容要按 value 断言（toContainText 读的是文本节点，只读框里永远是空）。
    await page.locator('[data-role="export-format"]').selectOption("json");
    await expect(page.locator('[data-role="export-output"]')).toHaveValue(/"email": "zhang@example\.com"/, { timeout: 10_000 });
  });

  test("没配 TypeSafe 时面板说明原因，不改表头也不报错", async ({ page }) => {
    await seedWithAI(page);
    await openTableTool(page);
    await page.locator('[data-role="input"]').fill(TSV);
    await page.locator('[data-role="open-map"]').click();
    await page.locator('[data-role="map-targets"]').fill("email, amount");
    await page.locator('[data-role="map-run"]').click();
    await expect(page.locator('[data-role="map-note"]')).toHaveText(/未启用 TypeSafe/, { timeout: 10_000 });
    await expect(page.locator('[data-role="map-list"]')).toHaveCount(0);
    expect(await typeSafeCalls(page)).toHaveLength(0);
  });

  test("端点失败只说一句「识别失败」，本地清洗照常用", async ({ page }) => {
    await seedWithAI(page, TYPESAFE_SETTINGS);
    await mockTypeSafe(page, { fail: true });
    await openTableTool(page);
    await page.locator('[data-role="input"]').fill(TSV);
    await page.locator('[data-role="open-map"]').click();
    await page.locator('[data-role="map-targets"]').fill("email, amount");
    await page.locator('[data-role="map-run"]').click();
    await expect(page.locator('[data-role="map-note"]')).toContainText("语义识别失败", { timeout: 15_000 });
    // 不阻塞：去重这个纯本地操作依旧生效
    await page.locator('[data-role="dedupe"]').click();
    await expect(page.locator(".tt-table tbody tr")).toHaveCount(2, { timeout: 10_000 });
  });
});
