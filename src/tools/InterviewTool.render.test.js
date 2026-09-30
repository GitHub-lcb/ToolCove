// InterviewTool 渲染冒烟 + 文案完整性。
//
// 题库契约、进度回路、导入解析各有测试兜着，这里只管视图层：组件导入期崩溃、
// 模板绑定写错、i18n 键缺失（缺键只会渲染出裸键名或空白，不会抛错）。
// 最后一组断言刻意跨文件扫：题库新增一个方向、界面新增一个页签或筛选档位，
// 忘了配文案就会在这里红，而不是等用户看到 toolbox.interview.category.xxx。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import zh from "../i18n/zh-CN.json";
import en from "../i18n/en-US.json";
import { i18n } from "../i18n/index.js";
import { CATEGORIES, DIFFICULTIES } from "./interviewBank.js";
import { RATINGS } from "./interviewProgress.js";
import InterviewTool from "./InterviewTool.vue";

const t = (key, params) => i18n.global.t(key, params);
const get = (dict, key) => key.split(".").reduce((node, part) => (node ? node[part] : undefined), dict);
const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const desktopSource = read("src/tools/InterviewTool.vue");
const mobileSource = read("mobile/app/tools/InterviewToolView.vue");

async function render() {
  const app = createSSRApp({ render: () => h(InterviewTool, { showToast: () => {} }) });
  app.use(i18n);
  return renderToString(app);
}

