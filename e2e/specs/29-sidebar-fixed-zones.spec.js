// 侧边栏分层回归：固定区不参与滚动，只有会话列表自己滚。
//
// 为什么要有这条：侧边栏里混了两类东西——固定入口（新任务 / 工作面 / 搜索 / 底部按钮）
// 和一条会无限增长的会话列表。它们一旦共用一个滚动容器，历史越长，固定入口就越往下掉，
// 最后「新任务」被滚出视野、工作面被挤到底部，能看见什么取决于你滚到哪。
// 这个缺陷不会让任何功能用例变红（点击仍然有效，只是要先滚一下），所以必须显式断言。
//
// 复现场景取自用户实测截图：窄而高的窗口（889×1101）+ 12 条跨越四个时间组的真实感历史。
import { expect, test } from "@playwright/test";
import { final, mockAI, runGoal, seedData, seedDesktopIpc, seedWithAI } from "../helpers.js";

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
  // 紧凑行在原来的 1101px 高度已无需滚动，缩短窗口以继续检验固定区与滚动区的分层。
  await page.setViewportSize({ width: 889, height: 640 });
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
  // 「历史」是分区标题（与「工作面」同级），时间分组仍要四个都在
  await expect(page.locator(".list-group")).toHaveText(["历史", "今天", "昨天", "最近 7 天", "更早"]);

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
  // 搜索态下不显示时间分组（少量命中被拆到多个标题下反而更难找）；只剩「历史」这一个静态分区标题
  await expect(page.locator(".list-group")).toHaveText(["历史"]);
  // 工作面与底部入口照旧在
  await expect(page.locator(".nav-item", { hasText: "研发" })).toBeVisible();
  await expect(page.locator(".side-foot")).toBeVisible();

  // 搜不到时给出明确空态，而不是一片空白
  await page.locator(".search-input").fill("绝对不存在的关键词");
  await expect(page.locator(".list-empty")).toContainText("没有匹配的任务");
  await expect(page.locator(".task-item")).toHaveCount(0);
});

async function seedHistory(page, runs = RUNS) {
  await page.addInitScript((records) => {
    localStorage.setItem("toolbox-agentRuns", JSON.stringify(records));
  }, runs);
}

test("新任务仅空闲空画布选中，执行及完成后选中当前任务，回看优先", async ({ page }) => {
  await seedWithAI(page);
  await seedHistory(page);
  await mockAI(page, { responses: [final("侧栏选中回归完成")], delayMs: 1200 });
  await page.goto("/");
  const newTask = page.locator(".new-chat");
  await expect(newTask).toHaveClass(/\bon\b/);
  await runGoal(page, "验证当前任务选中");
  const current = page.locator(".task-item", { hasText: "验证当前任务选中" });
  await expect(current).toBeVisible();
  await expect(newTask).not.toHaveClass(/\bon\b/);
  await expect(current).toHaveAttribute("aria-current", "page");
  // 选中高亮挂在**外层 .task-row**（样式是 `.task-row.on .task-item`），不在 .task-item 自己身上。
  // 原先这条盯在内层元素上，查的是一个从来不存在的类名——重构后一直没红，
  // 因为它断言的东西与实现无关。改成断言"这一行确实被标记为选中"。
  await expect(page.locator(".task-row.on", { hasText: "验证当前任务选中" })).toHaveCount(1);
  await expect(page.locator(".answer-card")).toContainText("侧栏选中回归完成");
  await expect(newTask).not.toHaveClass(/\bon\b/);
  await expect(current).toHaveAttribute("aria-current", "page");

  const history = page.locator(".task-item", { hasText: "向文件中写入一些数据" });
  await history.click();
  await expect(history).toHaveAttribute("aria-current", "page");
  await expect(current).not.toHaveAttribute("aria-current", "page");
  await expect(page.locator(".nav [aria-current=page]")).toHaveCount(1);
  await newTask.click();
  await expect(newTask).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".task-row.on")).toHaveCount(0);
});

test("等待用户时新任务不选中，任务状态包含可访问名称", async ({ page }) => {
  await seedWithAI(page);
  await seedHistory(page, [
    { ...RUNS[0], id: "done", input: "完成的任务", status: "completed" },
    { ...RUNS[0], id: "failed", input: "失败的任务", status: "failed" },
    { ...RUNS[0], id: "cancelled", input: "取消的任务", status: "cancelled" },
  ]);
  await mockAI(page, { responses: [{ type: "ask_user", question: "请提供路径" }] });
  await page.goto("/");
  await expect(page.locator(".task-item", { hasText: "完成的任务" })).toHaveAccessibleName(/完成的任务.*已完成/);
  await expect(page.locator(".task-item", { hasText: "失败的任务" })).toHaveAccessibleName(/失败的任务.*失败/);
  await expect(page.locator(".task-item", { hasText: "取消的任务" })).toHaveAccessibleName(/取消的任务.*取消/);
  await runGoal(page, "等待补充路径");
  await expect(page.locator(".confirm")).toBeVisible();
  await expect(page.locator(".new-chat")).not.toHaveClass(/\bon\b/);
  await expect(page.locator(".task-item", { hasText: "等待补充路径" })).toHaveAttribute("aria-current", "page");
});

