// 照片存档 E2E：手机形态（拍照/入队/配置校验）与桌面形态（云端列表 → 勾选 → 归档接线）。
//
// 两端的分工在这条用例里被锁住：
//   · 手机端不依赖任何原生桥（拍照走 `<input capture>`，上传走浏览器直发），所以走普通移动视口即可；
//   · 桌面端依赖 Rust（photo_list / photo_download / photo_manifest 与两个事件），
//     所以必须 seedDesktopIpc + 把这几条命令接到本文件的替身上（其它命令保持原路径）。
//
// 这里不碰真网络：配置里的 endpoint 是 127.0.0.1:1，连不上是**预期行为**——
// "失败如实显示、照片留在本地队列"正是要断言的东西。
import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { emitDesktopEvent, seedData, seedDesktopIpc } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";
const FIXTURE = fileURLToPath(new URL("../fixtures/sample-400x300.png", import.meta.url));

const KEY_A = "photos/2026/10/13/20261013T163000_ab12cd_9f3e.png";
const KEY_B = "photos/2026/10/13/20261013T163100_ab12cd_1122.png";
const OBJECTS = [
  { key: KEY_A, size: 3670, etag: "aaa", lastModified: "2026-10-13T08:30:00.000Z" },
  { key: KEY_B, size: 3670, etag: "bbb", lastModified: "2026-10-13T08:31:00.000Z" },
];

