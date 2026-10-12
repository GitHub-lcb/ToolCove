// 面试刷题 · 内置题库总装。
//
// 题库按方向 + 子领域拆成多个文件，是为了让每个文件都能单独读懂、单独 review：
// 一个几千行的题库文件没人会读，而「Java 基础」「并发」「MySQL」各自一份就都能看完。
// 这个文件是**唯一**的装配点——新增一个分片只需要在这里加一行 import 与一行展开，
// 别处（界面、检索、进度、测试）一律不用改，它们都只看 BUILTIN_QUESTIONS。
//
// 顺序即界面上的固定顺序：同方向内先放基础/总览，再放专项，最后放语言特性与工程实践。
// 列表顺序稳定很重要——它决定「默认选中第一道」是哪道，也决定复习队列同期到期时的先后。

import { ALGO_QUESTIONS } from "./interviewBankAlgo.js";
import { ALGO_A_QUESTIONS } from "./interviewBankAlgoA.js";
import { ALGO_B_QUESTIONS } from "./interviewBankAlgoB.js";
import { ALGO_C_QUESTIONS } from "./interviewBankAlgoC.js";
import { BACKEND_QUESTIONS } from "./interviewBankBackend.js";
import { BACKEND_BASIS_QUESTIONS } from "./interviewBankBackendBasis.js";
import { BACKEND_COLLECTION_QUESTIONS } from "./interviewBankBackendCollection.js";
import { BACKEND_CONCURRENCY_QUESTIONS } from "./interviewBankBackendConcurrency.js";
import { BACKEND_JVM_QUESTIONS } from "./interviewBankBackendJvm.js";
import { BACKEND_MIDDLEWARE_QUESTIONS } from "./interviewBankBackendMiddleware.js";
import { BACKEND_MYSQL_QUESTIONS } from "./interviewBankBackendMysql.js";
import { FILLER_QUESTIONS } from "./interviewBankFiller.js";
import { FRONTEND_QUESTIONS } from "./interviewBankFrontend.js";
import { FRONTEND_B_QUESTIONS } from "./interviewBankFrontendB.js";
import { FRONTEND_C_QUESTIONS } from "./interviewBankFrontendC.js";
import { SYSTEM_QUESTIONS } from "./interviewBankSystem.js";
import { SYSTEM_B_QUESTIONS } from "./interviewBankSystemB.js";

/** 全部内置题目。id 唯一性由 interviewBank.test.js 钉住，这里不重复校验。 */
export const BUILTIN_QUESTIONS = Object.freeze([
  // ── 后端 / Java ──────────────────────────────────────────────
  ...BACKEND_QUESTIONS,
  ...BACKEND_BASIS_QUESTIONS,
  ...BACKEND_JVM_QUESTIONS,
  ...BACKEND_CONCURRENCY_QUESTIONS,
  ...BACKEND_COLLECTION_QUESTIONS,
  ...BACKEND_MYSQL_QUESTIONS,
  ...BACKEND_MIDDLEWARE_QUESTIONS,
  // ── 算法与数据结构 ───────────────────────────────────────────
  ...ALGO_QUESTIONS,
  ...ALGO_A_QUESTIONS,
  ...ALGO_B_QUESTIONS,
  ...ALGO_C_QUESTIONS,
  // ── 系统设计 ─────────────────────────────────────────────────
  ...SYSTEM_QUESTIONS,
  ...SYSTEM_B_QUESTIONS,
  // ── 前端 / 浏览器 ────────────────────────────────────────────
  ...FRONTEND_QUESTIONS,
  ...FRONTEND_B_QUESTIONS,
  ...FRONTEND_C_QUESTIONS,
  // 薄主题补齐放最后：它按主题散落在各方向里，不属于任何单一分片
  ...FILLER_QUESTIONS,
]);

/**
 * 主题词表（受控词汇）。
 *
 * 为什么要有这张表：主题下拉是从数据里现取的（topicsOf），一旦两个分片给同一个概念起了两个名字
 * （「数组与哈希」vs「数组与矩阵」），下拉里就会出现两个其实同义的选项，筛选形同虚设。
 * 这张表把词表钉住，interviewBank.test.js 断言每道题的 topic 都在表内——
 * 新增题目时若起了新词，测试会红，而不是等用户看到重复选项。
 */
export const TOPICS = Object.freeze({
  backend: Object.freeze([
    "Java 基础",
    "泛型",
    "异常",
    "IO 与 NIO",
    "Java 新特性",
    "JVM",
    "GC",
    "类加载",
    "线上排查",
    "并发",
    "JMM",
    "锁",
    "线程池",
    "虚拟线程",
    "集合",
    "并发容器",
    "Stream 与函数式",
    "MySQL",
    "索引与优化",
    "事务与锁",
    "分库分表",
    "Elasticsearch",
    "Redis",
    "Spring",
    "Spring Cloud",
    "MyBatis",
    "消息队列",
    "分布式",
    "网络",
  ]),
  algo: Object.freeze([
    "数组与矩阵",
    "字符串",
    "链表",
    "栈与队列",
    "二叉树",
    "二分与搜索",
    "排序",
    "动态规划",
    "回溯",
    "贪心",
    "图论",
    "数据结构设计",
    "位运算",
    "数学",
    "海量数据",
    "复杂度分析",
    "编码与工程",
  ]),
  system: Object.freeze([
    "缓存",
    "高并发",
    "存储与分库分表",
    "消息队列",
    "一致性",
    "分布式与一致性",
    "可用性",
    "限流与降级",
    "容量规划",
    "经典设计题",
    "可观测性",
    "数据与存储",
    "运维与发布",
    "安全与权限",
  ]),
  frontend: Object.freeze([
    "JavaScript",
    "JavaScript 进阶",
    "TypeScript",
    "CSS",
    "CSS 布局",
    "浏览器",
    "浏览器与网络",
    "网络与缓存",
    "性能优化",
    "框架原理",
    "工程化",
    "安全",
    "手写代码",
    "场景与协作",
    "可访问性与体验",
  ]),
});

/** 每个方向的合法主题集合，供测试与导入校验使用。 */
export const TOPIC_KEYS = Object.freeze(
  Object.fromEntries(Object.entries(TOPICS).map(([category, list]) => [category, new Set(list)])),
);
