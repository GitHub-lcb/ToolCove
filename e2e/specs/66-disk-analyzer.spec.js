// 磁盘分析助手 E2E（桌面形态）。
//
// 真实扫描、并行递归与体积聚合在 Rust 侧（src-tauri/src/disk.rs 有单测）；
// treemap 布局算法与删除后的就地扣减在 src/diskAnalyzer.test.js 里单测。这里验的是**这条接线**：
// 驱动器枚举 → 扫描（进度事件推进）→ 完成事件带出的汇总与最大文件 → 目录下钻与返回
// → 多选/单项删除（回收站命令 + 确认弹窗 + 结果扣减）→ 取消回落。
//
// 必须走 seedDesktopIpc：工具标了 desktopOnly，浏览器形态会被注册表过滤掉；
// 而扫描结果完全由 disk:progress 事件推进（start 立即返回），替身不发事件页面会永远停在扫描中。
import { expect, test } from "@playwright/test";
import { emitDesktopEvent, seedData, seedDesktopIpc } from "../helpers.js";

const GB = 1024 ** 3;

const DRIVES = [
  { root: "C:\\", kind: "fixed", label: "系统盘", total: 512 * GB, free: 128 * GB },
  { root: "D:\\", kind: "fixed", label: "数据盘", total: 2048 * GB, free: 1200 * GB },
];

/** 节点表：id → 该节点的下钻响应（与 disk_scan_children 的返回同形）。 */
const TREE = {
  "0": {
    node: { id: 0, name: "C:\\", path: "C:\\", size: 100 * GB, ownBytes: 10 * GB, files: 12000, dirs: 800, errors: 0 },
    children: [
      { id: 1, name: "Windows", size: 60 * GB, ownBytes: 2 * GB, files: 9000, dirs: 500, errors: 0, childCount: 1 },
      { id: 2, name: "Users", size: 30 * GB, ownBytes: 1 * GB, files: 3000, dirs: 300, errors: 0, childCount: 1 },
      { id: 3, name: "ProgramData", size: 0, ownBytes: 0, files: 0, dirs: 0, errors: 1, childCount: 0 },
    ],
    childCount: 3,
    truncated: false,
  },
  "1": {
    node: { id: 1, name: "Windows", path: "C:\\Windows", size: 60 * GB, ownBytes: 2 * GB, files: 9000, dirs: 500, errors: 0 },
    children: [{ id: 4, name: "System32", size: 55 * GB, ownBytes: 3 * GB, files: 8000, dirs: 400, errors: 0, childCount: 0 }],
    childCount: 1,
    truncated: false,
  },
  "2": {
    node: { id: 2, name: "Users", path: "C:\\Users", size: 30 * GB, ownBytes: 1 * GB, files: 3000, dirs: 300, errors: 0 },
    children: [],
    childCount: 0,
    truncated: false,
  },
  "4": {
    node: { id: 4, name: "System32", path: "C:\\Windows\\System32", size: 55 * GB, ownBytes: 3 * GB, files: 8000, dirs: 400, errors: 0 },
    children: [],
    childCount: 0,
    truncated: false,
  },
};

/** 目录文件列表（disk_dir_files 按 path 回放）。 */
const FILES = {
  "C:\\": {
    files: [
      { name: "huge.iso", path: "C:\\huge.iso", size: 20 * GB, modifiedAt: 1700000000000 },
      { name: "pagefile.sys", path: "C:\\pagefile.sys", size: 8 * GB, modifiedAt: 1700000000000 },
    ],
    fileCount: 2,
    totalBytes: 28 * GB,
    truncated: false,
    errors: 0,
  },
  "C:\\Windows": { files: [], fileCount: 0, totalBytes: 0, truncated: false, errors: 0 },
};

/** 最大文件榜单（默认就是根目录那两个；「别处的文件」用例会换成深层路径）。 */
const TOP_FILES = FILES["C:\\"].files.map((file) => ({ path: file.path, size: file.size }));

/**
 * disk_* 命令的可控替身：驱动器/目录树/文件列表按常量回放，删除命令按 deleteResults 逐路径回放
 * （缺省全部成功）；迁移勘察按 migrateCheck 逐目标回放（值是报错文案，缺省返回一份可用计划），
 * 并记录所有调用。
 */
