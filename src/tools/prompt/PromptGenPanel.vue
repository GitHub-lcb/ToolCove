<script setup>
// 生成面板：三种后端（云端生图 / ComfyUI 内置文生图 / 自定义工作流）。
//
// 职责边界：
// - 面板只负责「组装参数 → 发起 → 展示进度/结果」；历史记录通过 history-add/history-update
//   事件交给外层持久化（单一写入口）；「存入库」也只 emit，不直接碰 repository。
// - 云端生图走 Rust 命令 prompt_image_generate（结果直接落 media/，bytes 不过 IPC）；
//   ComfyUI 走 comfyClient.runJob（提交→WS/轮询→流式落盘）。两边的「等待」都不挂单请求。
// - 参数面板直改共享的 config（外层 watch 后加密落盘）；seed「每次随机」在运行时才掷点。
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../../platform/invoke.js";
import { askConfirm } from "../../ui/confirm.js";
import Icon from "../../ui/Icon.vue";
import { buildSplitTxt2ImgWorkflow, buildTxt2ImgWorkflow, injectMapping, normalizeComfyBase, pickModelName, SAMPLER_OPTIONS, SCHEDULER_OPTIONS } from "./comfy.js";
import { cancelRemote, listModels, probe, runJob } from "./comfyClient.js";
import { cloudConfigReady, DEFAULT_GEN_CONFIG, genErrorKeyOf, mediaName, normalizeExt } from "./promptGen.js";
import { extractVariables, fillTemplate } from "./promptLib.js";
import PromptMediaCard from "./PromptMediaCard.vue";

const props = defineProps({
  prompt: { type: Object, default: null },
  fillSeq: { type: Number, default: 0 },
  runRequest: { type: Object, default: null },
  config: { type: Object, required: true },
  workflows: { type: Array, default: () => [] },
  showToast: { type: Function, default: () => {} },
});
const emit = defineEmits(["save-to-lib", "goto-settings", "history-add", "history-update"]);

const { t } = useI18n();
const toast = (message, options) => props.showToast(message, options);

const backend = ref("cloud"); // cloud | builtin | workflow
const positive = ref("");
const negative = ref("");
const varValues = ref({});
const running = ref(false);
const progress = ref({ step: 0, max: 0, pending: 0, downloading: "", wsLost: false });
const elapsed = ref(0);
const error = ref("");
const errorDetail = ref("");
const errorRows = ref([]);
const result = ref(null);
const currentPromptId = ref("");
const comfyState = ref({ probing: false, checked: false, ok: false, version: "", error: "" });
const models = ref({ checkpoints: [], diffusionModels: [], textEncoders: [], vaes: [], loras: [] });
// 本机 ComfyUI 的后端能力：有没有 Qwen 分体编码节点、CLIPLoader 支持哪些 type
const caps = ref({ qwenEncoder: false, clipTypes: [], clipType: "default" });

let abortController = null;
let elapsedTimer = null;
let runStartedAt = 0;

const vars = computed(() => extractVariables(positive.value, negative.value));
const filledPositive = computed(() => fillTemplate(positive.value, varValues.value));
const filledNegative = computed(() => fillTemplate(negative.value, varValues.value));
const cloudReady = computed(() => cloudConfigReady(props.config.cloud));
const selectedWorkflow = computed(() => props.workflows.find((w) => w.id === props.config.comfy.workflowId) || null);
// 内置文生图仍只支持整包 checkpoint；其余模型（扩散模型/CLIP/VAE）用于提示与自定义工作流。
const checkpoints = computed(() => models.value.checkpoints);
// 没有整包 checkpoint、但扩散模型 / 文本编码器 / VAE 都在：走分体式工作流（ComfyUI 里同样可直接跑）
const splitReady = computed(
  () =>
    !checkpoints.value.length &&
    models.value.diffusionModels.length > 0 &&
    models.value.textEncoders.length > 0 &&
    models.value.vaes.length > 0
);
const otherModels = computed(() => [
  { kind: "diffusionModels", list: models.value.diffusionModels },
  { kind: "textEncoders", list: models.value.textEncoders },
  { kind: "vaes", list: models.value.vaes },
  { kind: "loras", list: models.value.loras },
].filter((item) => item.list.length));
const progressPercent = computed(() =>
  progress.value.max > 0 ? Math.min(100, Math.round((progress.value.step / progress.value.max) * 100)) : 0
);