test.describe("手机端（拍照上传）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  async function openPhoto(page) {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await page.locator(".m-tab[data-tab='toolbox']").click();
    await page.locator('.m-item[data-tool="photo"] .m-item-main').click();
    await expect(page.locator('[data-tool="photo"]')).toBeVisible();
  }

  test("未配置时如实提示；拍照入口带 capture 提示（安卓/ iOS 拉相机靠它）", async ({ page }) => {
    await openPhoto(page);
    const tool = page.locator('[data-tool="photo"]');
    await expect(tool.locator('[data-role="config-missing"]')).toBeVisible();
    await expect(tool.locator('[data-role="take-photo"]')).toBeVisible();
    await expect(tool.locator('[data-role="pick-photos"]')).toBeVisible();
    await expect(tool.locator('[data-role="empty"]')).toBeVisible();
    // capture="environment" 是"后置摄像头"的浏览器契约：没它手机会弹成文件选择器
    await expect(tool.locator('[data-role="camera-input"]')).toHaveAttribute("capture", "environment");
  });

  test("选照片即入队：未配置停在待上传，照片留在本机", async ({ page }) => {
    await openPhoto(page);
    const tool = page.locator('[data-tool="photo"]');
    await tool.locator('[data-role="gallery-input"]').setInputFiles(FIXTURE);

    const row = tool.locator('.m-photo-row').first();
    await expect(row).toBeVisible();
    await expect(row.locator('[data-role="item-state"]')).toHaveText("待上传");
    // key 由本工具命名规则生成（photos/<日期>/…），云端目录结构从这一刻就定了
    await expect(row.locator(".m-photo-key")).toContainText("photos/2026/");
    await expect(tool.locator('[data-role="queue-meta"]')).toContainText("0/1");

    // 移除：未配置、未上传的项可以直接删
    await row.locator('[data-role="item-remove"]').click();
    await expect(tool.locator('[data-role="empty"]')).toBeVisible();
  });

  test("配置校验：缺字段逐条提示；测试连接失败如实显示错误", async ({ page }) => {
    await openPhoto(page);
    const tool = page.locator('[data-tool="photo"]');

    await tool.locator('[data-role="config-edit"]').click();
    // 后端下拉默认 S3 系；字段按 provider 渲染
    await expect(tool.locator('[data-role="provider"]')).toHaveValue("s3");
    await tool.locator('[data-role="config-save"]').click();
    await expect(tool.locator('[data-role="err-endpoint"]')).toBeVisible();
    await expect(tool.locator('[data-role="err-access-key"]')).toBeVisible();

    await tool.locator('[data-role="field-endpoint"]').fill("127.0.0.1:1");
    await tool.locator('[data-role="field-region"]').fill("test");
    await tool.locator('[data-role="field-bucket"]').fill("test-bucket");
    await tool.locator('[data-role="field-access-key"]').fill("AK");
    await tool.locator('[data-role="field-secret-key"]').fill("SK");
    await tool.locator('[data-role="config-save"]').click();
    await expect(tool.locator('[data-role="config-summary"]')).toContainText("test-bucket");

    // 连不上的地址：错误原样透出（而不是"测试中…"卡住）
    await tool.locator('[data-role="config-test"]').click();
    await expect(tool.locator('[data-role="test-error"]')).toBeVisible({ timeout: 15_000 });
  });

  test("导出 / 导入：一段文本把存储配置搬到另一台设备", async ({ page }) => {
    await openPhoto(page);
    const tool = page.locator('[data-tool="photo"]');

    // 导出：文本里带 kind 标记与完整字段（凭据明文，便于另一端直接可用）
    await tool.locator('[data-role="config-export"]').click();
    await expect(tool.locator('[data-role="transfer-text"]')).toHaveValue(/toolcove-photo-storage/);
    await tool.locator('[data-role="transfer-close"]').click();
    await expect(tool.locator('[data-role="transfer-box"]')).toHaveCount(0);

    // 导入：粘贴另一台设备的配置 → 立即生效并保存
    await tool.locator('[data-role="config-import"]').click();
    const payload = JSON.stringify({
      kind: "toolcove-photo-storage",
      version: 1,
      config: { provider: "s3", endpoint: "cos.ap-guangzhou.myqcloud.com", region: "ap-guangzhou", bucket: "imported-bucket", accessKey: "AK", secretKey: "SK", prefix: "photos" },
    });
    await tool.locator('[data-role="transfer-text"]').fill(payload);
    await tool.locator('[data-role="transfer-apply"]').click();
    await expect(tool.locator('[data-role="transfer-ok"]')).toBeVisible();
    await expect(tool.locator('[data-role="config-summary"]')).toContainText("imported-bucket");

    // 坏内容如实报错，不静默覆盖已有配置
    await tool.locator('[data-role="transfer-text"]').fill("随便一段话");
    await tool.locator('[data-role="transfer-apply"]').click();
    await expect(tool.locator('[data-role="transfer-error"]')).toContainText("不是有效的配置内容");
  });

  test("切到七牛：字段集随之切换，浏览器形态不给测试按钮", async ({ page }) => {
    await openPhoto(page);
    const tool = page.locator('[data-tool="photo"]');

    await tool.locator('[data-role="config-edit"]').click();
    await tool.locator('[data-role="provider"]').selectOption("qiniu");
    await expect(tool.locator('[data-role="field-domain"]')).toBeVisible();
    await expect(tool.locator('[data-role="field-upload-host"]')).toBeVisible();
    await expect(tool.locator('[data-role="field-endpoint"]')).toHaveCount(0);
    await expect(tool.locator('[data-role="field-region"]')).toHaveCount(0);

    // 空域名保存被拦（停在编辑态是刻意的：错误就在字段旁边）
    await tool.locator('[data-role="config-save"]').click();
    await expect(tool.locator('[data-role="err-domain"]')).toBeVisible();

    await tool.locator('[data-role="field-bucket"]').fill("my-photos");
    await tool.locator('[data-role="field-access-key"]').fill("AK");
    await tool.locator('[data-role="field-secret-key"]').fill("SK");
    await tool.locator('[data-role="field-domain"]').fill("cdn.example.com");
    await tool.locator('[data-role="config-save"]').click();
    await expect(tool.locator('[data-role="config-summary"]')).toContainText("my-photos");
    // 浏览器的跨域限制：七牛/WebDAV 的探活按钮禁用，并给出"去桌面端测"的说明
    await expect(tool.locator('[data-role="config-test"]')).toBeDisabled();
    await expect(tool.locator('[data-role="test-desktop-only"]')).toBeVisible();
  });
});