async function stubDisk(page, { deleteResults = {}, migrateCheck = {}, migrateWarnings = [], manyFiles = {}, drivesAfter = null, drivesAfterFrom = 3, resolvePaths = {}, rootLinks = null, dialogPath = null } = {}) {
  // 首启的遥测询问弹窗是全屏遮罩，会把所有点击都拦掉；标记成已询问即可
  await seedData(page, { settings: { telemetry: { prompted: true, enabled: false } } });
  await seedDesktopIpc(page, {});
  await page.addInitScript(
    (payload) => {
      window.__diskCalls = [];
      let driveListCalls = 0;
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        const name = String(cmd);
        // 系统文件夹选择框：用例要能「选择一个已经是链接的目录」来复现真机场景
        if (name === "plugin:dialog|open") return payload.dialogPath || null;
        if (!name.startsWith("disk_")) return original(cmd, args);
        window.__diskCalls.push({ cmd: name, args: args || {} });
        if (name === "disk_list_drives") {
          // 第 drivesAfterFrom 次起换成「迁移后的容量」：用来验「完成后自动刷新 + 变化量提示」
          driveListCalls += 1;
          if (payload.drivesAfter && driveListCalls >= payload.drivesAfterFrom) return payload.drivesAfter;
          return payload.drives;
        }
        if (name === "disk_scan_start" || name === "disk_scan_cancel" || name === "disk_scan_release") return null;
        if (name === "disk_scan_children") {
          const page = payload.tree[String(args?.nodeId ?? 0)] || null;
          // 根节点注入链接行：复现「迁移过的目录在原位置变成一个链接」
          if (page && payload.rootLinks && String(args?.nodeId ?? 0) === "0") {
            return { ...page, links: payload.rootLinks };
          }
          return page;
        }
        if (name === "disk_resolve_path") {
          const hit = (payload.resolvePaths || {})[String(args?.path ?? "")];
          return hit || { path: String(args?.path ?? ""), realPath: String(args?.path ?? ""), isLink: false, crossDrive: false };
        }
        if (name === "disk_dir_files") {
          // 「文件超过列表上限」用例：按 limit 切片回放，truncated 由真实切片算出来
          const many = (payload.manyFiles || {})[String(args?.path ?? "")];
          if (many) {
            const limit = Number(args?.limit) || 500;
            return {
              files: many.slice(0, limit),
              fileCount: many.length,
              totalBytes: many.reduce((sum, file) => sum + file.size, 0),
              truncated: many.length > limit,
              errors: 0,
            };
          }
          return payload.files[String(args?.path ?? "")] ||
            { files: [], fileCount: 0, totalBytes: 0, truncated: false, errors: 0 };
        }
        if (name === "disk_delete_to_trash") {
          const results = payload.deleteResults || {};
          return (args?.paths || []).map((path) => results[path] || { path, ok: true });
        }
        if (name === "disk_migrate_check") {
          const failures = payload.migrateCheck || {};
          const targetParent = String(args?.targetParent ?? "");
          if (failures[targetParent]) throw new Error(failures[targetParent]);
          const source = String(args?.source ?? "");
          const name = source.split(/[\\/]/).pop() || "";
          return {
            source,
            targetParent,
            targetPath: targetParent.replace(/[\\/]$/, "") + "\\" + name,
            name,
            bytes: 60 * 1024 ** 3,
            files: 9000,
            freeBytes: 1200 * 1024 ** 3,
            neededBytes: 63 * 1024 ** 3,
            warnings: payload.migrateWarnings || [],
          };
        }
        if (name === "disk_migrate_start" || name === "disk_migrate_cancel" || name === "disk_migrate_rollback") return null;
        return null;
      };
    },
    { drives: DRIVES, tree: TREE, files: FILES, deleteResults, migrateCheck, migrateWarnings, manyFiles, drivesAfter, drivesAfterFrom, resolvePaths, rootLinks, dialogPath }
  );
}

async function callArgs(page, cmd) {
  return page.evaluate((name) => {
    const hit = [...(window.__diskCalls || [])].reverse().find((call) => call.cmd === name);
    return hit ? hit.args : null;
  }, cmd);
}

/** 点驱动器开始扫描，返回前端生成的 sessionId。 */
async function startScan(page, drive = "C") {
  await page.locator(`[data-role="drive-${drive}"]`).click();
  await expect(page.locator('[data-role="scan-progress"]')).toBeVisible();
  await page.waitForFunction(() => (window.__diskCalls || []).some((call) => call.cmd === "disk_scan_start"));
  const args = await callArgs(page, "disk_scan_start");
  return String(args?.sessionId || "");
}

