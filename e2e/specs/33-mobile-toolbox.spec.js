// 工具箱 E2E（移动视口）：目录、迁移进度、三个已迁移工具的实际行为。
//
// 关键的一条是「重工具首屏不加载」：时间工具带 Luxon（约 180KB），
// 如果它进了首屏包，手机端启动就会明显变慢——这类回归只有靠请求记录才能发现。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

const goToolbox = async (page) => {
  await page.locator(".m-tab[data-tab='toolbox']").click();
  await expect(page.locator(".m-toolbox")).toBeVisible();
};

const openTool = async (page, key) => {
  await page.locator(`.m-item[data-tool="${key}"] .m-item-main`).click();
  await expect(page.locator(`.m-tool[data-tool="${key}"]`)).toBeVisible();
};

test.describe("手机端工具箱", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("首屏只取启动必需的 chunk，重工具（时间/Luxon）不加载", async ({ page }) => {
    const scripts = [];
    page.on("request", (request) => {
      if (request.resourceType() === "script") scripts.push(request.url());
    });
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "convert");
    await expect(page.locator('[data-tool="convert"] textarea').first()).toBeVisible();

    const loaded = scripts.join(" ");
    expect(loaded, "转换工具不该把时间工具一起拉进来").not.toContain("TimeToolView");
    expect(loaded, "JSON 工具也不该被转换工具拉进来").not.toContain("JsonToolView");
  });

  test("目录：分组齐全、未迁移的如实标注且点不动", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);

    // 迁移进度可见（这是一个「做到哪了」的诚实指标）
    await expect(page.locator('[data-role="tool-progress"]')).toContainText("/");

    // 已迁移的几个可以点
    for (const key of ["json", "convert", "time"]) {
      await expect(page.locator(`.m-item[data-tool="${key}"]`)).toHaveAttribute("data-ready", "true");
    }

    // 现在 14 个工具**全部迁移完成**，所以"未迁移的禁用"这条规则没有实例可断言了。
    // 改为断言完成状态本身 + 「能力受限的仍带说明」（可用 ≠ 和桌面一样）——
    // 后者才是这条用例真正要守的东西，而且不会随进度失效。
    await expect(page.locator('.m-item[data-ready="false"]')).toHaveCount(0);
    for (const key of ["network", "file", "db", "label"]) {
      const item = page.locator(`.m-item[data-tool="${key}"]`);
      await expect(item).toHaveAttribute("data-ready", "true");
      const text = await item.innerText();
      expect(text.length, `${key} 缺少能力差异说明`).toBeGreaterThan(6);
    }
  });

  test("JSON：格式化 / 压缩 / 转义 / 去转义 / 结构统计", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "json");

    const tool = page.locator('[data-tool="json"]');
    const input = tool.locator("textarea").first();
    const output = page.locator('[data-role="output"]');
    // 动作按钮在 .m-actions 里，与顶部的模式 chip 同名，用容器区分
    const act = (name) => tool.locator(".m-actions").getByRole("button", { name, exact: true });

    // 格式化 + 结构统计
    await input.fill('{"a":[1,2],"b":{"c":true}}');
    await act("格式化").click();
    await expect(output).toHaveValue(/{\n {2}"a": \[/);
    await expect(page.locator(".m-stats")).toContainText("结构深度");

    // 压缩
    await act("压缩").click();
    await expect(output).toHaveValue('{"a":[1,2],"b":{"c":true}}');

    // 转义：把内容转成可嵌入字符串的形态（内层内容，不带首尾引号）
    await input.fill('{"a":1}');
    await act("转义").click();
    await expect(output).toHaveValue('{\\"a\\":1}');

    // 去转义：吃的是上一步的**内容**（函数自己补引号），所以把结果接回输入
    await act("结果转输入").click();
    await expect(input).toHaveValue('{\\"a\\":1}');
    await act("去转义").click();
    await expect(output).toHaveValue('{"a":1}');
  });

  test("JSON：错误给出行列位置，而不是一句「解析失败」", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "json");

    const tool = page.locator('[data-tool="json"]');
    await tool.locator("textarea").first().fill('{\n  "a": 1,\n}');
    await tool.locator(".m-actions").getByRole("button", { name: "格式化", exact: true }).click();

    const error = page.locator('[data-role="error"]');
    await expect(error).toBeVisible();
    // 桌面端既有词条 errorLocation 是「第 {line} 行第 {column} 列：{message}」，
    // 手机端复用它（两端措辞一致），所以这里断言行号出现即可
    await expect(error).toContainText("第");
    await expect(error).toContainText("行");
    await expect(page.locator('[data-role="output"]')).toHaveValue("");
  });

  test("JSON：脱敏按敏感字段名处理，并说明脱敏了几处", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "json");

    const tool = page.locator('[data-tool="json"]');
    await tool.locator("textarea").first().fill('{"password":"secret","name":"lcb"}');
    // 模式 chip 与动作按钮都叫「脱敏」：先切模式，再执行
    await tool.locator(".m-chips").getByRole("button", { name: "脱敏", exact: true }).click();
    await tool.locator(".m-actions").getByRole("button", { name: "脱敏", exact: true }).click();

    await expect(page.locator('[data-role="info"]')).toContainText("1");
    await expect(page.locator('[data-role="output"]')).toHaveValue(/se\*\*et/);
    await expect(page.locator('[data-role="output"]')).toHaveValue(/lcb/);
  });

  test("转换：Base64 与 URL 往返、非法输入给出原因", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "convert");

    const input = page.locator('[data-tool="convert"] textarea').first();
    const output = page.locator('[data-role="output"]');

    await input.fill("你好");
    await page.locator(".m-btn", { hasText: "编码" }).click();
    await expect(output).toHaveValue("5L2g5aW9");
    await page.locator(".m-btn", { hasText: "结果转输入" }).click();
    await page.locator(".m-btn", { hasText: "解码" }).click();
    await expect(output).toHaveValue("你好");

    // 切到 URL 类型
    await page.locator(".m-chip", { hasText: "URL" }).click();
    await input.fill("a b&c");
    await page.locator(".m-btn", { hasText: "编码" }).click();
    await expect(output).toHaveValue("a%20b%26c");

    // 非法输入：给出可读原因而不是静默
    await page.locator(".m-chip", { hasText: "Base64" }).click();
    await input.fill("!!!not base64!!!");
    await page.locator(".m-btn", { hasText: "解码" }).click();
    await expect(page.locator('[data-role="error"]')).toContainText(/Base64/);
  });

  test("时间：当前时间戳可见，解析秒/毫秒都正确", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "time");

    // 当前时间：毫秒时间戳是 13 位，每秒刷新
    const nowMs = page.locator('[data-role="now-ms"]');
    await expect(nowMs).toHaveText(/^\d{13}$/);
    await expect(page.locator('[data-role="now-iso"]')).toHaveText(/^\d{4}-\d{2}-\d{2}T/);

    // 已知时间戳：1700000000 秒 = 2023-11-14T22:13:20Z。
    // ⚠️ 显示按**本机时区**渲染（与桌面端口径一致），所以断言不能写 UTC 字面量——
    // 这里换算成与运行机器无关的判定：秒与毫秒必须得到同一个瞬间。
    const stampInput = page.locator('[data-tool="time"] input').first();
    await stampInput.fill("1700000000");
    const isoFromSeconds = await page.locator('[data-role="stamp-iso"]').innerText();
    await stampInput.fill("1700000000000");
    const isoFromMillis = await page.locator('[data-role="stamp-iso"]').innerText();
    expect(isoFromSeconds).toContain("2023-11-1"); // UTC 11-14 22:13，东八区落在 11-15
    expect(isoFromMillis).toBe(isoFromSeconds); // 自动单位识别：秒与毫秒指的是同一瞬间
    // 秒级值回显为 1700000000（不随显示时区变化）
    await expect(page.locator('[data-role="stamp-seconds"]')).toHaveText("1700000000");
  });

  test("时间：时区换算（UTC → 东京）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "time");

    const inputs = page.locator('[data-tool="time"] input');
    await inputs.nth(1).fill("UTC"); // 源时区
    await page.locator('[data-tool="time"] input').nth(2).fill("2026-01-01T00:00:00");
    await page.locator('[data-tool="time"] input').nth(3).fill("Asia/Tokyo");
    // 东京比 UTC 快 9 小时
    await expect(page.locator('[data-role="zone-target"]')).toContainText("2026-01-01 09:00");
  });

  test("返回：从工具页回到列表页", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "json");
    await page.locator(".m-back").click();
    await expect(page.locator(".m-toolbox")).toHaveAttribute("data-view", "list");
    await expect(page.locator('.m-item[data-tool="convert"]')).toBeVisible();
  });
});
