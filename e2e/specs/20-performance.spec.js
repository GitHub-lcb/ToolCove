// 性能基线：不看「哪个文件大」，看「用户实际等多久、卡不卡」。
// 采集 FCP / 布局偏移 / 长任务 / 首屏加载的 chunk 清单 / 交互到绘制耗时，各跑 3 次取中位数
// ——单次测量在本地机器上噪声很大，取中位数才敢当基线。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * 首屏成本：从 index.html 的静态引用与 modulepreload 清单算。
 *
 * 为什么不用「FCP 之前的请求」：那依赖墙钟窗口（等多久再读 performance 条目），
 * 机器一忙就会把分类算错——实测全量混跑时出现过「阻塞首屏 0KB」「只有 1 次 FCP 采样」这类假结果。
 * HTML 里的静态引用是**构建产物的事实**：入口脚本 + 预加载清单就是浏览器必须下载才能渲染的东西，
 * 与运行时快慢无关，因此可以当防回退锁。
 */
async function measureStaticFirstLoad(page) {
  const response = await page.request.get("/index.html");
  const html = await response.text();
  const refs = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
  return { html, refs: [...new Set(refs)] };
}

async function measureOnce(page, bucket) {
  await page.addInitScript(() => {
    window.__PERF__ = { longTasks: [], shifts: 0 };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__PERF__.longTasks.push(Math.round(entry.duration));
      }).observe({ entryTypes: ["longtask"] });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__PERF__.shifts += entry.value;
        }
      }).observe({ entryTypes: ["layout-shift"] });
    } catch {}
  });
  page.on("request", (request) => {
    if (/\/assets\/.*\.js$/.test(request.url())) bucket.push(request.url().split("/").pop());
  });
  await seedData(page, {});
  await page.goto("/");
  await page.locator(".agent").waitFor();
  await page.waitForTimeout(600);

  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] || {};
    const paints = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, Math.round(p.startTime)]));
    const resources = performance.getEntriesByType("resource")
      .filter((r) => r.initiatorType === "script")
      .map((r) => ({ name: r.name.split("/").pop(), kb: Math.round((r.encodedBodySize || r.transferSize || 0) / 1024) }));
    return {
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
      fcp: paints["first-contentful-paint"] || null,
      longTasks: window.__PERF__.longTasks,
      cls: Number(window.__PERF__.shifts.toFixed(4)),
      scripts: resources,
    };
  });
}

test("首屏性能基线（3 次取中位数）", async ({ browser }) => {
  test.setTimeout(120_000);
  const runs = [];
  for (let i = 0; i < 3; i++) {
    // 每次测量都用**新页面**：同一个 page 上重复 addInitScript / on("request") 会累积，
    // 后续轮次的数据会被前一轮污染（第一版就是这么得出「阻塞首屏 0KB」的假结论）。
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const bucket = [];
    const result = await measureOnce(page, bucket);
    result.requested = bucket;
    runs.push(result);
    await context.close();
  }

  const fcp = runs.map((r) => r.fcp).filter((v) => typeof v === "number");
  const cls = runs.map((r) => r.cls);
  const longest = runs.flatMap((r) => r.longTasks);
  // 启动阶段实际交付的脚本总量：这是真正的防回退锁（把首屏期间动态加载的 chunk 也算进来）
  const bootScriptKb = Math.max(...runs.map((r) => r.scripts.reduce((sum, s) => sum + s.kb, 0)));

  // 确定性口径：构建产物里被入口 HTML 静态引用/预加载的脚本（判断「入口有没有夹带语言包」这类结构问题）
  const probeContext = await browser.newContext();
  const probePage = await probeContext.newPage();
  const { refs } = await measureStaticFirstLoad(probePage);
  const sizes = new Map();
  for (const run of runs) for (const s of run.scripts) sizes.set(s.name, s.kb);
  const critical = refs.map((ref) => ref.split("/").pop()).map((name) => ({ name, kb: sizes.get(name) ?? 0 }));
  const totalKb = critical.reduce((sum, s) => sum + s.kb, 0);
  await probeContext.close();

  console.log("== 首屏性能（3 次） ==");
  console.log("FCP(ms):", fcp.join(", "), "（采样 " + fcp.length + " 次）→ 中位数", median(fcp));
  console.log("DCL(ms):", runs.map((r) => r.domContentLoaded).join(", "), "→ 中位数", median(runs.map((r) => r.domContentLoaded)));
  console.log("CLS:", cls.join(", "), "→ 中位数", median(cls));
  console.log("长任务最长(ms):", longest.length ? Math.max(...longest) : 0, "｜次数", runs.map((r) => r.longTasks.length).join(", "));
  console.log("入口静态引用:", critical.map((s) => `${s.name}(${s.kb}KB)`).join(", "));
  console.log(`启动阶段交付的脚本总量: ${bootScriptKb}KB（含首屏期间动态加载的 chunk）`);
  const late = runs[0].requested.filter((n) => !critical.some((c) => c.name === n));
  if (late.length) console.log("首屏后（预热等）加载:", [...new Set(late)].join(", "));

  expect(fcp.length, "FCP 采样次数").toBeGreaterThan(0);
  expect(median(fcp), "FCP 中位数").toBeLessThan(2500);
  expect(median(cls), "CLS 中位数").toBeLessThan(0.1);
  // 启动阶段脚本量的演进：989KB（都静态打进入口）
  //   → 875KB（语言包按需加载）→ 532KB（工具实现懒加载，luxon/js-yaml/hash-wasm 移出首屏）。
  // 这条断言就是这两次优化的防回退锁：谁把重依赖静态 import 回首屏，这里立刻红。
  expect(bootScriptKb, "启动阶段脚本总量").toBeLessThan(600);
  expect(critical.length, "入口静态引用数").toBeLessThan(6);
});

