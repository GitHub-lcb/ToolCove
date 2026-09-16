<script setup>
// 标签打印（TSPL）：表单 → Rust 排版引擎 → 预览绘制模型 + TSPL 指令 + 打印前体检。
// 排版和指令生成只有 Rust 一份实现（src-tauri/src/label.rs），预览画的就是实打的那份坐标，
// 所以「所见即所打」。移植自 print-tool（佳博 GP-2120TF 标签打印工具）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import { invoke } from "../platform/invoke.js";
import { save as saveDialog } from "../platform/dialog.js";
import { isDesktop } from "../platform/env.js";
import { loadToolbox, saveToolbox, flushToolbox } from "../toolboxStore.js";
import {
  ALIGN_OPTIONS, DEFAULT_SETTINGS, ECC_OPTIONS, FONT_OPTIONS, LABEL_PRESETS, LIMITS,
  MEDIA_OPTIONS, SYMBOLOGY_OPTIONS, VALIGN_OPTIONS,
  formatBytes, issueMessage, normalizeSettings, plainSettings, previewGeometry, printerLabel, sourceLines,
} from "../labelTool.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const STORE_KEY = "label";
const LAYOUT_DEBOUNCE = 60;

const settings = ref(normalizeSettings(DEFAULT_SETTINGS));
const render = ref(null);
const busy = ref({ print: false, export: false });
const status = ref("");
const printers = ref([]);
const printerState = ref({ loading: false, error: "" });
const benchRef = ref(null);
const canvasRef = ref(null);
const previewGeo = ref({ scale: 1, pxPerMm: 8, cssW: 0, cssH: 0, gapPx: 0 });
// 折叠区展开状态：新增一项只改这里与模板，不用再加一组 ref
const sectionOpen = ref({ barcode: false, qr: false, paper: false });

const items = computed(() => render.value?.items ?? []);
const issues = computed(() => render.value?.issues ?? []);
const tsplLines = computed(() => sourceLines(render.value?.source));
const qrInfo = computed(() => {
  const qr = settings.value.job.qr;
  const modules = items.value.find((i) => i.kind === "qr")?.size ?? 0;
  if (!modules) return t("toolbox.label.qrInfoEmpty");
  return t("toolbox.label.qrInfo", {
    n: modules,
    size: modules * qr.cell,
    quiet: 4 * qr.cell,
  });
});
const presetKey = computed(() => {
  const { widthMm, heightMm, gapMm } = settings.value.label;
  const hit = LABEL_PRESETS.find((p) => p.widthMm === widthMm && p.heightMm === heightMm && p.gapMm === gapMm);
  return hit ? `${hit.widthMm}x${hit.heightMm}` : "custom";
});
const canPrint = computed(() => isDesktop && !!settings.value.printer && !busy.value.print);
const gapBandMm = computed(() => (settings.value.label.media === "gap" ? settings.value.label.gapMm : 0));
// 底纹一格 = 1 毫米（1mm = 8 点为 203dpi 的事实）；缩放过于极端时退回固定间距，
// 并如实把提示改成「点阵示意」，不谎报尺寸
const latticeExact = computed(() => previewGeo.value.pxPerMm >= 3 && previewGeo.value.pxPerMm <= 40);
const latticePx = computed(() => (latticeExact.value ? previewGeo.value.pxPerMm : 8));

// ---------------------------------------------------------------- 设置存取
let layoutTimer = null;

async function init() {
  try {
    const saved = await loadToolbox(STORE_KEY, null, { onError: (e) => console.error(e) });
    settings.value = normalizeSettings(saved);
  } catch (e) {
    props.showToast(t("toolbox.label.loadFailed", { err: errorText(e) }));
  }
  await loadPrinters();
  scheduleLayout(0);
}

function persist() {
  saveToolbox(STORE_KEY, plainSettings(settings.value), {
    onError: (e) => props.showToast(t("toolbox.label.persistFailed", { err: errorText(e.detail?.error ?? e) })),
  });
}

// ---------------------------------------------------------------- 打印机
async function loadPrinters() {
  if (!isDesktop) {
    printerState.value = { loading: false, error: t("toolbox.label.needDesktop") };
    return;
  }
  printerState.value = { loading: true, error: "" };
  try {
    const data = await invoke("label_printers");
    printers.value = data?.printers ?? [];
    printerState.value = { loading: false, error: "" };
    // 已选打印机不在了（换 USB 口会变成「副本 1」）就跟随建议值
    const names = printers.value.map((p) => p.name);
    if (!names.includes(settings.value.printer)) {
      settings.value.printer = data?.suggested || names[0] || "";
    }
  } catch (e) {
    printerState.value = { loading: false, error: errorText(e) };
  }
}

