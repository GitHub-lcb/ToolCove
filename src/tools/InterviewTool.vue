<script setup>
// 面试刷题 · 桌面版面。
//
// 三块职责，全都不含规则：把筛选条件交给 filterQuestions、把自评交给 rate、把复习队列交给 dueQuestions。
// 题库契约在 interviewBank.js，进度与间隔重复在 interviewProgress.js，导入解析在 interviewImport.js。
//
// 版面为什么长这样：
//  - **左边列表右边详情**：刷题是「扫一批 → 挑一道 → 读完 → 自评 → 下一道」的循环，
//    列表要一直留在视野里，否则每答完一题就丢失了「还剩多少」的手感；
//  - **答案默认折起来**：先自己答一遍再看，是这个工具存在的唯一理由。折起来这件事
//    必须由界面强制，不能靠自觉；
//  - **自评只有四档、没有输入框**：掌握度和下次复习时间都由自评推出来（见 interviewProgress），
//    让用户填数字只会让他不填；
//  - **出处挂在题解末尾而不是开头**：先看答案再看「哪来的」，顺序反了会变成在读别人的仓库目录。
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import MarkdownRender from "./MarkdownRender.vue";
import { openUrl } from "../platform/shell.js";
import { loadToolbox, saveToolboxNow } from "../toolboxStore.js";
import {
  bankStats,
  buildSession,
  BUILTIN_QUESTIONS,
  CATEGORIES,
  DIFFICULTIES,
  filterQuestions,
  mergeBank,
  sourceLinks,
  topicsOf,
} from "./interviewBank.js";
import { exportBankJson, parseBank } from "./interviewImport.js";
import {
  advanceSession,
  createSave,
  dueQuestions,
  endSession,
  exportProgress,
  isMastered,
  normalizeSave,
  progressStats,
  questionsByIds,
  rate,
  RATINGS,
  recordOf,
  setNote,
  startSession,
  toggleStar,
} from "./interviewProgress.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const STORE_KEY = "interview-save";
const CUSTOM_KEY = "interview-custom";

/** 四个页签：题库是主入口，其余是围绕它的三个动作。 */
const TABS = [
  { key: "bank", labelKey: "toolbox.interview.tab.bank", icon: "list" },
  { key: "review", labelKey: "toolbox.interview.tab.review", icon: "refresh" },
  { key: "session", labelKey: "toolbox.interview.tab.session", icon: "target" },
  { key: "manage", labelKey: "toolbox.interview.tab.manage", icon: "upload" },
];

const STATUSES = [
  { key: "all", labelKey: "toolbox.interview.status.all" },
  { key: "todo", labelKey: "toolbox.interview.status.todo" },
  { key: "done", labelKey: "toolbox.interview.status.done" },
  { key: "starred", labelKey: "toolbox.interview.status.starred" },
];

const save = ref(createSave());
const custom = ref([]);
const tab = ref("bank");
const query = ref("");
const category = ref("");
const difficulty = ref(0);
const topic = ref("");
const status = ref("all");
const currentId = ref("");
const revealed = ref(false);
const noteDraft = ref("");
const perCategory = ref(3);
const importText = ref("");
const importCategory = ref("");
const importTopic = ref("");
const importError = ref("");

const bank = computed(() => mergeBank(BUILTIN_QUESTIONS, custom.value));
const stats = computed(() => progressStats(bank.value, save.value));
const catalog = computed(() => bankStats(bank.value));
const dueList = computed(() => dueQuestions(bank.value, save.value));
const sessionList = computed(() => questionsByIds(bank.value, save.value.session?.ids ?? []));

const filtered = computed(() =>
  filterQuestions(bank.value, {
    query: query.value,
    category: category.value,
    difficulty: difficulty.value,
    topic: topic.value,
    status: status.value,
    starred: new Set(save.value.starred),
    records: save.value.records,
  }),
);

/** 题库页签的可见列表：模拟面试进行中就让位给会话列表，避免两套「当前题」打架。 */
const visible = computed(() => (tab.value === "review" ? dueList.value : tab.value === "session" ? sessionList.value : filtered.value));

/**
 * 当前题。
 *
 * 三种模式各有各的「当前」：
 *  - 模拟面试：由会话指针决定（save.session.index）。**不能**回退到列表第一道——
 *    那样自评推进指针后题干仍然停在第 1 道（E2E 抓到的真实缺陷：进度写着「第 2 / 4 道」，
 *    题目却还是第一道）；
 *  - 复习 / 题库：显式选中优先，没有选中或选中的题被筛掉时回退到第一道。
 *    首屏（以及 SSR）没有任何选中项，所以这个回退必须在这里做，而不是只在 onMounted 里做。
 */
const current = computed(() => {
  const list = visible.value;
  if (!list.length) return null;
  if (tab.value === "session") return list[Math.min(save.value.session?.index ?? 0, list.length - 1)] ?? null;
  return list.find((item) => item.id === currentId.value) ?? list[0];
});

