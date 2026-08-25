<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon.vue";
import { fmtDate, weekday, isWorkday } from "./shared.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});
const emit = defineEmits(["navigate", "open-settings"]);

const iterations = ref([]);
const problems = ref([]);
const snippets = ref([]);
const settings = ref({});
const loaded = ref(false); // 首屏数据就绪（就绪前显示骨架屏，避免空态闪现）

async function load() {
  try {
    const [its, probs, snips, sets] = await Promise.all([
      invoke("load_data", { key: "iterations" }),
      invoke("load_data", { key: "problems" }),
      invoke("load_data", { key: "snippets" }),
      invoke("load_data", { key: "settings" }),
    ]);
    iterations.value = its || [];
    problems.value = probs || [];
    snippets.value = snips || [];
    settings.value = sets || {};
    userName.value = settings.value.displayName || ""; // 本地显示名（设置 → 通用），无 Coding 依赖
  } catch (e) {
    props.showToast("加载概览失败：" + e);
  } finally {
    loaded.value = true;
  }
}

let dayTimer = null;
function onWindowFocus() {
  if (!document.hidden) load(); // 回到窗口时静默刷新本地数据（团队同步/他处修改自动跟上）
}
onMounted(async () => {
  await load();
  // 每分钟校时：跨天自动重载本地数据（通宵挂机后日期/激励语/「本周」范围不「卡在昨天」）
  dayTimer = setInterval(() => {
    const prev = today.value;
    now.value = new Date();
    if (today.value !== prev) load();
  }, 60_000);
  window.addEventListener("focus", onWindowFocus);
});
onUnmounted(() => {
  clearInterval(dayTimer);
  window.removeEventListener("focus", onWindowFocus);
});

// ------- 日期 / 问候（now 每分钟校时，跨天自动滚动；workday 用于周末不催工时） -------
const now = ref(new Date());
const userName = ref("");
const today = computed(() => fmtDate(now.value));
const workday = computed(() => isWorkday(today.value));
const greeting = computed(() => {
  const h = now.value.getHours();
  if (h < 6) return "夜深了";
  if (h < 12) return "早上好";
  if (h < 18) return "下午好";
  return "晚上好";
});
// 每日一句激励语（按日期轮换）
const SLOGANS = [
  "把大事拆小，把小事做完",
  "先完成，再完美",
  "上线顺利的秘诀，是提前一天准备",
  "今天的每一小步，都是版本号的一大步",
  "保持节奏，稳步交付",
];
const slogan = computed(() => SLOGANS[now.value.getDate() % SLOGANS.length]);

// ------- 迭代派生 -------
const STATUS_LABEL = { plan: "规划", dev: "开发", test: "测试", pending: "待上线", live: "已上线" };

function progress(it) {
  const list = it.items || [];
  const total = list.length;
  const done = list.filter((x) => x.done).length;
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
}
// 本周一 ~ 周日
function weekRange() {
  const d = new Date(today.value + "T00:00:00");
  const day = d.getDay() || 7;
  const mon = new Date(d);
  mon.setDate(d.getDate() - day + 1);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return [fmtDate(mon), fmtDate(sun)];
}
// 本周上线 + 逾期未上线
const weekList = computed(() => {
  const [mon, sun] = weekRange();
  return iterations.value
    .filter((it) => {
      const d = it.releaseDate || "";
      if (!d) return false;
      if (d >= mon && d <= sun) return true;
      return d < today.value && it.status !== "live"; // 逾期未上线也要提醒
    })
    .map((it) => ({ ...it, overdue: (it.releaseDate || "") < today.value && it.status !== "live" }))
    .sort((a, b) => (a.releaseDate || "").localeCompare(b.releaseDate || ""));
});

// ------- 行动数字 -------
const activeCount = computed(() => iterations.value.filter((r) => r.status !== "live").length);
const pendingCount = computed(() => iterations.value.filter((r) => r.status === "pending").length);
const openProblems = computed(() => problems.value.filter((p) => p.status === "open").length);
const openQuestions = computed(() =>
  iterations.value.reduce(
    (s, it) => s + (it.items || []).reduce((x, r) => x + ((r.questions || []).filter((q) => q.status !== "resolved").length), 0),
    0
  )
);