// ---------------------------------------------------------------- 排版与预览
function scheduleLayout(delay = LAYOUT_DEBOUNCE) {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(runLayout, delay);
}

async function runLayout() {
  if (!isDesktop) return;
  try {
    render.value = await invoke("label_layout", { settings: plainSettings(settings.value) });
    await nextTick();
    drawPreview();
  } catch (e) {
    status.value = errorText(e);
  }
}

/** 把绘制模型画到 canvas：标签内只有纯黑与纯白（热敏机是 1 位输出，画不出灰阶）。 */
function drawPreview() {
  const canvas = canvasRef.value;
  const bench = benchRef.value;
  const data = render.value;
  if (!canvas || !bench || !data) return;

  const geo = previewGeometry({
    benchWidth: bench.clientWidth || 380,
    dotW: data.canvasW,
    dotH: data.canvasH,
    widthMm: settings.value.label.widthMm,
    gapDots: data.gapDots,
  });
  previewGeo.value = geo;

  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${geo.cssW}px`;
  canvas.style.height = `${geo.cssH}px`;
  canvas.width = Math.max(1, Math.round(geo.cssW * dpr));
  canvas.height = Math.max(1, Math.round(geo.cssH * dpr));

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, geo.cssW, geo.cssH);

  // 对齐到设备像素，细条和二维码模块才不会被抗锯齿糊掉
  const snap = (dot) => Math.round(dot * geo.scale * dpr) / dpr;
  const hair = 1 / dpr;

  // 标签边界（安全区描边）
  ctx.strokeStyle = "rgba(22,24,29,0.16)";
  ctx.lineWidth = hair;
  ctx.strokeRect(hair / 2, hair / 2, geo.cssW - hair, geo.cssH - hair);

  for (const item of data.items) {
    if (item.kind === "text") {
      drawTextItem(ctx, item, geo.scale);
      continue;
    }

    ctx.fillStyle = "#000";

    if (item.kind === "barcode") {
      const x0 = snap(item.x);
      const y0 = snap(item.y);
      const barH = Math.max(snap(item.y + item.height) - y0, hair);

      if (!item.modules.length) {
        drawPlaceholder(ctx, x0, y0, Math.max(snap(item.width) || snap(120), hair), barH, hair);
        continue;
      }

      for (let i = 0; i < item.modules.length; i++) {
        if (!item.modules[i]) continue;
        const bx = snap(item.x + i * item.narrow);
        const bw = Math.max(snap(item.x + (i + 1) * item.narrow) - bx, hair);
        ctx.fillRect(bx, y0, bw, barH);
      }

      if (item.label) {
        ctx.font = `${Math.max(item.labelSize * geo.scale, 6)}px "SimSun", "Microsoft YaHei", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(item.label, snap(item.x + item.width / 2), y0 + barH + hair);
        ctx.textAlign = "left";
      }
      continue;
    }

    // 二维码
    const n = item.size || 1;
    for (let i = 0; i < item.bits.length; i++) {
      if (!item.bits[i]) continue;
      const col = i % n;
      const row = Math.floor(i / n);
      const bx = snap(item.x + col * item.cell);
      const by = snap(item.y + row * item.cell);
      const bw = Math.max(snap(item.x + (col + 1) * item.cell) - bx, hair);
      const bh = Math.max(snap(item.y + (row + 1) * item.cell) - by, hair);
      ctx.fillRect(bx, by, bw, bh);
    }
  }
}

/** 内容无法本地编码时的占位：黑色虚线框，不引入灰阶。 */
function drawPlaceholder(ctx, x, y, w, h, hair) {
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = hair;
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(x + hair / 2, y + hair / 2, Math.max(w - hair, hair), Math.max(h - hair, hair));
  ctx.setLineDash([]);
  ctx.font = `${Math.min(Math.max(h * 0.4, 8), 11)}px "Microsoft YaHei", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#000";
  ctx.fillText(t("toolbox.label.noLocalPreview"), x + w / 2, y + h / 2);
  ctx.restore();
}

/**
 * 打印机的字是固定点阵（中文 24×24、半角 12×24），浏览器字体是变宽的。
 * 按 Rust 算出的点阵宽度做一次横向缩放，让预览的占位和实打基本一致。
 */
function drawTextItem(ctx, item, scale) {
  if (!item.text) return;
  const sizePx = Math.max(item.size * scale, 4);
  ctx.font = `${sizePx}px "SimSun", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#000";

  const target = item.width * scale;
  const measured = ctx.measureText(item.text).width;
  const k = measured > 0 ? target / measured : 1;

  if (Number.isFinite(k) && k > 0.35 && k < 2.6 && Math.abs(k - 1) > 0.02) {
    ctx.save();
    ctx.translate(item.x * scale, item.y * scale);
    ctx.scale(k, 1);
    ctx.fillText(item.text, 0, 0);
    ctx.restore();
  } else {
    ctx.fillText(item.text, item.x * scale, item.y * scale);
  }
}

