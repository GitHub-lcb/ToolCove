// 回归：语言包按需加载在真实浏览器里成立。
//
// 背景：首屏只打包当前语言（另一种懒加载，把入口 chunk 从 552KB 降到 437KB）。
// 这里要证明三件事：
//   1) 英文系统 + 英文偏好时界面真的是英文（懒加载的包能正确装配，不是闪一堆词条 key）；
//   2) 中文系统下切到英文也能生效（运行时切换路径）；
//   3) 首屏不会去加载另一种语言包（否则省下的成本又被付回去了）。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const UI_SETTINGS = (locale) => ({ ui: { locale }, ai: { baseUrl: "", apiKey: "", model: "", enabled: false } });

test("英文偏好：界面是英文，且没有漏出词条 key", async ({ page }) => {
  await page.emulateMedia({ locale: "en-US" });
  await seedData(page, { settings: UI_SETTINGS("en-US") });
  await page.goto("/");
  await page.locator(".agent").waitFor();

  const body = await page.locator("body").innerText();
  // 英文界面必须真的出现英文（懒加载包装配失败时这里会全是中文或词条 key）
  expect(body, "英文偏好下应渲染英文").toMatch(/Agent|Tools|Settings|Capabilities/i);
  expect(body, "不该漏出词条 key").not.toMatch(/\b(agent|nav|toolbox|settings)\.[a-zA-Z]+\.[a-zA-Z]+/);
  // 中文专有文案不应出现在英文界面里
  expect(body).not.toContain("欢迎使用 Agent 工作台");
});

test("中文系统下切到英文：运行时切换生效", async ({ page }) => {
  await page.emulateMedia({ locale: "zh-CN" });
  await seedData(page, { settings: UI_SETTINGS("system") });
  await page.goto("/");
  await page.locator(".agent").waitFor();
  await expect(page.locator("body")).toContainText("欢迎使用 Agent 工作台");

  // 走设置页的语言切换（保存后 applyLocale 会 await 字典加载）
  const switched = await page.evaluate(async () => {
    const button = [...document.querySelectorAll(".nav-item, button")].find((el) => /设置/.test(el.textContent || ""));
    button?.click();
    await new Promise((r) => setTimeout(r, 400));
    const select = [...document.querySelectorAll("select")].find((el) => [...el.options].some((o) => /en-US/.test(o.value)));
    if (!select) return false;
    select.value = "en-US";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const inputs = [...document.querySelectorAll("button")].filter((el) => /保存/.test(el.textContent || ""));
    inputs.at(-1)?.click();
    return true;
  });
  expect(switched, "设置页应能找到语言选择与保存").toBe(true);
  await expect(page.locator("body")).toContainText(/Settings|Capabilities|Tools/i, { timeout: 10_000 });
});

test("中文系统首屏不加载另一种语言包（省下的成本不能又被付回去）", async ({ page }) => {
  await page.emulateMedia({ locale: "zh-CN" });
  await seedData(page, { settings: UI_SETTINGS("system") });

  // 判据一（确定性）：入口 HTML 的静态引用里不该出现另一种语言包。
  // 这比「FCP 之前有没有发请求」稳得多——后者依赖墙钟窗口，机器一忙就会误判。
  const html = await (await page.request.get("/index.html")).text();
  const staticallyReferenced = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1].split("/").pop());
  console.log("入口静态引用的脚本:", staticallyReferenced.join(", "));
  expect(
    staticallyReferenced.some((name) => /^(en-US|zh-CN)-/.test(name)),
    "入口不该静态引用任何语言包（另一种语言必须是按需加载）"
  ).toBe(false);

  // 判据二：启动那一刻不去取 en-US（预热被刻意推迟到 1.5 秒后）
  const early = [];
  page.on("request", (request) => {
    if (/\/assets\/en-US-.*\.js$/.test(request.url())) early.push(Date.now());
  });
  const startedAt = Date.now();
  await page.goto("/");
  await page.locator(".agent").waitFor();
  const elapsed = Date.now() - startedAt;
  const fetchedDuringBoot = early.filter((at) => at - startedAt < Math.min(1000, elapsed));
  console.log(`启动耗时 ${elapsed}ms，启动阶段取 en-US 的次数: ${fetchedDuringBoot.length}`);
  expect(fetchedDuringBoot, "启动阶段（首屏内）不该取 en-US 语言包").toHaveLength(0);
});
