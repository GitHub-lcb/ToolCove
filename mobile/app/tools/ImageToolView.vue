<script setup>
// 图片工具（手机端）：信息 / 压缩 / 转换 / 缩放 / 取色。
//
// 全部是浏览器原生能力（File API + Canvas），所以手机端**不需要任何原生桥**。
// 挑图走 `<input type="file">`——桌面端是 Tauri 系统对话框，手机端就是系统相册/文件选择器，
// 这正好是 platform/dialog.js 里 open() 在非桌面返回 null 时约定的调用方自理路径。
//
// 尺寸计算与输出命名一律复用 src/imageTool.js（calculateContainSize / buildImageOutputName），
// 保证"压缩到最长边 1920"这类口径与桌面端一致——自己写一份迟早两边不一样。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { IMAGE_FORMATS, aspectRatioLabel, buildImageOutputName, calculateContainSize, clampQuality, extractPaletteFromPixels, formatPaletteCss, formatPaletteJson, imageFormat } from "../../../src/imageTool.js";

const { t } = useI18n();

const TAB_KEYS = ["info", "compress", "convert", "resize", "palette"];
const TABS = TAB_KEYS.map((key) => ({ key, labelKey: `toolbox.image.tab${key[0].toUpperCase()}${key.slice(1)}` }));

const tab = ref("info");
const error = ref("");
const busy = ref(false);
const fileInput = ref(null);

/** 当前图片：保留原始 File 以便重新解码（换格式/改写质量都从原图重画，不做二次压缩）。 */
const source = ref(null); // { name, size, type, file }
const bitmap = ref(null); // ImageBitmap
const info = ref(null); // { width, height }
const previewUrl = ref("");

// 压缩 / 转换 / 缩放共用的输出设置
const options = ref({ format: "jpeg", quality: 0.8, maxWidth: 1920, maxHeight: 1920, allowUpscale: false });
const result = ref(null); // { url, size, name, width, height }

const palette = ref([]);
const paletteFormat = ref("css");

const formats = computed(() => IMAGE_FORMATS.map((f) => ({ ...f, label: f.extension.toUpperCase() })));

async function pickFile(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  await loadFile(file);
  // 清空 input，方便再次选择同一个文件
  if (fileInput.value) fileInput.value.value = "";
}

async function loadFile(file) {
  error.value = "";
  result.value = null;
  palette.value = [];
  busy.value = true;
  try {
    if (!String(file.type).startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) {
      throw new Error(t("toolbox.image.readFail"));
    }
    const bmp = await createImageBitmap(file);
    bitmap.value?.close?.();
    bitmap.value = bmp;
    source.value = { name: file.name, size: file.size, type: file.type, file };
    info.value = { width: bmp.width, height: bmp.height };
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = URL.createObjectURL(file);
    // 打开新图时把缩放上限设成原图尺寸，避免默认值把大图直接压小（与桌面端一致的思路）
    options.value = { ...options.value, maxWidth: bmp.width, maxHeight: bmp.height };
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    busy.value = false;
  }
}

/** 当前设置下的目标尺寸：压缩/缩放用 contain（保持比例），转换不改变尺寸。 */
const plan = computed(() => {
  if (!info.value) return null;
  if (tab.value === "convert") return { width: info.value.width, height: info.value.height };
  return calculateContainSize(info.value.width, info.value.height, options.value.maxWidth, options.value.maxHeight, options.value.allowUpscale);
});

/** 从原图重画到 canvas —— 每次都从原图开始，避免"压了又压"的累积损失。 */
function drawToCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  // JPEG 没有透明通道：先铺白底，否则透明区域会变黑（桌面端也是这么处理的）
  if (options.value.format === "jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bitmap.value, 0, 0, width, height);
  return canvas;
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(t("toolbox.image.encodeFail")))),
      mime,
      quality
    );
  });
}