/** 生效中的题目 id：列表高亮、笔记绑定与「换题收起答案」都以它为准，不直接读 currentId。 */
const activeId = computed(() => current.value?.id ?? "");
const currentRecord = computed(() => recordOf(save.value, activeId.value));
const currentLinks = computed(() => (current.value ? sourceLinks(current.value) : []));
const topics = computed(() => topicsOf(bank.value, category.value));
const sessionDone = computed(() => Boolean(save.value.session) && save.value.session.index >= save.value.session.ids.length);
const starredSet = computed(() => new Set(save.value.starred));

const emptyKey = computed(() => {
  if (tab.value === "review") return "reviewEmpty";
  if (tab.value === "session") return save.value.session ? "sessionEmpty" : "sessionIdle";
  return "listEmpty";
});

onMounted(async () => {
  save.value = normalizeSave(await loadToolbox(STORE_KEY, null));
  const loadedCustom = await loadToolbox(CUSTOM_KEY, null);
  custom.value = Array.isArray(loadedCustom) ? loadedCustom : [];
  pickFirst();
});

/** 每次筛选条件变化都重选第一道：否则会出现「列表里没有它、详情还开着」的错位。 */
watch([filtered, tab], () => pickFirst());

/** 换题必须收起答案——这是本工具唯一不能妥协的一条。 */
watch(activeId, (id) => {
  revealed.value = false;
  noteDraft.value = id ? save.value.notes[id] ?? "" : "";
});

/**
 * 让选中项始终落在可见列表里：否则会出现「列表里没有它、详情还开着」的错位。
 * 模拟面试模式下不动 currentId——那里的「当前」由会话指针决定（见 current），
 * 在这里改它只会制造两套互相打架的当前题。
 */
function pickFirst() {
  if (tab.value === "session") return;
  const list = visible.value;
  if (!list.length) {
    currentId.value = "";
    return;
  }
  if (!list.some((item) => item.id === currentId.value)) currentId.value = list[0].id;
}

function persist() {
  saveToolboxNow(STORE_KEY, save.value).then((res) => {
    if (res && res.ok === false) props.showToast(t("toolbox.interview.saveFailed"));
  });
}

function pick(id) {
  currentId.value = id;
}

function toggleReveal() {
  revealed.value = !revealed.value;
}

function onRate(ratingKey) {
  if (!current.value) return;
  const outcome = rate(save.value, current.value.id, ratingKey);
  save.value = outcome.save;
  persist();
  // 模拟面试里自评完自动走下一题：面试节奏不该被「点下一步」打断
  if (tab.value === "session" && !sessionDone.value) {
    save.value = advanceSession(save.value).save;
    persist();
    return;
  }
  // 题库/复习模式不自动跳：用户可能想顺手记一笔笔记
}

function onStar() {
  if (!current.value) return;
  save.value = toggleStar(save.value, current.value.id);
  persist();
}

function onNote() {
  if (!current.value) return;
  save.value = setNote(save.value, current.value.id, noteDraft.value);
  persist();
}

function newSession() {
  const ids = buildSession(bank.value, { perCategory: perCategory.value }).map((item) => item.id);
  if (!ids.length) return;
  save.value = startSession(save.value, ids);
  persist();
  tab.value = "session";
  // 会话里的当前题由指针决定（起点即 0），这里只把答案收起来，不动 currentId
  revealed.value = false;
}

function quitSession() {
  save.value = endSession(save.value);
  persist();
}

function skipSession() {
  if (!save.value.session || sessionDone.value) return;
  save.value = advanceSession(save.value).save;
  persist();
}

function resetProgress() {
  save.value = createSave();
  persist();
  props.showToast(t("toolbox.interview.progressReset"));
}

/** 导入：解析成功就并进导入题库（同 id 覆盖），失败把原因显示出来而不是静默吞掉。 */
function runImport() {
  importError.value = "";
  const result = parseBank(importText.value, { category: importCategory.value, topic: importTopic.value });
  if (result.error) {
    importError.value = t(`toolbox.interview.import.error.${result.error}`, { detail: result.stats?.detail ?? "" });
    return;
  }
  custom.value = mergeBank(custom.value, result.questions);
  saveToolboxNow(CUSTOM_KEY, custom.value).then((res) => {
    if (res && res.ok === false) props.showToast(t("toolbox.interview.saveFailed"));
  });
  importText.value = "";
  props.showToast(t("toolbox.interview.import.ok", { n: result.questions.length }));
}

function clearCustom() {
  custom.value = [];
  saveToolboxNow(CUSTOM_KEY, []).then(() => props.showToast(t("toolbox.interview.import.cleared")));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    props.showToast(t("toolbox.interview.copied"));
  } catch (error) {
    props.showToast(String(error));
  }
}

function openLink(url) {
  openUrl(url).catch((error) => props.showToast(String(error)));
}

function categoryName(key) {
  return t(CATEGORIES.find((item) => item.key === key)?.labelKey ?? key);
}

function recordStars(id) {
  return Math.min(3, recordOf(save.value, id).mastery);
}
</script>

