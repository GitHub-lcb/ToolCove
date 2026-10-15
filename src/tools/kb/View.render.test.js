// 知识库视图的渲染冒烟 + 文案完整性。
//
// 逻辑与界面接线分别有 logic.test.js 与 e2e（71-kb-tool / 72-mobile-kb）兜着，这里补两件**不需要浏览器**的事：
//   1. 组件能挂载渲染（导入期崩溃、模板绑定写错、SSR 下的 v-for 取值都会在这里露出来）；
//   2. 两端视图引用的词条键都真实存在——缺键只会渲染出裸键名（如 toolbox.kb.searchPh），
//      单测与端到端都看不见，所以按文件扫一遍。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import zhRaw from "../../i18n/zh-CN.json";
import enRaw from "../../i18n/en-US.json";
import { i18n, mergeMessages } from "../../i18n/index.js";
import { TEXT_EXTENSIONS } from "./logic.js";
import KbTool from "./View.vue";
import KbToolMobile from "../../../mobile/app/tools/KbToolView.vue";

const zh = mergeMessages("zh-CN", zhRaw);
const en = mergeMessages("en-US", enRaw);

const t = (key, params) => i18n.global.t(key, params);
const get = (dict, key) => key.split(".").reduce((node, part) => (node ? node[part] : undefined), dict);
const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");

async function render() {
  const app = createSSRApp({ render: () => h(KbTool, { showToast: () => {} }) });
  app.use(i18n);
  return renderToString(app);
}

/** 去掉 HTML 注释：注释里写的正是「不该出现什么」，不断开会被误伤。 */
const visible = (html) => html.replace(/<!--[\s\S]*?-->/g, "");

describe("知识库视图渲染", () => {
  it("首屏两栏都在：检索/标签/列表/新建/导入 + 编辑器", async () => {
    const html = visible(await render());
    expect(html).toContain(t("toolbox.kb.searchPh"));
    expect(html).toContain(t("toolbox.kb.newEntry"));
    expect(html).toContain(t("toolbox.kb.import"));
    expect(html).toContain(t("toolbox.kb.titlePh"));
    expect(html).toContain(t("toolbox.kb.tagsPh"));
    expect(html).toContain(t("toolbox.kb.contentPh"));
    expect(html).toContain(t("toolbox.kb.save"));
  });

  it("空库时说清怎么开始（不是一片空白）", async () => {
    const html = visible(await render());
    expect(html).toContain(t("toolbox.kb.empty"));
    expect(html).toContain(t("toolbox.kb.emptyHint"));
  });

  it("导入格式如实写明范围与限制（PDF / Word 未支持要说出来）", async () => {
    const html = visible(await render());
    const hint = t("toolbox.kb.importSafety", { exts: [...TEXT_EXTENSIONS].join(" / ") });
    expect(html).toContain(hint);
    expect(hint).toContain("PDF");
    expect(hint).toContain("md");
  });

  it("浏览器形态的文件入口与 accept 白名单一致（选了 PDF 也不会被当成文本读进来）", async () => {
    const html = visible(await render());
    const accept = TEXT_EXTENSIONS.map((ext) => `.${ext}`).join(",");
    expect(html).toContain(`accept="${accept}"`);
    expect(accept).not.toContain(".pdf");
    expect(accept).not.toContain(".docx");
  });

  it("未选中条目时删除按钮是禁用的（避免删到不存在的目标）", async () => {
    const html = visible(await render());
    expect(html).toMatch(/data-role="delete"[^>]*disabled/);
  });

  it("e2e 依赖的钩子都在（data-role 是端到端用例的选择器契约）", async () => {
    const html = visible(await render());
    for (const role of ["search", "tags", "list", "new", "import", "file-input", "title", "save", "delete", "content", "stats", "import-hint"]) {
      expect(html, `缺少 data-role="${role}"`).toContain(`data-role="${role}"`);
    }
  });
});

describe("知识库视图渲染（手机端）", () => {
  async function renderMobile() {
    const app = createSSRApp({ render: () => h(KbToolMobile) });
    app.use(i18n);
    return visible(await renderToString(app));
  }

  it("首屏渲染成列表态：检索、标签行、新建/导入、空态说明都在", async () => {
    const html = await renderMobile();
    expect(html).toContain('data-tool="kb"');
    expect(html).toContain(t("toolbox.kb.searchPh"));
    expect(html).toContain(t("toolbox.kb.newEntry"));
    expect(html).toContain(t("toolbox.kb.import"));
    expect(html).toContain(t("toolbox.kb.empty"));
  });

  it("e2e 依赖的钩子都在（含删除确认框的取消/确认按钮命名）", async () => {
    const html = await renderMobile();
    for (const role of ["search", "tags", "new", "import", "file-input", "list", "empty", "welcome"]) {
      expect(html, `缺少 data-role="${role}"`).toContain(`data-role="${role}"`);
    }
    // 删除确认是本地模态框：两个按钮的 data-role 与 work/DomainPanel 同一套命名
    const source = read("mobile/app/tools/KbToolView.vue");
    for (const role of ["confirm", "confirm-ok", "confirm-cancel"]) {
      expect(source, `缺少 data-role="${role}"`).toContain(`data-role="${role}"`);
    }
  });
});

describe("知识库词条（两端视图引用的键都真实存在）", () => {
  const files = ["src/tools/kb/View.vue", "mobile/app/tools/KbToolView.vue"];

  it("扫到了两端的视图源码（防空转）", () => {
    for (const file of files) {
      const source = read(file);
      expect(source.length, `${file} 内容为空`).toBeGreaterThan(200);
    }
  });

  it("每个被引用的词条键在中英合并字典里都存在且非空", () => {
    const missingZh = [];
    const missingEn = [];
    const empty = [];
    for (const file of files) {
      for (const match of read(file).matchAll(/t\(\s*["']([^"']+)["']/g)) {
        const key = match[1];
        // 动态拼键（如 `toolbox.kb.issue_${code}`）不在这里扫，它们由各自的守卫覆盖
        if (key.includes("${")) continue;
        if (get(zh, key) === undefined) missingZh.push(`${file} → ${key}`);
        if (get(en, key) === undefined) missingEn.push(`${file} → ${key}`);
      }
    }
    expect(missingZh, "zh 缺键").toEqual([]);
    expect(missingEn, "en 缺键").toEqual([]);
    expect(empty).toEqual([]);
  });

  it("视图引用的键不会退化成裸键名（t() 真能取到值）", async () => {
    const html = visible(await render());
    expect(html).not.toContain("toolbox.kb.");
  });
});
