<script setup>
// 标签打印（手机端）：表单 → **同一份排版引擎** → 预览 + TSPL 指令 + 体检提示。
//
// 关键点：排版走 crates/label-core 编译出的 WASM，而桌面端走 Tauri 的 label_layout 命令，
// **两者调的是同一个 Rust 函数**。所以「所见即所打」不是"两端看起来一样"，
// 而是同一份实现算出来的——预览里看到的每一个坐标，就是打印时下发的坐标。
//
// 手机端与桌面端的**能力差异**（界面上如实标注）：
//   · 桌面端能直接发送到 Windows 打印队列；安卓没有那个东西，所以这里只做
//     「生成指令 + 预览 + 导出 .prn」，真打印需要把 .prn 交给支持 TSPL 的打印 App/工具。
//     这不是"暂时没做"，而是平台上不存在 RAW 打印队列。
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { loadLabelEngine } from "../platform/labelEngine.js";

const { t } = useI18n();

/**
 * 字号 → 引擎的字体名。
 * ⚠️ 引擎只认固定几种点阵字体（core 的 Font 枚举），不能自己拼 `chinese${n}`——
 * 拼错会得到"未知字体"的错误，而那是运行时才暴露的（踩过一次）。
 * 中文内容必须用 chinese24（它是唯一支持汉字的字体），所以这里只给中文字体的几个档位。
 */
const FONT_OPTIONS = [
  { key: "chinese24", labelKey: "toolbox.label.fontChinese24" },
  { key: "ascii3", labelKey: "toolbox.label.fontAscii1" },
  { key: "ascii4", labelKey: "toolbox.label.fontAscii2" },
];

// ── 表单（默认值与桌面端一致：50×30mm @203dpi、间隙纸）─────────────────
const form = ref({
  widthMm: 50,
  heightMm: 30,
  gapMm: 2,
  dpi: 203,
  density: 8,
  speed: 4,
  media: "gap",
  copies: 1,
  text: "测试标签",
  font: "chinese24",
  barcode: "",
  qr: "",
  printer: "",
});

const MEDIA = [
  { key: "gap", labelKey: "mobile.labelMediaGap" },
  { key: "blackMark", labelKey: "mobile.labelMediaBlack" },
  { key: "continuous", labelKey: "mobile.labelMediaContinuous" },
];

const engine = ref(null);
const loadError = ref("");
const renderError = ref("");
const render = ref(null);
const busy = ref(false);
const notice = ref("");
const showSource = ref(false);
const canvasRef = ref(null);

/** 表单 → 引擎入参：形状必须与桌面端 label_layout 的 Settings 一致（camelCase）。 */
function settingsPayload() {
  const elements = [{ kind: "text", x: 8, y: 8, font: form.value.font, xMult: 1, yMult: 1, text: form.value.text }];
  if (form.value.barcode.trim()) {
    elements.push({ kind: "barcode", x: 8, y: 0, height: 60, narrow: 2, readable: 1, data: form.value.barcode.trim() });
  }
  if (form.value.qr.trim()) {
    elements.push({ kind: "qr", x: 0, y: 0, cell: 4, ecc: "m", data: form.value.qr.trim() });
  }
  return {
    label: {
      widthMm: Number(form.value.widthMm),
      heightMm: Number(form.value.heightMm),
      gapMm: Number(form.value.gapMm),
      dpi: Number(form.value.dpi),
      density: Number(form.value.density),
      speed: Number(form.value.speed),
      marginX: 0,
      media: form.value.media,
    },
    job: { copies: Number(form.value.copies), elements },
    printer: form.value.printer,
  };
}

onMounted(async () => {
  try {
    engine.value = await loadLabelEngine();
  } catch (e) {
    loadError.value = e?.message || String(e);
  }
});