function seedValue() {
  const comfy = props.config.comfy;
  if (comfy.seedMode === "random") return Math.floor(Math.random() * 2 ** 31);
  return Math.max(0, Math.trunc(Number(comfy.seed) || 0));
}

function rerollSeed() {
  props.config.comfy.seed = Math.floor(Math.random() * 2 ** 31);
}

function fillFromPrompt() {
  positive.value = props.prompt?.positive ?? "";
  negative.value = props.prompt?.negative ?? "";
  varValues.value = {};
  error.value = "";
  errorDetail.value = "";
  errorRows.value = [];
  result.value = null;
}

watch(
  () => [props.prompt?.id ?? "", props.fillSeq],
  () => fillFromPrompt(),
  { immediate: true }
);

// 后台/其他窗口改库不清空面板编辑中的文本；只有「点选另一条/编辑保存」才刷新（id/fillSeq 变化驱动）

function formatElapsed(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 60_000) return `${Math.round(value / 100) / 10}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

function startTimer() {
  runStartedAt = Date.now();
  elapsed.value = 0;
  elapsedTimer = setInterval(() => {
    elapsed.value = Date.now() - runStartedAt;
  }, 1000);
}

function stopTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function newRecord(backendName, mode, pos, neg, params) {
  return {
    id: `pg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    status: "running",
    backend: backendName,
    mode,
    promptId: "",
    libraryId: props.prompt?.id ?? "",
    positive: pos,
    negative: neg,
    params,
    files: [],
    error: "",
    durationMs: 0,
  };
}

function showError(errorOrMessage) {
  const raw = typeof errorOrMessage === "string" ? errorOrMessage : String(errorOrMessage?.message ?? errorOrMessage);
  const text = t(genErrorKeyOf(errorOrMessage), { message: raw });
  error.value = text;
  errorDetail.value = text.includes(raw) ? "" : raw;
}

async function run() {
  if (running.value) return;
  error.value = "";
  errorDetail.value = "";
  errorRows.value = [];
  result.value = null;
  currentPromptId.value = "";
  const pos = filledPositive.value.output;
  if (!pos.trim()) {
    error.value = t("toolbox.prompt.editorRequired");
    return;
  }
  const neg = filledNegative.value.output;
  if (backend.value === "cloud") return runCloud(pos, neg);
  if (backend.value === "builtin") return runComfy("txt2img", pos, neg);
  return runComfy("workflow", pos, neg);
}

async function runCloud(pos, neg) {
  const cloud = props.config.cloud;
  if (!cloudConfigReady(cloud)) {
    error.value = t("toolbox.prompt.errConfig");
    return;
  }
  running.value = true;
  startTimer();
  const sendNeg = cloud.sendNegative ? neg : "";
  const record = newRecord("cloud", "cloud", pos, sendNeg, { model: cloud.model, size: cloud.size, n: cloud.n, sendNegative: cloud.sendNegative });
  emit("history-add", record);
  try {
    const res = await invoke("prompt_image_generate", {
      baseUrl: cloud.baseUrl,
      apiKey: cloud.apiKey,
      model: cloud.model,
      prompt: pos,
      negativePrompt: sendNeg,
      size: cloud.size,
      n: cloud.n,
    });
    const files = (Array.isArray(res?.files) ? res.files : []).map((file) => ({
      name: String(file?.name ?? ""),
      kind: "image",
      bytes: Number(file?.bytes) || 0,
    }));
    if (!files.length) throw new Error(t("toolbox.prompt.errNoImages"));
    result.value = { files, failed: [], backend: "cloud", mode: "cloud" };
    emit("history-update", { id: record.id, patch: { status: "done", files, durationMs: Number(res?.durationMs) || 0 } });
  } catch (e) {
    showError(e);
    emit("history-update", { id: record.id, patch: { status: "error", error: String(e?.message ?? e), durationMs: Date.now() - runStartedAt } });
  } finally {
    running.value = false;
    stopTimer();
  }
}