test.describe("桌面端（批量归档）", () => {
  test.beforeEach(async ({ page }) => {
    // 播种一份"已配置"的存储设置。两个约定要对齐：
    //   · 键名是 toolbox-photo 且值包成 { v: … }（toolboxStore 的落盘形状，与 61-auto-checkin 同一写法）；
    //   · 凭据用**明文**（没有 enc: 前缀）——替身没实现 encrypt/decrypt 命令，
    //     明文让 secure.js 直接短路返回，不需要走命令。
    await seedData(page, {
      settings: { telemetry: { prompted: true, enabled: false } },
      "toolbox-photo": {
        v: {
          provider: "s3",
          endpoint: "127.0.0.1:1",
          region: "test",
          bucket: "test-bucket",
          accessKey: "AK",
          secretKey: "SK",
          sessionToken: "",
          pathStyle: true,
          prefix: "photos",
          deviceId: "ab12cd",
        },
      },
    });
    await seedDesktopIpc(page, {});
    await page.addInitScript((objects) => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__E2E_PHOTO_STATE__ = { archived: [] };
      window.__E2E_PHOTO_CALLS__ = [];
      window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
        window.__E2E_PHOTO_CALLS__.push({ cmd, args });
        if (cmd === "photo_list") return { objects, truncated: false, nextToken: "" };
        if (cmd === "photo_manifest") return { version: 1, entries: window.__E2E_PHOTO_STATE__.archived };
        if (cmd === "photo_download") return null;
        if (cmd === "photo_test") return { sampleCount: 2 };
        // 真实桌面端是 DPAPI（Rust）且返回**裸字符串**（安卓桥才是 {cipher}/{plain}）。
        // 替身不可少：导入配置会走 secure.encryptValue，缺这条会以"加密没有返回密文"失败。
        if (cmd === "encrypt_text") return `e2e-enc:${String(args?.plain ?? "")}`;
        if (cmd === "decrypt_text") return String(args?.cipher ?? "").replace(/^e2e-enc:/, "");
        return original(cmd, args);
      };
    }, OBJECTS);
    await page.goto("/?tool=photo");
    await expect(page.locator('[data-role="list-meta"]')).toBeVisible({ timeout: 15_000 });
  });

  async function archiveCalls(page) {
    return page.evaluate(() => window.__E2E_PHOTO_CALLS__.filter((call) => call.cmd === "photo_download"));
  }

  test("云端列表按日期分组、标出新照片；全选新照片可一键勾上", async ({ page }) => {
    await expect(page.locator('[data-role="list-meta"]')).toHaveText("共 2 张 · 已存档 0 · 新照片 2");
    await expect(page.locator(".date-head").first()).toHaveText("2026-10-13");
    await expect(page.locator('.photo-row [data-role="fresh-chip"]')).toHaveCount(2);

    // 每行都有缩略图位；替身没有 photo_thumb（返回空），应优雅占位而不是报错
    await expect(page.locator(".photo-row [data-role='thumb']")).toHaveCount(2);

    // 整行可点选：点文件名即勾上，已选计数跟着走
    await page.locator(".photo-row .photo-name").first().click();
    await expect(page.locator('[data-role="pick-20261013T163100_ab12cd_1122.png"]')).toBeChecked();
    await expect(page.locator('[data-role="selected-count"]')).toContainText("1");
    await page.locator('[data-role="clear-selection"]').click();
    await expect(page.locator('[data-role="selected-count"]')).toHaveCount(0);

    await page.locator('[data-role="select-new"]').click();
    await expect(page.locator('[data-role="pick-20261013T163000_ab12cd_9f3e.png"]')).toBeChecked();
    await expect(page.locator('[data-role="pick-20261013T163100_ab12cd_1122.png"]')).toBeChecked();
  });

  test("归档接线：进度事件推进进度条，完成事件写结果并重新标已存档", async ({ page }) => {
    await page.locator('[data-role="archive-dir"]').fill("D:\\photos-archive");
    await page.locator('[data-role="select-new"]').click();
    await page.locator('[data-role="start-archive"]').click();

    // 任务下发到 Rust（items 带 key/size，供归档按大小核对）
    await expect.poll(async () => (await archiveCalls(page)).length).toBe(1);
    const [call] = await archiveCalls(page);
    expect(call.args.items.map((item) => item.key)).toEqual([KEY_A, KEY_B]);
    expect(call.args.destDir).toBe("D:\\photos-archive");
    const id = call.args.id;

    // 进度事件 → 进度条与当前文件
    await emitDesktopEvent(page, "photo:progress", { id, done: 1, total: 2, skipped: 0, failed: 0, currentKey: KEY_B, fileDone: 100, fileTotal: 3670 });
    await expect(page.locator('[data-role="progress"]')).toContainText("已处理 1/2");
    await expect(page.locator('[data-role="progress"]')).toContainText("20261013T163100_ab12cd_1122.png");

    // 完成事件 → 已存档标记回写（账本替身在完成时给出两条记录）
    await page.evaluate(
      (entries) => {
        window.__E2E_PHOTO_STATE__.archived = entries;
      },
      [
        { key: KEY_A, size: 3670, sha256: "x", archivedAt: 1, path: "2026-10-13/a.png" },
        { key: KEY_B, size: 3670, sha256: "y", archivedAt: 1, path: "2026-10-13/b.png" },
      ]
    );
    await emitDesktopEvent(page, "photo:finished", { id, ok: true, canceled: false, processed: 2, skipped: 0, failedCount: 0, failed: [], error: "" });

    await expect(page.locator('[data-role="result-note"]')).toHaveText("归档完成：下载 2 张，跳过 0 张");
    await expect(page.locator('[data-role="archived-chip"]')).toHaveCount(2, { timeout: 10_000 });
    await expect(page.locator('[data-role="list-meta"]')).toHaveText("共 2 张 · 已存档 2 · 新照片 0");
  });

  test("取消归档：取消事件回落为提示，不报成失败", async ({ page }) => {
    await page.locator('[data-role="archive-dir"]').fill("D:\\photos-archive");
    await page.locator('[data-role="select-new"]').click();
    await page.locator('[data-role="start-archive"]').click();
    await expect.poll(async () => (await archiveCalls(page)).length).toBe(1);
    const [call] = await archiveCalls(page);

    await page.locator('[data-role="cancel-archive"]').click();
    await emitDesktopEvent(page, "photo:finished", { id: call.args.id, ok: false, canceled: true, processed: 1, skipped: 0, failedCount: 0, failed: [], error: "" });
    await expect(page.locator('[data-role="result-note"]')).toContainText("已取消");
  });

  // 回归：矮窗口（笔记本半屏 / 嵌入主窗口的窄工具区）里，配置表单比可用高度高，
  // 面板曾用 flex-shrink:0 + 祖先 overflow:hidden 直接裁掉下半截——"存储设置滑不下去、保存按钮看不到"。
  test("矮窗口下存储设置可滚动，保存按钮不被裁切", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.goto("/?tool=photo");
    await page.locator('[data-role="config-edit"]').click();

    const metrics = await page.evaluate(() => {
      const root = document.querySelector(".tool-photo");
      root.scrollTo(0, 1e6);
      const save = document.querySelector('[data-role="config-save"]');
      const saveRect = save.getBoundingClientRect();
      let node = save.parentElement;
      let clippedAt = null;
      while (node && node !== document.documentElement) {
        const rect = node.getBoundingClientRect();
        const overflowY = getComputedStyle(node).overflowY;
        if ((overflowY === "hidden" || overflowY === "clip") && saveRect.bottom > rect.bottom + 1) {
          clippedAt = String(node.className);
          break;
        }
        node = node.parentElement;
      }
      return { clippedAt, scrolled: Math.round(root.scrollTop), saveBottom: Math.round(saveRect.bottom), innerHeight: window.innerHeight };
    });
    expect(metrics.clippedAt, "保存按钮被这个祖先裁掉了").toBe(null);
    expect(metrics.scrolled, "工具根节点应当可滚动").toBeGreaterThan(0);
    await expect(page.locator('[data-role="config-save"]')).toBeInViewport();
  });

  test("桌面端导入配置：立即生效并刷新云端列表", async ({ page }) => {
    await page.locator('[data-role="config-import"]').click();
    const payload = JSON.stringify({
      provider: "s3",
      endpoint: "cos.ap-shanghai.myqcloud.com",
      region: "ap-shanghai",
      bucket: "switched-bucket",
      accessKey: "AK2",
      secretKey: "SK2",
      prefix: "photos",
    });
    await page.locator('[data-role="transfer-text"]').fill(payload);
    await page.locator('[data-role="transfer-apply"]').click();
    await expect(page.locator('[data-role="transfer-ok"]')).toBeVisible();
    await expect(page.locator('[data-role="config-summary"]')).toContainText("switched-bucket");
    // 导入后会重新拉一次列表（photo_list 在我们的替身里始终返回同样的对象，这里只确认没炸）
    await expect(page.locator('[data-role="list-meta"]')).toBeVisible();
  });
});