/** 走完一次扫描：running 一段进度 → done 带汇总与最大文件。 */
async function finishScan(page, sessionId, { topFiles = TOP_FILES, links = 0 } = {}) {
  await emitDesktopEvent(page, "disk:progress", {
    sessionId,
    status: "running",
    entries: 12345,
    bytes: 42 * GB,
    dirs: 800,
    errors: 0,
    path: "C:\\Windows\\System32",
  });
  await expect(page.locator('[data-role="scan-progress"]')).toContainText("12,345");
  // 进度里的当前路径来自 running 事件（扫描开始那一刻是根目录，随扫描深入而变化）
  await expect(page.locator('[data-role="scan-progress"]')).toContainText("C:\\Windows\\System32");
  await emitDesktopEvent(page, "disk:progress", {
    sessionId,
    status: "done",
    summary: {
      root: "C:\\",
      totalBytes: 100 * GB,
      files: 12000,
      dirs: 800,
      links,
      errors: 1,
      truncated: false,
      elapsedMs: 3400,
    },
    topFiles,
  });
  await expect(page.locator('[data-role="summary"]')).toBeVisible();
}

/** 勾选某一行的复选框（按行内文本定位）。 */
const checkRow = (page, text) => page.locator(".dk-row", { hasText: text }).locator(".dk-check").check();

