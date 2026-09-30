<script setup>
// 面试刷题（手机端）。
//
// 逻辑一行都不重写：题库契约在 src/tools/interviewBank.js，进度与间隔重复在
// interviewProgress.js，导入解析在 interviewImport.js——与桌面端同一份，
// 所以同一道题在两端的掌握度、复习队列、筛选结果必然一致。
//
// 版面按手机重排：列表是**一屏到底**的单列（点一道题进详情页，而不是左右分栏——
// 手机上左右分栏会把题干挤成三行），答案仍然默认折起来，
// 自评四档做成一行大按钮，拇指够得着。
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { renderMarkdown } from "../../../src/shared.js";
import { loadToolbox, saveToolboxNow } from "../../../src/toolboxStore.js";
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
} from "../../../src/tools/interviewBank.js";
import { parseBank } from "../../../src/tools/interviewImport.js";
import {
  advanceSession,
  createSave,
  dueQuestions,
  endSession,
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
} from "../../../src/tools/interviewProgress.js";

const { t } = useI18n();

const STORE_KEY = "interview-save";
const CUSTOM_KEY = "interview-custom";

const TABS = [
  { key: "bank", labelKey: "toolbox.interview.tab.bank" },
  { key: "review", labelKey: "toolbox.interview.tab.review" },
  { key: "session", labelKey: "toolbox.interview.tab.session" },
  { key: "manage", labelKey: "toolbox.interview.tab.manage" },
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
const openId = ref("");
const revealed = ref(false);
const noteDraft = ref("");
const perCategory = ref(3);
const importText = ref("");
const importCategory = ref("");
const importError = ref("");
const saveNote = ref("");

const bank = computed(() => mergeBank(BUILTIN_QUESTIONS, custom.value));
const stats = computed(() => progressStats(bank.value, save.value));
const catalog = computed(() => bankStats(bank.value));
const dueList = computed(() => dueQuestions(bank.value, save.value));
const sessionList = computed(() => questionsByIds(bank.value, save.value.session?.ids ?? []));
const sessionDone = computed(() => Boolean(save.value.session) && save.value.session.index >= save.value.session.ids.length);

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

/** 详情页是否打开：手机上「列表 / 详情」是两屏，用一个 id 当路由。 */
const open = computed(() => (openId.value ? bank.value.find((item) => item.id === openId.value) ?? null : null));
const openRecord = computed(() => recordOf(save.value, openId.value));
const openLinks = computed(() => (open.value ? sourceLinks(open.value) : []));
const openHtml = computed(() => (open.value ? renderMarkdown(open.value.answer, { highlight: false }) : ""));
const topics = computed(() => topicsOf(bank.value, category.value));
const sessionQuestion = computed(() => sessionList.value[save.value.session?.index ?? 0] ?? null);
const sessionHtml = computed(() => (sessionQuestion.value ? renderMarkdown(sessionQuestion.value.answer, { highlight: false }) : ""));

onMounted(async () => {
  save.value = normalizeSave(await loadToolbox(STORE_KEY, null));
  const loadedCustom = await loadToolbox(CUSTOM_KEY, null);
  custom.value = Array.isArray(loadedCustom) ? loadedCustom : [];
});

/** 换题必须收起答案，与桌面端同一条规矩。 */
watch(openId, () => {
  revealed.value = false;
  noteDraft.value = openId.value ? save.value.notes[openId.value] ?? "" : "";
});

function persist() {
  saveToolboxNow(STORE_KEY, save.value).then((res) => {
    if (res && res.ok === false) saveNote.value = t("toolbox.interview.saveFailed");
  });
}

function pick(id) {
  openId.value = id;
}

function back() {
  openId.value = "";
}

function onRate(ratingKey) {
  const target = open.value ?? sessionQuestion.value;
  if (!target) return;
  save.value = rate(save.value, target.id, ratingKey).save;
  persist();
  if (tab.value === "session" && !sessionDone.value) {
    save.value = advanceSession(save.value).save;
    persist();
  }
}

function onStar() {
  if (!open.value) return;
  save.value = toggleStar(save.value, open.value.id);
  persist();
}

function onNote() {
  if (!open.value) return;
  save.value = setNote(save.value, open.value.id, noteDraft.value);
  persist();
}

function newSession() {
  const ids = buildSession(bank.value, { perCategory: perCategory.value }).map((item) => item.id);
  if (!ids.length) return;
  save.value = startSession(save.value, ids);
  persist();
  tab.value = "session";
}

function skipSession() {
  if (!save.value.session || sessionDone.value) return;
  save.value = advanceSession(save.value).save;
  persist();
}

function quitSession() {
  save.value = endSession(save.value);
  persist();
}

function runImport() {
  importError.value = "";
  const result = parseBank(importText.value, { category: importCategory.value });
  if (result.error) {
    importError.value = t(`toolbox.interview.import.error.${result.error}`, { detail: result.stats?.detail ?? "" });
    return;
  }
  custom.value = mergeBank(custom.value, result.questions);
  saveToolboxNow(CUSTOM_KEY, custom.value).then((res) => {
    if (res && res.ok === false) saveNote.value = t("toolbox.interview.saveFailed");
  });
  importText.value = "";
  saveNote.value = t("toolbox.interview.import.ok", { n: result.questions.length });
}

function clearCustom() {
  custom.value = [];
  saveToolboxNow(CUSTOM_KEY, []).then(() => {
    saveNote.value = t("toolbox.interview.import.cleared");
  });
}

function categoryName(key) {
  return t(CATEGORIES.find((item) => item.key === key)?.labelKey ?? key);
}

function recordStars(id) {
  return Math.min(3, recordOf(save.value, id).mastery);
}

function openLink(url) {
  // 手机上不引 opener 插件：直接走系统浏览器（WebView 里 window.open 会被接管）
  window.open(url, "_blank", "noopener");
}
</script>

<template>
  <section class="m-tool" data-tool="interview">
    <p v-if="saveNote" class="m-ok" data-role="save-note">{{ saveNote }}</p>

    <!-- ── 详情页 ──────────────────────────────────────────── -->
    <template v-if="open">
      <div class="m-card">
        <div class="m-card-head">
          <button class="m-btn" data-role="back" @click="back">← {{ t("toolbox.interview.back") }}</button>
          <button class="m-btn" data-role="star" @click="onStar">
            {{ save.starred.includes(open.id) ? t("toolbox.interview.starred") : t("toolbox.interview.star") }}
          </button>
        </div>
        <div class="m-itv-meta">
          <span class="m-itv-diff" :data-level="open.difficulty">{{ t(`toolbox.interview.difficulty.${open.difficulty}`) }}</span>
          <span>{{ categoryName(open.category) }}</span>
          <span v-if="open.topic">{{ open.topic }}</span>
          <span v-if="open.custom">{{ t("toolbox.interview.importedTag") }}</span>
        </div>
        <h3 class="m-itv-question" data-role="question">{{ open.question }}</h3>
        <div v-if="open.tags.length" class="m-chips">
          <span v-for="tag in open.tags" :key="tag" class="m-badge">{{ tag }}</span>
        </div>
        <p class="m-hint-sm" data-role="mastery">
          {{ t("toolbox.interview.mastery") }}：{{ "●".repeat(recordStars(open.id)) }}{{ "○".repeat(3 - recordStars(open.id)) }}
          · {{ t("toolbox.interview.lastReview", { n: openRecord.reviews }) }}
        </p>
      </div>

      <div class="m-card">
        <button class="m-btn primary" data-role="reveal" @click="revealed = !revealed">
          {{ revealed ? t("toolbox.interview.hideAnswer") : t("toolbox.interview.showAnswer") }}
        </button>
        <p v-if="!revealed" class="m-hint-sm">{{ t("toolbox.interview.revealTip") }}</p>
        <template v-else>
          <!-- eslint-disable-next-line vue/no-v-html -- 渲染入口是 shared.renderMarkdown（先 escapeHtml 再套标记） -->
          <div class="m-md" data-role="answer" v-html="openHtml"></div>
          <div v-if="open.points.length" class="m-itv-points" data-role="points">
            <b>{{ t("toolbox.interview.pointsTitle") }}</b>
            <ul>
              <li v-for="point in open.points" :key="point">{{ point }}</li>
            </ul>
          </div>
          <p v-if="open.follow" class="m-hint-sm" data-role="follow">
            <b>{{ t("toolbox.interview.followTitle") }}</b> {{ open.follow }}
          </p>
          <div class="m-itv-sources" data-role="sources">
            <b>{{ t("toolbox.interview.sourcesTitle") }}</b>
            <p class="m-hint-sm">{{ t("toolbox.interview.sourcesNote") }}</p>
            <ul class="m-list">
              <li v-for="link in openLinks" :key="link.repo" class="m-item">
                <!-- 白名单外只署名不给链接（见桌面端同一处注释） -->
                <button v-if="link.url" class="m-item-main" @click="openLink(link.url)">
                  <span class="m-item-title">{{ link.name }}</span>
                  <span class="m-item-tags">
                    <span>{{ link.path || "/" }}</span>
                    <span>★ {{ link.stars }}</span>
                    <span v-if="link.license">{{ link.license }}</span>
                  </span>
                </button>
                <div v-else class="m-item-main">
                  <span class="m-item-title">{{ link.name }}</span>
                  <span class="m-item-tags">
                    <span>{{ link.path || "/" }}</span>
                    <span>{{ t("toolbox.interview.sourcesExternal") }}</span>
                  </span>
                </div>
              </li>
            </ul>
            <p v-if="!openLinks.length" class="m-hint-sm">{{ t("toolbox.interview.sourcesNone") }}</p>
          </div>
        </template>
      </div>

      <div class="m-card">
        <b>{{ t("toolbox.interview.rateTitle") }}</b>
        <div class="m-itv-rate" data-role="rate">
          <button v-for="item in RATINGS" :key="item.key" class="m-btn" :data-rating="item.key" :data-role="`rate-${item.key}`" @click="onRate(item.key)">
            {{ t(item.labelKey) }}
          </button>
        </div>
        <p class="m-hint-sm">{{ t("toolbox.interview.rateHint") }}</p>
        <label class="m-itv-note">
          <span>{{ t("toolbox.interview.noteTitle") }}</span>
          <textarea v-model="noteDraft" rows="2" :placeholder="t('toolbox.interview.notePlaceholder')" data-role="note" @change="onNote" @blur="onNote" />
        </label>
      </div>
    </template>

    <!-- ── 题库 / 复习列表 ─────────────────────────────────── -->
    <template v-else>
      <div class="m-card">
        <div class="m-card-head">
          <b>{{ t("toolbox.interview.title") }}</b>
          <span class="m-status" data-role="stats">{{ stats.mastered }}/{{ stats.total }} · {{ stats.pct }}%</span>
        </div>
        <div class="m-chips">
          <button v-for="item in TABS" :key="item.key" class="m-chip" :class="{ on: tab === item.key }" :data-role="`tab-${item.key}`" @click="tab = item.key">
            {{ t(item.labelKey) }}<template v-if="item.key === 'review' && stats.due"> {{ stats.due }}</template>
          </button>
        </div>
      </div>

      <div v-if="tab === 'bank'" class="m-card">
        <label class="m-itv-field">
          <input v-model="query" type="search" :placeholder="t('toolbox.interview.searchPlaceholder')" data-role="search" />
        </label>
        <label class="m-itv-field">
          <select v-model="category" data-role="filter-category">
            <option value="">{{ t("toolbox.interview.allCategories") }}</option>
            <option v-for="item in CATEGORIES" :key="item.key" :value="item.key">{{ t(item.labelKey) }}</option>
          </select>
        </label>
        <label class="m-itv-field">
          <select v-model="topic" data-role="filter-topic">
            <option value="">{{ t("toolbox.interview.allTopics") }}</option>
            <option v-for="item in topics" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <div class="m-chips" data-role="filter-status">
          <button v-for="item in STATUSES" :key="item.key" class="m-chip" :class="{ on: status === item.key }" @click="status = item.key">
            {{ t(item.labelKey) }}
          </button>
        </div>
        <div class="m-chips" data-role="filter-difficulty">
          <button class="m-chip" :class="{ on: difficulty === 0 }" @click="difficulty = 0">{{ t("toolbox.interview.allDifficulty") }}</button>
          <button v-for="item in DIFFICULTIES" :key="item.level" class="m-chip" :class="{ on: difficulty === item.level }" @click="difficulty = item.level">
            {{ t(item.labelKey) }}
          </button>
        </div>
        <p class="m-hint-sm" data-role="filter-count">{{ t("toolbox.interview.resultCount", { n: filtered.length }) }}</p>
      </div>

      <div v-if="tab === 'bank' || tab === 'review'" class="m-card">
        <ul class="m-list" data-role="question-list">
          <li v-for="item in tab === 'review' ? dueList : filtered" :key="item.id" class="m-item" :data-role="`q-${item.id}`">
            <button class="m-item-main" @click="pick(item.id)">
              <span class="m-item-title" :class="{ done: isMastered(save, item.id) }">{{ item.question }}</span>
              <span class="m-item-tags">
                <span class="m-itv-diff" :data-level="item.difficulty">{{ item.difficulty }}</span>
                <span>{{ categoryName(item.category) }}</span>
                <span>{{ "●".repeat(recordStars(item.id)) }}{{ "○".repeat(3 - recordStars(item.id)) }}</span>
              </span>
            </button>
          </li>
          <li v-if="!(tab === 'review' ? dueList : filtered).length" class="m-hint-sm" data-role="list-empty">
            {{ t(`toolbox.interview.empty.${tab === "review" ? "reviewEmpty" : "listEmpty"}`) }}
          </li>
        </ul>
      </div>

      <!-- ── 模拟面试 ──────────────────────────────────────── -->
      <div v-else-if="tab === 'session'" class="m-card" data-role="session">
        <template v-if="!save.session">
          <b>{{ t("toolbox.interview.session.setupTitle") }}</b>
          <p class="m-hint-sm">{{ t("toolbox.interview.session.setupNote") }}</p>
          <label class="m-itv-field">
            <span>{{ t("toolbox.interview.session.perCategory") }}</span>
            <input v-model.number="perCategory" type="number" min="1" max="20" data-role="per-category" />
          </label>
          <p class="m-hint-sm">{{ t("toolbox.interview.session.total", { n: perCategory * 4 }) }}</p>
          <button class="m-btn primary" data-role="start-session" @click="newSession">{{ t("toolbox.interview.session.start") }}</button>
        </template>
        <template v-else>
          <div class="m-card-head">
            <span class="m-status" data-role="session-progress">
              {{ t("toolbox.interview.session.progress", { done: Math.min(save.session.index + 1, sessionList.length), total: sessionList.length }) }}
            </span>
            <button class="m-btn" data-role="session-skip" @click="skipSession">{{ t("toolbox.interview.session.skip") }}</button>
            <button class="m-btn" data-role="session-quit" @click="quitSession">{{ t("toolbox.interview.session.quit") }}</button>
          </div>
          <template v-if="sessionQuestion && !sessionDone">
            <div class="m-itv-meta">
              <span class="m-itv-diff" :data-level="sessionQuestion.difficulty">{{ t(`toolbox.interview.difficulty.${sessionQuestion.difficulty}`) }}</span>
              <span>{{ categoryName(sessionQuestion.category) }}</span>
              <span v-if="sessionQuestion.topic">{{ sessionQuestion.topic }}</span>
            </div>
            <h3 class="m-itv-question" data-role="session-question">{{ sessionQuestion.question }}</h3>
            <button class="m-btn primary" data-role="session-reveal" @click="revealed = !revealed">
              {{ revealed ? t("toolbox.interview.hideAnswer") : t("toolbox.interview.showAnswer") }}
            </button>
            <template v-if="revealed">
              <!-- eslint-disable-next-line vue/no-v-html -- 渲染入口是 shared.renderMarkdown（先 escapeHtml 再套标记） -->
              <div class="m-md" data-role="session-answer" v-html="sessionHtml"></div>
              <div v-if="sessionQuestion.points.length" class="m-itv-points">
                <b>{{ t("toolbox.interview.pointsTitle") }}</b>
                <ul>
                  <li v-for="point in sessionQuestion.points" :key="point">{{ point }}</li>
                </ul>
              </div>
              <div class="m-itv-rate" data-role="session-rate">
                <button v-for="item in RATINGS" :key="item.key" class="m-btn" :data-rating="item.key" @click="onRate(item.key)">
                  {{ t(item.labelKey) }}
                </button>
              </div>
              <p class="m-hint-sm">{{ t("toolbox.interview.session.autoNext") }}</p>
            </template>
          </template>
          <template v-else>
            <b data-role="session-done">{{ t("toolbox.interview.session.doneTitle") }}</b>
            <p class="m-hint-sm">{{ t("toolbox.interview.session.doneNote", { n: sessionList.length }) }}</p>
            <div class="m-actions">
              <button class="m-btn primary" data-role="session-again" @click="newSession">{{ t("toolbox.interview.session.again") }}</button>
              <button class="m-btn" @click="quitSession">{{ t("toolbox.interview.session.quit") }}</button>
            </div>
          </template>
        </template>
      </div>

      <!-- ── 导入 ──────────────────────────────────────────── -->
      <div v-else class="m-card" data-role="manage">
        <b>{{ t("toolbox.interview.import.title") }}</b>
        <p class="m-hint-sm">{{ t("toolbox.interview.import.note") }}</p>
        <label class="m-itv-field">
          <span>{{ t("toolbox.interview.import.category") }}</span>
          <select v-model="importCategory" data-role="import-category">
            <!-- 空值 = 让文件头的 `> 方向:` 决定（见桌面端同一处注释） -->
            <option value="">{{ t("toolbox.interview.import.categoryFromFile") }}</option>
            <option v-for="item in CATEGORIES" :key="item.key" :value="item.key">{{ t(item.labelKey) }}</option>
          </select>
        </label>
        <textarea v-model="importText" rows="6" :placeholder="t('toolbox.interview.import.placeholder')" data-role="import-text" />
        <div class="m-actions">
          <button class="m-btn primary" data-role="import-run" @click="runImport">{{ t("toolbox.interview.import.run") }}</button>
          <button class="m-btn" :disabled="!custom.length" data-role="import-clear" @click="clearCustom">
            {{ t("toolbox.interview.import.clear", { n: custom.length }) }}
          </button>
        </div>
        <p v-if="importError" class="m-err" data-role="import-error">{{ importError }}</p>
        <p v-else-if="custom.length" class="m-hint-sm" data-role="import-count">{{ t("toolbox.interview.import.customCount", { n: custom.length }) }}</p>
        <dl class="m-status">
          <li v-for="item in CATEGORIES" :key="item.key">
            <span>{{ t(item.labelKey) }}</span>
            <span>{{ catalog.byCategory[item.key] }} · {{ stats.byCategory[item.key].mastered }}</span>
          </li>
        </dl>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* 手机端只补壳里没有的几处：难度角标、自评按钮行、要点块、出处块。
   其余（卡片/列表/按钮/标签）一律复用 mobile/app/styles/shell.css 的 m-* 体系。 */
.m-itv-meta { display: flex; align-items: center; gap: var(--m-gap, 8px); flex-wrap: wrap; color: var(--m-muted); font-size: 12px; }
.m-itv-question { margin: 6px 0; font-size: 16px; line-height: 1.6; }
.m-itv-diff { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 4px; font-size: 11px; font-weight: 600; background: var(--m-soft); }
.m-itv-diff[data-level="1"] { color: var(--m-ok); }
.m-itv-diff[data-level="2"] { color: var(--m-primary); }
.m-itv-diff[data-level="3"] { color: #d08700; }
.m-itv-field { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13px; color: var(--m-muted); }
.m-itv-field input, .m-itv-field select { flex: 1; min-width: 0; }
.m-itv-rate { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 8px 0; }
.m-itv-rate .m-btn { width: 100%; }
.m-itv-rate .m-btn[data-rating="again"] { color: var(--m-danger); }
.m-itv-rate .m-btn[data-rating="good"], .m-itv-rate .m-btn[data-rating="easy"] { color: var(--m-ok); }
.m-itv-points { padding: 10px 12px; margin: 8px 0; border: 1px dashed var(--m-primary); border-radius: 8px; }
.m-itv-points b { display: block; margin-bottom: 6px; font-size: 13px; color: var(--m-primary); }
.m-itv-points ul { margin: 0; padding-left: 1.2em; font-size: 13px; line-height: 1.8; }
.m-itv-sources { margin-top: 10px; }
.m-itv-sources > b { display: block; font-size: 13px; }
.m-itv-note { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; font-size: 13px; color: var(--m-muted); }
.m-itv-note textarea { width: 100%; }
.m-item-title.done { color: var(--m-ok, #3a9d5d); }
</style>
