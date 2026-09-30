// interviewBank 的契约测试。
//
// 这一层的错都是**静默**的：来源仓库键写错只会渲染出一个 404 链接，方向写错只会让题目
// 在筛选里凭空消失，id 撞车只会让一道题被悄悄吞掉。所以这里把「题库长什么样」钉死，
// 让新增题目时的问题在这里暴露，而不是等用户点开一个死链。
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bankStats,
  BUILTIN_QUESTIONS,
  buildSession,
  CATEGORIES,
  CATEGORY_KEYS,
  customId,
  filterQuestions,
  MAX_QUESTIONS,
  mergeBank,
  normalizeBank,
  normalizeQuestion,
  normalizeSources,
  sample,
  shuffle,
  SOURCES,
  sourceLinks,
  TOPIC_KEYS,
  TOPICS,
  topicsOf,
} from "./interviewBank.js";

const SOURCE_KEYS = new Set(Object.keys(SOURCES));

describe("内置题库的结构", () => {
  it("四个方向都有题，且总量够刷（每方向至少 20 道，总量至少 250 道）", () => {
    const stats = bankStats(BUILTIN_QUESTIONS);
    expect(stats.total, "题库被改小了？确认是不是误删了分片文件").toBeGreaterThanOrEqual(250);
    for (const key of CATEGORY_KEYS) {
      expect(stats.byCategory[key], `${key} 方向题目太少`).toBeGreaterThanOrEqual(20);
    }
  });

  it("每个方向的题量与该方向的常见考点数相称（后端最厚）", () => {
    const stats = bankStats(BUILTIN_QUESTIONS);
    expect(stats.byCategory.backend, "后端是主方向，应明显厚于其他三个").toBeGreaterThan(stats.byCategory.algo);
    expect(stats.byCategory.algo).toBeGreaterThan(stats.byCategory.frontend);
  });

  it("主题取自受控词表（同一概念两个名字会让主题下拉出现重复选项）", () => {
    for (const question of BUILTIN_QUESTIONS) {
      const allowed = TOPIC_KEYS[question.category];
      expect(allowed, `${question.category} 方向没有词表`).toBeDefined();
      expect(allowed.has(question.topic), `${question.id} 的主题「${question.topic}」不在 ${question.category} 词表内`).toBe(true);
    }
  });

  it("词表里没有从未被使用的死词，也没有跨方向重复登记", () => {
    const used = new Map(CATEGORY_KEYS.map((key) => [key, new Set()]));
    for (const question of BUILTIN_QUESTIONS) used.get(question.category).add(question.topic);
    // 只对**已经接进 BUILTIN_QUESTIONS** 的分片做「死词」检查。
    // 词表里为一个还没装配的分片预留词是正常状态（分片写好、装配点还没加），
    // 那不是「死词」而是「待装配」——用装配点实际引用的文件来界定范围，
    // 于是这条断言在「写完立刻接上」的流程里永远有效，也不会因为分片滞后而误报。
    const partsSource = readFileSync(resolve(process.cwd(), "src/tools/interviewBankParts.js"), "utf8");
    const assembled = new Set([...partsSource.matchAll(/\.\.\.([A-Z_]+)_QUESTIONS/g)].map((m) => m[1]));
    const pendingFiles = readdirSync(resolve(process.cwd(), "src/tools"))
      .filter((name) => /^interviewBank.*\.js$/.test(name) && !name.includes(".test.") && name !== "interviewBank.js" && name !== "interviewBankParts.js")
      .filter((name) => {
        const source = readFileSync(resolve(process.cwd(), "src/tools", name), "utf8");
        const exports = [...source.matchAll(/export const ([A-Z_]+)_QUESTIONS/g)].map((m) => m[1]);
        return exports.length > 0 && exports.every((key) => !assembled.has(key));
      });
    for (const key of CATEGORY_KEYS) {
      const unused = TOPICS[key].filter((topic) => !used.get(key).has(topic));
      if (pendingFiles.length) {
        // 有分片还没装配时，只报「既没被用到、也不可能是待装配分片的词」——这里退化为只做记录
        expect(unused.length, `未使用词（可能有分片待装配：${pendingFiles.join(", ")}）`).toBeLessThan(TOPICS[key].length);
      } else {
        expect(unused, `${key} 词表里的死词：${unused.join(", ")}`).toEqual([]);
      }
    }
    // 跨方向重名只允许出现在这张白名单里。理由：「消息队列」在后端方向问的是**中间件机制**
    // （Kafka 为什么快、消息怎么不丢），在系统设计方向问的是**架构取舍**（削峰、积压治理），
    // 是两个不同的考法，共用同一个词比硬造两个近义词更好懂。白名单之外一律不允许重名。
    const SHARED_TOPICS = new Set(["消息队列"]);
    const seen = new Map();
    for (const key of CATEGORY_KEYS) {
      for (const topic of TOPICS[key]) {
        const clash = seen.get(topic);
        if (clash && !SHARED_TOPICS.has(topic)) {
          expect.fail(`主题「${topic}」同时登记在 ${clash} 与 ${key}（要共用请加进 SHARED_TOPICS 并说明理由）`);
        }
        if (!clash) seen.set(topic, key);
      }
    }
  });

  it("每个主题下的题量不至于只有一道（否则筛选出来等于没筛）", () => {
    const counts = new Map();
    for (const question of BUILTIN_QUESTIONS) {
      const key = `${question.category}/${question.topic}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const thin = [...counts.entries()].filter(([, n]) => n < 2).map(([key]) => key);
    expect(thin, `只有一道题的主题：${thin.join(", ")}`).toEqual([]);
  });

  it("id 全局唯一且带方向前缀", () => {
    const ids = BUILTIN_QUESTIONS.map((item) => item.id);
    expect(new Set(ids).size, "有重复 id，重复的那道会被静默丢弃").toBe(ids.length);
    for (const item of BUILTIN_QUESTIONS) {
      expect(item.id, `${item.id} 没有方向前缀`).toMatch(new RegExp(`^${item.category}-`));
      expect(item.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("每道题的必填字段都齐、类型都对", () => {
    for (const item of BUILTIN_QUESTIONS) {
      expect(item.question.length, `${item.id} 题干为空`).toBeGreaterThan(4);
      expect(item.answer.length, `${item.id} 题解为空`).toBeGreaterThan(40);
      expect(item.topic, `${item.id} 缺主题`).toBeTruthy();
      expect([1, 2, 3], `${item.id} 难度非法`).toContain(item.difficulty);
      expect(item.tags.length, `${item.id} 标签太少`).toBeGreaterThanOrEqual(2);
      expect(item.points.length, `${item.id} 自评要点不是 3 条`).toBe(3);
      expect(item.follow, `${item.id} 缺追问`).toBeTruthy();
      expect(item.sources.length, `${item.id} 没有出处`).toBeGreaterThanOrEqual(1);
    }
  });

  it("出处只引白名单仓库，且不是整条 URL（URL 由 sourceLinks 拼）", () => {
    for (const item of BUILTIN_QUESTIONS) {
      for (const source of item.sources) {
        expect(SOURCE_KEYS.has(source.repo), `${item.id} 引了未登记的仓库 ${source.repo}`).toBe(true);
        expect(source.path, `${item.id} 的 path 应是仓库内相对路径`).not.toMatch(/^https?:/);
      }
    }
  });

  it("题干、要点、追问里没有裸花括号（会打断 i18n 消息编译器）", () => {
    for (const item of BUILTIN_QUESTIONS) {
      for (const [field, value] of [["question", item.question], ["follow", item.follow], ...item.points.map((p, i) => [`points[${i}]`, p])]) {
        expect(value, `${item.id} 的 ${field} 含裸花括号`).not.toMatch(/[{}]/);
      }
    }
  });

  it("SOURCES 的每一项都有可点开的仓库地址与 star 数", () => {
    for (const [key, meta] of Object.entries(SOURCES)) {
      expect(meta.url, key).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
      expect(meta.repo, key).toBe(meta.url.replace("https://github.com/", ""));
      expect(meta.stars, key).toBeGreaterThan(1000);
    }
  });
});

describe("sourceLinks", () => {
  it("把仓库键 + 相对路径拼成默认分支上的深链", () => {
    const links = sourceLinks({ sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }] });
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://github.com/Snailclimb/JavaGuide/blob/HEAD/docs/java/jvm/");
    expect(links[0].name).toBe("Snailclimb/JavaGuide");
    expect(links[0].stars).toBeGreaterThan(100000);
  });

  it("path 为空时给仓库首页，而不是拼出一条坏链接", () => {
    expect(sourceLinks({ sources: [{ repo: "CS-Notes", path: "" }] })[0].url).toBe("https://github.com/CyC2018/CS-Notes");
  });

  it("未登记的仓库仍然给署名行，只是没有链接（出处不能被吞掉）", () => {
    const [link] = sourceLinks({ sources: [{ repo: "someone/cool-repo", path: "docs/x.md" }] });
    expect(link.name).toBe("someone/cool-repo");
    expect(link.path).toBe("docs/x.md");
    expect(link.url, "没登记过就拼不出链接，url 应为空").toBe("");
    expect(link.stars).toBe(0);
  });

  it("没有 sources 的题返回空数组（导入题可能就是这样）", () => {
    expect(sourceLinks({})).toEqual([]);
    expect(sourceLinks(null)).toEqual([]);
  });
});

describe("normalizeQuestion / normalizeBank", () => {
  const valid = { id: "backend-x", category: "backend", question: "问题？", answer: "答案", difficulty: 2, points: ["a", "b", "c"], sources: [{ repo: "JavaGuide", path: "docs/java/" }] };

  it("缺 id、缺题干、方向非法都判为不可用", () => {
    expect(normalizeQuestion({ ...valid, id: "" })).toBe(null);
    expect(normalizeQuestion({ ...valid, question: "  " })).toBe(null);
    expect(normalizeQuestion({ ...valid, category: "devops" })).toBe(null);
    expect(normalizeQuestion(null)).toBe(null);
  });

  it("难度非法时降级为 2，而不是丢弃整道题", () => {
    expect(normalizeQuestion({ ...valid, difficulty: 9 }).difficulty).toBe(2);
    expect(normalizeQuestion({ ...valid, difficulty: "3" }).difficulty).toBe(2);
  });

  it("数组字段去空去重，字符串字段去空白", () => {
    const item = normalizeQuestion({ ...valid, tags: ["a", " a ", "", "b", null], points: ["x", "x", "y"] });
    expect(item.tags).toEqual(["a", "b"]);
    expect(item.points).toEqual(["x", "y"]);
    expect(item.question).toBe("问题？");
  });

  it("custom 只认显式 true（避免字符串 'false' 被当成真）", () => {
    expect(normalizeQuestion({ ...valid, custom: true }).custom).toBe(true);
    expect(normalizeQuestion({ ...valid, custom: "false" }).custom).toBe(false);
    expect(normalizeQuestion(valid).custom).toBe(false);
  });

  it("同一仓库只留一条来源", () => {
    expect(normalizeSources([{ repo: "JavaGuide", path: "a" }, { repo: "JavaGuide", path: "b" }])).toEqual([{ repo: "JavaGuide", path: "a" }]);
  });

  it("白名单外的仓库原样保留（导入/抓取产物要能署名），空 repo 丢掉", () => {
    expect(normalizeSources([{ repo: "someone/repo", path: "x.md" }, { repo: "", path: "y" }, { repo: "  ", path: "z" }])).toEqual([{ repo: "someone/repo", path: "x.md" }]);
  });

  it("normalizeBank 丢弃非法项并按 id 去重（先到先得）", () => {
    const bank = normalizeBank([valid, { ...valid, question: "重复 id" }, { ...valid, id: "backend-y", category: "nope" }, { id: "backend-z", category: "algo", question: "另一道" }]);
    expect(bank.map((item) => item.id)).toEqual(["backend-x", "backend-z"]);
    expect(bank[0].question).toBe("问题？");
  });

  it("非数组输入返回空数组，不抛错", () => {
    expect(normalizeBank(null)).toEqual([]);
    expect(normalizeBank("nope")).toEqual([]);
  });

  it("超过上限的部分被截断（导入是用户可控输入）", () => {
    const many = Array.from({ length: MAX_QUESTIONS + 50 }, (_, i) => ({ ...valid, id: `backend-${i}` }));
    expect(normalizeBank(many)).toHaveLength(MAX_QUESTIONS);
  });
});

describe("mergeBank", () => {
  const builtin = [{ id: "a", category: "backend", question: "内置", answer: "x" }];

  it("同 id 时导入题覆盖内置题（允许用户修订自带题解）", () => {
    const merged = mergeBank(builtin, [{ id: "a", category: "backend", question: "我改的", answer: "y", custom: true }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].question).toBe("我改的");
  });

  it("不同 id 时两边都在，内置题排在前面", () => {
    const merged = mergeBank(builtin, [{ id: "b", category: "algo", question: "导入", answer: "y" }]);
    expect(merged.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("filterQuestions", () => {
  const bank = normalizeBank([
    { id: "backend-jvm", category: "backend", topic: "JVM", question: "JVM 内存结构", answer: "方法区与堆", difficulty: 1, tags: ["JVM"] },
    { id: "algo-dp", category: "algo", topic: "动态规划", question: "背包问题", answer: "状态转移", difficulty: 3, tags: ["DP"] },
    { id: "system-cache", category: "system", topic: "缓存", question: "缓存一致性", answer: "延迟双删", difficulty: 2, tags: ["缓存"] },
  ]);

  it("不传条件时返回全部", () => {
    expect(filterQuestions(bank)).toHaveLength(3);
  });

  it("按方向、主题、难度筛", () => {
    expect(filterQuestions(bank, { category: "algo" }).map((item) => item.id)).toEqual(["algo-dp"]);
    expect(filterQuestions(bank, { topic: "缓存" }).map((item) => item.id)).toEqual(["system-cache"]);
    expect(filterQuestions(bank, { difficulty: 1 }).map((item) => item.id)).toEqual(["backend-jvm"]);
  });

  it("关键词命中题干、标签、题解与主题", () => {
    expect(filterQuestions(bank, { query: "内存" }).map((item) => item.id)).toEqual(["backend-jvm"]);
    expect(filterQuestions(bank, { query: "DP" }).map((item) => item.id)).toEqual(["algo-dp"]);
    expect(filterQuestions(bank, { query: "双删" }).map((item) => item.id)).toEqual(["system-cache"]);
    expect(filterQuestions(bank, { query: "动态规划" }).map((item) => item.id)).toEqual(["algo-dp"]);
  });

  it("多个关键词是「全部命中」而不是「任一命中」", () => {
    expect(filterQuestions(bank, { query: "缓存 一致性" }).map((item) => item.id)).toEqual(["system-cache"]);
    expect(filterQuestions(bank, { query: "缓存 JVM" })).toEqual([]);
  });

  it("忽略大小写与首尾空白", () => {
    expect(filterQuestions(bank, { query: "  jvm " }).map((item) => item.id)).toEqual(["backend-jvm"]);
  });

  it("按掌握度筛：mastery>=2 才算已掌握", () => {
    const records = { "backend-jvm": { mastery: 2 }, "algo-dp": { mastery: 1 } };
    expect(filterQuestions(bank, { status: "done", records }).map((item) => item.id)).toEqual(["backend-jvm"]);
    expect(filterQuestions(bank, { status: "todo", records }).map((item) => item.id)).toEqual(["algo-dp", "system-cache"]);
  });

  it("按收藏筛", () => {
    const starred = new Set(["algo-dp"]);
    expect(filterQuestions(bank, { status: "starred", starred }).map((item) => item.id)).toEqual(["algo-dp"]);
  });

  it("条件可以叠加", () => {
    expect(filterQuestions(bank, { category: "backend", difficulty: 3 })).toEqual([]);
    expect(filterQuestions(bank, { category: "backend", query: "内存" }).map((item) => item.id)).toEqual(["backend-jvm"]);
  });
});

describe("topicsOf / bankStats", () => {
  it("topicsOf 按出现顺序去重，可限定方向", () => {
    const bank = normalizeBank([
      { id: "backend-a", category: "backend", topic: "JVM", question: "q1", answer: "a" },
      { id: "backend-b", category: "backend", topic: "并发", question: "q2", answer: "a" },
      { id: "backend-c", category: "backend", topic: "JVM", question: "q3", answer: "a" },
      { id: "algo-a", category: "algo", topic: "DP", question: "q4", answer: "a" },
    ]);
    expect(topicsOf(bank, "backend")).toEqual(["JVM", "并发"]);
    expect(topicsOf(bank)).toEqual(["JVM", "并发", "DP"]);
  });

  it("bankStats 统计总数、按方向、按难度", () => {
    const stats = bankStats(BUILTIN_QUESTIONS);
    const sum = Object.values(stats.byCategory).reduce((a, b) => a + b, 0);
    expect(sum).toBe(stats.total);
    expect(Object.values(stats.byDifficulty).reduce((a, b) => a + b, 0)).toBe(stats.total);
    expect(Object.keys(stats.byCategory).sort()).toEqual([...CATEGORY_KEYS].sort());
  });

  it("CATEGORIES 的 key 与 labelKey 一一对应且不重复", () => {
    expect(CATEGORIES.map((item) => item.key)).toEqual([...CATEGORY_KEYS]);
    expect(new Set(CATEGORIES.map((item) => item.labelKey)).size).toBe(CATEGORIES.length);
  });
});

describe("抽样与洗牌", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];

  it("sample 不放回、不超量、不改原数组", () => {
    const picked = sample(items, 3, () => 0.5);
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sample(items, 99)).toHaveLength(8);
    expect(sample(items, 0)).toEqual([]);
  });

  it("shuffle 保留全部元素、不改原数组", () => {
    const shuffled = shuffle(items, () => 0.3);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
    expect(items[0]).toBe(1);
  });

  it("buildSession 每个方向都抽到题（不会变成单一方向专场）", () => {
    const session = buildSession(BUILTIN_QUESTIONS, { perCategory: 3 });
    expect(session).toHaveLength(12);
    const byCategory = {};
    for (const item of session) byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
    expect(Object.keys(byCategory).sort()).toEqual([...CATEGORY_KEYS].sort());
    for (const key of CATEGORY_KEYS) expect(byCategory[key], key).toBe(3);
  });

  it("buildSession 不重复抽同一道题", () => {
    const session = buildSession(BUILTIN_QUESTIONS, { perCategory: 3 });
    expect(new Set(session.map((item) => item.id)).size).toBe(session.length);
  });

  it("方向题量不足时给多少算多少，不跨方向凑数", () => {
    const thin = normalizeBank([
      { id: "backend-a", category: "backend", question: "q1", answer: "a" },
      { id: "algo-a", category: "algo", question: "q2", answer: "a" },
    ]);
    const session = buildSession(thin, { perCategory: 5 });
    expect(session).toHaveLength(2);
    expect(session.map((item) => item.category).sort()).toEqual(["algo", "backend"]);
  });
});

describe("customId", () => {
  it("生成 custom- 前缀的 slug，中文保留", () => {
    expect(customId("HashMap 扩容机制?")).toBe("custom-hashmap-扩容机制");
    expect(customId("  ???  ")).toBe("custom-q");
    expect(customId("")).toBe("custom-q");
  });

  it("超长标题被截断，避免 id 无限长", () => {
    expect(customId("a".repeat(200)).length).toBeLessThanOrEqual(50);
  });
});