<template>
  <div class="itv-tool">
    <header class="itv-head">
      <div class="head-line">
        <div class="head-title">
          <Icon name="book-open" :size="18" />
          <b>{{ t("toolbox.interview.title") }}</b>
          <span>{{ t("toolbox.interview.subtitle") }}</span>
        </div>
        <div class="head-stats" data-role="stats">
          <span><b>{{ stats.mastered }}</b> / {{ stats.total }} {{ t("toolbox.interview.statMastered") }}</span>
          <span class="pct" data-role="pct">{{ stats.pct }}%</span>
          <span v-if="stats.due" class="due" data-role="due-badge">
            <Icon name="refresh" :size="13" />{{ t("toolbox.interview.statDue", { n: stats.due }) }}
          </span>
        </div>
      </div>

      <div class="head-bar">
        <div class="tabs" role="tablist">
          <button
            v-for="item in TABS"
            :key="item.key"
            type="button"
            class="tab"
            :class="{ on: tab === item.key }"
            :data-role="`tab-${item.key}`"
            @click="tab = item.key"
          >
            <Icon :name="item.icon" :size="14" />{{ t(item.labelKey) }}
            <small v-if="item.key === 'review' && stats.due">{{ stats.due }}</small>
            <small v-else-if="item.key === 'session' && save.session">{{ sessionList.length }}</small>
          </button>
        </div>
        <div class="progress-track" :aria-label="t('toolbox.interview.statMastered')">
          <b class="progress-fill" :style="{ width: Math.min(100, stats.pct) + '%' }" />
        </div>
      </div>

      <div v-if="tab === 'bank'" class="filters">
        <label class="field grow">
          <Icon name="search" :size="14" />
          <input v-model="query" type="search" :placeholder="t('toolbox.interview.searchPlaceholder')" data-role="search" />
        </label>
        <label class="field">
          <select v-model="category" data-role="filter-category">
            <option value="">{{ t("toolbox.interview.allCategories") }}</option>
            <option v-for="item in CATEGORIES" :key="item.key" :value="item.key">{{ t(item.labelKey) }}</option>
          </select>
        </label>
        <label class="field">
          <select v-model="topic" data-role="filter-topic">
            <option value="">{{ t("toolbox.interview.allTopics") }}</option>
            <option v-for="item in topics" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <div class="seg" data-role="filter-status">
          <button v-for="item in STATUSES" :key="item.key" type="button" :class="{ on: status === item.key }" @click="status = item.key">
            {{ t(item.labelKey) }}
          </button>
        </div>
        <div class="seg" data-role="filter-difficulty">
          <button type="button" :class="{ on: difficulty === 0 }" @click="difficulty = 0">{{ t("toolbox.interview.allDifficulty") }}</button>
          <button v-for="item in DIFFICULTIES" :key="item.level" type="button" :class="{ on: difficulty === item.level }" @click="difficulty = item.level">
            {{ t(item.labelKey) }}
          </button>
        </div>
        <span class="count" data-role="filter-count">{{ t("toolbox.interview.resultCount", { n: filtered.length }) }}</span>
      </div>
    </header>

    <main class="itv-main">
      <!-- ── 题库 ─────────────────────────────────────────────── -->
      <template v-if="tab === 'bank'">
        <ul class="qlist" data-role="question-list">
          <li v-for="item in filtered" :key="item.id">
            <button type="button" class="qitem" :class="{ on: item.id === activeId, done: isMastered(save, item.id) }" :data-role="`q-${item.id}`" :data-mastery="recordStars(item.id)" @click="pick(item.id)">
              <span class="qline">
                <i class="diff" :class="`d${item.difficulty}`" :title="t(`toolbox.interview.difficulty.${item.difficulty}`)">{{ item.difficulty }}</i>
                <b>{{ item.question }}</b>
              </span>
              <span class="qmeta">
                <span class="cat">{{ categoryName(item.category) }}</span>
                <span v-if="item.topic" class="topic">{{ item.topic }}</span>
                <span v-if="item.custom" class="custom">{{ t("toolbox.interview.importedTag") }}</span>
                <span class="mast" :title="t('toolbox.interview.mastery')">{{ "●".repeat(recordStars(item.id)) }}{{ "○".repeat(3 - recordStars(item.id)) }}</span>
                <Icon v-if="starredSet.has(item.id)" name="star" :size="12" class="starred" />
              </span>
            </button>
          </li>
          <li v-if="!filtered.length" class="empty" data-role="list-empty">{{ t(`toolbox.interview.empty.${emptyKey}`) }}</li>
        </ul>

        <section class="detail" data-role="detail">
          <article v-if="current" class="card">
            <div class="dhead">
              <div class="dmeta">
                <i class="diff" :class="`d${current.difficulty}`">{{ t(`toolbox.interview.difficulty.${current.difficulty}`) }}</i>
                <span class="cat">{{ categoryName(current.category) }}</span>
                <span v-if="current.topic" class="topic">{{ current.topic }}</span>
              </div>
              <div class="dactions">
                <button type="button" class="btn-ghost sm" data-role="star" :title="t('toolbox.interview.starTip')" @click="onStar">
                  <Icon name="star" :size="14" />{{ starredSet.has(current.id) ? t("toolbox.interview.starred") : t("toolbox.interview.star") }}
                </button>
                <button type="button" class="btn-ghost sm" data-role="copy" @click="copyText(current.question + '\n\n' + current.answer)">
                  <Icon name="copy" :size="14" />{{ t("toolbox.interview.copy") }}
                </button>
              </div>
            </div>

            <h2 class="question" data-role="question">{{ current.question }}</h2>

            <div v-if="current.tags.length" class="tags">
              <span v-for="tag in current.tags" :key="tag" class="tag">{{ tag }}</span>
            </div>

            <div class="reveal-bar">
              <button class="btn-primary" type="button" data-role="reveal" @click="toggleReveal">
                <Icon :name="revealed ? 'eye-off' : 'eye'" :size="14" />
                {{ revealed ? t("toolbox.interview.hideAnswer") : t("toolbox.interview.showAnswer") }}
              </button>
              <span v-if="!revealed" class="reveal-tip">{{ t("toolbox.interview.revealTip") }}</span>
              <span v-else class="reveal-tip dim">{{ t("toolbox.interview.lastReview", { n: currentRecord.reviews }) }}</span>
            </div>

            <div v-if="revealed" class="answer" data-role="answer">
              <MarkdownRender :text="current.answer" :show-toast="props.showToast" />
            </div>

            <div v-if="revealed && current.points.length" class="points" data-role="points">
              <b>{{ t("toolbox.interview.pointsTitle") }}</b>
              <ul>
                <li v-for="point in current.points" :key="point">{{ point }}</li>
              </ul>
            </div>

            <p v-if="revealed && current.follow" class="follow" data-role="follow">
              <b>{{ t("toolbox.interview.followTitle") }}</b>{{ " " }}{{ current.follow }}
            </p>

            <div v-if="revealed" class="sources" data-role="sources">
              <b>{{ t("toolbox.interview.sourcesTitle") }}</b>
              <p class="sources-note">{{ t("toolbox.interview.sourcesNote") }}</p>
              <ul>
                <li v-for="link in currentLinks" :key="link.repo">
                  <!-- 白名单内的仓库给可点开的深链；导入/抓取产物引用的仓库只显示署名行（无链接），
                       但**照样显示**——出处是署名，不能因为「没登记过」就不显示。 -->
                  <button v-if="link.url" type="button" class="src" @click="openLink(link.url)">
                    <Icon name="link" :size="13" />
                    <span class="src-name">{{ link.name }}</span>
                    <span class="src-path">{{ link.path || "/" }}</span>
                    <span class="src-stars">★ {{ link.stars }}</span>
                    <span v-if="link.license" class="src-license">{{ link.license }}</span>
                  </button>
                  <span v-else class="src src-plain">
                    <Icon name="link" :size="13" />
                    <span class="src-name">{{ link.name }}</span>
                    <span class="src-path">{{ link.path || "/" }}</span>
                    <span class="src-license">{{ t("toolbox.interview.sourcesExternal") }}</span>
                  </span>
                </li>
                <li v-if="!currentLinks.length" class="src-none">{{ t("toolbox.interview.sourcesNone") }}</li>
              </ul>
            </div>

            <div class="rate-block" data-role="rate">
              <b>{{ t("toolbox.interview.rateTitle") }}</b>
              <div class="rate-row">
                <button v-for="item in RATINGS" :key="item.key" type="button" class="rate" :class="[`r-${item.key}`, { on: currentRecord.rating === item.key }]" :data-role="`rate-${item.key}`" @click="onRate(item.key)">
                  {{ t(item.labelKey) }}
                </button>
              </div>
              <p class="rate-hint">{{ t("toolbox.interview.rateHint") }}</p>
            </div>

            <div class="note">
              <label :for="`note-${current.id}`">{{ t("toolbox.interview.noteTitle") }}</label>
              <textarea :id="`note-${current.id}`" v-model="noteDraft" rows="2" :placeholder="t('toolbox.interview.notePlaceholder')" data-role="note" @change="onNote" @blur="onNote" />
            </div>
          </article>
          <p v-else class="empty" data-role="detail-empty">{{ t(`toolbox.interview.empty.${emptyKey}`) }}</p>
        </section>
      </template>

      <!-- ── 复习 ─────────────────────────────────────────────── -->
      <template v-else-if="tab === 'review'">
        <!-- 队列空时整块换成一句说明：保留左右两栏会渲染出**两遍**同一句空态（截图里一眼看得出来） -->
        <p v-if="!dueList.length" class="empty empty-wide" data-role="review-empty">{{ t("toolbox.interview.empty.reviewEmpty") }}</p>
        <template v-else>
          <ul class="qlist" data-role="review-list">
            <li v-for="item in dueList" :key="item.id">
              <button type="button" class="qitem" :class="{ on: item.id === activeId }" @click="pick(item.id)">
                <span class="qline">
                  <i class="diff" :class="`d${item.difficulty}`">{{ item.difficulty }}</i>
                  <b>{{ item.question }}</b>
                </span>
                <span class="qmeta">
                  <span class="cat">{{ categoryName(item.category) }}</span>
                  <span class="mast">{{ "●".repeat(recordStars(item.id)) }}{{ "○".repeat(3 - recordStars(item.id)) }}</span>
                </span>
              </button>
            </li>
          </ul>
          <section class="detail" data-role="review-detail">
            <article v-if="current" class="card">
              <div class="dhead">
                <div class="dmeta">
                  <i class="diff" :class="`d${current.difficulty}`">{{ t(`toolbox.interview.difficulty.${current.difficulty}`) }}</i>
                  <span class="cat">{{ categoryName(current.category) }}</span>
                  <span v-if="current.topic" class="topic">{{ current.topic }}</span>
                </div>
              </div>
              <h2 class="question" data-role="review-question">{{ current.question }}</h2>
              <div class="reveal-bar">
                <button class="btn-primary" type="button" data-role="review-reveal" @click="toggleReveal">
                  {{ revealed ? t("toolbox.interview.hideAnswer") : t("toolbox.interview.showAnswer") }}
                </button>
              </div>
              <div v-if="revealed" class="answer" data-role="review-answer"><MarkdownRender :text="current.answer" :show-toast="props.showToast" /></div>
              <div v-if="revealed" class="rate-block" data-role="review-rate">
                <b>{{ t("toolbox.interview.rateTitle") }}</b>
                <div class="rate-row">
                  <button v-for="item in RATINGS" :key="item.key" type="button" class="rate" :class="`r-${item.key}`" @click="onRate(item.key)">
                    {{ t(item.labelKey) }}
                  </button>
                </div>
              </div>
            </article>
          </section>
        </template>
      </template>

      <!-- ── 模拟面试 ─────────────────────────────────────────── -->
      <template v-else-if="tab === 'session'">
        <section class="session" data-role="session">
          <div v-if="!save.session" class="setup">
            <h3>{{ t("toolbox.interview.session.setupTitle") }}</h3>
            <p class="setup-note">{{ t("toolbox.interview.session.setupNote") }}</p>
            <label class="field">
              <span>{{ t("toolbox.interview.session.perCategory") }}</span>
              <input v-model.number="perCategory" type="number" min="1" max="20" data-role="per-category" />
            </label>
            <p class="setup-total">{{ t("toolbox.interview.session.total", { n: perCategory * 4 }) }}</p>
            <button class="btn-primary" type="button" data-role="start-session" @click="newSession">{{ t("toolbox.interview.session.start") }}</button>
          </div>

          <template v-else>
            <div class="session-bar">
              <span class="session-progress" data-role="session-progress">
                {{ t("toolbox.interview.session.progress", { done: Math.min(save.session.index + 1, sessionList.length), total: sessionList.length }) }}
              </span>
              <button class="btn-ghost sm" type="button" data-role="session-skip" @click="skipSession">{{ t("toolbox.interview.session.skip") }}</button>
              <button class="btn-ghost sm" type="button" data-role="session-quit" @click="quitSession">{{ t("toolbox.interview.session.quit") }}</button>
            </div>

            <article v-if="current && !sessionDone" class="card" data-role="session-card">
              <div class="dmeta">
                <i class="diff" :class="`d${current.difficulty}`">{{ t(`toolbox.interview.difficulty.${current.difficulty}`) }}</i>
                <span class="cat">{{ categoryName(current.category) }}</span>
                <span v-if="current.topic" class="topic">{{ current.topic }}</span>
              </div>
              <h2 class="question" data-role="session-question">{{ current.question }}</h2>
              <div class="reveal-bar">
                <button class="btn-primary" type="button" data-role="session-reveal" @click="toggleReveal">
                  {{ revealed ? t("toolbox.interview.hideAnswer") : t("toolbox.interview.showAnswer") }}
                </button>
                <span class="reveal-tip">{{ t("toolbox.interview.session.answerTip") }}</span>
              </div>
              <div v-if="revealed" class="answer" data-role="session-answer"><MarkdownRender :text="current.answer" :show-toast="props.showToast" /></div>
              <div v-if="revealed && current.points.length" class="points">
                <b>{{ t("toolbox.interview.pointsTitle") }}</b>
                <ul>
                  <li v-for="point in current.points" :key="point">{{ point }}</li>
                </ul>
              </div>
              <div v-if="revealed" class="rate-block" data-role="session-rate">
                <b>{{ t("toolbox.interview.rateTitle") }}</b>
                <div class="rate-row">
                  <button v-for="item in RATINGS" :key="item.key" type="button" class="rate" :class="`r-${item.key}`" :data-role="`session-rate-${item.key}`" @click="onRate(item.key)">
                    {{ t(item.labelKey) }}
                  </button>
                </div>
                <p class="rate-hint">{{ t("toolbox.interview.session.autoNext") }}</p>
              </div>
            </article>

            <div v-else class="session-done" data-role="session-done">
              <h3>{{ t("toolbox.interview.session.doneTitle") }}</h3>
              <p>{{ t("toolbox.interview.session.doneNote", { n: sessionList.length }) }}</p>
              <div class="ops">
                <button class="btn-primary" type="button" data-role="session-again" @click="newSession">{{ t("toolbox.interview.session.again") }}</button>
                <button class="btn-ghost" type="button" @click="quitSession">{{ t("toolbox.interview.session.quit") }}</button>
              </div>
            </div>
          </template>
        </section>
      </template>

      <!-- ── 导入与设置 ───────────────────────────────────────── -->
      <template v-else>
        <section class="manage">
          <div class="card">
            <h3>{{ t("toolbox.interview.import.title") }}</h3>
            <p class="setup-note">{{ t("toolbox.interview.import.note") }}</p>
            <div class="import-row">
              <label class="field">
                <span>{{ t("toolbox.interview.import.category") }}</span>
                <select v-model="importCategory" data-role="import-category">
                  <!-- 空值 = 让文件头的 `> 方向:` 决定。没有这一项时下拉永远给得出方向，
                       「文件没写方向」这条错误就永远不可能出现，用户也就不知道有这个约定。 -->
                  <option value="">{{ t("toolbox.interview.import.categoryFromFile") }}</option>
                  <option v-for="item in CATEGORIES" :key="item.key" :value="item.key">{{ t(item.labelKey) }}</option>
                </select>
              </label>
              <label class="field grow">
                <span>{{ t("toolbox.interview.import.topic") }}</span>
                <input v-model="importTopic" type="text" :placeholder="t('toolbox.interview.import.topicPlaceholder')" data-role="import-topic" />
              </label>
            </div>
            <textarea v-model="importText" rows="8" :placeholder="t('toolbox.interview.import.placeholder')" data-role="import-text" />
            <div class="ops">
              <button class="btn-primary" type="button" data-role="import-run" @click="runImport">{{ t("toolbox.interview.import.run") }}</button>
              <button class="btn-ghost" type="button" data-role="import-export" @click="copyText(exportBankJson(bank))">{{ t("toolbox.interview.import.exportBank") }}</button>
              <button class="btn-ghost" type="button" data-role="import-clear" :disabled="!custom.length" @click="clearCustom">
                {{ t("toolbox.interview.import.clear", { n: custom.length }) }}
              </button>
            </div>
            <p v-if="importError" class="import-error" data-role="import-error">{{ importError }}</p>
            <p v-else-if="custom.length" class="import-ok" data-role="import-count">{{ t("toolbox.interview.import.customCount", { n: custom.length }) }}</p>
          </div>

          <div class="card">
            <h3>{{ t("toolbox.interview.about.title") }}</h3>
            <p class="setup-note">{{ t("toolbox.interview.about.note") }}</p>
            <dl class="catalog" data-role="catalog">
              <div v-for="item in CATEGORIES" :key="item.key">
                <dt>{{ t(item.labelKey) }}</dt>
                <dd>{{ catalog.byCategory[item.key] }} {{ t("toolbox.interview.about.questions") }}</dd>
                <dd class="dim">{{ stats.byCategory[item.key].mastered }} {{ t("toolbox.interview.statMastered") }}</dd>
              </div>
            </dl>
            <div class="ops">
              <button class="btn-ghost" type="button" data-role="export-progress" @click="copyText(exportProgress(bank, save))">{{ t("toolbox.interview.about.exportProgress") }}</button>
              <button class="btn-ghost" type="button" data-role="reset-progress" @click="resetProgress">{{ t("toolbox.interview.about.resetProgress") }}</button>
            </div>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.itv-tool { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.itv-head { flex-shrink: 0; display: flex; flex-direction: column; gap: var(--sp-3); padding-bottom: var(--sp-3); border-bottom: 1px solid var(--border); }
.head-line { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
.head-title { display: flex; align-items: center; gap: var(--sp-2); color: var(--primary-hover); }
.head-title b { color: var(--text); font-size: var(--fs-lg); }
.head-title span { color: var(--muted); font-size: var(--fs-sm); }
.head-stats { display: flex; align-items: center; gap: var(--sp-3); color: var(--muted); font-size: var(--fs-sm); }
.head-stats b { color: var(--text); font-family: var(--font-num); font-size: var(--fs-md); }
.pct { color: var(--primary-hover); font-family: var(--font-num); font-weight: 600; }
.due { display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px; border-radius: var(--r-pill); background: var(--amber-soft); color: var(--amber); font-size: var(--fs-xs); }

.head-bar { display: flex; align-items: center; gap: var(--sp-4); }
.tabs { display: flex; gap: var(--sp-1); }
.tab { display: inline-flex; align-items: center; gap: 5px; padding: 5px var(--sp-3); border: 1px solid transparent; border-radius: var(--r-md); background: transparent; color: var(--text-weak); font-size: var(--fs-sm); cursor: pointer; }
.tab:hover { background: var(--well); }
.tab.on { border-color: var(--primary); background: var(--primary-soft); color: var(--primary-hover); font-weight: 600; }
.tab small { padding: 0 5px; border-radius: var(--r-pill); background: var(--well); color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.tab.on small { background: var(--primary); color: #fff; }
.progress-track { flex: 1; min-width: 80px; height: 6px; border-radius: var(--r-pill); background: var(--well); overflow: hidden; }
.progress-fill { display: block; height: 100%; background: var(--primary); transition: width .25s ease; }

.filters { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.field { display: inline-flex; align-items: center; gap: var(--sp-2); padding: 4px var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--well); color: var(--muted); font-size: var(--fs-sm); }
.field.grow { flex: 1; min-width: 160px; }
.field input, .field select { flex: 1; min-width: 0; border: none; background: transparent; color: var(--text); font-size: var(--fs-sm); outline: none; }
.field span { color: var(--muted); font-size: var(--fs-xs); white-space: nowrap; }
.seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--r-sm); overflow: hidden; }
.seg button { padding: 5px var(--sp-3); border: none; background: var(--card); color: var(--text-weak); font-size: var(--fs-sm); cursor: pointer; }
.seg button + button { border-left: 1px solid var(--border); }
.seg button.on { background: var(--primary-soft); color: var(--primary-hover); font-weight: 600; }
.count { margin-left: auto; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-sm); }

.itv-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(260px, 34%) minmax(0, 1fr); gap: var(--sp-4); overflow: hidden; }