/** 表单变化即重排：排版是纯计算，几十毫秒的事，不需要"点击预览"。 */
watch(
  form,
  () => {
    if (!engine.value) return;
    renderError.value = "";
    try {
      render.value = engine.value.layout(settingsPayload());
    } catch (e) {
      render.value = null;
      renderError.value = e?.message || String(e);
    }
  },
  { deep: true, immediate: true }
);

// 引擎加载完成后立刻排一次（watch 的 immediate 跑在引擎就绪之前）
watch(engine, (value) => {
  if (!value) return;
  try {
    render.value = value.layout(settingsPayload());
  } catch (e) {
    renderError.value = e?.message || String(e);
  }
});

/**
 * 把绘制模型画到 canvas。
 * 与桌面端同一口径：**只有纯黑与纯白**（热敏机是 1 位输出，画不出灰阶），
 * 所以不要加抗锯齿式的半透明，否则预览会比实打"好看"而误导。
 */
function paint() {
  const canvas = canvasRef.value;
  const data = render.value;
  if (!canvas || !data) return;
  // 按容器宽度等比缩放：手机上标签通常比屏幕窄，直接按点画会太小
  const maxCssWidth = Math.max(120, canvas.parentElement?.clientWidth || 320);
  const scale = Math.min(2, maxCssWidth / data.canvasW);
  const cssW = Math.round(data.canvasW * scale);
  const cssH = Math.round(data.canvasH * scale);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, data.canvasW, data.canvasH);
  ctx.fillStyle = "#000000";

  for (const item of data.items || []) {
    if (item.kind === "text") {
      ctx.font = `${item.size}px monospace`;
      ctx.textBaseline = "top";
      ctx.fillText(item.text, item.x, item.y);
    } else if (item.kind === "barcode") {
      // modules 是 0/1 序列：1 画黑条
      let x = item.x;
      for (const module of item.modules || []) {
        if (module) ctx.fillRect(x, item.y, item.narrow, item.height);
        x += item.narrow;
      }
      if (item.label) {
        ctx.font = `${item.labelSize || 20}px monospace`;
        ctx.textBaseline = "top";
        ctx.fillText(item.label, item.x, item.y + item.height + 2);
      }
    } else if (item.kind === "qr") {
      const bits = item.bits || [];
      for (let row = 0; row < item.size; row += 1) {
        for (let col = 0; col < item.size; col += 1) {
          if (bits[row * item.size + col]) ctx.fillRect(item.x + col * item.cell, item.y + row * item.cell, item.cell, item.cell);
        }
      }
    }
  }
}

watch(render, () => requestAnimationFrame(paint));
onMounted(() => requestAnimationFrame(paint));