test.describe("工具（磁盘分析）", () => {
  test("驱动器枚举 → 扫描进度 → 完成后渲染汇总、目录行、treemap 与最大文件", async ({ page }) => {
    await stubDisk(page);
    await page.goto("/?tool=disk");
    await page.locator(".tool-disk").waitFor({ state: "visible", timeout: 15_000 });

    // 驱动器卡片：卷标、容量、可用空间
    await expect(page.locator('[data-role="drive-C"]')).toContainText("系统盘");
    await expect(page.locator('[data-role="drive-C"]')).toContainText("可用 128 GB / 512 GB");
    await expect(page.locator('[data-role="drive-D"]')).toContainText("数据盘");

    const sessionId = await startScan(page, "C");
    expect(sessionId).toBeTruthy();
    await expect(page.locator('[data-role="scan-progress"]')).toContainText("正在扫描");

    await finishScan(page, sessionId);
    // 汇总条：总量 / 文件数 / 目录数 / 耗时 / 读不动的目录如实标注
    await expect(page.locator('[data-role="summary"]')).toContainText("共 100 GB");
    await expect(page.locator('[data-role="summary"]')).toContainText("12,000 个文件");
    await expect(page.locator('[data-role="summary"]')).toContainText("1 个目录无法读取");

    // 目录与文件按体积混排：Windows 60 GB > Users 30 GB > huge.iso 20 GB
    const names = await page.locator('[data-role="rows"] .dk-row-name').allTextContents();
    expect(names.slice(0, 3)).toEqual(["Windows", "Users", "huge.iso"]);
    // 文件列表来自实时读盘，目录体积来自扫描快照
    await expect(page.locator('[data-role="node-stat"]')).toContainText("其中直属文件 10 GB");

    // treemap 画布真的画过（尺寸由 JS 按容器与 dpr 设置）
    await page.waitForFunction(() => {
      const canvas = document.querySelector('[data-role="treemap"]');
      return canvas && canvas.width > 0 && canvas.height > 0;
    });
    await expect(page.locator('[data-role="top-files"]')).toContainText("huge.iso");
  });

  test("下钻与返回：目录行、面包屑、treemap 方块都能进能出", async ({ page }) => {
    await stubDisk(page);
    await page.goto("/?tool=disk");
    await page.locator(".tool-disk").waitFor({ state: "visible", timeout: 15_000 });
    const sessionId = await startScan(page, "C");
    await finishScan(page, sessionId);

    // 点目录行进 Windows
    await page.locator('[data-role="row-dir"]', { hasText: "Windows" }).first().click();
    await expect(page.locator('[data-role="crumbs"]')).toContainText("Windows");
    await expect(page.locator('[data-role="node-stat"]')).toContainText("60 GB");
    await expect(page.locator('[data-role="row-dir"]', { hasText: "System32" })).toHaveCount(1);
    const drillArgs = await callArgs(page, "disk_scan_children");
    expect(drillArgs?.nodeId).toBe(1);

    // 用面包屑回根
    await page.locator('[data-role="crumbs"] .dk-crumb').first().click();
    await expect(page.locator('[data-role="row-dir"]', { hasText: "Users" })).toHaveCount(1);

    // treemap 点击：最大的一块（Windows）在左上角区域，点它应下钻进 Windows
    const box = await page.locator('[data-role="treemap"]').boundingBox();
    await page.mouse.click(box.x + 20, box.y + 20);
    await expect(page.locator('[data-role="crumbs"]')).toContainText("Windows");

    // 再往上一层：上一级按钮回到根
    await page.locator('[data-role="go-up"]').click();
    await expect(page.locator('[data-role="crumbs"]')).toContainText("C:");
    await expect(page.locator('[data-role="row-dir"]', { hasText: "Windows" })).toHaveCount(1);
  });

  test("多选批量删除：确认后走回收站命令，体积就地扣减并标记可刷新", async ({ page }) => {
    await stubDisk(page);
    await page.goto("/?tool=disk");
    await page.locator(".tool-disk").waitFor({ state: "visible", timeout: 15_000 });
    const sessionId = await startScan(page, "C");
    await finishScan(page, sessionId);

    await checkRow(page, "Windows");
    await checkRow(page, "huge.iso");
    const bar = page.locator('[data-role="selection-bar"]');
    await expect(bar).toContainText("已选 2 项");
    await expect(bar).toContainText("80 GB");

    await page.locator('[data-role="delete-selected"]').click();
    // 删除必须过确认弹窗：这是本工具唯一的破坏性动作
    await expect(page.locator(".cf-box")).toContainText("移入回收站");
    await page.locator(".cf-btn.ok").click();

    await expect.poll(async () => (await callArgs(page, "disk_delete_to_trash"))?.paths?.length).toBe(2);
    const args = await callArgs(page, "disk_delete_to_trash");
    expect(args.paths).toEqual(expect.arrayContaining(["C:\\Windows", "C:\\huge.iso"]));

    // 行与最大文件榜单都移除了；汇总就地扣减 80 GB（100 → 20）
    await expect(page.locator('[data-role="rows"] .dk-row-name', { hasText: /^Windows$/ })).toHaveCount(0);
    await expect(page.locator('[data-role="rows"] .dk-row-name', { hasText: /^huge\.iso$/ })).toHaveCount(0);
    await expect(page.locator('[data-role="top-files"]')).not.toContainText("huge.iso");
    await expect(page.locator('[data-role="summary"]')).toContainText("共 20 GB");
    await expect(page.locator('[data-role="node-stat"]')).toContainText("20 GB");
    // 体积是就地扣减的：如实标注「重新扫描可完全刷新」，并把它做成可点的动作
    await expect(page.locator('[data-role="stale-notice"]')).toBeVisible();
    await expect(page.locator(".toast")).toContainText("已删除 2 项到回收站");
    await expect(page.locator(".toast-act")).toBeVisible();
    await expect(page.locator('[data-role="selection-bar"]')).toHaveCount(0);
  });

  test("删除失败不假装成功：项目留在列表里、如实报错、不做扣减", async ({ page }) => {
    await stubDisk(page, {
      deleteResults: { "C:\\huge.iso": { path: "C:\\huge.iso", ok: false, error: "文件正在被其它程序使用" } },
    });
    await page.goto("/?tool=disk");
    await page.locator(".tool-disk").waitFor({ state: "visible", timeout: 15_000 });
    const sessionId = await startScan(page, "C");
    await finishScan(page, sessionId);

    await page.locator(".dk-row", { hasText: "huge.iso" }).locator(".dk-mini.danger").click();
    await expect(page.locator(".cf-box")).toContainText("移入回收站");
    await page.locator(".cf-btn.ok").click();

    await expect(page.locator(".toast")).toContainText("1 项删除失败");
    await expect(page.locator(".toast")).toContainText("正在被其它程序使用");
    await expect(page.locator('[data-role="rows"] .dk-row-name', { hasText: /^huge\.iso$/ })).toHaveCount(1);
    await expect(page.locator('[data-role="summary"]')).toContainText("共 100 GB");
    await expect(page.locator('[data-role="stale-notice"]')).toHaveCount(0);
  });

  test("删别处的文件（最大文件榜单里的深层路径）：不做就地扣减，只提示重新扫描", async ({ page }) => {
    const deep = { path: "C:\\Users\\me\\Downloads\\deep-model.bin", size: 30 * GB };
    await stubDisk(page);
    await page.goto("/?tool=disk");
    await page.locator(".tool-disk").waitFor({ state: "visible", timeout: 15_000 });
    const sessionId = await startScan(page, "C");
    await finishScan(page, sessionId, { topFiles: [deep] });

    await page.locator('[data-role="top-files"] .dk-file', { hasText: "deep-model.bin" }).locator(".dk-mini.danger").click();
    await page.locator(".cf-btn.ok").click();

    // 该文件不在当前节点（C:\）的直属清单里——中间层目录的体积扣不动，如实提示而不是演算假数
    await expect(page.locator('[data-role="top-files"]')).not.toContainText("deep-model.bin");
    await expect(page.locator('[data-role="summary"]')).toContainText("共 100 GB");
    await expect(page.locator('[data-role="stale-notice"]')).toBeVisible();
    await expect(page.locator(".toast-act")).toBeVisible();
  });

  test("迁移目录：勘察 → 二次确认 → 进度 → 记录；回滚把它搬回来", async ({ page }) => {
    // 第 3 次 disk_list_drives（迁移完成后的那次刷新）换成「迁移后的容量」：
    // C: 128 → 136 GB，用来验「完成后自动刷新 + 变化量提示」
    const drivesAfter = [
      { ...DRIVES[0], free: 136 * GB },
      { ...DRIVES[1], free: 1200 * GB },
    ];
    await stubDisk(page, {
      drivesAfter,
      drivesAfterFrom: 3,
      // 可搬但有风险的地方要给提醒（UWP / 系统组件 / Temp 等由原生侧判定，前端如实展示）
      migrateWarnings: ["这是商店应用（UWP）的数据目录：个别应用对目录联接敏感，迁移后若某个应用异常，可以直接回滚"],
    });
    await page.goto("/?tool=disk");
    await page.locator(".tool-disk").waitFor({ state: "visible", timeout: 15_000 });
    const sessionId = await startScan(page, "C");
    await finishScan(page, sessionId);

    // 行内迁移按钮只有目录行有；文件行没有
    await expect(page.locator(".dk-row", { hasText: "huge.iso" }).locator('[data-role="row-migrate"]')).toHaveCount(0);
    await page.locator(".dk-row", { hasText: "Windows" }).locator('[data-role="row-migrate"]').click();

    const dialog = page.locator('[data-role="migrate-dialog"]');
    await expect(dialog).toBeVisible();
    // 体积与文件数来自原生勘察（不是界面上的快照数字）
    await expect(dialog).toContainText("60 GB");
    await expect(dialog).toContainText("9,000");
    // 目标候选排除源所在卷（C:），只剩 D:
    await expect(page.locator('[data-role="migrate-target-D"]')).toBeVisible();
    await expect(page.locator('[data-role="migrate-target-C"]')).toHaveCount(0);
    // 目标可用空间（formatBytes 口径到 GB 为止，1200 GB 不会写成 1.2 TB）
    await expect(dialog).toContainText("1200 GB");
    // 风险提醒如实展示（决定权仍在用户）
    await expect(page.locator('[data-role="migrate-warning"]')).toContainText("商店应用");

    await page.locator('[data-role="migrate-start"]').click();
    // 迁移必须过确认弹窗（会动数据）
    await expect(page.locator(".cf-box")).toContainText("确认迁移");
    await expect(page.locator(".cf-box")).toContainText("D:\\Windows");
    await page.locator(".cf-btn.ok").click();

    await expect(page.locator('[data-role="migrate-progress"]')).toBeVisible();
    const migrateSession = await page.evaluate(() => {
      const hit = [...(window.__diskCalls || [])].reverse().find((call) => call.cmd === "disk_migrate_start");
      return String(hit?.args?.sessionId || "");
    });
    expect(migrateSession).toBeTruthy();
    const startArgs = await callArgs(page, "disk_migrate_start");
    expect(startArgs?.source).toBe("C:\\Windows");
    expect(startArgs?.targetParent).toBe("D:\\");

    await emitDesktopEvent(page, "disk:migrate-progress", {
      sessionId: migrateSession,
      status: "running",
      phase: "copy",
      copiedBytes: 30 * GB,
      totalBytes: 60 * GB,
      files: 4000,
      totalFiles: 9000,
      current: "C:\\Windows\\System32",
    });
    const progress = page.locator('[data-role="migrate-progress"]');
    await expect(progress).toContainText("正在复制");
    await expect(progress).toContainText("30 GB / 60 GB");
    await expect(progress).toContainText("C:\\Windows\\System32");

    await emitDesktopEvent(page, "disk:migrate-progress", {
      sessionId: migrateSession,
      status: "done",
      report: { source: "C:\\Windows", targetPath: "D:\\Windows", movedBytes: 60 * GB, movedFiles: 9000, leftovers: 0, leftoverPaths: [] },
    });
    await expect(page.locator('[data-role="migrate-progress"]')).toHaveCount(0);
    await expect(page.locator(".toast")).toContainText("已迁移到 D:\\Windows");
    // 容量卡片自动刷新（C: 可用 128 → 136 GB），且提示里带上变化量——
    // 真机踩过：不刷新会让用户以为迁移失败
    await expect(page.locator('[data-role="drive-C"]')).toContainText("可用 136 GB / 512 GB");
    await expect(page.locator(".toast")).toContainText("磁盘可用变化");
    await expect(page.locator(".toast")).toContainText("C: +8 GB");
    // 体积口径变了（数据在别的盘 / 链接不计入）：如实标注，并出现记录入口
    await expect(page.locator('[data-role="stale-notice"]')).toBeVisible();
    await expect(page.locator('[data-role="open-records"]')).toBeVisible();

    // 回滚：记录里点回滚，确认后事件推进，完成后记录消失
    await page.locator('[data-role="open-records"]').click();
    await expect(page.locator('[data-role="record"]')).toHaveCount(1);
    await expect(page.locator('[data-role="record"]')).toContainText("D:\\Windows");
    await page.locator('[data-role="rollback"]').click();
    await expect(page.locator(".cf-box")).toContainText("确认回滚");
    await page.locator(".cf-btn.ok").click();
    const rollbackSession = await page.evaluate(() => {
      const hit = [...(window.__diskCalls || [])].reverse().find((call) => call.cmd === "disk_migrate_rollback");
      return String(hit?.args?.sessionId || "");
    });
    expect(rollbackSession).toBeTruthy();
    await emitDesktopEvent(page, "disk:migrate-progress", {
      sessionId: rollbackSession,
      status: "done",
      report: { source: "C:\\Windows", targetPath: "D:\\Windows", movedBytes: 60 * GB, movedFiles: 9000, leftovers: 0, leftoverPaths: [] },
    });
    await expect(page.locator(".toast")).toContainText("已回滚");
    await expect(page.locator('[data-role="open-records"]')).toHaveCount(0);
  });

  test("迁移检查未通过：如实给出原因，且不允许开始", async ({ page }) => {
    await stubDisk(page, { migrateCheck: { "D:\\": "目标磁盘空间不足：需要 63 GB（含余量），可用 10 GB" } });
    await page.goto("/?tool=disk");
    await page.locator(".tool-disk").waitFor({ state: "visible", timeout: 15_000 });
    const sessionId = await startScan(page, "C");
    await finishScan(page, sessionId);

    await page.locator(".dk-row", { hasText: "Users" }).locator('[data-role="row-migrate"]').click();
    const dialog = page.locator('[data-role="migrate-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-role="migrate-check-error"]')).toContainText("空间不足");
    await expect(page.locator('[data-role="migrate-start"]')).toBeDisabled();
  });

  test("取消迁移：发出取消命令，收到 canceled 后收面板并提示", async ({ page }) => {
    await stubDisk(page);
    await page.goto("/?tool=disk");
    await page.locator(".tool-disk").waitFor({ state: "visible", timeout: 15_000 });
    const sessionId = await startScan(page, "C");
    await finishScan(page, sessionId);

    await page.locator(".dk-row", { hasText: "Users" }).locator('[data-role="row-migrate"]').click();
    await page.locator('[data-role="migrate-start"]').click();
    await page.locator(".cf-btn.ok").click();
    await expect(page.locator('[data-role="migrate-progress"]')).toBeVisible();

    await page.locator('[data-role="migrate-cancel"]').click();
    await expect
      .poll(async () => Boolean((await callArgs(page, "disk_migrate_cancel"))?.sessionId))
      .toBe(true);
    const migrateSession = (await callArgs(page, "disk_migrate_start"))?.sessionId;
    await emitDesktopEvent(page, "disk:migrate-progress", { sessionId: migrateSession, status: "canceled", error: "" });
    await expect(page.locator('[data-role="migrate-progress"]')).toHaveCount(0);
    await expect(page.locator(".toast")).toContainText("迁移已取消");
  });

  test("文件超过列表上限：如实提示 + 「显示更多」放开（全选只选装进列表的项）", async ({ page }) => {
    // 真机反馈过的困惑：目录里 1000+ 文件、列表只装 500，删几个后数字「看着没变」
    const manyFiles = Array.from({ length: 620 }, (_, index) => ({
      name: `big-${String(index).padStart(3, "0")}.bin`,
      path: `C:\\big-${String(index).padStart(3, "0")}.bin`,
      size: (620 - index) * 1024 * 1024,
      modifiedAt: 1700000000000,
    }));
    await stubDisk(page, { manyFiles: { "C:\\": manyFiles } });
    await page.goto("/?tool=disk");
    await page.locator(".tool-disk").waitFor({ state: "visible", timeout: 15_000 });
    const sessionId = await startScan(page, "C");
    await finishScan(page, sessionId);

    // 首次读盘按默认上限 500 取头部：真数如实显示，并给出放开入口
    expect((await callArgs(page, "disk_dir_files"))?.limit).toBe(500);
    await expect(page.locator('[data-role="show-more"]')).toContainText("120");
    await expect(page.locator(".dk-more")).toContainText("620");

    await page.locator('[data-role="show-more"]').click();
    await expect.poll(async () => (await callArgs(page, "disk_dir_files"))?.limit).toBe(1000);
    await expect(page.locator('[data-role="show-more"]')).toHaveCount(0);
    // 3 个目录 + 620 个文件全在列表里（不再有截断提示）
    await expect(page.locator('[data-role="rows"] .dk-row-name')).toHaveCount(623);
  });

  test("扫到链接路径：顶部警示 + 一键扫真实位置；链接行有标签且不计入统计", async ({ page }) => {
    // 真机场景：C:\...\Downloads 已被迁移成指向 E: 的目录联接，用户又选了它来扫
    const linkRoot = "C:\\Users\\chenbo.li\\Downloads";
    const realRoot = "E:\\develop-lcb\\downloads\\20261010迁移\\Downloads";
    await stubDisk(page, {
      dialogPath: linkRoot,
      rootLinks: [{ name: "执行结果 (1)", target: "E:\\develop-lcb\\downloads\\20261010迁移\\执行结果 (1)" }],
      resolvePaths: {
        [linkRoot]: { path: linkRoot, realPath: realRoot, isLink: true, crossDrive: true },
      },
    });
    await page.goto("/?tool=disk");
    await page.locator(".tool-disk").waitFor({ state: "visible", timeout: 15_000 });

    // 走「选择文件夹」扫那个链接路径
    await page.locator('[data-role="pick-folder"]').click();
    await expect(page.locator('[data-role="scan-progress"]')).toBeVisible();
    await page.waitForFunction(() => (window.__diskCalls || []).some((call) => call.cmd === "disk_scan_start"));
    const startArgs = await callArgs(page, "disk_scan_start");
    expect(startArgs?.root).toBe(linkRoot);
    await finishScan(page, String(startArgs?.sessionId || ""), { links: 1 });

    // 顶部警示：说清实体在哪，并给一键扫真实位置
    const banner = page.locator('[data-role="root-link-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(realRoot);

    // 链接行：带「链接」角标、占位不计数（没有复选框，也不给删除/迁移按钮）
    const linkRow = page.locator('[data-role="row-link"]');
    await expect(linkRow).toHaveCount(1);
    await expect(linkRow).toContainText("执行结果 (1)");
    await expect(linkRow.locator(".dk-row-badge")).toHaveText("链接");
    await expect(linkRow.locator(".dk-check")).toHaveCount(0);
    await expect(linkRow.locator(".dk-mini.danger")).toHaveCount(0);
    await expect(page.locator('[data-role="link-count"]')).toContainText("链接 1 个");
    await expect(page.locator('[data-role="summary"]')).toContainText("链接 1 个");

    // 一键扫真实位置：新会话的 root 就是真身路径
    await page.locator('[data-role="scan-real"]').click();
    await expect.poll(async () => (await callArgs(page, "disk_scan_start"))?.root).toBe(realRoot);
  });

  test("迁移失败后可重试：源目录未动，重新确认再搬一单", async ({ page }) => {
    await stubDisk(page);
    await page.goto("/?tool=disk");
    await page.locator(".tool-disk").waitFor({ state: "visible", timeout: 15_000 });
    const sessionId = await startScan(page, "C");
    await finishScan(page, sessionId);

    await page.locator(".dk-row", { hasText: "Windows" }).locator('[data-role="row-migrate"]').click();
    await page.locator('[data-role="migrate-start"]').click();
    await page.locator(".cf-btn.ok").click();
    const migrateSession = (await callArgs(page, "disk_migrate_start"))?.sessionId;

    // 引擎在复制失败时就是这么报的：占用类错误带上「常见占用者」提示（真机实测过）
    await emitDesktopEvent(page, "disk:migrate-progress", {
      sessionId: migrateSession,
      status: "error",
      error: "复制失败 C:\\Windows\\x.svg：另一个程序正在使用此文件，进程无法访问。(os error 32)（另一个程序正占用它——常见于杀毒实时扫描、搜索索引、或该应用的残留后台进程）",
    });
    const panel = page.locator('[data-role="migrate-progress"]');
    await expect(page.locator('[data-role="migrate-run-error"]')).toContainText("os error 32");
    await expect(page.locator('[data-role="migrate-run-error"]')).toContainText("杀毒实时扫描");

    // 重试：再确认一次 → 用同样的参数重新开一单（复制阶段中止时源目录一个字节没动）
    await page.locator('[data-role="migrate-retry"]').click();
    await expect(page.locator(".cf-box")).toContainText("确认迁移");
    await page.locator(".cf-btn.ok").click();
    await expect
      .poll(async () => page.evaluate(() => (window.__diskCalls || []).filter((call) => call.cmd === "disk_migrate_start").length))
      .toBe(2);
    const args = await callArgs(page, "disk_migrate_start");
    expect(args?.source).toBe("C:\\Windows");
    expect(args?.targetParent).toBe("D:\\");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("正在复制");
  });

  test("取消扫描：发出 disk_scan_cancel，收到 canceled 后回落空态并提示", async ({ page }) => {
    await stubDisk(page);
    await page.goto("/?tool=disk");
    await page.locator(".tool-disk").waitFor({ state: "visible", timeout: 15_000 });
    const sessionId = await startScan(page, "C");

    await page.locator('[data-role="cancel-scan"]').click();
    await expect
      .poll(async () => (await callArgs(page, "disk_scan_cancel"))?.sessionId)
      .toBe(sessionId);

    await emitDesktopEvent(page, "disk:progress", { sessionId, status: "canceled", entries: 0, bytes: 0, dirs: 0, errors: 0, path: "" });
    await expect(page.locator('[data-role="scan-progress"]')).toHaveCount(0);
    await expect(page.locator(".toast")).toContainText("扫描已取消");
    await expect(page.locator('[data-role="empty"]')).toBeVisible();
    // 半棵树的体积是误导性的：取消后不给结果区
    await expect(page.locator('[data-role="summary"]')).toHaveCount(0);
  });

  test("重新扫描前释放旧会话（否则整棵目录树的内存会挂到窗口关闭）", async ({ page }) => {
    await stubDisk(page);
    await page.goto("/?tool=disk");
    await page.locator(".tool-disk").waitFor({ state: "visible", timeout: 15_000 });
    const first = await startScan(page, "C");
    await finishScan(page, first);

    await page.locator('[data-role="rescan"]').click();
    await expect
      .poll(async () => (await callArgs(page, "disk_scan_release"))?.sessionId)
      .toBe(first);
    await expect(page.locator('[data-role="scan-progress"]')).toBeVisible();
  });

  test("工具页可从工具箱搜到", async ({ page }) => {
    await stubDisk(page);
    await page.goto("/");
    await page.locator(".nav-item", { hasText: "工具箱" }).click();
    const box = page.locator(".toolbox-search input");
    await box.waitFor({ state: "visible", timeout: 10_000 });
    await box.fill("磁盘");
    await expect(page.locator(".tool-item .name", { hasText: /^磁盘分析$/ })).toHaveCount(1);
  });

  test("浏览器形态：直达链接显示桌面专属错误，工具箱里不出现该卡片", async ({ page }) => {
    // 不 seed：浏览器形态下 desktopOnly 工具会被过滤掉
    await page.goto("/?tool=disk");
    await expect(page.locator('[data-role="desktop-error"]')).toContainText("桌面版能力");
    await expect(page.locator('[data-role="pick-folder"]')).toBeVisible();

    await page.goto("/");
    await page.locator(".nav-item", { hasText: "工具箱" }).click();
    const box = page.locator(".toolbox-search input");
    await box.waitFor({ state: "visible", timeout: 10_000 });
    await box.fill("磁盘");
    await expect(page.locator(".tool-item .name", { hasText: /^磁盘分析$/ })).toHaveCount(0);
  });
});