test("切模块与开工具的交互延迟（人眼可感阈值 200ms）", async ({ page }) => {
  test.setTimeout(60_000);
  await seedData(page, {});
  await page.goto("/");
  await page.locator(".agent").waitFor();

  /**
   * 在**页面内**测量交互到下一次绘制：dispatch 事件 → rAF → rAF。
   * 不能用 Playwright 的 locator.click() 计时——它自带可操作性检查、滚动与稳定等待，
   * 那部分耗时是测试框架的，不是应用的（第一版就是这么量出「1254ms」这种假数字的）。
   */
  const measureNav = (label) =>
    page.evaluate((text) => {
      const button = [...document.querySelectorAll(".nav-item")].find((el) => el.textContent.includes(text));
      if (!button) return -1;
      const started = performance.now();
      button.click();
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - started)))));
    }, label);

  const samples = [];
  for (const label of ["工作台", "记录", "工具箱", "Agent"]) samples.push(await measureNav(label));

  // 打开一个工具（工具箱里点第一张卡）
  const toolDelay = await page.evaluate(async () => {
    const openToolbox = [...document.querySelectorAll(".nav-item")].find((el) => el.textContent.includes("工具箱"));
    openToolbox?.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const card = document.querySelector(".tool-card, .tile, .tb-card");
    if (!card) return -1;
    const started = performance.now();
    card.click();
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - started)))));
  });

  // 再测一轮并取全部样本的中位数。
  // 为什么必须测两轮：第一次进入某个模块要编译并执行它的 chunk（工作台/记录的 chunk 首屏没加载），
  // 首轮样本混着 JIT 与模块求值，会出现 38ms 与 904ms 这种极端值——拿首轮当基线会得出「应用很慢」的错觉，
  // 而用户感知的是「第二次点同一个地方」的开销。
  const warm = [];
  for (const label of ["工作台", "记录", "工具箱", "Agent", "工作台", "记录"]) warm.push(await measureNav(label));
  const all = [...samples, ...warm];

  console.log("== 交互延迟(ms，页面内测量) ==");
  console.log("首轮(含模块首次求值):", samples.join(", "));
  console.log("预热后:", warm.join(", "));
  console.log("全部样本中位数:", median(all), "｜预热后中位数:", median(warm));
  console.log("开工具:", toolDelay);

  expect(samples.every((s) => s >= 0), "导航按钮都应找得到").toBe(true);
  expect(median(warm), "切模块中位耗时（预热后）").toBeLessThan(200);
  expect(median(all), "切模块中位耗时（含首轮）").toBeLessThan(300);
});