.qlist { margin: 0; padding: 0 var(--sp-1) 0 0; list-style: none; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-1); }
.qitem { width: 100%; display: flex; flex-direction: column; gap: 4px; padding: var(--sp-2) var(--sp-3); border: 1px solid transparent; border-left: 3px solid var(--border-strong); border-radius: 0 var(--r-sm) var(--r-sm) 0; background: var(--card); color: var(--text); text-align: left; cursor: pointer; }
.qitem:hover { border-left-color: var(--border-blue); background: var(--well); }
.qitem.on { border-left-color: var(--primary); background: var(--primary-soft); }
.qitem.done { border-left-color: var(--success); }
.qitem.done.on { border-left-color: var(--primary); }
.qline { display: flex; align-items: baseline; gap: var(--sp-2); }
.qline b { font-size: var(--fs-sm); font-weight: 500; line-height: 1.5; }
.qmeta { display: flex; align-items: center; gap: var(--sp-2); color: var(--muted); font-size: var(--fs-xs); flex-wrap: wrap; }
.cat { color: var(--primary-hover); }
.topic { padding: 0 5px; border-radius: var(--r-xs); background: var(--well); }
.custom { padding: 0 5px; border-radius: var(--r-xs); background: var(--amber-soft); color: var(--amber); }
.mast { font-family: var(--font-num); letter-spacing: 1px; }
.starred { color: var(--amber); }
.diff { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; border-radius: var(--r-xs); font-family: var(--font-num); font-size: var(--fs-xs); font-style: normal; font-weight: 600; }
.diff.d1 { background: var(--success-soft); color: var(--success-deep); }
.diff.d2 { background: var(--primary-soft); color: var(--primary-hover); }
.diff.d3 { background: var(--amber-soft); color: var(--amber); }
.empty { padding: var(--sp-6); color: var(--muted); text-align: center; font-size: var(--fs-sm); list-style: none; }
/* 整页空态要横跨两栏，否则它会挤在 34% 的列表栏里、右侧空一大片 */
.empty-wide { grid-column: 1 / -1; }