// ---------------------------------------------------------------- 动作
async function printLabel() {
  if (!isDesktop) return props.showToast(t("toolbox.label.needDesktop"));
  if (!settings.value.printer) return props.showToast(t("toolbox.label.statusNoPrinter"));
  if (busy.value.print) return;
  busy.value.print = true;
  status.value = t("toolbox.label.printing");
  try {
    const r = await invoke("label_print", { settings: plainSettings(settings.value) });
    status.value = t("toolbox.label.printed", {
      bytes: formatBytes(r.bytes),
      printer: r.printer,
      ms: r.elapsedMs,
      copies: r.copies,
    });
    props.showToast(t("toolbox.label.printDone"));
  } catch (e) {
    status.value = t("toolbox.label.printFailed", { err: errorText(e) });
  } finally {
    busy.value.print = false;
    scheduleLayout(0);
  }
}

async function exportPrn() {
  if (!isDesktop) return props.showToast(t("toolbox.label.needDesktop"));
  if (busy.value.export) return;
  busy.value.export = true;
  try {
    const path = await saveDialog({
      title: t("toolbox.label.exportTitle"),
      defaultPath: "label.prn",
      filters: [{ name: "PRN", extensions: ["prn"] }],
    });
    if (!path) return;
    const saved = await invoke("label_export_prn", { settings: plainSettings(settings.value), path });
    status.value = t("toolbox.label.exported", { path: saved });
    props.showToast(t("toolbox.label.exported", { path: saved }));
  } catch (e) {
    props.showToast(t("toolbox.label.exportFailed", { err: errorText(e) }));
  } finally {
    busy.value.export = false;
  }
}

async function copySource() {
  try {
    await navigator.clipboard.writeText(render.value?.source ?? "");
    props.showToast(t("toolbox.label.tsplCopied"));
  } catch (e) {
    props.showToast(t("toolbox.label.copyFailed", { err: errorText(e) }));
  }
}

function applyPreset(key) {
  const preset = LABEL_PRESETS.find((p) => `${p.widthMm}x${p.heightMm}` === key);
  if (!preset) return;
  Object.assign(settings.value.label, {
    widthMm: preset.widthMm,
    heightMm: preset.heightMm,
    gapMm: preset.gapMm,
    media: "gap",
  });
}

/**
 * 折叠区开合：展开后把整块滚进可视区。
 * 展开的区块（尤其二维码/纸张）比可视区高，不滚一下就会出现「展开了却看不全」。
 */
function onSectionToggle(event, key) {
  const open = event.target.open;
  sectionOpen.value[key] = open;
  if (open) event.target.scrollIntoView({ block: "nearest" });
}

function resetLabel() {
  Object.assign(settings.value.label, JSON.parse(JSON.stringify(DEFAULT_SETTINGS.label)));
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function onKeydown(event) {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    printLabel();
  }
}

// ---------------------------------------------------------------- 生命周期
let observer = null;

watch(
  settings,
  () => {
    persist();
    scheduleLayout();
  },
  { deep: true }
);

// 勾选条码/二维码时顺手展开区块，避免「勾了却没看到字段」
watch(
  () => settings.value.job.barcode.enabled,
  (on) => {
    if (on) sectionOpen.value.barcode = true;
  }
);
watch(
  () => settings.value.job.qr.enabled,
  (on) => {
    if (on) sectionOpen.value.qr = true;
  }
);

onMounted(async () => {
  await init();
  window.addEventListener("keydown", onKeydown);
  observer = new ResizeObserver(() => drawPreview());
  if (benchRef.value) observer.observe(benchRef.value);
});

onBeforeUnmount(() => {
  clearTimeout(layoutTimer);
  window.removeEventListener("keydown", onKeydown);
  observer?.disconnect();
  observer = null;
  flushToolbox(STORE_KEY);
});
</script>