/** 导出 .prn：指令按 GB18030 编码由引擎给出字节数，这里导出可读的指令文本。 */
async function exportPrn() {
  if (!render.value?.source) return;
  busy.value = true;
  notice.value = "";
  try {
    const blob = new Blob([render.value.source], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "label.prn";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    notice.value = t("mobile.labelExported");
  } catch (e) {
    renderError.value = e?.message || String(e);
  } finally {
    busy.value = false;
  }
}

const copied = ref("");
async function copySource() {
  if (!render.value?.source) return;
  try {
    await navigator.clipboard.writeText(render.value.source);
    copied.value = t("toolbox.rail.copied");
    setTimeout(() => (copied.value = ""), 2000);
  } catch {
    renderError.value = t("snippet.copyFailed");
  }
}

/** 体检提示：返回的是错误码而非文案，界面按语言渲染（与桌面端同一约定）。 */
const issues = computed(() => (render.value?.issues || []).map((issue) => ({ ...issue, text: t(`toolbox.label.issue.${issue.code}`, issue.params || {}, true) || issue.code })));
</script>

<template>
  <section class="m-tool" data-tool="label">
    <p v-if="loadError" class="m-err" data-role="engine-error">{{ t("mobile.labelEngineFail", { err: loadError }) }}</p>
    <p v-else-if="!engine" class="m-hint-sm" data-role="engine-loading">{{ t("common.loading") }}</p>

    <!-- 与桌面端的差异必须写在界面上：安卓没有 RAW 打印队列 -->
    <p class="m-hint-sm" data-role="print-note">{{ t("mobile.labelNoPrint") }}</p>

    <!-- 预览 -->
    <div class="m-card">
      <div class="m-card-head">
        <b>{{ t("mobile.labelPreview") }}</b>
        <span class="m-zone" data-role="canvas-size">{{ render ? `${render.canvasW} × ${render.canvasH}` : "" }}</span>
      </div>
      <div class="m-canvas-wrap"><canvas ref="canvasRef" data-role="preview"></canvas></div>
      <p v-if="renderError" class="m-err" data-role="render-error">{{ renderError }}</p>
    </div>

    <!-- 内容 -->
    <label class="m-field">
      <span>{{ t("mobile.labelText") }}</span>
      <input v-model="form.text" spellcheck="false" data-role="text" />
    </label>
    <div class="m-field-row">
      <label class="m-field">
        <span>{{ t("mobile.labelFont") }}</span>
        <select v-model="form.font" data-role="font">
          <option v-for="item in FONT_OPTIONS" :key="item.key" :value="item.key">{{ t(item.labelKey) }}</option>
        </select>
      </label>
      <label class="m-field">
        <span>{{ t("mobile.labelCopies") }}</span>
        <input v-model.number="form.copies" type="number" min="1" max="99" inputmode="numeric" data-role="copies" />
      </label>
    </div>
    <label class="m-field">
      <span>{{ t("mobile.labelBarcode") }}</span>
      <input v-model="form.barcode" spellcheck="false" data-role="barcode" placeholder="123456789012" />
    </label>
    <label class="m-field">
      <span>{{ t("mobile.labelQr") }}</span>
      <input v-model="form.qr" spellcheck="false" data-role="qr" placeholder="https://example.com" />
    </label>

    <!-- 纸张 -->
    <div class="m-field-row">
      <label class="m-field">
        <span>{{ t("mobile.labelWidth") }}</span>
        <input v-model.number="form.widthMm" type="number" min="10" max="56" inputmode="decimal" data-role="width" />
      </label>
      <label class="m-field">
        <span>{{ t("mobile.labelHeight") }}</span>
        <input v-model.number="form.heightMm" type="number" min="10" max="200" inputmode="decimal" data-role="height" />
      </label>
    </div>
    <div class="m-chips">
      <button v-for="item in MEDIA" :key="item.key" class="m-chip" :class="{ on: form.media === item.key }" :data-media="item.key" @click="form.media = item.key">
        {{ t(item.labelKey) }}
      </button>
    </div>

    <!-- 体检提示：打印前拦一下，避免"打出来半张废纸" -->
    <ul v-if="issues.length" class="m-stats" data-role="issues">
      <li v-for="(issue, index) in issues" :key="index" :data-level="issue.level">
        <b>{{ issue.level }}</b><span>{{ issue.text }}</span>
      </li>
    </ul>

    <!-- 指令文本 -->
    <div class="m-chips">
      <button class="m-chip" :class="{ on: showSource }" data-role="toggle-source" @click="showSource = !showSource">
        {{ t("mobile.labelShowSource") }}
      </button>
    </div>
    <label v-if="showSource" class="m-field">
      <span>TSPL</span>
      <textarea :value="render?.source || ''" rows="10" readonly spellcheck="false" data-role="source"></textarea>
    </label>

    <div class="m-actions">
      <button class="m-btn primary" :disabled="busy || !render" data-role="export" @click="exportPrn">{{ t("mobile.labelExport") }}</button>
      <button class="m-btn" :disabled="!render" data-role="copy-source" @click="copySource">{{ t("snippet.copy") }}</button>
    </div>

    <p v-if="notice" class="m-ok" data-role="notice">{{ notice }}</p>
    <p v-if="copied" class="m-ok">{{ copied }}</p>
  </section>
</template>
