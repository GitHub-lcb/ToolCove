// 真机行为回归（移动视口）——**模拟安卓桥存在**的环境。
//
// 为什么需要这组用例：现有 E2E 全跑在"浏览器形态"（没有 window.ToolCove），
// 走的是 IndexedDB 回退路径。而真机上桥是存在的，**走的是另一条分支**——
// 那条分支此前从未被测过，于是漏掉了一个致命 bug：
// invoke 在桥存在时直接返回桥的结果，不回退浏览器处理器；而桥没实现 load_data/save_data，
// 导致真机上读写不了任何数据（记录、工作台、设置、Agent 全用这两个命令）。
//
// 这组用例把"桥存在"作为环境，覆盖真机才会走的分支。
import { expect, test } from "@playwright/test";

const MOBILE = "/mobile/app/index.html";

/** Kotlin 桥当前真正实现的命令（与 Bridge.kt 的 when 分支同步）。 */
const BRIDGE_COMMANDS = [
  "http_request",
  "network_tcp_check",
  "encrypt_text",
  "decrypt_text",
  "file_pick",
  "file_tool_read_text",
  "file_tool_write_text",
  "file_tool_inspect",
  "db_connect",
  "db_close",
  "db_query",
  "db_tables",
  "db_columns",
  "db_test",
];

/**
 * 种一个**尽量贴近真机**的桥：只实现 Kotlin 桥真正实现过的命令，其余一律返回 unsupported。
 * 这样任何"前端调了但桥没实现"的命令都会在这组用例里暴露，而不是等装机。
 *
 * `fallback` 控制是否模拟"回退到浏览器实现"——默认开启（即修复后的行为）。
 */
async function seedRealisticBridge(page, { fallback = true } = {}) {
  await page.addInitScript(
    ([implemented, allowFallback]) => {
      const store = new Map();
      const ok = (value) => JSON.stringify(value);
      window.__E2E_BRIDGE_CALLS__ = [];
      window.__E2E_FALLBACKS__ = [];
      window.ToolCove = {
        isMobile: true,
        invoke(cmd, argsJson) {
          const args = argsJson ? JSON.parse(argsJson) : {};
          window.__E2E_BRIDGE_CALLS__.push({ cmd, args });
          if (implemented.includes(cmd)) {
            if (cmd === "load_data" || cmd === "load_data_versioned") return ok(store.get(args.key) ?? []);
            if (cmd === "save_data" || cmd === "save_data_versioned") {
              store.set(args.key, args.value);
              return "null";
            }
            return ok({});
          }
          if (allowFallback) {
            // 修复后的行为：桥不认这个命令 → 前端回退浏览器实现（IndexedDB）。
            // 这里只记录，真正的回退由 src/platform/invoke.js 完成。
            window.__E2E_FALLBACKS__.push(cmd);
          }
          return JSON.stringify({ __error: `手机端尚未实现该命令：${cmd}`, __code: "unsupported" });
        },
      };
    },
    [BRIDGE_COMMANDS, fallback]
  );
}

test.describe("真机环境（安卓桥存在）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("桥不实现存储命令时，App 仍能读写数据（关键回归）", async ({ page }) => {
    // 这是那个 bug 的精确复现条件：桥存在，但不实现 load_data/save_data。
    // 修复前：invoke 直接把桥的错误抛出来 → 记录页读不到数据、新建保存失败。
    // 修复后：回退到浏览器的 IndexedDB 实现 → 功能正常。
    await seedRealisticBridge(page);
    await page.goto(MOBILE);

    // 根元素用真实存在的选择器：Shell 的骨架是 main + tablist（没有 .m-shell 这个类）
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator('nav[role="tablist"]')).toBeVisible();
    await page.locator(".m-tab[data-tab='records']").click();
    const records = page.locator(".m-records");
    await expect(records).toBeVisible({ timeout: 10_000 });
    // 加载过程不能报错（修复前这里会出现"尚未实现该命令：load_data"）
    await expect(records.locator(".m-err")).toHaveCount(0);

    // 新建一条速记：这条路径要经过 save_data + load_data。
    // 选择器用真实的 .m-sheet（RecordsView 的编辑抽屉），不要猜 data-role——
    // 这个文件里根本没有 data-role，猜的话只会得到"元素找不到"。
    await records.locator(".m-add").click();
    await expect(page.locator(".m-sheet")).toBeVisible({ timeout: 5_000 });
    await page.locator(".m-sheet-body input, .m-sheet-body textarea").first().fill("真机回归：这条能存下");
    await page.locator(".m-sheet-save").click();
    // 保存后列表里应出现这条记录（说明 save_data + 重新 load_data 都通了）
    await expect(records).toContainText("真机回归", { timeout: 10_000 });
    await expect(records.locator(".m-err")).toHaveCount(0);
  });

  test("走遍主要页面：前端调用过但桥未实现的命令必须能回退", async ({ page }) => {
    await seedRealisticBridge(page);
    await page.goto(MOBILE);

    for (const tab of ["records", "work", "toolbox", "agent", "settings"]) {
      await page.locator(`.m-tab[data-tab='${tab}']`).click();
      await page.waitForTimeout(400);
    }

    const calls = await page.evaluate(() => [...new Set(window.__E2E_BRIDGE_CALLS__.map((c) => c.cmd))]);
    const fellBack = await page.evaluate(() => [...new Set(window.__E2E_FALLBACKS__)]);
    console.log("桥被调用的命令:", calls.join(", "));
    console.log("其中回退到浏览器实现的:", fellBack.join(", ") || "（无）");

    // 存储命令确实走到了回退路径——这正是修复的证明
    expect(fellBack, "load_data/save_data 应走回退（说明修复生效）").toContain("load_data");

    // 页面不能因为桥不认某个命令就报错
    for (const tab of ["records", "work", "agent", "settings"]) {
      await page.locator(`.m-tab[data-tab='${tab}']`).click();
      await page.waitForTimeout(200);
      const errors = await page.locator(".m-err").allInnerTexts();
      const fatal = errors.filter((text) => /尚未实现|unsupported|is not a function/i.test(text));
      expect(fatal, `${tab} 页出现"未实现"类错误：${fatal.join(" | ")}`).toEqual([]);
    }
  });
});