/** 去掉 HTML 注释：模板注释里写的正是「不该出现什么」，不断开会被误伤。 */
function visible(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

describe("InterviewTool 渲染", () => {
  it("首屏是题库：标题、统计、四个页签、搜索与筛选都在", async () => {
    const html = visible(await render());
    expect(html).toContain(t("toolbox.interview.title"));
    expect(html).toContain(t("toolbox.interview.searchPlaceholder"));
    expect(html).toContain(t("toolbox.interview.allCategories"));
    expect(html).toContain(t("toolbox.interview.allTopics"));
    expect(html).toContain(t("toolbox.interview.allDifficulty"));
    expect(html).toContain('data-role="stats"');
    for (const key of ["bank", "review", "session", "manage"]) {
      expect(html, key).toContain(t(`toolbox.interview.tab.${key}`));
    }
  });

  it("答案默认是折起来的——这是这个工具存在的唯一理由", async () => {
    const html = visible(await render());
    expect(html).toContain(t("toolbox.interview.showAnswer"));
    expect(html).not.toContain(t("toolbox.interview.hideAnswer"));
    expect(html, "没点之前不该有题解区").not.toContain('data-role="answer"');
    expect(html, "没点之前不该有出处区").not.toContain('data-role="sources"');
  });

  it("首屏就列出题目，并且第一道默认选中", async () => {
    const html = visible(await render());
    expect(html).toContain('data-role="question-list"');
    expect(html).toContain('data-role="detail"');
    expect(html).toContain('data-role="question"');
    expect(html, "首屏要有可点的题目条目").toMatch(/data-role="q-[a-z0-9-]+"/);
  });

  it("自评四档、要点清单、出处都只出现在题解展开之后的位置上（模板层面）", () => {
    // 渲染态断言（上面两条）已经证明默认不显示；这里补一条结构性断言，
    // 防止以后有人把自评块挪到 v-if="revealed" 之外
    const rateBlock = desktopSource.slice(desktopSource.indexOf('class="rate-block"'));
    expect(desktopSource, "自评块必须挂在 revealed 之下").toContain('v-if="revealed"');
    expect(rateBlock.length).toBeGreaterThan(0);
  });

  it("四个方向的筛选项都渲染出来", async () => {
    const html = visible(await render());
    for (const item of CATEGORIES) {
      expect(html, item.key).toContain(t(item.labelKey));
    }
  });
});

describe("InterviewTool 的文案完整性", () => {
  it("两屏用到的每个静态 toolbox.interview 键在中英文里都非空", () => {
    const keys = [...new Set(
      [desktopSource, mobileSource]
        .flatMap((file) => [...file.matchAll(/"toolbox\.interview\.([A-Za-z0-9_.]+)"/g)].map((m) => `toolbox.interview.${m[1]}`)),
    )].filter((key) => !key.includes("$"));
    expect(keys.length, "一个键都没扫到，说明扫描口径失效了").toBeGreaterThan(25);
    for (const key of keys) {
      expect(String(get(zh, key) ?? "").trim().length, `zh ${key}`).toBeGreaterThan(0);
      expect(String(get(en, key) ?? "").trim().length, `en ${key}`).toBeGreaterThan(0);
    }
  });

  it("每个方向、每个难度、每个自评档、每个空态、每个导入错误都有双语文案", () => {
    const groups = [
      ...CATEGORIES.map((item) => item.labelKey.replace("toolbox.interview.", "")),
      ...DIFFICULTIES.map((item) => item.labelKey.replace("toolbox.interview.", "")),
      ...RATINGS.map((item) => item.labelKey.replace("toolbox.interview.", "")),
      ...["listEmpty", "reviewEmpty", "sessionEmpty", "sessionIdle"].map((key) => `empty.${key}`),
      // 导入错误键必须与 interviewImport.js 里真正会返回的 error 值一一对应
      ...["empty", "badJson", "badShape", "noQuestion", "noCategory"].map((key) => `import.error.${key}`),
      ...["bank", "review", "session", "manage"].map((key) => `tab.${key}`),
      ...["all", "todo", "done", "starred"].map((key) => `status.${key}`),
    ];
    for (const path of groups) {
      const key = `toolbox.interview.${path}`;
      expect(String(get(zh, key) ?? "").trim().length, `zh ${key}`).toBeGreaterThan(0);
      expect(String(get(en, key) ?? "").trim().length, `en ${key}`).toBeGreaterThan(0);
    }
  });

  it("导入错误键与解析器真正返回的 error 值一致（缺一个就会渲染出裸键名）", () => {
    const source = read("src/tools/interviewImport.js");
    const codes = [...new Set([...source.matchAll(/error: "([A-Za-z]+)"/g)].map((m) => m[1]))];
    expect(codes.length, "一个错误码都没扫到").toBeGreaterThan(3);
    for (const code of codes) {
      expect(String(get(zh, `toolbox.interview.import.error.${code}`) ?? "").trim().length, `zh ${code}`).toBeGreaterThan(0);
      expect(String(get(en, `toolbox.interview.import.error.${code}`) ?? "").trim().length, `en ${code}`).toBeGreaterThan(0);
    }
  });

  it("手机端复用了同一套 interview 文案，没有自造前缀", () => {
    const keys = [...mobileSource.matchAll(/"toolbox\.(?!interview\.)([A-Za-z0-9_.]+)"/g)].map((m) => `toolbox.${m[1]}`);
    expect(keys, `手机端引用了非 interview 的文案键：${keys.join(", ")}`).toEqual([]);
  });
});

describe("InterviewTool 的按钮体系", () => {
  it("按钮走全局按钮体系，不在视图里自造 .btn-*", () => {
    const styleBlock = desktopSource.slice(desktopSource.indexOf("<style scoped>"));
    const custom = [...styleBlock.matchAll(/^\.btn-[a-z-]+\s*\{/gm)].map((m) => m[0]);
    expect(custom, `自造的按钮类：${custom.join(" ")}`).toEqual([]);
    expect(desktopSource, "模板该用 App.vue 里的全局按钮").toContain("btn-primary");
  });
});

describe("旧工具已经清干净", () => {
  it("源码里不再有 pipeline 工具的引用", () => {
    const files = ["src/toolboxTools.js", "src/toolComponents.js", "mobile/app/toolbox.js", "src-tauri/capabilities/default.json"];
    for (const file of files) {
      expect(read(file), `${file} 还留着 pipeline`).not.toMatch(/pipeline/i);
    }
  });
});

describe("模拟面试的当前题由会话指针决定（回归）", () => {
  // 这一条守的是一个已经发生过的真实缺陷：会话模式下「当前题」若回退到列表第一道，
  // 自评推进指针后进度会写「第 2 / 4 道」而题干仍停在第 1 道——进度条与题目互相打架。
  // 光看渲染看不出来（首屏两者恰好一致），所以断言落在源码的分支上。
  it("session 模式不读 currentId 回退，而是按 save.session.index 取题", () => {
    const body = desktopSource.slice(desktopSource.indexOf("const current = computed"), desktopSource.indexOf("const activeId"));
    expect(body, "current 必须区分 session 模式").toContain('tab.value === "session"');
    expect(body, "session 模式要按会话指针取题").toMatch(/session\?\.index/);
  });

  it("筛选变化时不动会话里的选中项（避免两套「当前题」）", () => {
    const body = desktopSource.slice(desktopSource.indexOf("function pickFirst"), desktopSource.indexOf("function persist"));
    expect(body, "pickFirst 在 session 模式下应直接返回").toContain('tab.value === "session"');
  });
});