// ------- KPI 数字滚动（数据变化时 350ms 缓动到位，反馈型动效） -------
const kpiShown = ref({ active: 0, pending: 0, questions: 0, problems: 0 });
function animateKpi(key, target) {
  const from = kpiShown.value[key];
  if (from === target) return;
  const t0 = performance.now();
  const dur = 350;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const ease = 1 - Math.pow(1 - p, 3);
    kpiShown.value[key] = Math.round(from + (target - from) * ease);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
watch(activeCount, (v) => animateKpi("active", v));
watch(pendingCount, (v) => animateKpi("pending", v));
watch(openQuestions, (v) => animateKpi("questions", v));
watch(openProblems, (v) => animateKpi("problems", v));
// 待确认聚合到迭代（取前 5）
const questionIters = computed(() =>
  iterations.value
    .map((it) => ({
      id: it.id,
      title: it.title,
      count: (it.items || []).reduce((x, r) => x + ((r.questions || []).filter((q) => q.status !== "resolved").length), 0),
    }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
);

// ------- 今日工时 -------
function round(n) {
  return Math.round(n * 100) / 100;
}
const todayHours = computed(() => round(dayHours.value[today.value] || 0));
// 工时目标读设置（hoursReminder.target），不再硬编码 8h；非工作日不显示进度条
const targetHours = computed(() => Number(settings.value?.hoursReminder?.target) || 8);
const hoursPct = computed(() => (workday.value ? Math.min(100, Math.round((todayHours.value / targetHours.value) * 100)) : 0));

const dayHours = computed(() => {
  const mine = userName.value;
  const bucket = {};
  const add = (date, hours) => {
    if (date && hours) bucket[date] = (bucket[date] || 0) + hours;
  };
  iterations.value.forEach((it) =>
    (it.items || []).forEach((r) => {
      (r.subtasks || []).forEach((s) => {
        if (mine && s.assignee && s.assignee !== mine) return;
        add(s.date, Number(s.hours) || 0);
      });
      (r.logs || []).forEach((l) => add(l.date, Number(l.hours) || 0));
    })
  );
  problems.value.forEach((p) => (p.logs || []).forEach((l) => add(l.date, Number(l.hours) || 0)));
  return bucket;
});

// ------- 最近动态（迭代/问题的工作日志聚合，默认收起只显示 4 条，避免首屏滑动条） -------
const ACT_LIMIT = 4;
const actExpanded = ref(false);
const recentLogs = computed(() => {
  const out = [];
  iterations.value.forEach((it) =>
    (it.items || []).forEach((r) => {
      (r.subtasks || []).forEach((s) => {
        const h = Number(s.hours) || 0;
        if (h > 0 && s.date) out.push({ date: s.date, hours: h, note: s.name || "", src: r.name, from: it.title, module: "iteration", id: it.id });
      });
      (r.logs || []).forEach((l) => out.push({ date: l.date || "", hours: Number(l.hours) || 0, note: l.note || "", src: r.name, from: it.title, module: "iteration", id: it.id }));
    })
  );
  problems.value.forEach((p) =>
    (p.logs || []).forEach((l) => out.push({ date: l.date || "", hours: Number(l.hours) || 0, note: l.note || "", src: p.title, from: "问题", module: "problem", id: p.id }))
  );
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
});
const visibleLogs = computed(() => (actExpanded.value ? recentLogs.value : recentLogs.value.slice(0, ACT_LIMIT)));
const actRestCount = computed(() => recentLogs.value.length - ACT_LIMIT);

function go(module, id) {
  emit("navigate", { module, id: id || null });
}

// ------- 今日行动（聚合今日必办：上线/逾期/待确认/工时，一键跳转） -------
const todayActs = computed(() => {
  const acts = [];
  for (const it of weekList.value) {
    if (it.releaseDate === today.value && it.status !== "live") {
      acts.push({ key: "due-" + it.id, icon: "rocket", text: `今日上线：${it.title}`, module: "iteration", id: it.id });
    }
    if (it.overdue) {
      acts.push({ key: "late-" + it.id, icon: "alert", text: `已逾期：${it.title}`, module: "iteration", id: it.id, late: true });
    }
  }
  if (openQuestions.value > 0) acts.push({ key: "q", icon: "chat", text: `${openQuestions.value} 项待产品确认`, module: "iteration" });
  if (workday.value && todayHours.value < targetHours.value) acts.push({ key: "hours", icon: "clock", text: `今日工时 ${todayHours.value}h / ${targetHours.value}h`, module: "task" });
  return acts;
});
// 今日行动展开/收起（默认 6 条，超出提示「还有 N 项」）
const ACT_MAX = 6;
const actsExpanded = ref(false);
const visibleActs = computed(() => (actsExpanded.value ? todayActs.value : todayActs.value.slice(0, ACT_MAX)));

// ------- 新手引导（首次启动且数据为空时展示，可关闭，本地记忆） -------
const showGuide = ref(false);
watch(
  () => loaded.value,
  (v) => {
    if (v && !localStorage.getItem("guideDone") && !iterations.value.length && !problems.value.length) showGuide.value = true;
  }
);
function dismissGuide() {
  showGuide.value = false;
  localStorage.setItem("guideDone", "1");
}

// ------- 最新速记（脱敏分类不展示，按更新时间取最近 3 条） -------
const SECRET_CAT = /密码|口令|密钥|秘钥|token|secret|password/i; // 与 SnippetView 脱敏口径一致
const latestSnippets = computed(() =>
  [...snippets.value]
    .filter((s) => !SECRET_CAT.test(s.category || ""))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 3)
);
const firstLine = (t) => String(t || "").split("\n")[0].trim();
</script>

<template>
  <main class="home">
    <!-- 首屏骨架：数据加载中，避免空态闪现（本地 JSON 通常一闪而过） -->
    <template v-if="!loaded">
      <div class="skel-block skel-greet"></div>
      <div class="kpis">
        <div v-for="i in 5" :key="i" class="skel-block skel-kpi"></div>
      </div>
      <div class="cols">
        <div class="col-main">
          <div class="skel-block skel-card"></div>
          <div class="skel-block skel-card"></div>
        </div>
        <div class="col-side">
          <div class="skel-block skel-card"></div>
          <div class="skel-block skel-card"></div>
        </div>
      </div>
    </template>

    <template v-else>
    <!-- 问候区（品牌 hero） -->
    <section class="greet card">
      <span class="greet-logo"><Icon name="rocket" :size="22" /></span>
      <div class="greet-main">
        <h2>{{ greeting }}{{ userName ? "，" + userName : "" }}</h2>
        <p class="greet-sub">今天是 {{ today }} · {{ weekday(today) }} · {{ slogan }}</p>
      </div>
      <div class="greet-date" :title="today">
        <b>{{ today.slice(8) }}</b>
        <i>{{ Number(today.slice(5, 7)) }} 月</i>
      </div>
    </section>

    <!-- 新手引导：全新用户三步上手 -->
    <section v-if="showGuide" class="card guide-card">
      <span class="guide-ico"><Icon name="rocket" :size="18" /></span>
      <div class="guide-main">
        <b>欢迎使用 ToolCove</b>
        <span>三步开始：建迭代 → 记工时 → 收问题，到点自动提醒上线。</span>
      </div>
      <button class="btn-outline sm" @click="dismissGuide(); go('iteration')"><Icon name="plus" :size="14" /> 建第一个迭代</button>
      <button class="guide-close" title="不再显示" @click="dismissGuide"><Icon name="x" :size="13" /></button>
    </section>

    <!-- 今日行动：聚合今日必办（上线/逾期/待确认/工时），有行动才显示 -->
    <section v-if="todayActs.length" class="card today-card">
      <span class="today-label"><Icon name="target" :size="13" /> 今日行动</span>
      <button v-for="a in visibleActs" :key="a.key" class="today-item" :class="{ late: a.late }" @click="go(a.module, a.id)">
        <Icon :name="a.icon" :size="12" /> {{ a.text }}
      </button>
      <button v-if="todayActs.length > ACT_MAX" class="today-more" @click="actsExpanded = !actsExpanded">
        {{ actsExpanded ? "收起" : `还有 ${todayActs.length - ACT_MAX} 项` }}
        <Icon name="chevron" :size="12" class="tgl-arrow" :class="{ up: actsExpanded }" />
      </button>
    </section>

    <!-- 行动数字条 -->
    <section class="kpis">
      <button class="kpi" @click="go('iteration')">
        <span class="k-ico"><Icon name="repeat" :size="20" /></span>
        <span class="k-main"><span class="k-num">{{ kpiShown.active }}</span><span class="k-lbl">进行中迭代</span></span>
      </button>
      <button class="kpi amber" @click="go('iteration')">
        <span class="k-ico"><Icon name="clock" :size="20" /></span>
        <span class="k-main"><span class="k-num">{{ kpiShown.pending }}</span><span class="k-lbl">待上线</span></span>
      </button>
      <button class="kpi warn" @click="go('iteration')">
        <span class="k-ico"><Icon name="check" :size="20" /></span>
        <span class="k-main"><span class="k-num">{{ kpiShown.questions }}</span><span class="k-lbl">待产品确认</span></span>
      </button>
      <button class="kpi red" @click="go('problem')">
        <span class="k-ico"><Icon name="alert" :size="20" /></span>
        <span class="k-main"><span class="k-num">{{ kpiShown.problems }}</span><span class="k-lbl">未解决问题</span></span>
      </button>
      <button class="kpi hours" :class="{ ok: workday && todayHours >= targetHours }" @click="go('task')">
        <span class="k-ico"><Icon name="bar-chart" :size="20" /></span>
        <span class="k-main">
          <span class="k-num">{{ todayHours }}<i v-if="workday">/{{ targetHours }}h</i><i v-else>h</i></span>
          <span class="k-lbl">今日工时</span>
          <span v-if="workday" class="k-bar"><i :style="{ width: hoursPct + '%' }"></i></span>
        </span>
      </button>
    </section>

    <div class="cols">
      <div class="col-main">
        <!-- 本周上线 -->
        <section class="card">
          <h3 class="sec-title">
            <Icon name="rocket" :size="15" class="sec-ico" /> 本周上线
            <button class="sec-more" @click="go('iteration')">查看全部 <Icon name="chevron" :size="12" class="more-arrow" /></button>
          </h3>
        <div v-if="weekList.length" class="rel-list">
          <button v-for="it in weekList" :key="it.id" class="rel-row" @click="go('iteration', it.id)">
            <span class="rel-date" :class="{ overdue: it.overdue, done: it.status === 'live' }">
              <b>{{ (it.releaseDate || "").slice(5) }}</b>
              <i>{{ it.overdue ? "已逾期" : weekday(it.releaseDate) }}</i>
            </span>
            <span class="rel-main">
              <span class="rel-title">{{ it.title }}<em v-if="it.version" class="rel-ver">{{ it.version }}</em></span>
              <span class="rel-prog">需求 {{ progress(it).done }}/{{ progress(it).total }}</span>
            </span>
            <span class="st-chip" :class="'st-' + it.status">{{ STATUS_LABEL[it.status] }}</span>
            <Icon name="chevron" :size="14" class="rel-arrow" />
          </button>
        </div>
        <div v-else class="empty">
          <span class="empty-ico"><Icon name="calendar" :size="40" /></span>
          <p>本周没有计划上线的迭代，可以去「迭代」安排一个。</p>
        </div>
        </section>

        <!-- 最近动态 -->
        <section class="card">
          <h3 class="sec-title">
            <Icon name="activity" :size="15" class="sec-ico" /> 最近动态
            <button class="sec-more" @click="go('task')">查看更多 <Icon name="chevron" :size="12" class="more-arrow" /></button>
          </h3>
          <table v-if="recentLogs.length" class="act-table">
            <thead>
              <tr><th>时间</th><th>类型</th><th>内容</th><th class="th-r">耗时</th></tr>
            </thead>
            <tbody>
              <tr v-for="(l, i) in visibleLogs" :key="i" @click="go(l.module, l.id)">
                <td class="at-date" :class="{ today: l.date === today }">{{ l.date === today ? "今天" : l.date.slice(5) }}</td>
                <td><span class="at-type" :class="l.module">{{ l.module === "problem" ? "问题" : "迭代" }}</span></td>
                <td class="at-note">
                  <span class="at-txt" :title="l.note || ''">{{ l.note || "（未写内容）" }}</span>
                  <span class="at-src" :title="l.module === 'problem' ? l.src : l.from">{{ l.module === "problem" ? l.src : l.from }}</span>
                </td>
                <td class="at-hrs">{{ l.hours ? l.hours + "h" : "-" }}</td>
              </tr>
            </tbody>
          </table>
          <!-- 超出默认条数时才出现：就地展开/收起，不撑高首屏 -->
          <button v-if="actRestCount > 0" class="act-toggle" @click="actExpanded = !actExpanded">
            {{ actExpanded ? "收起" : `展开剩余 ${actRestCount} 条` }}
            <Icon name="chevron" :size="12" class="tgl-arrow" :class="{ up: actExpanded }" />
          </button>
          <div v-else-if="!recentLogs.length" class="empty">
            <span class="empty-ico"><Icon name="note" :size="40" /></span>
            <p>还没有工作记录，在迭代需求或问题里「记一笔」后会汇总到这里。</p>
          </div>
        </section>
      </div>

      <div class="col-side">
        <!-- 待产品确认 -->
        <section class="card">
          <h3 class="sec-title"><Icon name="check" :size="15" class="sec-ico" /> 待产品确认</h3>
          <div v-if="questionIters.length" class="q-list">
            <button v-for="q in questionIters" :key="q.id" class="q-row" @click="go('iteration', q.id)">
              <span class="q-title">{{ q.title }}</span>
              <span class="q-count">{{ q.count }}</span>
            </button>
          </div>
          <div v-else class="empty">
            <span class="empty-ico"><Icon name="check" :size="40" /></span>
            <p>没有卡在产品那边的问题，很好。</p>
          </div>
        </section>

        <!-- 最新速记（最近 3 条，脱敏分类不展示） -->
        <section v-if="latestSnippets.length" class="card">
          <h3 class="sec-title"><Icon name="copy" :size="15" class="sec-ico" /> 最新速记
            <button class="sec-more" @click="go('snippet')">查看全部 <Icon name="chevron" :size="12" class="more-arrow" /></button>
          </h3>
          <div class="snip-list">
            <button v-for="s in latestSnippets" :key="s.id" class="snip-row" @click="go('snippet')">
              <span class="snip-row-title">{{ s.title || "无标题" }}</span>
              <span class="snip-row-preview">{{ firstLine(s.content) || "（无正文）" }}</span>
            </button>
          </div>
        </section>

        <!-- 快捷操作 -->
        <section class="card">
          <h3 class="sec-title"><Icon name="sparkles" :size="15" class="sec-ico" /> 快捷入口</h3>
          <div class="quick">
            <button class="quick-btn" @click="go('iteration')"><Icon name="repeat" :size="16" /> 迭代</button>
            <button class="quick-btn" @click="go('task')"><Icon name="clock" :size="16" /> 记工时</button>
            <button class="quick-btn" @click="go('problem')"><Icon name="alert" :size="16" /> 记问题</button>
            <button class="quick-btn" @click="go('snippet')"><Icon name="copy" :size="16" /> 速记</button>
          </div>
        </section>

      </div>
    </div>
    </template>
  </main>
</template>

<style scoped>
.home { flex: 1; padding: 8px 28px 18px; display: flex; flex-direction: column; gap: 14px; }
.card { background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: 18px 20px; box-shadow: var(--shadow); }

/* 首屏骨架（占位与真实布局同构，加载完成即替换） */
.skel-greet { height: 82px; border-radius: var(--r-lg); }
.skel-kpi { height: 72px; border-radius: var(--r-lg); min-width: 150px; }
.skel-card { height: 190px; border-radius: var(--r-lg); }
.col-main .skel-card:nth-child(2), .col-side .skel-card:nth-child(2) { height: 160px; }

/* 问候区（品牌 hero：极淡蓝紫渐变 + 光球点缀 + 右侧日期徽章） */
.greet { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; position: relative; overflow: hidden; background: linear-gradient(135deg, color-mix(in srgb, var(--primary) 5%, var(--card)), color-mix(in srgb, var(--accent) 7%, var(--card))); }
.greet::after { content: ""; position: absolute; right: -50px; top: -70px; width: 200px; height: 200px; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--accent) 13%, transparent), transparent 70%); pointer-events: none; }
.greet-logo { width: 48px; height: 48px; display: grid; place-items: center; border-radius: var(--r-md); background: var(--grad-brand); color: var(--text-invert); box-shadow: var(--glow-md); flex-shrink: 0; }
.greet-main { position: relative; z-index: 1; }
.greet-main h2 { margin: 0 0 4px; font-size: var(--fs-xl); font-weight: 700; }
.greet-sub { margin: 0; font-size: var(--fs-md); color: var(--muted); }
.greet-date { margin-left: auto; position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; min-width: 64px; padding: 7px 14px; border-radius: var(--r-md); background: var(--card); border: 1px solid var(--accent-border); }
.greet-date b { font-size: var(--fs-num); font-weight: 700; color: var(--accent-hover); line-height: 1.15; font-family: var(--font-num); font-variant-numeric: tabular-nums; }
.greet-date i { font-style: normal; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); }