async function runComfy(mode, pos, neg) {
  const comfy = props.config.comfy;
  const base = normalizeComfyBase(comfy.baseUrl);
  const seed = seedValue();
  let workflow = null;
  if (mode === "txt2img") {
    if (comfy.checkpoint) {
      workflow = buildTxt2ImgWorkflow({
        checkpoint: comfy.checkpoint,
        positive: pos,
        negative: neg,
        width: comfy.width,
        height: comfy.height,
        steps: comfy.steps,
        cfg: comfy.cfg,
        seed,
        samplerName: comfy.sampler,
        scheduler: comfy.scheduler,
        denoise: comfy.denoise,
      });
    } else if (splitReady.value) {
      workflow = buildSplitTxt2ImgWorkflow({
        unet: comfy.unet,
        clip: comfy.clip,
        vae: comfy.vae,
        clipType: caps.value.clipType,
        encoder: caps.value.qwenEncoder ? "qwen" : "plain",
        positive: pos,
        negative: neg,
        width: comfy.width,
        height: comfy.height,
        steps: comfy.steps,
        cfg: comfy.cfg,
        seed,
        samplerName: comfy.sampler,
        scheduler: comfy.scheduler,
        denoise: comfy.denoise,
      });
    } else {
      error.value = t("toolbox.prompt.noCheckpointHint");
      return;
    }
  } else {
    const wf = selectedWorkflow.value;
    if (!wf) {
      error.value = t("toolbox.prompt.wfEmpty");
      return;
    }
    const injected = injectMapping(
      wf.workflow,
      wf.mapping,
      {
        positive: pos,
        negative: neg,
        seed,
        steps: comfy.steps,
        cfg: comfy.cfg,
        denoise: comfy.denoise,
        samplerName: comfy.sampler,
        scheduler: comfy.scheduler,
        width: comfy.width,
        height: comfy.height,
      },
      { overrideParams: Boolean(comfy.overrideParams) }
    );
    if (injected.skipped.includes("positive")) {
      error.value = t("toolbox.prompt.wfStale");
      return;
    }
    workflow = injected.workflow;
  }

  running.value = true;
  startTimer();
  progress.value = { step: 0, max: 0, pending: 0, downloading: "", wsLost: false };
  abortController = new AbortController();
  const params =
    mode === "txt2img"
      ? { checkpoint: comfy.checkpoint, width: comfy.width, height: comfy.height, steps: comfy.steps, cfg: comfy.cfg, sampler: comfy.sampler, scheduler: comfy.scheduler, denoise: comfy.denoise, seedMode: comfy.seedMode, seed: comfy.seed }
      : { workflowId: comfy.workflowId, workflowName: selectedWorkflow.value?.name ?? "", overrideParams: Boolean(comfy.overrideParams), seedMode: comfy.seedMode, seed: comfy.seed };
  const record = newRecord("comfy", mode, pos, neg, params);
  emit("history-add", record);
  let promptIdSaved = false;
  try {
    const res = await runJob({
      base,
      workflow,
      signal: abortController.signal,
      nameFor: (file) => mediaName(normalizeExt(file.filename)),
      onProgress: (event) => {
        if (event.promptId && !promptIdSaved) {
          promptIdSaved = true;
          currentPromptId.value = event.promptId;
          emit("history-update", { id: record.id, patch: { promptId: event.promptId } });
        }
        if (event.wsLost) progress.value.wsLost = true;
        if (event.status) progress.value.downloading = event.status === "downloading" ? `${event.index}/${event.total}` : "";
        if (event.step != null) progress.value.step = event.step;
        if (event.max != null) progress.value.max = event.max;
        if (event.pending != null) progress.value.pending = event.pending;
      },
    });
    currentPromptId.value = res.promptId || currentPromptId.value;
    const durationMs = Number(res.durationMs) || Date.now() - runStartedAt;
    if (res.status === "done") {
      result.value = { files: res.files, failed: res.failed, backend: "comfy", mode };
      emit("history-update", { id: record.id, patch: { status: "done", promptId: res.promptId, files: res.files, durationMs } });
    } else if (res.status === "canceled") {
      emit("history-update", { id: record.id, patch: { status: "canceled", durationMs } });
      toast(t("toolbox.prompt.canceled"));
    } else {
      let key = "toolbox.prompt.errTransport";
      if (res.code === "nodeErrors") {
        errorRows.value = res.nodeErrors;
        key = "toolbox.prompt.errNodeErrors";
      } else if (res.code === "timeout") key = "toolbox.prompt.errJobTimeout";
      else if (res.code === "noOutputs") key = "toolbox.prompt.errNoOutputs";
      else if (res.code === "downloadFailed") key = "toolbox.prompt.errDownloadFailed";
      else if (res.code === "execution") key = "toolbox.prompt.errExecution";
      error.value = t(key, { message: res.error });
      errorDetail.value = res.error && !error.value.includes(res.error) ? res.error : "";
      if (res.failed?.length) result.value = { files: [], failed: res.failed, backend: "comfy", mode };
      emit("history-update", { id: record.id, patch: { status: "error", error: res.error || res.code, durationMs } });
    }
  } catch (e) {
    showError(e);
    emit("history-update", { id: record.id, patch: { status: "error", error: String(e?.message ?? e), durationMs: Date.now() - runStartedAt } });
  } finally {
    running.value = false;
    abortController = null;
    stopTimer();
  }
}