<template>
  <div class="label-tool">
    <!-- 顶栏：目标打印机 -->
    <header class="lab-bar">
      <label class="field grow">
        <span>{{ t("toolbox.label.printerLabel") }}</span>
        <select v-model="settings.printer" :disabled="!printers.length">
          <option v-if="!printers.length" value="">{{ t("toolbox.label.printerEmpty") }}</option>
          <option v-for="printer in printers" :key="printer.name" :value="printer.name">
            {{ printerLabel(printer, t("toolbox.label.printerDefault")) }}
          </option>
        </select>
      </label>
      <button class="btn-ghost sm" type="button" :disabled="printerState.loading" @click="loadPrinters">
        <Icon name="refresh" :size="14" />{{ t("toolbox.label.printerRefresh") }}
      </button>
      <span v-if="printerState.error" class="bar-error" :title="printerState.error"><Icon name="alert" :size="14" />{{ printerState.error }}</span>
      <span v-else-if="render && !render.printerOk" class="bar-warn"><Icon name="alert" :size="14" />{{ t("toolbox.label.printerSuspect") }}</span>
    </header>

    <div class="lab-body">
      <!-- 左：内容与设置 -->
      <section class="lab-editor">
        <article class="panel">
          <header class="panel-head">
            <b>{{ t("toolbox.label.textTitle") }}</b>
            <span>{{ t("toolbox.label.textHint") }}</span>
          </header>
          <div class="panel-body">
            <textarea
              v-model="settings.job.text"
              class="text-input"
              rows="4"
              spellcheck="false"
              :placeholder="t('toolbox.label.textPh')"
              :aria-label="t('toolbox.label.textTitle')"
            ></textarea>

            <div class="grid">
              <label class="field">
                <span>{{ t("toolbox.label.font") }}</span>
                <select v-model="settings.job.font">
                  <option v-for="font in FONT_OPTIONS" :key="font.value" :value="font.value">{{ t(font.labelKey) }}</option>
                </select>
              </label>

              <div class="field">
                <span>{{ t("toolbox.label.scale") }}</span>
                <div class="inline">
                  <label class="mini">{{ t("toolbox.label.scaleX") }}
                    <input v-model.number="settings.job.xMult" type="number" :min="LIMITS.xMult[0]" :max="LIMITS.xMult[1]" />
                  </label>
                  <label class="mini">{{ t("toolbox.label.scaleY") }}
                    <input v-model.number="settings.job.yMult" type="number" :min="LIMITS.yMult[0]" :max="LIMITS.yMult[1]" />
                  </label>
                </div>
              </div>

              <div class="field">
                <span>{{ t("toolbox.label.align") }}</span>
                <div class="seg" role="group" :aria-label="t('toolbox.label.align')">
                  <button v-for="a in ALIGN_OPTIONS" :key="a" type="button" :class="{ on: settings.job.align === a }" @click="settings.job.align = a">
                    {{ t(`toolbox.label.align_${a}`) }}
                  </button>
                </div>
              </div>

              <div class="field">
                <span>{{ t("toolbox.label.valign") }}</span>
                <div class="seg" role="group" :aria-label="t('toolbox.label.valign')">
                  <button v-for="v in VALIGN_OPTIONS" :key="v" type="button" :class="{ on: settings.job.valign === v }" @click="settings.job.valign = v">
                    {{ t(`toolbox.label.valign_${v}`) }}
                  </button>
                </div>
              </div>

              <label class="field">
                <span>{{ t("toolbox.label.lineGap") }}</span>
                <input v-model.number="settings.job.lineGap" type="number" :min="LIMITS.lineGap[0]" :max="LIMITS.lineGap[1]" />
              </label>

              <label class="field">
                <span>{{ t("toolbox.label.blockGap") }}</span>
                <input v-model.number="settings.job.blockGap" type="number" :min="LIMITS.blockGap[0]" :max="LIMITS.blockGap[1]" />
              </label>
            </div>
          </div>
        </article>

        <!-- 一维条码 -->
        <details class="panel" :open="sectionOpen.barcode" @toggle="onSectionToggle($event, 'barcode')">
          <summary class="panel-head">
            <Icon name="chevron-right" :size="14" class="chev" />
            <b>{{ t("toolbox.label.barcodeTitle") }}</b>
            <span>{{ settings.job.barcode.enabled ? t("toolbox.label.barcodeOn") : t("toolbox.label.barcodeOff") }}</span>
          </summary>
          <div class="panel-body">
            <label class="switch">
              <input v-model="settings.job.barcode.enabled" type="checkbox" />
              <span>{{ t("toolbox.label.barcodeEnable") }}</span>
            </label>
            <div class="grid" :class="{ dim: !settings.job.barcode.enabled }">
              <label class="field wide">
                <span>{{ t("toolbox.label.barcodeSym") }}</span>
                <select v-model="settings.job.barcode.symbology">
                  <option v-for="s in SYMBOLOGY_OPTIONS" :key="s" :value="s">{{ t(`toolbox.label.sym_${s}`) }}</option>
                </select>
              </label>
              <label class="field wide">
                <span>{{ t("toolbox.label.barcodeData") }}</span>
                <input v-model="settings.job.barcode.data" type="text" spellcheck="false" :placeholder="t('toolbox.label.barcodeDataPh')" />
              </label>
              <label class="field">
                <span>{{ t("toolbox.label.barcodeHeight") }}</span>
                <input v-model.number="settings.job.barcode.height" type="number" :min="LIMITS.barcodeHeight[0]" :max="LIMITS.barcodeHeight[1]" />
              </label>
              <label class="field">
                <span>{{ t("toolbox.label.barcodeNarrow") }}</span>
                <input v-model.number="settings.job.barcode.narrow" type="number" :min="LIMITS.barcodeNarrow[0]" :max="LIMITS.barcodeNarrow[1]" />
              </label>
              <label class="field">
                <span>{{ t("toolbox.label.barcodeWide") }}</span>
                <input v-model.number="settings.job.barcode.wide" type="number" :min="LIMITS.barcodeWide[0]" :max="LIMITS.barcodeWide[1]" />
              </label>
              <div class="field">
                <span>{{ t("toolbox.label.align") }}</span>
                <div class="seg" role="group" :aria-label="t('toolbox.label.barcodeAlign')">
                  <button v-for="a in ALIGN_OPTIONS" :key="a" type="button" :class="{ on: settings.job.barcode.align === a }" @click="settings.job.barcode.align = a">
                    {{ t(`toolbox.label.align_${a}`) }}
                  </button>
                </div>
              </div>
              <label class="switch span-2">
                <input v-model="settings.job.barcode.readable" type="checkbox" />
                <span>{{ t("toolbox.label.barcodeReadable") }}</span>
              </label>
            </div>
            <p v-if="render && settings.job.barcode.enabled && settings.job.barcode.data.trim() && !render.barcodeOk" class="note warn">
              <Icon name="alert" :size="14" />{{ t("toolbox.label.barcodeBad") }}
            </p>
          </div>
        </details>

        <!-- 二维码 -->
        <details class="panel" :open="sectionOpen.qr" @toggle="onSectionToggle($event, 'qr')">
          <summary class="panel-head">
            <Icon name="chevron-right" :size="14" class="chev" />
            <b>{{ t("toolbox.label.qrTitle") }}</b>
            <span>{{ settings.job.qr.enabled ? t("toolbox.label.barcodeOn") : t("toolbox.label.barcodeOff") }}</span>
          </summary>
          <div class="panel-body">
            <label class="switch">
              <input v-model="settings.job.qr.enabled" type="checkbox" />
              <span>{{ t("toolbox.label.qrEnable") }}</span>
            </label>
            <div class="grid" :class="{ dim: !settings.job.qr.enabled }">
              <label class="field wide">
                <span>{{ t("toolbox.label.qrData") }}</span>
                <input v-model="settings.job.qr.data" type="text" spellcheck="false" :placeholder="t('toolbox.label.qrDataPh')" />
              </label>
              <label class="field">
                <span>{{ t("toolbox.label.qrCell") }}</span>
                <input v-model.number="settings.job.qr.cell" type="number" :min="LIMITS.qrCell[0]" :max="LIMITS.qrCell[1]" />
              </label>
              <label class="field">
                <span>{{ t("toolbox.label.qrEcc") }}</span>
                <select v-model="settings.job.qr.ecc">
                  <option v-for="e in ECC_OPTIONS" :key="e" :value="e">{{ t(`toolbox.label.ecc_${e}`) }}</option>
                </select>
              </label>
              <div class="field">
                <span>{{ t("toolbox.label.align") }}</span>
                <div class="seg" role="group" :aria-label="t('toolbox.label.qrAlign')">
                  <button v-for="a in ALIGN_OPTIONS" :key="a" type="button" :class="{ on: settings.job.qr.align === a }" @click="settings.job.qr.align = a">
                    {{ t(`toolbox.label.align_${a}`) }}
                  </button>
                </div>
              </div>
            </div>
            <p v-if="settings.job.qr.enabled && settings.job.qr.data.trim()" class="note">{{ qrInfo }}</p>
          </div>
        </details>

        <!-- 纸张与打印质量 -->
        <details class="panel" :open="sectionOpen.paper" @toggle="onSectionToggle($event, 'paper')">
          <summary class="panel-head">
            <Icon name="chevron-right" :size="14" class="chev" />
            <b>{{ t("toolbox.label.paperTitle") }}</b>
            <span>{{ settings.label.widthMm }} × {{ settings.label.heightMm }} mm · {{ t(`toolbox.label.media_${settings.label.media}`) }}</span>
          </summary>
          <div class="panel-body">
            <label class="field wide">
              <span>{{ t("toolbox.label.paperPreset") }}</span>
              <select :value="presetKey" @change="applyPreset($event.target.value)">
                <option v-for="preset in LABEL_PRESETS" :key="`${preset.widthMm}x${preset.heightMm}`" :value="`${preset.widthMm}x${preset.heightMm}`">
                  {{ preset.widthMm }} × {{ preset.heightMm }} mm
                </option>
                <option value="custom">{{ t("toolbox.label.presetCustom") }}</option>
              </select>
            </label>

            <div class="grid">
              <label class="field">
                <span>{{ t("toolbox.label.paperWidth") }}</span>
                <input v-model.number="settings.label.widthMm" type="number" :min="LIMITS.widthMm[0]" :max="LIMITS.widthMm[1]" step="0.5" />
              </label>
              <label class="field">
                <span>{{ t("toolbox.label.paperHeight") }}</span>
                <input v-model.number="settings.label.heightMm" type="number" :min="LIMITS.heightMm[0]" :max="LIMITS.heightMm[1]" step="0.5" />
              </label>
              <label class="field">
                <span>{{ t("toolbox.label.paperMedia") }}</span>
                <select v-model="settings.label.media">
                  <option v-for="m in MEDIA_OPTIONS" :key="m" :value="m">{{ t(`toolbox.label.media_${m}`) }}</option>
                </select>
              </label>
              <label v-if="settings.label.media === 'gap'" class="field">
                <span>{{ t("toolbox.label.paperGap") }}</span>
                <input v-model.number="settings.label.gapMm" type="number" :min="LIMITS.gapMm[0]" :max="LIMITS.gapMm[1]" step="0.5" />
              </label>
              <label v-else-if="settings.label.media === 'blackMark'" class="field">
                <span>{{ t("toolbox.label.paperBlackMark") }}</span>
                <input v-model.number="settings.label.blackMarkMm" type="number" :min="LIMITS.blackMarkMm[0]" :max="LIMITS.blackMarkMm[1]" step="0.5" />
              </label>
              <label class="field">
                <span>{{ t("toolbox.label.paperDensity") }}</span>
                <input v-model.number="settings.label.density" type="number" :min="LIMITS.density[0]" :max="LIMITS.density[1]" />
              </label>
              <label class="field">
                <span>{{ t("toolbox.label.paperSpeed") }}</span>
                <input v-model.number="settings.label.speed" type="number" :min="LIMITS.speed[0]" :max="LIMITS.speed[1]" />
              </label>
              <label class="field">
                <span>{{ t("toolbox.label.paperMarginX") }}</span>
                <input v-model.number="settings.label.marginX" type="number" :min="LIMITS.marginX[0]" :max="LIMITS.marginX[1]" />
              </label>
              <label class="field">
                <span>{{ t("toolbox.label.paperMarginY") }}</span>
                <input v-model.number="settings.label.marginY" type="number" :min="LIMITS.marginY[0]" :max="LIMITS.marginY[1]" />
              </label>
            </div>

            <label class="switch">
              <input v-model="settings.label.codepage936" type="checkbox" />
              <span>{{ t("toolbox.label.paperCodepage") }}</span>
            </label>

            <div class="panel-foot">
              <button class="btn-ghost sm" type="button" @click="resetLabel">{{ t("toolbox.label.paperReset") }}</button>
            </div>
          </div>
        </details>
      </section>

      <!-- 右：预览 -->
      <aside class="lab-preview">
        <article class="panel bench-panel">
          <header class="panel-head">
            <b>{{ t("toolbox.label.previewTitle") }}</b>
            <span>{{ latticeExact ? t("toolbox.label.previewHint") : t("toolbox.label.previewHintFallback") }}</span>
          </header>
          <div
            ref="benchRef"
            class="bench"
            :style="{ '--lattice': `${latticePx}px` }"
          >
            <div class="label-stack">
              <canvas ref="canvasRef"></canvas>
              <div v-if="gapBandMm > 0 && previewGeo.gapPx > 0" class="gap-strip" :style="{ height: `${previewGeo.gapPx}px` }">
                <span>{{ t("toolbox.label.gapBand", { mm: gapBandMm }) }}</span>
              </div>
            </div>
          </div>

          <dl class="readout">
            <div><dt>{{ t("toolbox.label.readoutDots") }}</dt><dd>{{ render ? `${render.canvasW} × ${render.canvasH}` : "—" }}</dd></div>
            <div><dt>{{ t("toolbox.label.readoutPaper") }}</dt><dd>{{ settings.label.widthMm }} × {{ settings.label.heightMm }} mm</dd></div>
            <div><dt>{{ t("toolbox.label.readoutDpi") }}</dt><dd>{{ settings.label.dpi }} dpi</dd></div>
            <div><dt>{{ t("toolbox.label.readoutBytes") }}</dt><dd>{{ render ? formatBytes(render.bytes) : "—" }}</dd></div>
          </dl>
        </article>

        <article class="panel">
          <header class="panel-head">
            <b>{{ t("toolbox.label.issuesTitle") }}</b>
            <span v-if="!issues.length" class="ok-chip"><Icon name="check" :size="13" />{{ t("toolbox.label.issuesOk") }}</span>
          </header>
          <ul v-if="issues.length" class="issue-list">
            <li v-for="(issue, i) in issues" :key="i" :class="issue.level">
              <!-- info 与 warn 都用警示图标，靠颜色区分级别：体检结论里出现对勾会被误读成「通过」 -->
              <Icon name="alert" :size="14" />
              <span>{{ issueMessage(issue, t) }}</span>
            </li>
          </ul>
        </article>

        <details class="panel tspl-panel">
          <summary class="panel-head">
            <Icon name="chevron-right" :size="14" class="chev" />
            <b>{{ t("toolbox.label.tsplTitle") }}</b>
            <span>{{ tsplLines.length }} {{ t("toolbox.label.tsplLines") }}</span>
          </summary>
          <div class="tspl-body">
            <pre class="tspl">{{ render?.source || "" }}</pre>
            <button class="btn-ghost sm" type="button" @click="copySource"><Icon name="copy" :size="13" />{{ t("toolbox.label.tsplCopy") }}</button>
          </div>
        </details>
      </aside>
    </div>

    <!-- 底栏：动作 -->
    <footer class="lab-actions">
      <label class="field copies-field">
        <span>{{ t("toolbox.label.copies") }}</span>
        <input v-model.number="settings.job.copies" type="number" :min="LIMITS.copies[0]" :max="LIMITS.copies[1]" />
      </label>

      <button class="btn-ghost sm" type="button" :disabled="busy.export" @click="exportPrn">
        <Icon name="download" :size="14" />{{ t("toolbox.label.exportPrn") }}
      </button>

      <div class="status" role="status" aria-live="polite">{{ status }}</div>

      <div class="target" :class="{ bad: render && !render.printerOk }">
        <Icon name="printer" :size="15" />
        <span :title="settings.printer">{{ settings.printer || t("toolbox.label.statusNoPrinter") }}</span>
      </div>

      <button class="btn-primary" type="button" :disabled="!canPrint" @click="printLabel">
        <Icon name="printer" :size="15" />{{ busy.print ? t("toolbox.label.printing") : t("toolbox.label.printBtn") }}
        <kbd>Ctrl</kbd><kbd>↵</kbd>
      </button>
    </footer>
  </div>
