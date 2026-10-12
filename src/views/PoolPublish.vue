<script setup>
// Pool 发布弹窗：本地发布步骤记录（打包 → 上传 → 发布 → 验证）。
// 每步手动确认「标记完成」记时间戳，全部完成后落盘为已发布；可中途放弃（记为发布失败）。
// 数据写入 pool.lastRelease（对象引用共享），父组件监听 @saved 负责持久化。
import { computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../ui/Icon.vue";
import { RELEASE_STEPS, currentStepKey, doneStepsCount } from "../publishState.js";
import { relativeTime } from "../shared/dates.js";
import { askConfirm } from "../ui/confirm.js";

const { t } = useI18n();

// 步骤显示文案：publishState.js 里的 label 是**落盘数据**（写进 pool.lastRelease.steps[].label），
// 保持中文原样不动；界面展示另走这里按 key 查词条，历史数据同样能正常显示。
const STEP_TEXT_KEYS = { pack: "release.stepPack", upload: "release.stepUpload", release: "release.stepRelease", verify: "release.stepVerify" };
function stepText(key) {
  return t(STEP_TEXT_KEYS[key] || "common.notSet");
}

const props = defineProps({
  pool: { type: Object, required: true },
  showToast: { type: Function, default: () => {} },
});
const emit = defineEmits(["close", "saved"]);

const rel = computed(() => props.pool.lastRelease || null);
const curKey = computed(() => currentStepKey(rel.value));

// 步骤元信息（序号 / 是否完成 / 是否进行中 / 完成时间）
const stepMeta = computed(() => {
  const r = rel.value;
  return RELEASE_STEPS.map((s, i) => {
    const done = !!r?.steps?.find((x) => x.key === s.key)?.done;
    const at = r?.steps?.find((x) => x.key === s.key)?.at || 0;
    return { ...s, idx: i + 1, done, at, active: r?.status === "doing" && curKey.value === s.key };
  });
});

// 开始一次新的发布：初始化 lastRelease 并落盘
function startRelease() {
  const now = Date.now();
  props.pool.lastRelease = {
    startedAt: now,
    steps: RELEASE_STEPS.map((s) => ({ key: s.key, label: s.label, done: false, at: 0 })),
    status: "doing",
    finishedAt: 0,
  };
  emit("saved");
  props.showToast(t("release.toastStarted", { name: props.pool.name }));
}

// 标记当前步骤完成并前进；全部完成即发布结束
async function markStep() {
  const r = rel.value;
  if (!r || !curKey.value) return;
  const s = r.steps.find((x) => x.key === curKey.value);
  if (!s) return;
  s.done = true;
  s.at = Date.now();
  if (r.steps.every((x) => x.done)) {
    r.status = "done";
    r.finishedAt = Date.now();
    props.showToast(t("release.toastAllDone", { name: props.pool.name }));
  } else {
    props.showToast(t("release.toastStepDone", { label: stepText(curKey.value) }));
  }
  emit("saved");
}

// 放弃本次发布：记失败并结束（可随后重新发布）
async function abortRelease() {
  const ok = await askConfirm({
    title: t("release.confirmAbortTitle"),
    message: t("release.confirmAbortMsg", { name: props.pool.name }),
    okText: t("release.confirmAbortOk"),
    danger: true,
  });
  if (!ok) return;
  const r = rel.value;
  if (r) {
    r.status = "failed";
    r.finishedAt = Date.now();
    emit("saved");
    props.showToast(t("release.toastAborted"));
  }
}

// 重新发布：清空旧记录重新走一遍
async function restartRelease() {
  const ok = await askConfirm({
    title: t("release.confirmRestartTitle"),
    message: t("release.confirmRestartMsg", { name: props.pool.name }),
    okText: t("release.confirmRestartOk"),
  });
  if (!ok) return;
  props.pool.lastRelease = null;
  startRelease();
}

function close() {
  emit("close");
}
// 配置类弹窗：禁点遮罩关闭，仅 Esc 可关（发布流程进行中防误关）
function onEsc(e) {
  if (e.key === "Escape") close();
}
onMounted(() => window.addEventListener("keydown", onEsc));
onUnmounted(() => window.removeEventListener("keydown", onEsc));
</script>

<template>
  <div class="modal-mask">
    <div class="modal pub-modal">
      <h2><Icon name="upload" :size="18" /> {{ t("release.modalTitle", { name: pool.name }) }}</h2>
      <p class="pub-sub">{{ t("release.modalSub") }}</p>

      <!-- 首次打开：流程说明 + 开始 -->
      <template v-if="!rel">
        <div class="guide-box">
          <p>{{ t("release.guideText") }}</p>
          <div class="preview-steps">
            <span v-for="s in RELEASE_STEPS" :key="s.key" class="preview-step"><Icon name="check" :size="12" /> {{ stepText(s.key) }}</span>
          </div>
        </div>
      </template>

      <!-- 已开始：步骤时间线 -->
      <template v-else>
        <p class="status-line" :class="{ ok: rel.status === 'done', bad: rel.status === 'failed' }">
          <Icon :name="rel.status === 'doing' ? 'repeat' : rel.status === 'done' ? 'check' : 'alert'" :size="15" :class="{ spin: rel.status === 'doing' }" />
          <template v-if="rel.status === 'doing'">
            {{ curKey ? t("release.statusDoing", { cur: stepMeta.find((s) => s.key === curKey).idx, total: RELEASE_STEPS.length, label: stepText(curKey) }) : t("release.statusDoingTail", { cur: doneStepsCount(rel) + 1, total: RELEASE_STEPS.length }) }}
          </template>
          <template v-else-if="rel.status === 'done'">{{ t("release.statusDone", { time: relativeTime(rel.finishedAt) }) }}</template>
          <template v-else>{{ t("release.statusFailed", { time: relativeTime(rel.finishedAt) }) }}</template>
        </p>

        <div class="step" v-for="s in stepMeta" :key="s.key" :class="{ dim: !s.done && !s.active }">
          <div class="step-head">
            <span class="step-no" :class="{ ok: s.done }"><Icon v-if="s.done" name="check" :size="12" /><template v-else>{{ s.idx }}</template></span>
            <span class="step-title">{{ stepText(s.key) }}</span>
            <span v-if="s.active" class="step-tag doing">{{ t("release.tagDoing") }}</span>
            <span v-if="s.at" class="step-time">{{ relativeTime(s.at) }}</span>
          </div>
          <div v-if="s.active" class="step-body">
            <p class="hint">{{ t("release.stepHint", { label: stepText(s.key) }) }}</p>
            <button class="btn-primary sm" @click="markStep"><Icon name="check" :size="14" /> {{ t("release.markDoneBtn", { label: stepText(s.key) }) }}</button>
          </div>
        </div>
      </template>

      <div class="modal-foot">
        <button class="btn-ghost" @click="close">{{ t("release.btnClose") }}</button>
        <template v-if="!rel">
          <button class="btn-primary" @click="startRelease"><Icon name="upload" :size="15" /> {{ t("release.btnStart") }}</button>
        </template>
        <template v-else-if="rel.status === 'doing'">
          <button class="btn-ghost danger" @click="abortRelease"><Icon name="x" :size="15" /> {{ t("release.btnAbort") }}</button>
          <button v-if="!curKey" class="btn-primary" @click="markStep"><Icon name="check" :size="15" /> {{ t("release.btnFinishLast") }}</button>
        </template>
        <template v-else>
          <button class="btn-primary" @click="restartRelease"><Icon name="repeat" :size="15" /> {{ t("release.btnRestart") }}</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pub-modal { width: 560px; }
.pub-modal h2 { display: flex; align-items: center; gap: var(--sp-2); }
.pub-sub { margin: -6px 0 var(--sp-6); font-size: var(--fs-md); color: var(--muted); }

.guide-box { border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--sp-4) var(--sp-5); margin-bottom: var(--sp-3); }
.guide-box p { margin: 0 0 var(--sp-3); font-size: var(--fs-md); color: var(--muted); }
.preview-steps { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.preview-step { display: inline-flex; align-items: center; gap: 4px; padding: 4px var(--sp-3); border-radius: var(--r-pill); background: var(--primary-soft); color: var(--primary); font-size: var(--fs-sm); font-weight: 600; }

.status-line { display: flex; align-items: center; gap: 7px; margin: 0 0 var(--sp-4); font-size: var(--fs-md); font-weight: 600; }
.status-line.ok { color: var(--success-deep); }
.status-line.bad { color: var(--danger-deep); }

.step { border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--sp-4) var(--sp-5); margin-bottom: var(--sp-3); transition: opacity 0.2s; }
.step.dim { opacity: 0.55; }
.step-head { display: flex; align-items: center; gap: 9px; }
.step-no { width: 22px; height: 22px; border-radius: var(--r-pill); background: var(--well); color: var(--text-soft); font-size: var(--fs-sm); font-weight: 700; display: grid; place-items: center; flex-shrink: 0; }
.step-no.ok { background: var(--success-deep); color: var(--text-invert); }
.step-title { font-size: var(--fs-base); font-weight: 600; }
.step-tag.doing { padding: 2px 9px; border-radius: var(--r-pill); background: var(--amber-soft); color: var(--warn-deep); font-size: var(--fs-xs); font-weight: 600; }
.step-time { margin-left: auto; font-size: var(--fs-xs); color: var(--muted); }
.step-body { margin-top: var(--sp-3); padding-left: 31px; display: flex; align-items: center; gap: var(--sp-4); flex-wrap: wrap; }
.hint { margin: 0; font-size: var(--fs-md); color: var(--muted); }

.modal-foot .btn-ghost.danger { color: var(--danger); }
.modal-foot .btn-ghost.danger:hover { color: var(--danger-deep); background: var(--danger-soft); }

@media (prefers-color-scheme: dark) {
  .step-no { background: var(--well); color: var(--text-weak); }
  .step-tag.doing { background: var(--amber-soft); color: var(--amber-light); }
}
</style>
