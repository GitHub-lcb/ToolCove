// 工具箱第二轮 E2E：加密 / 生成器 / 文本对比。
//
// 加密用**已知向量**断言（sha256("hello") 这类值全网可查），
// 这样测的是"算对了"而不是"算出了点什么"。
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

test.describe("手机端工具箱（加密/生成器/对比）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("摘要：已知向量正确（SHA-256 / MD5）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "crypto");

    const tool = page.locator('[data-tool="crypto"]');
    await tool.locator("textarea").first().fill("hello");
    await tool.locator('[data-role="algo"]').selectOption("SHA-256");
    await tool.locator(".m-btn.primary").click();
    await expect(page.locator('[data-role="output"]')).toHaveValue("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");

    await tool.locator('[data-role="algo"]').selectOption("MD5");
    // 老算法保留但要有提示（页面上有两处提示文案，取老算法那条）
    await expect(tool.locator(".m-hint-sm").first()).toContainText("兼容");
    await tool.locator(".m-btn.primary").click();
    await expect(page.locator('[data-role="output"]')).toHaveValue("5d41402abc4b2a76b9719d911017c592");
  });

  test("HMAC：同样的消息，密钥不同结果不同", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "crypto");

    const tool = page.locator('[data-tool="crypto"]');
    await tool.locator('.m-chip[data-tab="hmac"]').click();
    await tool.locator("textarea").first().fill("hello");
    await tool.locator('[data-role="algo"]').selectOption("SHA-256");

    await tool.locator('[data-role="secret"]').fill("secret");
    await tool.locator(".m-btn.primary").click();
    await expect(page.locator('[data-role="output"]')).toHaveValue("88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b");

    await tool.locator('[data-role="secret"]').fill("other");
    await tool.locator(".m-btn.primary").click();
    await expect(page.locator('[data-role="output"]')).not.toHaveValue("88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b");
  });

  test("密码生成：长度、字符集开关、熵值都反映出来", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "crypto");

    const tool = page.locator('[data-tool="crypto"]');
    await tool.locator('.m-chip[data-tab="password"]').click();
    await tool.locator('[data-role="pw-length"]').fill("24");
    await tool.locator(".m-btn.primary").click();

    const password = page.locator('[data-role="password"]');
    await expect(password).toBeVisible();
    expect((await password.innerText()).length).toBe(24);
    await expect(page.locator('[data-role="pw-stats"]')).toContainText("熵");

    // 关掉符号集：字符池变小 → 熵值下降（取池大小那一行的值，不是整行文案）
    const poolOf = async () => (await page.locator('[data-role="pw-stats"] li').nth(2).locator("span").innerText()).trim();
    const poolBefore = await poolOf();
    await tool.locator('.m-chip[data-opt="symbols"]').click();
    await tool.locator(".m-btn.primary").click();
    const poolAfter = await poolOf();
    // 池大小文案形如「85 个候选字符」，比较其中的数字
    const num = (text) => Number(String(text).match(/(\d+)/)?.[1] ?? 0);
    expect(num(poolAfter)).toBeLessThan(num(poolBefore));
    expect(num(poolAfter)).toBeGreaterThan(0); // 不能把所有字符集都关掉（否则生成会报错）
  });

  test("生成器：标识符格式正确，且种子可复现", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "generator");

    const tool = page.locator('[data-tool="generator"]');
    const output = page.locator('[data-role="output"]');

    // UUID v4 的标准形状
    await tool.locator('[data-role="id-type"]').selectOption("uuid-v4");
    await tool.locator(".m-btn.primary").click();
    const uuids = (await output.inputValue()).split("\n");
    expect(uuids).toHaveLength(10);
    for (const id of uuids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // ULID：26 位 Crockford Base32
    await tool.locator('[data-role="id-type"]').selectOption("ulid");
    await tool.locator(".m-btn.primary").click();
    expect((await output.inputValue()).split("\n")[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("生成器：序列按前缀/步长/补零拼装", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "generator");

    const tool = page.locator('[data-tool="generator"]');
    await tool.locator('.m-chip[data-tab="sequence"]').click();
    const inputs = tool.locator(".m-field input");
    await inputs.nth(0).fill("3"); // count
    await inputs.nth(1).fill("1"); // start
    await inputs.nth(2).fill("1"); // step
    await inputs.nth(3).fill("3"); // padding
    await inputs.nth(4).fill("ID-"); // prefix
    await tool.locator(".m-btn.primary").click();

    await expect(page.locator('[data-role="output"]')).toHaveValue("ID-001\nID-002\nID-003");
  });

  test("生成器：mock 数据可选字段并导出 CSV", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "generator");

    const tool = page.locator('[data-tool="generator"]');
    await tool.locator('.m-chip[data-tab="mock"]').click();
    await tool.locator('[data-role="mock-format"]').selectOption("csv");
    await tool.locator(".m-btn.primary").click();

    const csv = await page.locator('[data-role="output"]').inputValue();
    // 共享层按 CSV 规范用 \r\n，但浏览器读取 textarea 值时会规范化成 \n——
    // 这里按 \n 切分（断言的是行内容，不是行尾符）
    const lines = csv.trim().split("\n");
    expect(lines.length).toBe(6); // 表头 + 默认 5 行
    // CSV 列数应与表头一致
    expect(lines[1].split(",").length).toBe(lines[0].split(",").length);

    // 导出 SQL：应带表名与 INSERT
    await tool.locator('[data-role="mock-format"]').selectOption("sql");
    await tool.locator(".m-btn.primary").click();
    const sql = await page.locator('[data-role="output"]').inputValue();
    expect(sql).toContain("INSERT INTO");
  });

  test("文本对比：统计与逐行标记正确", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "diff");

    const tool = page.locator('[data-tool="diff"]');
    await tool.locator('[data-role="left"]').fill("a\nb\nc");
    await tool.locator('[data-role="right"]').fill("a\nB\nc\nd");

    await expect(page.locator('[data-role="stat-added"]')).toHaveText("1");
    await expect(page.locator('[data-role="stat-removed"]')).toHaveText("0");

    // 逐行结果里能看到改动（符号 + 内容）
    const rows = page.locator('[data-role="diff-rows"] .m-diff-row');
    await expect(rows.first()).toBeVisible();
    await expect(page.locator('[data-role="diff-rows"]')).toContainText("B");
  });

  test("文本对比：内容相同给出明确结论，而不是空列表", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "diff");

    const tool = page.locator('[data-tool="diff"]');
    await tool.locator('[data-role="left"]').fill("same\ntext");
    await tool.locator('[data-role="right"]').fill("same\ntext");
    await expect(page.locator('[data-role="same"]')).toBeVisible();
    await expect(page.locator('[data-role="diff-rows"]')).toHaveCount(0);
  });

  test("文本对比：统一补丁包含文件头与 +/- 行", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "diff");

    const tool = page.locator('[data-tool="diff"]');
    await tool.locator('[data-role="left"]').fill("a\nb");
    await tool.locator('[data-role="right"]').fill("a\nc");
    await tool.locator('.m-chip[data-mode="patch"]').click();

    const patch = await page.locator('[data-role="patch"]').inputValue();
    expect(patch).toContain("@@");
    expect(patch).toContain("-b");
    expect(patch).toContain("+c");
  });

  test("新工具只在自己被打开时加载，主包不因此变大", async ({ page }) => {
    const scripts = [];
    page.on("request", (request) => {
      if (request.resourceType() === "script") scripts.push(request.url());
    });
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);

    // 目录页不该加载任何工具实现
    const atList = scripts.join(" ");
    for (const chunk of ["CryptoToolView", "GeneratorToolView", "DiffToolView", "TimeToolView"]) {
      expect(atList, `目录页不该加载 ${chunk}`).not.toContain(chunk);
    }

    await openTool(page, "diff");
    const afterOpen = scripts.join(" ");
    expect(afterOpen).toContain("DiffToolView");
    // 但只加载被打开的那个
    expect(afterOpen).not.toContain("GeneratorToolView");
    expect(afterOpen).not.toContain("CryptoToolView");
  });

  test("迁移进度跟着新工具一起前进", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);

    for (const key of ["crypto", "generator", "diff"]) {
      await expect(page.locator(`.m-item[data-tool="${key}"]`)).toHaveAttribute("data-ready", "true");
    }
    // 进度文案形如 "已迁移 6/14"
    const text = await page.locator('[data-role="tool-progress"]').innerText();
    expect(text).toMatch(/6\s*\/\s*14/);
  });
});