</template>

<style scoped>
.label-tool { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }

/* 顶栏 */
.lab-bar { flex-shrink: 0; display: flex; align-items: flex-end; gap: var(--sp-3); }
.lab-bar .grow { flex: 1; }
.bar-error, .bar-warn { display: flex; align-items: center; gap: var(--sp-1); padding-bottom: 8px; font-size: var(--fs-sm); }
.bar-error { color: var(--danger-deep); }
.bar-warn { color: var(--warn-deep); }

.field { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.field > span { color: var(--text-weak); font-size: var(--fs-sm); font-weight: 600; }
.field input, .field select, .text-input {
  min-width: 0; width: 100%; height: 34px; padding: 0 var(--sp-3);
  border: 1px solid var(--border-strong); border-radius: var(--r-sm); outline: none;
  background: var(--card); color: var(--text); font-size: var(--fs-md);
}
.field select { cursor: pointer; }
.field input:focus, .field select:focus, .text-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.field.wide { width: 100%; }
.inline { display: flex; gap: var(--sp-2); }
.mini { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-1); color: var(--muted); font-size: var(--fs-sm); }
.mini input { height: 34px; }

/* 主体两栏：两列各自滚动。行高必须钉成 minmax(0,1fr)，否则内容会把整行撑高、
   列内的 overflow 永远不会触发（面板被压扁后由自身 overflow:hidden 裁掉内容）。 */