async function cancel() {
  if (!running.value || backend.value === "cloud") return;
  const ok = await askConfirm({
    title: t("toolbox.prompt.cancelInterruptTitle"),
    message: t("toolbox.prompt.cancelInterruptMsg"),
    okText: t("toolbox.prompt.cancel"),
  });
  if (!ok) return;
  abortController?.abort();
  if (currentPromptId.value) {
    await cancelRemote(normalizeComfyBase(props.config.comfy.baseUrl), currentPromptId.value);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t("toolbox.prompt.copied"));
  } catch {
    toast(t("toolbox.prompt.copyFailed"));
  }
}

function saveToLib() {
  emit("save-to-lib", { positive: positive.value, negative: negative.value });
}

function pickModel(list, current, family = "") {
  return pickModelName(list, { current, family });
}

async function refreshComfy() {
  comfyState.value = { ...comfyState.value, probing: true };
  const probed = await probe(props.config.comfy.baseUrl);
  comfyState.value = { probing: false, checked: true, ok: probed.ok, version: probed.version, error: probed.error };
  if (!probed.ok) return;
  const list = await listModels(props.config.comfy.baseUrl);
  models.value = list.models;
  const comfy = props.config.comfy;
  if (!list.models.checkpoints.includes(comfy.checkpoint)) comfy.checkpoint = list.models.checkpoints[0] ?? "";
  caps.value = {
    qwenEncoder: list.classTypes?.includes("TextEncodeQwenImage21") === true,
    clipTypes: list.clipTypes ?? [],
    clipType: (list.clipTypes ?? []).some((type) => /qwen/i.test(type)) ? "qwen_image" : ((list.clipTypes ?? [])[0] ?? "default"),
  };
  if (!splitReady.value) return;
  // 分体式：以扩散模型为基准，挑同家族的编码器 / VAE（同目录常混装多套模型）。
  comfy.unet = pickModel(list.models.diffusionModels, comfy.unet);
  comfy.clip = pickModel(list.models.textEncoders, comfy.clip, comfy.unet);
  comfy.vae = pickModel(list.models.vaes, comfy.vae, comfy.unet);
  if (comfy.cfg === DEFAULT_GEN_CONFIG.comfy.cfg && comfy.scheduler === DEFAULT_GEN_CONFIG.comfy.scheduler) {
    comfy.cfg = 1;
    comfy.scheduler = "simple";
    comfy.steps = 25;
  }
}

onMounted(refreshComfy);

// 历史「重跑」：外层把 spec 放进 runRequest，这里应用后立即起跑
watch(
  () => props.runRequest?.seq,
  async () => {
    const spec = props.runRequest?.spec;
    if (!spec) return;
    backend.value = spec.backend;
    positive.value = spec.positive ?? "";
    negative.value = spec.negative ?? "";
    varValues.value = {};
    if (spec.params?.workflowId) props.config.comfy.workflowId = spec.params.workflowId;
    result.value = null;
    await run();
  }
);
</script>

