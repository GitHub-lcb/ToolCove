<script setup>
// Pool 发布弹窗：本地发布步骤记录（打包 → 上传 → 发布 → 验证）。
// 每步手动确认「标记完成」记时间戳，全部完成后落盘为已发布；可中途放弃（记为发布失败）。
// 数据写入 pool.lastRelease（对象引用共享），父组件监听 @saved 负责持久化。
import { ref, computed, onMounted, onUnmounted } from "vue";
import Icon from "./Icon.vue";
import { RELEASE_STEPS, currentStepKey, doneStepsCount, stepLabel } from "./publishState.js";
import { relativeTime } from "./shared.js";
import { askConfirm } from "./confirm.js";

const props = defineProps({
  pool: { type: Object, required: true },
  showToast: { type: Function, default: () => {} },
});
const emit = defineEmits(["close", "saved"]);

const rel = computed(() => props.pool.lastRelease || null);
const curKey = computed(() => currentStepKey(rel.value));
const allDone = computed(() => rel.value?.status === "done");

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
  props.showToast(`已开始发布「${props.pool.name}」`);
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
    props.showToast(`「${props.pool.name}」发布流程已完成`);
  } else {
    props.showToast(`「${stepLabel(curKey.value)}」已完成`);
  }
  emit("saved");
}

// 放弃本次发布：记失败并结束（可随后重新发布）
async function abortRelease() {
  const ok = await askConfirm({
    title: "放弃本次发布",
    message: `将结束「${props.pool.name}」本次发布流程并标记为发布失败，确定吗？`,
    okText: "放弃",
    danger: true,
  });
  if (!ok) return;
  const r = rel.value;
  if (r) {
    r.status = "failed";
    r.finishedAt = Date.now();
    emit("saved");
    props.showToast("已放弃本次发布");
  }
}

// 重新发布：清空旧记录重新走一遍
async function restartRelease() {
  const ok = await askConfirm({
    title: "重新发布",
    message: `将清空「${props.pool.name}」上次的发布记录并重新开始，确定吗？`,
    okText: "重新发布",
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
      <h2><Icon name="upload" :size="18" /> 发布「{{ pool.name }}」</h2>
      <p class="pub-sub">本地发布步骤记录：按 打包 → 上传 → 发布 → 验证 逐项确认，每步完成自动记录时间。</p>

      <!-- 首次打开：流程说明 + 开始 -->
      <template v-if="!rel">
        <div class="guide-box">
          <p>发布流程共 4 步，每步在实际操作完成后点击「标记完成」记录时间；中途放弃会标记为发布失败。</p>
          <div class="preview-steps">
            <span v-for="s in RELEASE_STEPS" :key="s.key" class="preview-step"><Icon name="check" :size="12" /> {{ s.label }}</span>
          </div>
        </div>
      </template>

      <!-- 已开始：步骤时间线 -->
      <template v-else>
        <p class="status-line" :class="{ ok: rel.status === 'done', bad: rel.status === 'failed' }">
          <Icon :name="rel.status === 'doing' ? 'repeat' : rel.status === 'done' ? 'check' : 'alert'" :size="15" :class="{ spin: rel.status === 'doing' }" />
          <template v-if="rel.status === 'doing'">
            进行中 · 第 {{ curKey ? stepMeta.find((s) => s.key === curKey).idx : doneStepsCount(rel) + 1 }}/{{ RELEASE_STEPS.length }} 步：{{ curKey ? stepLabel(curKey) : "收尾" }}
          </template>
          <template v-else-if="rel.status === 'done'">已发布 · {{ relativeTime(rel.finishedAt) }} 完成</template>
          <template v-else>发布失败 · {{ relativeTime(rel.finishedAt) }} 放弃</template>
        </p>

        <div class="step" v-for="s in stepMeta" :key="s.key" :class="{ dim: !s.done && !s.active }">
          <div class="step-head">
            <span class="step-no" :class="{ ok: s.done }"><Icon v-if="s.done" name="check" :size="12" /><template v-else>{{ s.idx }}</template></span>
            <span class="step-title">{{ s.label }}</span>
            <span v-if="s.active" class="step-tag doing">进行中</span>
            <span v-if="s.at" class="step-time">{{ relativeTime(s.at) }}</span>
          </div>
          <div v-if="s.active" class="step-body">
            <p class="hint">完成「{{ s.label }}」操作后点击右侧按钮记录时间</p>
            <button class="btn-primary sm" @click="markStep"><Icon name="check" :size="14" /> 标记「{{ s.label }}」完成</button>
          </div>
        </div>
      </template>

      <div class="modal-foot">
        <button class="btn-ghost" @click="close">关闭</button>
        <template v-if="!rel">
          <button class="btn-primary" @click="startRelease"><Icon name="upload" :size="15" /> 开始发布</button>
        </template>
        <template v-else-if="rel.status === 'doing'">
          <button class="btn-ghost danger" @click="abortRelease"><Icon name="x" :size="15" /> 放弃本次发布</button>
          <button v-if="!curKey" class="btn-primary" @click="markStep"><Icon name="check" :size="15" /> 完成最后一步</button>
        </template>
        <template v-else>
          <button class="btn-primary" @click="restartRelease"><Icon name="repeat" :size="15" /> 重新发布</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pub-modal { width: 560px; }
.pub-modal h2 { display: flex; align-items: center; gap: 8px; }
.pub-sub { margin: -6px 0 16px; font-size: var(--fs-md); color: var(--muted); }

.guide-box { border: 1px solid var(--border); border-radius: var(--r-md); padding: 12px 14px; margin-bottom: 10px; }
.guide-box p { margin: 0 0 10px; font-size: var(--fs-md); color: var(--muted); }
.preview-steps { display: flex; gap: 8px; flex-wrap: wrap; }
.preview-step { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: var(--r-pill); background: var(--primary-soft); color: var(--primary); font-size: var(--fs-sm); font-weight: 600; }

.status-line { display: flex; align-items: center; gap: 7px; margin: 0 0 12px; font-size: var(--fs-md); font-weight: 600; }
.status-line.ok { color: var(--success-deep); }
.status-line.bad { color: var(--danger-deep); }

.step { border: 1px solid var(--border); border-radius: var(--r-md); padding: 12px 14px; margin-bottom: 10px; transition: opacity 0.2s; }
.step.dim { opacity: 0.55; }
.step-head { display: flex; align-items: center; gap: 9px; }
.step-no { width: 22px; height: 22px; border-radius: var(--r-pill); background: var(--well); color: var(--text-soft); font-size: var(--fs-sm); font-weight: 700; display: grid; place-items: center; flex-shrink: 0; }
.step-no.ok { background: var(--success-deep); color: var(--text-invert); }
.step-title { font-size: var(--fs-base); font-weight: 600; }
.step-tag.doing { padding: 2px 9px; border-radius: var(--r-pill); background: var(--amber-soft); color: var(--warn-deep); font-size: var(--fs-xs); font-weight: 600; }
.step-time { margin-left: auto; font-size: var(--fs-xs); color: var(--muted); }
.step-body { margin-top: 10px; padding-left: 31px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.hint { margin: 0; font-size: var(--fs-md); color: var(--muted); }

.modal-foot .btn-ghost.danger { color: var(--danger); }
.modal-foot .btn-ghost.danger:hover { color: var(--danger-deep); background: var(--danger-soft); }

@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin 0.9s linear infinite; }

@media (prefers-color-scheme: dark) {
  .step-no { background: var(--well); color: var(--text-weak); }
  .step-tag.doing { background: var(--amber-soft); color: var(--amber-light); }
}
</style>