/* 今日行动（聚合今日必办，胶囊清单） */
.today-card { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border-left: 3px solid var(--accent); }
.today-label { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); font-weight: 700; color: var(--accent-hover); margin-right: 2px; }
.today-item { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border: none; border-radius: var(--r-pill); background: var(--accent-soft); color: var(--accent-hover); font-size: var(--fs-sm); font-weight: 600; cursor: pointer; font-family: inherit; transition: background 0.15s; }
.today-item:hover { background: var(--accent-tint); }
.today-item.late { background: var(--danger-soft); color: var(--danger-deep); }
.today-item.late:hover { background: var(--danger-soft); }
.today-more { display: inline-flex; align-items: center; gap: 4px; border: none; background: none; padding: 4px 10px; border-radius: var(--r-sm); font-size: var(--fs-sm); font-weight: 600; color: var(--muted); cursor: pointer; font-family: inherit; transition: color 0.15s, background 0.15s; }
.today-more:hover { color: var(--accent-hover); background: var(--accent-tint); }
.today-more .tgl-arrow { transform: rotate(90deg); transition: transform 0.18s; }
.today-more .tgl-arrow.up { transform: rotate(-90deg); }

/* 新手引导 */
.guide-card { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 14px 16px; border-left: 3px solid var(--primary); background: linear-gradient(135deg, color-mix(in srgb, var(--primary) 4%, var(--card)), var(--card)); }
.guide-ico { width: 40px; height: 40px; display: grid; place-items: center; border-radius: var(--r-md); background: var(--primary-soft); color: var(--primary-hover); box-shadow: var(--glow-sm); flex-shrink: 0; }
.guide-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.guide-main b { font-size: var(--fs-base); }
.guide-main span { font-size: var(--fs-sm); color: var(--muted); }
.guide-close { width: 24px; height: 24px; padding: 0; display: grid; place-items: center; border: none; background: none; color: var(--muted); border-radius: var(--r-xs); cursor: pointer; transition: background 0.15s, color 0.15s; }
.guide-close:hover { background: var(--danger-soft); color: var(--danger-deep); }