.lab-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr); grid-template-rows: minmax(0, 1fr); gap: var(--sp-3); }
.lab-editor { min-height: 0; display: flex; flex-direction: column; gap: var(--sp-2); overflow: auto; padding-right: 2px; }
.lab-preview { min-height: 0; display: flex; flex-direction: column; gap: var(--sp-2); overflow: auto; }
/* 卡片按内容自然高度排布，超出交给列滚动，不压缩、不裁切 */
.lab-editor > *, .lab-preview > * { flex-shrink: 0; }

.panel { border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); overflow: hidden; }
.panel-head { min-height: 38px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--card-soft); }
.panel-head b { font-size: var(--fs-md); }
.panel-head > span { margin-left: auto; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); white-space: nowrap; }
details.panel > summary { cursor: pointer; list-style: none; }
details.panel > summary::-webkit-details-marker { display: none; }
summary .chev { color: var(--muted); transition: transform 0.15s; }
details[open] > summary .chev { transform: rotate(90deg); }
.panel-body { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
.panel-foot { display: flex; justify-content: flex-end; }
.text-input { height: auto; padding: var(--sp-3); resize: vertical; line-height: var(--lh-body); }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); }
.grid .span-2 { grid-column: span 2; }
.grid.dim { opacity: 0.55; }
.seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; padding: 2px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--well); }
.seg button { height: 28px; padding: 0 var(--sp-2); border: none; border-radius: var(--r-xs); background: transparent; color: var(--muted); font-size: var(--fs-sm); cursor: pointer; }
.seg button.on { background: var(--card); color: var(--primary-hover); box-shadow: var(--shadow); font-weight: 600; }
.switch { display: flex; align-items: center; gap: var(--sp-2); color: var(--text); font-size: var(--fs-md); cursor: pointer; }
.switch input { width: 15px; height: 15px; accent-color: var(--primary); cursor: pointer; }
.note { display: flex; align-items: center; gap: var(--sp-2); margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-xs); background: var(--well); color: var(--text-weak); font-size: var(--fs-sm); }
.note.warn { background: var(--warn-soft); color: var(--warn-deep); }