.detail { min-width: 0; overflow: auto; }
.card { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-5); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.dhead { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
.dmeta { display: flex; align-items: center; gap: var(--sp-2); color: var(--muted); font-size: var(--fs-xs); }
.dactions { display: flex; gap: var(--sp-2); }
.question { margin: 0; font-size: var(--fs-xl); line-height: 1.55; }
.tags { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.tag { padding: 1px 8px; border-radius: var(--r-pill); background: var(--well); color: var(--text-weak); font-size: var(--fs-xs); }

.reveal-bar { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
.reveal-tip { color: var(--muted); font-size: var(--fs-sm); }
.reveal-tip.dim { font-family: var(--font-num); }

.answer { padding: var(--sp-4); border-left: 3px solid var(--primary); border-radius: 0 var(--r-sm) var(--r-sm) 0; background: var(--well); line-height: 1.75; overflow-x: auto; }
.points { padding: var(--sp-3) var(--sp-4); border: 1px dashed var(--border-blue); border-radius: var(--r-sm); }
.points b { display: block; margin-bottom: var(--sp-2); color: var(--primary-hover); font-size: var(--fs-sm); }
.points ul { margin: 0; padding-left: 1.2em; color: var(--text-weak); line-height: 1.8; }
.follow { margin: 0; color: var(--text-weak); line-height: 1.7; }
.follow b { color: var(--amber); }

.sources b { display: block; color: var(--text-weak); font-size: var(--fs-sm); }
.sources-note { margin: var(--sp-1) 0 var(--sp-2); color: var(--muted); font-size: var(--fs-xs); line-height: 1.6; }
.sources ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-1); }
.src { width: 100%; display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--card); color: var(--text-weak); font-size: var(--fs-sm); text-align: left; cursor: pointer; }
.src:hover { border-color: var(--border-blue); color: var(--primary-hover); }
/* 白名单外的出处：只署名，不给链接（所以不加 hover 反馈，避免看起来能点） */
.src-plain { cursor: default; color: var(--muted); }
.src-plain:hover { border-color: var(--border-strong); color: var(--muted); }
.src-name { font-weight: 600; }
.src-path { flex: 1; min-width: 0; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.src-stars { color: var(--amber); font-family: var(--font-num); font-size: var(--fs-xs); }
.src-license { color: var(--muted); font-size: var(--fs-xs); }
.src-none { color: var(--muted); font-size: var(--fs-sm); }

.rate-block { display: flex; flex-direction: column; gap: var(--sp-2); padding-top: var(--sp-3); border-top: 1px solid var(--border); }
.rate-block b { font-size: var(--fs-sm); color: var(--text-weak); }
.rate-row { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.rate { padding: 6px var(--sp-4); border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--well); color: var(--text-weak); font-size: var(--fs-sm); cursor: pointer; }
.rate:hover { border-color: var(--border-blue); }
.rate.r-again.on, .rate.r-again:hover { border-color: var(--border-danger); background: var(--danger-soft); color: var(--danger-deep); }
.rate.r-fuzzy.on, .rate.r-fuzzy:hover { border-color: var(--amber); background: var(--amber-soft); color: var(--amber); }
.rate.r-good.on, .rate.r-good:hover { border-color: var(--success); background: var(--success-soft); color: var(--success-deep); }
.rate.r-easy.on, .rate.r-easy:hover { border-color: var(--primary); background: var(--primary-soft); color: var(--primary-hover); }
.rate.on { font-weight: 600; }
.rate-hint { margin: 0; color: var(--muted); font-size: var(--fs-xs); }

.note { display: flex; flex-direction: column; gap: var(--sp-1); }
.note label { color: var(--text-weak); font-size: var(--fs-sm); }
.note textarea { padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--well); color: var(--text); font-family: inherit; font-size: var(--fs-sm); line-height: 1.6; resize: vertical; }