async function run() {
  if (!bitmap.value || !plan.value) {
    error.value = t("toolbox.image.pickImgFirst");
    return;
  }
  error.value = "";
  busy.value = true;
  try {
    const fmt = imageFormat(options.value.format);
    const canvas = drawToCanvas(plan.value.width, plan.value.height);
    const blob = await canvasToBlob(canvas, fmt.mime, clampQuality(options.value.quality));
    if (result.value?.url) URL.revokeObjectURL(result.value.url);
    result.value = {
      url: URL.createObjectURL(blob),
      size: blob.size,
      name: buildImageOutputName(source.value?.name || "image", { format: fmt.key, suffix: tab.value === "resize" ? "-resized" : "" }),
      width: canvas.width,
      height: canvas.height,
    };
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    busy.value = false;
  }
}

/** 取色：缩到 160px 以内再采样（大图全量扫描在手机上会明显卡）。 */
async function extractPalette() {
  if (!bitmap.value) {
    error.value = t("toolbox.image.pickThenExtract");
    return;
  }
  error.value = "";
  busy.value = true;
  try {
    const scale = Math.min(1, 160 / Math.max(bitmap.value.width, bitmap.value.height));
    const width = Math.max(1, Math.round(bitmap.value.width * scale));
    const height = Math.max(1, Math.round(bitmap.value.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap.value, 0, 0, width, height);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    palette.value = extractPaletteFromPixels(rgba, 6);
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    busy.value = false;
  }
}

const paletteText = computed(() =>
  palette.value.length ? (paletteFormat.value === "css" ? formatPaletteCss(palette.value) : formatPaletteJson(palette.value)) : ""
);

const copied = ref("");
async function copy(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = t("toolbox.image.copied");
    setTimeout(() => (copied.value = ""), 2000);
  } catch {
    error.value = t("toolbox.image.copyFail");
  }
}

function download() {
  if (!result.value) return;
  const link = document.createElement("a");
  link.href = result.value.url;
  link.download = result.value.name;
  link.click();
}

/** 清空当前图片（释放 objectURL 与 ImageBitmap，手机上这些不释放会一直占内存）。 */
function clearImage() {
  bitmap.value?.close?.();
  bitmap.value = null;
  source.value = null;
  info.value = null;
  palette.value = [];
  error.value = "";
  if (result.value?.url) URL.revokeObjectURL(result.value.url);
  result.value = null;
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = "";
}

const kb = (bytes) => `${Math.max(1, Math.round(Number(bytes || 0) / 1024))} KB`;
</script>