/* 行动数字条 */
.kpis { display: flex; gap: 12px; flex-wrap: wrap; }
.kpi { position: relative; flex: 1; min-width: 150px; display: flex; align-items: center; gap: 12px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: 13px 15px; box-shadow: var(--shadow-tile); cursor: pointer; font-family: inherit; transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s; }
.kpi:hover { transform: translateY(-2px); border-color: var(--accent-soft-text); box-shadow: 0 4px 10px rgba(35, 43, 66, 0.08), 0 18px 40px rgba(35, 43, 66, 0.14); }
.k-ico { width: 46px; height: 46px; display: grid; place-items: center; border-radius: var(--r-md); background: var(--primary-soft); color: var(--primary); box-shadow: var(--shadow-tile); flex-shrink: 0; transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.2s; }
.kpi.amber .k-ico { background: var(--amber-soft); color: var(--amber); }
.kpi.warn .k-ico { background: var(--warn-soft); color: var(--warn-deep); }
.kpi.red .k-ico { background: var(--danger-soft); color: var(--danger-deep); }
.kpi.hours .k-ico { background: var(--primary-soft); color: var(--primary); }
.kpi.hours.ok .k-ico { background: var(--success-soft); color: var(--success-deep); }
/* 焦点感知：hover 图标上浮 + 品牌光晕，暗示可点击 */
.kpi:hover .k-ico { transform: translateY(-4px) scale(1.05); box-shadow: var(--glow-sm); }
.k-main { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; flex: 1; min-width: 0; }
.k-num { font-size: var(--fs-num); font-weight: 700; color: var(--accent); line-height: 1.1; font-family: var(--font-num); font-variant-numeric: tabular-nums; }
.k-num i { font-style: normal; font-size: var(--fs-md); font-weight: 600; color: var(--muted); }
.kpi.amber .k-num { color: var(--amber); }
.kpi.warn .k-num { color: var(--warn); }
.kpi.red .k-num { color: var(--danger); }
.kpi.hours .k-num { color: var(--primary); }
.kpi.hours.ok .k-num { color: var(--success); }
.k-lbl { font-size: var(--fs-sm); color: var(--muted); }
.k-bar { width: 100%; height: 5px; margin-top: 6px; background: var(--well); border-radius: var(--r-pill); overflow: hidden; }
.k-bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--primary), var(--primary-light)); border-radius: var(--r-pill); transition: width 0.3s; }
.kpi.hours.ok .k-bar i { background: linear-gradient(90deg, var(--success), var(--success-light)); }