test("工作台壳为280/56px侧栏与48px顶栏（三栏 AppFrame），底部入口横排且没有装饰光晕", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".new-chat")).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "280px");
  await expect(page.locator(".topbar")).toHaveCSS("height", "48px");
  await expect(page.locator(".page-title h1")).toHaveCSS("font-size", "14px");
  await expect(page.locator(".brand-logo")).toHaveCSS("width", "27px");
  await expect(page.locator(".brand-logo")).toHaveCSS("box-shadow", "none");
  await expect(page.locator(".pt-ico")).toHaveCSS("box-shadow", "none");
  await expect(page.locator(".orbs")).toHaveCount(0);
  const foot = page.locator(".side-foot button");
  await expect(foot).toHaveCount(3);
  const boxes = await foot.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().y));
  expect(new Set(boxes).size).toBe(1);
  await expect(page.locator(".side-foot").getByRole("button", { name: "设置", exact: true })).toBeVisible();
  await expect(page.locator(".sponsor-btn")).toHaveAttribute("aria-label", /.+/);
  await page.locator(".side-foot").getByRole("button", { name: "收起", exact: true }).click();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "56px");
  await expect(page.locator(".side-foot").getByRole("button", { name: "展开", exact: true })).toBeVisible();
});

test("760px自动图标轨道：搜索可展开聚焦且不修改桌面折叠偏好", async ({ page }) => {
  await seedHistory(page);
  await page.setViewportSize({ width: 760, height: 720 });
  await page.goto("/");
  await expect(page.locator(".task-item")).toHaveCount(RUNS.length);
  await expect(page.locator(".sidebar")).toHaveCSS("width", "56px");
  await expect(page.locator(".side-foot").getByRole("button", { name: "设置", exact: true })).toBeVisible();
  await expect(page.locator(".sponsor-btn")).toBeVisible();
  await page.locator(".nav").getByRole("button", { name: /搜索历史/ }).click();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "280px");
  await expect(page.locator(".search-input")).toBeFocused();
  await page.locator(".search-input").fill("csv");
  await expect(page.locator(".task-item")).toHaveCount(1);
  await page.locator(".side-foot").getByRole("button", { name: "收起", exact: true }).click();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "56px");
  await page.locator(".side-foot").getByRole("button", { name: "展开", exact: true }).click();
  await expect(page.locator(".search-input")).toHaveValue("csv");
  await page.setViewportSize({ width: 1000, height: 720 });
  await expect(page.locator(".sidebar")).toHaveCSS("width", "280px");
  expect(await page.evaluate(() => localStorage.getItem("tc.sidebar.collapsed"))).toBeNull();
});

test("760px临时展开的侧栏是浮层：主区始终占满56px轨道之外的宽度", async ({ page }) => {
  await seedHistory(page);
  await page.setViewportSize({ width: 760, height: 720 });
  await page.goto("/");
  await expect(page.locator(".task-item")).toHaveCount(RUNS.length);

  const mainWidth = () => page.locator(".main").evaluate((el) => el.getBoundingClientRect().width);
  expect(await mainWidth(), "轨道态主区应占 760-56=704px").toBe(704);

  // 临时展开：侧栏浮在主区上方，而不是让主区掉进 56px 网格列
  await page.locator(".side-foot").getByRole("button", { name: "展开", exact: true }).click();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "280px");
  expect(await mainWidth(), "浮层展开不应挤压主区").toBe(704);

  await page.locator(".side-foot").getByRole("button", { name: "收起", exact: true }).click();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "56px");
  expect(await mainWidth(), "收起后主区宽度不变").toBe(704);
});

test("760px点击主区收起临时展开的浮层，不改桌面折叠偏好", async ({ page }) => {
  await seedHistory(page);
  await page.setViewportSize({ width: 760, height: 720 });
  await page.goto("/");
  await expect(page.locator(".task-item")).toHaveCount(RUNS.length);

  await page.locator(".side-foot").getByRole("button", { name: "展开", exact: true }).click();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "280px");
  await page.locator(".topbar").click();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "56px");
  expect(await page.evaluate(() => localStorage.getItem("tc.sidebar.collapsed"))).toBeNull();
});

test("窄窗顶栏保留搜索及桌面窗口控件，主区不横向溢出", async ({ page }) => {
  await seedDesktopIpc(page);
  await seedData(page, { settings: { telemetry: { prompted: true, enabled: false } } });
  await page.setViewportSize({ width: 560, height: 720 });
  await page.goto("/");
  await expect(page.locator(".new-chat")).toBeVisible();
  await expect(page.locator(".gs-trigger")).toBeVisible();
  await expect(page.locator(".win-ctrls button")).toHaveCount(3);
  for (const width of [560, 320]) {
    await page.setViewportSize({ width, height: 720 });
    for (const button of await page.locator(".win-ctrls button").all()) await expect(button).toBeInViewport({ ratio: 1 });
    expect(await page.locator(".main").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.locator(".gs-trigger").click();
  await expect(page.locator(".gs-inputbar input")).toBeFocused();
});