<template>
  <div class="gen-panel">
    <div class="seg" data-role="gen-backend">
      <button
        type="button"
        :class="{ on: backend === 'cloud' }"
        :title="t('toolbox.prompt.backendCloudHint')"
        data-role="gen-backend-cloud"
        @click="backend = 'cloud'"
      >
        {{ t("toolbox.prompt.backendCloud") }}
      </button>
      <button
        type="button"
        :class="{ on: backend === 'builtin' }"
        :title="t('toolbox.prompt.backendBuiltinHint')"
        data-role="gen-backend-builtin"
        @click="backend = 'builtin'"
      >
        {{ t("toolbox.prompt.backendBuiltin") }}
      </button>
      <button
        type="button"
        :class="{ on: backend === 'workflow' }"
        :title="t('toolbox.prompt.backendWorkflowHint')"
        data-role="gen-backend-workflow"
        @click="backend = 'workflow'"
      >
        {{ t("toolbox.prompt.backendWorkflow") }}
      </button>
    </div>

    <div v-if="backend === 'cloud'" class="state-line" data-role="gen-cloud-state">
      <template v-if="cloudReady">
        <Icon name="check" :size="13" />
        <span>{{ t("toolbox.prompt.cloudReady", { model: config.cloud.model }) }}</span>
      </template>
      <template v-else>
        <Icon name="alert" :size="13" />
        <span>{{ t("toolbox.prompt.cloudNotReady") }}</span>
        <button type="button" class="link" data-role="gen-go-settings" @click="emit('goto-settings')">
          {{ t("toolbox.prompt.goSettings") }}
        </button>
      </template>
    </div>

    <div v-else class="comfy-block">
      <div class="state-line" data-role="comfy-state">
        <Icon :name="comfyState.ok ? 'check' : 'alert'" :size="13" />
        <span v-if="comfyState.probing">{{ t("toolbox.prompt.comfyProbing") }}</span>
        <span v-else-if="comfyState.ok">{{ t("toolbox.prompt.comfyOk", { version: comfyState.version || "ComfyUI" }) }}</span>
        <span v-else-if="comfyState.checked">{{ t("toolbox.prompt.comfyFail") }}</span>
        <span v-else>{{ t("toolbox.prompt.comfyProbe") }}</span>
        <button type="button" class="link" data-role="comfy-probe" @click="refreshComfy">{{ t("toolbox.prompt.comfyProbe") }}</button>
      </div>
      <p v-if="comfyState.checked && !comfyState.ok" class="hint hint-warn">{{ t("toolbox.prompt.comfyFailHint") }}</p>
      <p v-if="comfyState.checked && !comfyState.ok && comfyState.error" class="hint detail" data-role="comfy-error-detail">
        {{ comfyState.error }}
      </p>

      <label v-if="backend === 'builtin' && checkpoints.length" class="field">
        <span>{{ t("toolbox.prompt.checkpoint") }}</span>
        <select v-model="config.comfy.checkpoint" data-role="comfy-checkpoint">
          <option v-for="name in checkpoints" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>

      <template v-if="backend === 'builtin' && !checkpoints.length && splitReady">
        <p class="hint" data-role="comfy-split-hint">{{ t("toolbox.prompt.splitHint") }}</p>
        <label class="field">
          <span>{{ t("toolbox.prompt.splitUnet") }}</span>
          <select v-model="config.comfy.unet" data-role="comfy-unet">
            <option v-for="name in models.diffusionModels" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label class="field">
          <span>{{ t("toolbox.prompt.splitClip") }}</span>
          <select v-model="config.comfy.clip" data-role="comfy-clip">
            <option v-for="name in models.textEncoders" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label class="field">
          <span>{{ t("toolbox.prompt.splitVae") }}</span>
          <select v-model="config.comfy.vae" data-role="comfy-vae">
            <option v-for="name in models.vaes" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
      </template>

      <p v-if="backend === 'builtin' && comfyState.ok && !checkpoints.length && !splitReady" class="hint hint-warn" data-role="comfy-no-checkpoint">
        {{ t("toolbox.prompt.noCheckpointHint") }}
      </p>
      <div v-if="comfyState.ok && otherModels.length" class="model-scan" data-role="comfy-models">
        <p class="hint">{{ t("toolbox.prompt.modelsFound") }}</p>
        <p v-for="group in otherModels" :key="group.kind" class="model-line">
          <span class="model-kind">{{ t(`toolbox.prompt.model_${group.kind}`) }}（{{ group.list.length }}）</span>
          <span class="model-names">{{ group.list.join("、") }}</span>
        </p>
        <p v-if="!checkpoints.length && !splitReady" class="hint">{{ t("toolbox.prompt.modelsNoCheckpoint") }}</p>
      </div>

      <label v-if="backend === 'workflow'" class="field">
        <span>{{ t("toolbox.prompt.wfSelect") }}</span>
        <select v-model="config.comfy.workflowId" data-role="wf-select">
          <option value="">{{ t("toolbox.prompt.wfEmpty") }}</option>
          <option v-for="wf in workflows" :key="wf.id" :value="wf.id">{{ wf.name }}</option>
        </select>
      </label>

      <div class="params">
        <label v-if="backend === 'builtin' || config.comfy.overrideParams" class="field small">
          <span>{{ t("toolbox.prompt.width") }}</span>
          <input v-model.number="config.comfy.width" type="number" min="64" max="4096" step="64" data-role="gen-width" />
        </label>
        <label v-if="backend === 'builtin' || config.comfy.overrideParams" class="field small">
          <span>{{ t("toolbox.prompt.height") }}</span>
          <input v-model.number="config.comfy.height" type="number" min="64" max="4096" step="64" data-role="gen-height" />
        </label>
        <label v-if="backend === 'builtin' || config.comfy.overrideParams" class="field small">
          <span>{{ t("toolbox.prompt.steps") }}</span>
          <input v-model.number="config.comfy.steps" type="number" min="1" max="150" data-role="gen-steps" />
        </label>
        <label v-if="backend === 'builtin' || config.comfy.overrideParams" class="field small">
          <span>{{ t("toolbox.prompt.cfg") }}</span>
          <input v-model.number="config.comfy.cfg" type="number" min="0" max="30" step="0.5" data-role="gen-cfg" />
        </label>
        <label v-if="backend === 'builtin' || config.comfy.overrideParams" class="field small">
          <span>{{ t("toolbox.prompt.sampler") }}</span>
          <select v-model="config.comfy.sampler" data-role="gen-sampler">
            <option v-for="name in SAMPLER_OPTIONS" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label v-if="backend === 'builtin' || config.comfy.overrideParams" class="field small">
          <span>{{ t("toolbox.prompt.scheduler") }}</span>
          <select v-model="config.comfy.scheduler" data-role="gen-scheduler">
            <option v-for="name in SCHEDULER_OPTIONS" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
      </div>

      <label v-if="backend === 'workflow'" class="check">
        <input v-model="config.comfy.overrideParams" type="checkbox" data-role="wf-override" />
        <span>{{ t("toolbox.prompt.wfOverride") }}</span>
      </label>
      <p v-if="backend === 'workflow' && !config.comfy.overrideParams" class="hint">{{ t("toolbox.prompt.wfOverrideTip") }}</p>

      <div class="seed-row">
        <label class="field small">
          <span>{{ t("toolbox.prompt.seed") }}</span>
          <select v-model="config.comfy.seedMode" data-role="gen-seed-mode">
            <option value="random">{{ t("toolbox.prompt.seedRandom") }}</option>
            <option value="fixed">{{ t("toolbox.prompt.seedFixed") }}</option>
          </select>
        </label>
        <template v-if="config.comfy.seedMode === 'fixed'">
          <input v-model.number="config.comfy.seed" type="number" min="0" class="seed-input" data-role="gen-seed" />
          <button type="button" class="mini" :title="t('toolbox.prompt.seedRefresh')" data-role="gen-seed-refresh" @click="rerollSeed">
            <Icon name="refresh" :size="13" />
          </button>
        </template>
      </div>
    </div>

    <div class="prompt-block">
      <label class="field">
        <span class="row-between">
          <span>{{ t("toolbox.prompt.editorPositive") }}</span>
          <button type="button" class="link" data-role="gen-copy-positive" @click="copyText(filledPositive.output)">
            {{ t("toolbox.prompt.copyPositive") }}
          </button>
        </span>
        <textarea v-model="positive" rows="4" :placeholder="t('toolbox.prompt.editorPositivePh')" data-role="gen-positive"></textarea>
      </label>
      <label class="field">
        <span class="row-between">
          <span>{{ t("toolbox.prompt.editorNegative") }}</span>
          <button type="button" class="link" data-role="gen-copy-negative" @click="copyText(filledNegative.output)">
            {{ t("toolbox.prompt.copyNegative") }}
          </button>
        </span>
        <textarea v-model="negative" rows="2" :placeholder="t('toolbox.prompt.editorNegativePh')" data-role="gen-negative"></textarea>
      </label>
      <div class="vars" data-role="gen-vars">
        <div class="vars-head">{{ t("toolbox.prompt.varsTitle") }}</div>
        <p v-if="!vars.length" class="hint">{{ t("toolbox.prompt.varsEmpty") }}</p>
        <template v-else>
          <p class="hint">{{ t("toolbox.prompt.varsHint") }}</p>
          <label v-for="name in vars" :key="name" class="field small var-field">
            <span>{{ name }}</span>
            <input v-model="varValues[name]" type="text" :data-role="'gen-var-' + name" />
          </label>
          <p v-if="filledPositive.missing.length || filledNegative.missing.length" class="hint hint-warn" data-role="gen-var-missing">
            {{ t("toolbox.prompt.varMissing", { names: [...new Set([...filledPositive.missing, ...filledNegative.missing])].join("、") }) }}
          </p>
        </template>
      </div>
    </div>

    <div class="run-row">
      <button type="button" class="primary" :disabled="running" data-role="gen-run" @click="run">
        <Icon name="wand" :size="14" />
        {{ running ? t("toolbox.prompt.running") : t("toolbox.prompt.run") }}
      </button>
      <button v-if="running && backend !== 'cloud'" type="button" class="ghost" data-role="gen-cancel" @click="cancel">
        {{ t("toolbox.prompt.cancel") }}
      </button>
      <span v-if="running" class="elapsed" data-role="gen-elapsed">{{ t("toolbox.prompt.elapsed", { time: formatElapsed(elapsed) }) }}</span>
    </div>

    <div v-if="running" class="progress" data-role="gen-progress">
      <div class="bar" :class="{ indet: !progress.max }">
        <div class="fill" :style="progress.max ? { width: progressPercent + '%' } : {}"></div>
      </div>
      <div class="progress-text" data-role="gen-progress-text">
        <span v-if="progress.max">{{ t("toolbox.prompt.progressStep", { value: progress.step, max: progress.max }) }}</span>
        <span v-else>{{ t("toolbox.prompt.progressIndeterminate") }}</span>
        <span v-if="progress.pending" data-role="gen-queue">{{ t("toolbox.prompt.progressQueued", { n: progress.pending }) }}</span>
        <span v-if="progress.downloading">{{ t("toolbox.prompt.progressDownloading", { index: progress.downloading.split("/")[0], total: progress.downloading.split("/")[1] }) }}</span>
      </div>
      <p v-if="progress.wsLost" class="hint">{{ t("toolbox.prompt.wsLost") }}</p>
    </div>

    <p v-if="error" class="hint hint-error" data-role="gen-error">{{ error }}</p>
    <p v-if="errorDetail" class="hint detail" data-role="gen-error-detail">{{ errorDetail }}</p>
    <ul v-if="errorRows.length" class="nodes" data-role="gen-err-nodes">
      <li v-for="row in errorRows" :key="row.node + row.message">#{{ row.node }} ({{ row.classType }})：{{ row.message }}</li>
    </ul>

    <div v-if="result" class="result" data-role="gen-result">
      <div class="result-head">
        <span>{{ t("toolbox.prompt.resultTitle") }}</span>
        <button type="button" class="link" data-role="gen-save-lib" @click="saveToLib">{{ t("toolbox.prompt.saveToLib") }}</button>
      </div>
      <div v-if="result.files.length" class="media-grid">
        <PromptMediaCard v-for="file in result.files" :key="file.name" :name="file.name" :kind="file.kind" :show-toast="showToast" />
      </div>
      <p v-if="result.failed?.length" class="hint hint-warn">
        {{ t("toolbox.prompt.errDownloadFailed") }}：{{ result.failed.map((f) => f.filename).join("、") }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.gen-panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 0;
}
.seg {
  display: flex;
  gap: var(--sp-05);
  background: var(--well);
  border-radius: var(--r-sm, 8px);
  padding: 3px;
}
.seg button {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text-weak);
  font-size: var(--fs-sm);
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-xs, 6px);
  cursor: pointer;
}
.seg button.on {
  background: var(--card);
  color: var(--text);
  box-shadow: var(--shadow);
}
.state-line {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-sm);
  color: var(--text-weak);
}
.comfy-block {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-05);
  font-size: var(--fs-sm);
  color: var(--text-weak);
  min-width: 0;
}
.field.small {
  max-width: 200px;
}
.row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.params {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.seed-row {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-1);
}
.seed-input {
  max-width: 140px;
}
.check {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-sm);
  color: var(--text-weak);
}
.prompt-block {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.vars {
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm, 8px);
  padding: var(--sp-2) var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  background: var(--card-soft, transparent);
}
.vars-head {
  font-size: var(--fs-sm);
  color: var(--text);
  font-weight: 600;
}
.var-field {
  display: grid;
  grid-template-columns: minmax(60px, 160px) 1fr;
  align-items: center;
  gap: var(--sp-2);
  max-width: none;
}
.hint {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-weak);
}
.hint-warn {
  color: var(--warn);
}
.hint-error {
  color: var(--danger);
  font-size: var(--fs-sm);
}
.hint.detail {
  color: var(--text-weak);
  word-break: break-all;
}
.model-scan {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  background: var(--well);
  border-radius: var(--r-sm, 8px);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.model-line {
  margin: 0;
  font-size: var(--fs-xs);
  display: flex;
  gap: var(--sp-2);
  min-width: 0;
}
.model-kind {
  flex: none;
  color: var(--text-weak);
}
.model-names {
  color: var(--text);
  word-break: break-all;
}
.nodes {
  margin: 0;
  padding-left: 18px;
  font-size: var(--fs-sm);
  color: var(--danger);
}
.run-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.primary {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  background: var(--primary);
  color: var(--text-invert);
  border: none;
  border-radius: var(--r-sm, 8px);
  padding: var(--sp-2) var(--sp-6);
  font-size: var(--fs-base);
  cursor: pointer;
}
.primary:hover {
  background: var(--primary-hover);
}
.primary:disabled {
  opacity: 0.6;
  cursor: default;
}
.ghost {
  border: 1px solid var(--border);
  border-radius: var(--r-sm, 8px);
  background: transparent;
  color: var(--text);
  padding: 7px var(--sp-4);
  font-size: var(--fs-sm);
  cursor: pointer;
}
.ghost:hover {
  background: var(--ghost);
}
.elapsed {
  font-size: var(--fs-sm);
  color: var(--text-weak);
}
.progress {
  display: flex;
  flex-direction: column;
  gap: var(--sp-05);
}
.bar {
  height: 6px;
  background: var(--well);
  border-radius: var(--r-pill, 999px);
  overflow: hidden;
}
.bar .fill {
  height: 100%;
  background: var(--primary);
  transition: width 0.3s ease;
}
.bar.indet .fill {
  width: 35%;
  animation: indeterminate 1.2s ease-in-out infinite;
}
@keyframes indeterminate {
  0% {
    margin-left: 0;
  }
  100% {
    margin-left: 65%;
  }
}
.progress-text {
  display: flex;
  gap: var(--sp-4);
  font-size: var(--fs-xs);
  color: var(--text-weak);
}
.result {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-sm);
  font-weight: 600;
}
.media-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--sp-2);
}
.link {
  border: none;
  background: transparent;
  color: var(--primary);
  font-size: var(--fs-sm);
  cursor: pointer;
  padding: 0;
}
.link:hover {
  text-decoration: underline;
}
.mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: var(--r-xs, 6px);
  background: transparent;
  color: var(--text-weak);
  cursor: pointer;
}
.mini:hover {
  background: var(--ghost);
  color: var(--text);
}
textarea,
input,
select {
  font: inherit;
  font-size: var(--fs-sm);
  color: var(--text);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-xs, 6px);
  padding: var(--sp-1) var(--sp-2);
  min-width: 0;
}
textarea {
  resize: vertical;
}
</style>