/* 两栏 */
.cols { display: grid; grid-template-columns: 1.6fr 1fr; gap: 16px; align-items: start; }
@media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
.col-side { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.col-main { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.sec-title { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font-size: var(--fs-base); font-weight: 700; }
.sec-ico { flex-shrink: 0; color: var(--accent-hover); }
.sec-more { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; border: none; background: none; font-size: var(--fs-sm); font-weight: 600; color: var(--muted); cursor: pointer; padding: 3px 8px; border-radius: var(--r-sm); font-family: inherit; transition: color 0.15s, background 0.15s; }
.sec-more:hover { color: var(--accent-hover); background: var(--accent-tint); }
.sec-more:disabled { opacity: 0.55; cursor: default; }
.more-arrow { transform: rotate(-90deg); }
.empty { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 0 12px; text-align: center; }
.empty-ico { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 50%; background: var(--primary-soft); color: var(--primary); margin-bottom: 4px; }
.empty p { margin: 0; font-size: var(--fs-md); color: var(--muted); }

/* 本周上线列表 */
.rel-list { display: flex; flex-direction: column; }
.rel-row { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; background: none; border: none; border-bottom: 1px solid var(--border); padding: 11px 4px; cursor: pointer; font-family: inherit; border-radius: var(--r-sm); transition: background 0.15s; }
.rel-row:last-child { border-bottom: none; }
.rel-row:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); box-shadow: inset 2px 0 0 var(--primary); }
.rel-date { display: flex; flex-direction: column; align-items: center; gap: 1px; min-width: 56px; padding: 5px 8px; border-radius: var(--r-sm); background: var(--accent-soft); color: var(--accent-hover); flex-shrink: 0; white-space: nowrap; }
.rel-date b { font-size: var(--fs-base); font-weight: 700; font-family: var(--font-num); white-space: nowrap; }
.rel-date i { font-style: normal; font-size: var(--fs-xs); }
.rel-date.overdue { background: var(--danger-soft); color: var(--danger-deep); }
.rel-date.done { background: var(--success-soft); color: var(--success-deep); }
.rel-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.rel-title { font-size: var(--fs-md); font-weight: 600; color: var(--text); word-break: break-word; }
.rel-ver { font-style: normal; font-size: var(--fs-xs); font-weight: 700; color: var(--accent-hover); background: var(--accent-soft); padding: 1px 8px; border-radius: var(--r-pill); margin-left: 8px; font-family: var(--font-num); }
.rel-prog { font-size: var(--fs-sm); color: var(--muted); }
.rel-arrow { flex-shrink: 0; transform: rotate(-90deg); color: var(--faint); transition: color 0.15s, transform 0.15s; }
.rel-row:hover .rel-arrow { color: var(--accent-hover); transform: rotate(-90deg) translateY(2px); }