<template>
  <section class="m-tool" data-tool="image">
    <!-- 挑图：手机端就是系统文件选择器 -->
    <input ref="fileInput" type="file" accept="image/*" class="m-file-hidden" data-role="file" @change="pickFile" />
    <div class="m-actions">
      <button class="m-btn primary" data-role="pick" @click="fileInput?.click()">
        {{ source ? t("toolbox.image.pickImg") : t("toolbox.image.pickFirstImg") }}
      </button>
      <button v-if="source" class="m-btn" data-role="clear" @click="clearImage">{{ t("common.cancel") }}</button>
    </div>

    <div v-if="info" class="m-card">
      <img v-if="previewUrl" :src="previewUrl" class="m-thumb" alt="" data-role="preview" />
      <ul class="m-stats" data-role="info">
        <li><b>{{ t("toolbox.image.fileName") }}</b><span data-role="name">{{ source?.name }}</span></li>
        <li><b>{{ t("toolbox.image.imgSize") }}</b><span data-role="size">{{ info.width }} × {{ info.height }}</span></li>
        <li><b>{{ t("toolbox.image.aspectRatio") }}</b><span>{{ aspectRatioLabel(info.width, info.height) }}</span></li>
        <li><b>{{ t("toolbox.image.fileSize") }}</b><span>{{ kb(source?.size) }}</span></li>
      </ul>
    </div>

    <div class="m-chips">
      <button v-for="item in TABS" :key="item.key" class="m-chip" :class="{ on: tab === item.key }" :data-tab="item.key" @click="tab = item.key">
        {{ t(item.labelKey) }}
      </button>
    </div>

    <!-- 压缩 / 转换 / 缩放：共用输出设置 -->
    <template v-if="tab !== 'info' && tab !== 'palette'">
      <label class="m-field">
        <span>{{ t("toolbox.image.outFormat") }}</span>
        <select v-model="options.format" data-role="format">
          <option v-for="fmt in formats" :key="fmt.key" :value="fmt.key">{{ fmt.label }}</option>
        </select>
      </label>

      <label v-if="options.format !== 'png'" class="m-field">
        <span>{{ t("toolbox.image.outQuality") }}</span>
        <input v-model.number="options.quality" type="range" min="0.1" max="1" step="0.05" data-role="quality" />
      </label>

      <template v-if="tab !== 'convert'">
        <div class="m-field-row">
          <label class="m-field">
            <span>{{ t("toolbox.image.maxWidth") }}</span>
            <input v-model.number="options.maxWidth" type="number" min="1" inputmode="numeric" data-role="max-width" />
          </label>
          <label class="m-field">
            <span>{{ t("toolbox.image.maxHeight") }}</span>
            <input v-model.number="options.maxHeight" type="number" min="1" inputmode="numeric" data-role="max-height" />
          </label>
        </div>
        <div class="m-chips">
          <button class="m-chip" :class="{ on: options.allowUpscale }" data-opt="upscale" @click="options.allowUpscale = !options.allowUpscale">
            {{ t("toolbox.image.allowUpscale") }}
          </button>
        </div>
      </template>

      <p v-if="plan && info" class="m-hint-sm" data-role="plan">
        {{ t("toolbox.image.colOutSize") }}: {{ plan.width }} × {{ plan.height }}
      </p>

      <div class="m-actions">
        <button class="m-btn primary" :disabled="busy" data-role="run" @click="run">
          {{ busy ? t("toolbox.image.processing") : tab === "convert" ? t("toolbox.image.convertImg") : t("toolbox.image.compressImg") }}
        </button>
      </div>
    </template>

    <!-- 取色 -->
    <template v-else-if="tab === 'palette'">
      <div class="m-actions">
        <button class="m-btn primary" :disabled="busy" data-role="extract" @click="extractPalette">
          {{ busy ? t("toolbox.image.extracting") : t("toolbox.image.paletteTitle") }}
        </button>
      </div>
      <div v-if="palette.length" class="m-palette" data-role="palette">
        <div v-for="color in palette" :key="color.hex" class="m-swatch" :style="{ background: color.hex }" :title="color.hex">
          <span>{{ color.hex.toUpperCase() }}</span>
        </div>
      </div>
      <div v-if="palette.length" class="m-chips">
        <button class="m-chip" :class="{ on: paletteFormat === 'css' }" @click="paletteFormat = 'css'">{{ t("toolbox.image.cssVars") }}</button>
        <button class="m-chip" :class="{ on: paletteFormat === 'json' }" @click="paletteFormat = 'json'">JSON</button>
      </div>
      <label v-if="palette.length" class="m-field">
        <span>{{ t("toolbox.image.paletteJson") }}</span>
        <textarea :value="paletteText" rows="6" readonly spellcheck="false" data-role="palette-text"></textarea>
      </label>
      <div v-if="palette.length" class="m-actions">
        <button class="m-btn" @click="copy(paletteText)">{{ t("toolbox.image.copyCss") }}</button>
      </div>
    </template>

    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>

    <!-- 结果 -->
    <div v-if="result" class="m-card" data-role="result">
      <div class="m-card-head">
        <b>{{ t("toolbox.image.done") }}</b>
        <span class="m-zone" data-role="result-meta">{{ kb(result.size) }} · {{ result.width }} × {{ result.height }}</span>
      </div>
      <img :src="result.url" class="m-thumb" alt="" data-role="result-preview" />
      <ul class="m-stats">
        <li><b>{{ t("toolbox.image.colOutSize") }}</b><span>{{ result.width }} × {{ result.height }}</span></li>
        <li><b>{{ t("toolbox.image.colOutBytes") }}</b><span data-role="result-size">{{ kb(result.size) }}</span></li>
        <li><b>{{ t("toolbox.image.fileName") }}</b><span>{{ result.name }}</span></li>
      </ul>
      <div class="m-actions">
        <button class="m-btn primary" data-role="download" @click="download">{{ t("toolbox.image.saveImgTitle") }}</button>
        <button class="m-btn" @click="copy(result.name)">{{ t("snippet.copy") }}</button>
      </div>
    </div>

    <p v-if="copied" class="m-ok">{{ copied }}</p>
    <p class="m-hint-sm">{{ t("mobile.imgLocalNote") }}</p>
  </section>
</template>