/* 预览台：底纹是真实的 203dpi 点阵，一格 = 1 毫米 */
.bench-panel { flex-shrink: 0; }
.bench {
  display: flex; justify-content: center; padding: var(--sp-4);
  background-color: var(--well);
  background-image:
    linear-gradient(to right, rgba(31, 35, 40, 0.12) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(31, 35, 40, 0.12) 1px, transparent 1px);
  background-size: var(--lattice, 8px) var(--lattice, 8px);
  overflow: auto;
}
.label-stack { display: flex; flex-direction: column; align-items: stretch; }
.bench canvas { display: block; background: #fff; box-shadow: var(--shadow); }
/* 标签之间的间隙：按真实高度画出来，这正是操作员最容易出问题的地方 */
.gap-strip { position: relative; display: grid; place-items: center; background: repeating-linear-gradient(45deg, var(--well) 0 4px, var(--card) 4px 8px); border-top: 1px dashed var(--faint); border-bottom: 1px dashed var(--faint); overflow: hidden; }
.gap-strip span { color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); white-space: nowrap; }

.readout { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; border-top: 1px solid var(--border); }
.readout > div { min-width: 0; padding: var(--sp-3) var(--sp-4); border-right: 1px solid var(--border); }
.readout > div:last-child { border-right: none; }
.readout dt { color: var(--muted); font-size: var(--fs-xs); }
.readout dd { margin: 2px 0 0; overflow: hidden; color: var(--text-code); font-family: var(--font-num); font-size: var(--fs-md); text-overflow: ellipsis; white-space: nowrap; }

