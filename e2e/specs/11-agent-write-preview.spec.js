// 回归：写文件前的确认卡必须带 diff（写前预览）。
// 用户实测发现的原始现象：改了代码却没在界面上看到预览——查下来是运行实例是旧构建，
// 但「预览有没有真的画出来」当时只能靠人工看，所以把它固化成用例。
//
// 这条用例跑在「桌面形态」下（见 helpers.seedDesktopIpc）：file.* 是 desktopOnly 工具，
// 浏览器端会把它们剔除，而写前预览正好挂在这些工具上。
import { expect, test } from "@playwright/test";
import { aiCalls, desktopOps, final, mockAI, runGoal, seedDesktopIpc, seedWithAI, toolCall } from "../helpers.js";

const FILE = String.raw`C:\Users\e2e\Downloads\test\1.txt`;
/**
 * 这条用例里模型的三步：读文件 → 写文件 → 收尾。
 * @param {string} text 要写入的内容
 * @param {string} answer 最终答复（各用例不同，所以必须可传）
 */
const writeFlow = (text = "12342532", answer = "已成功写入文件") => [
  toolCall("file.read_text", { path: FILE }, "c1"),
  toolCall("file.write_text", { path: FILE, text }, "c2"),
  final(answer),
];

test("写文件：确认卡显示路径与 diff 行，允许后按原参数写入", async ({ page }) => {
  await seedWithAI(page);
  // 桌面形态：AI 走 IPC、file.* 走替身，队列要在注入替身时一起给（见 helpers 的说明）
  const ipc = await seedDesktopIpc(page, { [FILE]: "1231314" }, { responses: writeFlow() });
  await page.goto("/");
  await runGoal(page, `把 ${FILE} 的内容改成 12342532`);

  // 先读后写是门禁要求；等确认卡（也就是写那一步）出现
  const card = page.locator(".confirm");
  await expect(card).toBeVisible({ timeout: 20_000 });

  // 1) 预览块带标题、路径与增删统计
  const preview = card.locator(".cf-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("写入前预览");
  await expect(preview).toContainText("1.txt");
  // 单行替换在 textDiff 里是 modified：既不算增也不算删，但必须显示出来
  await expect(preview.locator(".cf-pv-stat")).toContainText("+0 / -0");
  await expect(preview.locator(".cf-pv-stat")).toContainText("修改 1");

  // 2) diff 行真的渲染出来（不是只有标题）：行号 + 新值 + 语义底色
  const rows = preview.locator(".cf-pv-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("12342532");
  await expect(rows.first()).toHaveClass(/pv-changed/);
  await expect(rows.first().locator(".cf-pv-no")).toHaveText("1");

  // 3) 参数区仍在（预览不替代参数）
  await expect(card.locator(".cf-args")).toContainText("path");

  // 4) 允许 → 运行收尾，且真的写进了替身
  await card.getByRole("button", { name: "允许" }).click();
  await expect(page.locator(".answer-card")).toContainText("已成功写入文件", { timeout: 20_000 });
  expect(ipc.file(FILE)).toBe("12342532");

  // 5) 预览与实际执行一致：写入用的 text 与卡片上显示的一致
  const write = ipc.ops.filter((op) => op.cmd === "file_tool_write_text").pop();
  expect(write.args.path).toBe(FILE);
  expect(write.args.text).toBe("12342532");
  expect(await aiCalls(page)).toHaveLength(3);
});

test("新建文件：模型先 inspect 证明不存在，预览标明新建且不阻断批准", async ({ page }) => {
  await seedWithAI(page);
  // 真实模型路径：读前先确认文件不存在（门禁只认「有证据的缺失」），再写。
  // 直接让 read 失败是不行的——工具报错会终止这次运行，走不到写那一步。
  const ipc = await seedDesktopIpc(page, {}, {
    responses: [
      toolCall("file.inspect", { paths: [FILE] }, "c1"),
      toolCall("file.write_text", { path: FILE, text: "hello" }, "c2"),
      final("已创建文件"),
    ],
  });
  await page.goto("/");
  await runGoal(page, `新建 ${FILE} 并写入 hello`);

  const card = page.locator(".confirm");
  await expect(card).toBeVisible({ timeout: 20_000 });
  const preview = card.locator(".cf-preview");
  await expect(preview).toContainText("写入前预览");
  await expect(preview).toContainText("新建文件");
  await expect(preview.locator(".cf-pv-row").first()).toContainText("hello");

  await card.getByRole("button", { name: "允许" }).click();
  await expect(page.locator(".answer-card")).toContainText("已创建文件", { timeout: 20_000 });
  expect(ipc.file(FILE)).toBe("hello");
});

test("拒绝写入：不产生任何写入调用（预览看过了也可以说不）", async ({ page }) => {
  await seedWithAI(page);
  const ipc = await seedDesktopIpc(page, { [FILE]: "原内容" }, { responses: writeFlow("新内容", "最终答复：用户拒绝了写入") });
  await page.goto("/");
  await runGoal(page, `把 ${FILE} 改成新内容`);

  const card = page.locator(".confirm");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole("button", { name: "拒绝" }).click();

  // 拒绝写入 → 模型拿到拒绝反馈后给最终答复；关键是没有发生任何写入
  await expect(page.locator(".answer-card")).toContainText("用户拒绝了写入", { timeout: 20_000 });  expect(ipc.ops.filter((op) => op.cmd === "file_tool_write_text")).toHaveLength(0);
  expect(ipc.file(FILE)).toBe("原内容");
});
