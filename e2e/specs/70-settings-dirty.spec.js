// 设置页「未保存修改」标记的语义回归。
//
// 守的是什么：这个标记必须只在**用户真的改了东西**之后出现。
// 之前的缺陷是「一进设置页就显示有未保存修改」——回填跨了多个 await（解密 apiKey、
// 读开机启动状态），而 onMounted 里 loadSettings() 没被 await，于是「回填完把 dirty 置回
// false」总有一部分变更落在它之后，把标记又点亮。用户看到的是一个永远亮着的警告，
// 于是它就彻底失去意义：真正改过东西时也不再能区分。
//
// 这个缺陷不会让任何功能用例变红（保存照样能存），所以必须显式断言两侧：
// 刚进来不该亮、真改了必须亮。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

/**
 * AI 服务地址输入框。
 * 刻意用**完整 placeholder** 而不是 /例如|https/ 这类松散正则：「例如」在模型输入框的
 * placeholder 里也有，而它在 DOM 里更靠前——松散匹配会静默改到另一个字段，
 * 于是「改了字段」的断言变成了假证据。
 */
const baseUrlInput = (page) => page.getByPlaceholder(/api\.openai\.com\/v1/);

/**
 * 进设置页并切到「AI 模型」分节（走侧边栏底部入口，与真实路径一致）。
 *
 * 为什么必须显式切分节：设置页默认落在「系统设置」，其余分节是 v-show 隐藏的——
 * 隐藏元素仍在 DOM 里，locator 能解析到但 fill 会一直等到超时。不切分节就会拿到
 * 一个「找得到、点不动」的输入框。
 */
async function openSettings(page) {
  await page.locator(".side-foot button", { hasText: "设置" }).first().click();
  await expect(page.locator(".sv-bar")).toBeVisible();
  await page.locator(".sv-nav", { hasText: "AI 模型" }).first().click();
  await expect(baseUrlInput(page)).toBeVisible();
}

test("刚进设置页不该显示「有未保存修改」", async ({ page }) => {
  await seedData(page, {
    settings: { ai: { baseUrl: "", apiKey: "", model: "", enabled: false } },
  });
  await page.goto("/");
  await openSettings(page);

  // 回填是异步的：给它充分时间把「回填尾巴点亮 dirty」的旧行为暴露出来。
  // 断言放在等待之后而不是立刻，否则旧代码也可能在竞态里侥幸变绿。
  await page.waitForTimeout(1200);
  await expect(page.locator(".sv-dirty")).toHaveCount(0);

  // 切到另一个分节再回来也不该点亮（分节切换本身不是改动）
  await page.locator(".sv-nav", { hasText: "Agent" }).first().click();
  await page.waitForTimeout(400);
  await expect(page.locator(".sv-dirty")).toHaveCount(0);
  await page.locator(".sv-nav", { hasText: "AI 模型" }).first().click();
  await page.waitForTimeout(400);
  await expect(page.locator(".sv-dirty")).toHaveCount(0);
});

test("真的改了字段才亮，且存完就灭", async ({ page }) => {
  await seedData(page, {
    settings: { ai: { baseUrl: "", apiKey: "", model: "", enabled: false } },
  });
  await page.goto("/");
  await openSettings(page);
  await page.waitForTimeout(1000);
  await expect(page.locator(".sv-dirty")).toHaveCount(0);

  // 改一个真实字段：闸门只该豁免回填，不该把用户输入一起吞掉
  await baseUrlInput(page).fill("https://example.com/v1");
  await expect(page.locator(".sv-dirty")).toBeVisible();

  // 保存后复位
  await page.getByRole("button", { name: /保存/ }).first().click();
  await expect(page.locator(".sv-dirty")).toHaveCount(0, { timeout: 10_000 });
});

test("改动后切分节再切回来，标记保持（不是「切页面就重置」）", async ({ page }) => {
  await seedData(page, {
    settings: { ai: { baseUrl: "", apiKey: "", model: "", enabled: false } },
  });
  await page.goto("/");
  await openSettings(page);
  await page.waitForTimeout(1000);

  await baseUrlInput(page).fill("https://example.com/v1");
  await expect(page.locator(".sv-dirty")).toBeVisible();

  // 分节切换只是 v-show，不该把用户的未保存修改"洗掉"
  await page.locator(".sv-nav", { hasText: "Agent" }).first().click();
  await page.waitForTimeout(300);
  await expect(page.locator(".sv-dirty")).toBeVisible();
  await page.locator(".sv-nav", { hasText: "AI 模型" }).first().click();
  await page.waitForTimeout(300);
  await expect(page.locator(".sv-dirty")).toBeVisible();
  // 输入框里的值也还在
  await expect(baseUrlInput(page)).toHaveValue("https://example.com/v1");
});