.ok-chip { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; padding: 2px var(--sp-2); border-radius: var(--r-pill); background: var(--success-soft); color: var(--success-deep); font-size: var(--fs-xs); }
.issue-list { margin: 0; padding: var(--sp-2) var(--sp-4) var(--sp-3); list-style: none; }
.issue-list li { display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-2) 0; color: var(--text-weak); font-size: var(--fs-sm); line-height: var(--lh-tight); }
.issue-list li.warn { color: var(--warn-deep); }
.issue-list li svg { flex-shrink: 0; margin-top: 1px; }

.tspl-panel .tspl-body { position: relative; }
.tspl { max-height: 220px; margin: 0; padding: var(--sp-4) var(--sp-6) var(--sp-4) var(--sp-4); overflow: auto; background: var(--well); color: var(--success-deep); font-family: var(--font-mono); font-size: var(--fs-sm); line-height: var(--lh-body); white-space: pre; }
.tspl-body button { position: absolute; top: var(--sp-2); right: var(--sp-2); }

/* 底栏 */
.lab-actions { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-3); padding-top: var(--sp-2); border-top: 1px solid var(--border); }
.copies-field { flex-direction: row; align-items: center; gap: var(--sp-2); width: auto; }
.copies-field input { width: 76px; }
.status { flex: 1; min-width: 0; overflow: hidden; color: var(--muted); font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.target { display: flex; align-items: center; gap: var(--sp-2); max-width: 240px; color: var(--text-weak); font-size: var(--fs-sm); }
.target span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.target.bad { color: var(--warn-deep); }
.btn-primary kbd { margin-left: 4px; padding: 1px 4px; border-radius: var(--r-xs); background: rgba(255, 255, 255, 0.22); font-size: var(--fs-xs); }

@media (max-width: 860px) {
  .lab-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(220px, 1fr) auto; overflow: auto; }
  .readout { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .lab-actions { flex-wrap: wrap; }
  .status { flex-basis: 100%; order: 5; }
}
</style>
