// 侧边栏分层回归：固定区不参与滚动，只有会话列表自己滚。
//
// 为什么要有这条：侧边栏里混了两类东西——固定入口（新任务 / 工作面 / 搜索 / 底部按钮）
// 和一条会无限增长的会话列表。它们一旦共用一个滚动容器，历史越长，固定入口就越往下掉，
// 最后「新任务」被滚出视野、工作面被挤到底部，能看见什么取决于你滚到哪。
// 这个缺陷不会让任何功能用例变红（点击仍然有效，只是要先滚一下），所以必须显式断言。
//
// 复现场景取自用户实测截图：窄而高的窗口（889×1101）+ 12 条跨越四个时间组的真实感历史。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

/** 12 条历史，刻意横跨「今天 / 昨天 / 最近 7 天 / 更早」四组，并混入 failed 与 max_steps 状态灯。 */
const RUNS = [
  ["比较这两段文本的差异并总结改动", 0.01, "completed"],
  ["把这段 JSON 格式化，并逐个解释字段含义", 0.2, "completed"],
  ["向文件中写入一些数据", 1.1, "completed"],
  ["比较这两段文本的差异", 1.3, "failed"],
  ["生成 10 个 UUID 并把结果转成 Base64", 3.2, "completed"],
  ["把这段 JSON 格式化，并逐个解释字段含义", 4.5, "max_steps"],
  ["合并两个 PDF 文件并输出到下载目录", 9, "completed"],
  ["从 order.json 里找出重复字段并导出 csv", 14, "completed"],
  ["读取 notes.txt 的内容并解析出所有订单号", 22, "completed"],
  ["把 Base64 转回文本再校验一遍", 27, "completed"],
  ["解析分隔文本并转成 Markdown 表格", 29, "completed"],
  ["比较这两段文本的差异并总结改动", 31, "completed"],
].map(([input, daysAgo, status], i) => ({
  id: "run-" + i,
  input,
  status,
  steps: [{ type: "final", answer: "完成", ts: now - daysAgo * DAY }],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 1 },
  createdAt: now - daysAgo * DAY,
  updatedAt: now - daysAgo * DAY,
}));

/** 固定区选择器：这三个在任何滚动位置都必须原地不动、且可见。 */
const FIXED = [".new-chat", ".nav-group", ".search-input"];

test("长历史下固定区不动：只有会话列表滚动", async ({ page }) => {
  // 窄而高的窗口最容易暴露「固定区被滚走」，与用户实拍同尺寸
  await page.setViewportSize({ width: 889, height: 1101 });
  // 浏览器形态下 toolboxStore 直接读 localStorage（键 = toolbox-<key>，值为**裸数组**，
  // 不走原生形态的 { v: … } 包装），所以这里手写 localStorage 而不是走 seedData 的 IndexedDB。
  await page.addInitScript(
    ([key, runs]) => {
      try {
        localStorage.setItem(key, JSON.stringify(runs));
      } catch {
        /* 隐私模式：播种失败会让下面的 count 断言先红，不必在这里报错 */
      }
    },
    ["toolbox-agentRuns", RUNS]
  );
  await seedData(page, { settings: { ai: { baseUrl: "", apiKey: "", model: "", enabled: false } } });
  await page.goto("/");

  await expect(page.locator(".task-item")).toHaveCount(RUNS.length);
  // 四个时间组都渲染出来了（分组不是只对少数几条生效）
  await expect(page.locator(".list-group")).toHaveText(["今天", "昨天", "最近 7 天", "更早"]);

  const before = {};
  for (const sel of FIXED) {
    before[sel] = await page.locator(sel).first().boundingBox();
    expect(before[sel], `${sel} 初始应可见`).not.toBeNull();
  }

  // 会话列表自己可滚，而侧边栏容器不是滚动容器（这正是分层的判据）
  expect(await page.locator(".history").evaluate((el) => el.scrollHeight > el.clientHeight + 4), "历史区应可滚动").toBe(true);
  expect(await page.locator(".nav").evaluate((el) => el.scrollHeight > el.clientHeight + 4), "侧边栏容器本身不该滚动").toBe(false);

  // 把历史滚到底：固定区一个像素都不该动
  await page.locator(".history").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(300);
  for (const sel of FIXED) {
    const after = await page.locator(sel).first().boundingBox();
    expect(after, `${sel} 滚动后仍应可见`).not.toBeNull();
    expect(Math.round(after.y), `${sel} 滚动后不该移动`).toBe(Math.round(before[sel].y));
  }
});

test("搜索只过滤会话列表，不影响工作面与底部入口", async ({ page }) => {
  await seedData(page, { settings: { ai: { baseUrl: "", apiKey: "", model: "", enabled: false } } });
  await page.addInitScript(
    ([key, runs]) => {
      try {
        localStorage.setItem(key, JSON.stringify(runs));
      } catch {
        /* 同上 */
      }
    },
    ["toolbox-agentRuns", RUNS]
  );
  await page.goto("/");
  await expect(page.locator(".task-item")).toHaveCount(RUNS.length);

  // 搜一个只命中一条的词：命中数与「没有匹配」态都要正确
  await page.locator(".search-input").fill("csv");
  await expect(page.locator(".task-item")).toHaveCount(1);
  await expect(page.locator(".task-item")).toContainText("order.json");
  // 搜索态下不显示时间分组（少量命中被拆到多个标题下反而更难找）
  await expect(page.locator(".list-group")).toHaveCount(0);
  // 工作面与底部入口照旧在
  await expect(page.locator(".nav-item", { hasText: "研发" })).toBeVisible();
  await expect(page.locator(".side-foot")).toBeVisible();

  // 搜不到时给出明确空态，而不是一片空白
  await page.locator(".search-input").fill("绝对不存在的关键词");
  await expect(page.locator(".list-empty")).toContainText("没有匹配的任务");
  await expect(page.locator(".task-item")).toHaveCount(0);
});