.session, .manage { display: flex; flex-direction: column; gap: var(--sp-4); overflow: auto; }
/* 会话与管理页是「一屏一件事」，必须**横跨主区的两栏**：
   .itv-main 是 [列表 34% | 详情] 的两栏 grid，单栏放一张卡会被挤成窄条、右侧留一大片空白。
   题库/复习页不跨栏——它们本来就要用满这两栏（左列表右详情）。 */
.session, .manage { grid-column: 1 / -1; }
.session { display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; }
.manage { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); align-content: start; align-items: start; }
.setup, .session-done { display: flex; flex-direction: column; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-6); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.setup h3, .session-done h3 { margin: 0; font-size: var(--fs-lg); }
.setup-note { margin: 0; color: var(--text-weak); font-size: var(--fs-sm); line-height: 1.7; }
.setup .field { align-self: flex-start; }
.setup .field input { width: 70px; }
.setup-total { margin: 0; color: var(--muted); font-size: var(--fs-sm); }
.session-bar { display: flex; align-items: center; gap: var(--sp-3); }
.session-progress { color: var(--text-weak); font-family: var(--font-num); font-size: var(--fs-sm); }
.session-bar .btn-ghost:last-child { margin-left: auto; }
.ops { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }

.import-row { display: flex; gap: var(--sp-3); flex-wrap: wrap; }
.import-row .field { flex: 1; min-width: 150px; }
.manage textarea { width: 100%; padding: var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--well); color: var(--text); font-family: var(--font-num); font-size: var(--fs-sm); line-height: 1.6; resize: vertical; }
.import-error { margin: 0; padding: var(--sp-3); border-radius: var(--r-sm); background: var(--danger-soft); color: var(--danger-deep); font-size: var(--fs-sm); }
.import-ok { margin: 0; color: var(--success-deep); font-size: var(--fs-sm); }
.catalog { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-3); margin: 0; }
.catalog div { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3); border-radius: var(--r-sm); background: var(--well); }
.catalog dt { color: var(--primary-hover); font-size: var(--fs-sm); font-weight: 600; }
.catalog dd { margin: 0; font-family: var(--font-num); font-size: var(--fs-sm); }
.catalog dd.dim { color: var(--muted); font-size: var(--fs-xs); }

@media (max-width: 900px) {
  .itv-main { grid-template-columns: 1fr; grid-template-rows: minmax(140px, 40%) minmax(0, 1fr); }
  .count { margin-left: 0; }
  .head-bar { flex-wrap: wrap; }
}
</style>