/* 最近动态（表格） */
.act-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.act-table th { text-align: left; font-size: var(--fs-xs); font-weight: 700; color: var(--muted); padding: 4px 8px 8px; border-bottom: 1px solid var(--border); }
.act-table th:first-child { width: 56px; }
.act-table th:nth-child(2) { width: 60px; }
.act-table th.th-r { width: 56px; text-align: right; }
.act-table tbody tr { cursor: pointer; transition: background 0.15s; }
.act-table tbody tr:hover { background: color-mix(in srgb, var(--primary) 6%, transparent); }
.act-table tbody tr:hover td:first-child { box-shadow: inset 2px 0 0 var(--primary); }
.act-table td { padding: 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.act-table tbody tr:last-child td { border-bottom: none; }
.at-date { font-size: var(--fs-sm); font-weight: 700; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.at-date.today { color: var(--primary); }
.at-type { display: inline-block; font-size: var(--fs-xs); font-weight: 700; padding: 2px 8px; border-radius: var(--r-pill); background: var(--accent-soft); color: var(--accent-hover); white-space: nowrap; }
.at-type.problem { background: var(--danger-soft); color: var(--danger-deep); }
.at-note { min-width: 0; }
.at-txt { display: block; font-size: var(--fs-md); color: var(--text); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.at-src { display: block; font-size: var(--fs-xs); color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.at-hrs { font-size: var(--fs-sm); font-weight: 700; color: var(--primary); text-align: right; white-space: nowrap; }
/* 就地展开/收起：通栏轻量按钮，不抢视觉重心 */
.act-toggle { display: flex; align-items: center; justify-content: center; gap: 4px; width: 100%; margin-top: 6px; padding: 7px 0; border: none; background: none; border-radius: var(--r-sm); font-size: var(--fs-sm); font-weight: 600; color: var(--muted); cursor: pointer; transition: background 0.15s, color 0.15s; }
.act-toggle:hover { background: color-mix(in srgb, var(--primary) 6%, transparent); color: var(--primary); }
.act-toggle .tgl-arrow { transform: rotate(90deg); transition: transform 0.18s; }
.act-toggle .tgl-arrow.up { transform: rotate(-90deg); }

/* 待确认 */
.q-list { display: flex; flex-direction: column; gap: 4px; }
.q-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: none; border: none; padding: 8px 6px; border-radius: var(--r-sm); cursor: pointer; font-family: inherit; text-align: left; transition: background 0.15s; }
.q-row:hover { background: color-mix(in srgb, var(--amber) 7%, transparent); }
.q-title { font-size: var(--fs-md); color: var(--text); min-width: 0; word-break: break-word; }
.q-count { flex-shrink: 0; font-size: var(--fs-sm); font-weight: 700; color: var(--warn); background: var(--warn-soft); padding: 2px 9px; border-radius: var(--r-pill); }

/* 最新速记 */
.snip-list { display: flex; flex-direction: column; gap: 4px; }
.snip-row { display: flex; flex-direction: column; gap: 2px; background: none; border: none; padding: 8px 6px; border-radius: var(--r-sm); cursor: pointer; font-family: inherit; text-align: left; transition: background 0.15s; }
.snip-row:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.snip-row-title { font-size: var(--fs-md); font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.snip-row-preview { font-size: var(--fs-xs); color: var(--muted); font-family: var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 快捷入口 */
.quick { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.quick-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 11px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--card-soft); color: var(--text-soft); font-size: var(--fs-md); font-weight: 600; cursor: pointer; font-family: inherit; transition: all 0.15s; }
.quick-btn:hover { border-color: var(--accent); color: var(--accent-hover); background: var(--accent-tint); }

@media (prefers-color-scheme: dark) {
  .card { background: var(--card); border-color: var(--border); }
  /* 深色下 .card 规则会覆盖 .greet/.today-card 的浅色渐变背景，这里重新声明深色渐变 */
  .greet { background: linear-gradient(135deg, color-mix(in srgb, var(--primary) 9%, var(--card)), color-mix(in srgb, var(--accent) 12%, var(--card))); }
  .today-card { background: linear-gradient(135deg, color-mix(in srgb, var(--primary) 8%, var(--card)), var(--card)); }
  .rel-date { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .rel-date.overdue { background: var(--danger-soft); color: var(--danger-light); }
  .rel-date.done { background: var(--success-soft); color: var(--success-light); }
  .rel-ver { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .q-count { background: var(--warn-soft); color: var(--amber-light); }
  .at-hrs { color: var(--primary-light); }
  .at-type { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .at-type.problem { background: var(--danger-soft); color: var(--danger-light); }
  .quick-btn { background: var(--card-raised); color: var(--text-weak); }
  .quick-btn:hover { background: var(--accent-soft-deep-hover); }
  /* 今日行动：深色下胶囊换深底亮字 */
  .today-item { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .today-item:hover { background: var(--accent-soft-deep-hover); }
  .today-item.late { background: var(--danger-soft); color: var(--danger-light); }
  /* 最新速记：深色下换亮色文字 */
  .snip-row-preview { color: var(--text-weak); }
}
</style>
