<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import Icon from "../Icon.vue";
import ImagePreview from "./ImagePreview.vue";
import { formatFileSize } from "../fileTool.js";
import { aiComplete, isAIConfigured } from "../ai.js";
import {
  CROP_RATIOS,
  IMAGE_FORMATS,
  aspectRatioLabel,
  buildImageOutputName,
  calculateCenterCrop,
  calculateContainSize,
  calculateRenderPlan,
  clampQuality,
  encodeBmp,
  extractPaletteFromPixels,
  extractSvgFromAiText,
  formatPaletteCss,
  formatPaletteJson,
  buildLetterIconSvg,
  iconOutputName,
  imageFormat,
  parseExif,
  rgbToHex,
  rgbToHsl,
  resizeWithAspect,
  sanitizeSvg,
} from "../imageTool.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const isTauri = !!window.__TAURI_INTERNALS__;
const TABS = [
  { key: "convert", label: "格式转换" },
  { key: "compress", label: "压缩优化" },
  { key: "resize", label: "尺寸编辑" },
  { key: "batch", label: "批量处理" },
  { key: "palette", label: "颜色提取" },
  { key: "icon", label: "图标生成" },
  { key: "info", label: "图片信息" },
];
const ICON_SIZES = [16, 32, 48, 64, 128, 256, 512];
const activeTab = ref("convert");
const singleInput = ref(null);
const batchInput = ref(null);
const paletteCanvas = ref(null);
const source = ref(null);
const output = ref(null);
const busy = ref(false);
const dragOver = ref(false);
const error = ref("");
const defaultJpegBackground = getComputedStyle(document.documentElement).getPropertyValue("--text-invert").trim() || "white";

const convertOptions = reactive({ format: "png", quality: 90, background: defaultJpegBackground });
const compressOptions = reactive({ format: "webp", quality: 78, maxWidth: 1920, maxHeight: 1920, allowUpscale: false });
const resizeOptions = reactive({ width: 0, height: 0, lock: true, crop: "original", rotation: 0, flipX: false, flipY: false, format: "png", quality: 90 });
const batchOptions = reactive({ format: "webp", quality: 80, maxWidth: 1920, maxHeight: 1920, allowUpscale: false, prefix: "", suffix: "-optimized" });
const batchItems = ref([]);
const batchBusy = ref(false);
const paletteCount = ref(6);
const palette = ref([]);
const paletteBusy = ref(false);
const pickedColor = ref(null);
const copiedColor = ref("");
const iconMode = ref("local");
const iconOptions = reactive({ text: "ZG", background: "#0969DA", foreground: "#FFFFFF", radius: 96, fontSize: 220, transparent: false, name: "app-icon" });
const aiIconOptions = reactive({ prompt: "", color: "#0969DA", transparent: true });
const aiIconSvg = ref("");
const aiIconBusy = ref(false);
const aiConfigured = ref(false);
const iconSizes = ref([32, 64, 128, 256, 512]);
const iconPreviewUrl = ref("");
let paletteTimer = null;

const selectedFormat = computed(() => imageFormat(
  activeTab.value === "convert" ? convertOptions.format
    : activeTab.value === "compress" ? compressOptions.format
      : resizeOptions.format
));
const sourceSummary = computed(() => source.value
  ? `${source.value.width} × ${source.value.height} · ${formatFileSize(source.value.file.size)}`
  : "未选择图片");
const savedPercent = computed(() => {
  if (!source.value || !output.value) return 0;
  return Math.round((1 - output.value.blob.size / source.value.file.size) * 100);
});
const cropRatio = computed(() => CROP_RATIOS.find((item) => item.key === resizeOptions.crop)?.ratio || 0);
const exifRows = computed(() => {
  const exif = source.value?.exif || {};
  const labels = {
    make: "相机厂商", model: "相机型号", takenAt: "拍摄时间", modifiedAt: "修改时间",
    exposureTime: "曝光时间", fNumber: "光圈", iso: "ISO", focalLength: "焦距",
    orientation: "方向", pixelWidth: "EXIF 宽度", pixelHeight: "EXIF 高度", hasGps: "包含定位信息",
  };
  return Object.entries(labels)
    .filter(([key]) => exif[key] !== undefined)
    .map(([key, label]) => ({ label, value: formatExifValue(key, exif[key]) }));
});
const localIconSvg = computed(() => buildLetterIconSvg(iconOptions));
const currentIconSvg = computed(() => iconMode.value === "local" ? localIconSvg.value : aiIconSvg.value);
const selectedIconSizes = computed(() => [...iconSizes.value].sort((a, b) => a - b));

function errorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}
function formatExifValue(key, value) {
  if (key === "hasGps") return value ? "是" : "否";
  if (key === "exposureTime" && Number(value) > 0 && Number(value) < 1) return `1/${Math.round(1 / Number(value))} 秒`;
  if (key === "fNumber") return `f/${Number(value).toFixed(1).replace(/\.0$/, "")}`;
  if (key === "focalLength") return `${Number(value).toFixed(1).replace(/\.0$/, "")} mm`;
  return String(value).replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
}
function revokeUrl(value) {
  if (value?.url?.startsWith("blob:")) URL.revokeObjectURL(value.url);
}
function clearOutput() {
  revokeUrl(output.value);
  output.value = null;
  error.value = "";
}
function resetSource() {
  clearOutput();
  revokeUrl(source.value);
  source.value?.image?.close?.();
  source.value = null;
  palette.value = [];
  pickedColor.value = null;
}
function onSingleChange(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) loadSingleFile(file);
}
function onBatchChange(event) {
  const files = [...(event.target.files || [])];
  event.target.value = "";
  if (files.length) loadBatchFiles(files);
}
function onDrop(event) {
  dragOver.value = false;
  if (activeTab.value === "icon") return;
  const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type.startsWith("image/"));
  if (!files.length) return props.showToast("没有识别到可处理的图片");
  if (activeTab.value === "batch") loadBatchFiles(files);
  else loadSingleFile(files[0]);
}
async function decodeImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  const image = await createImageBitmap(file);
  if (!image.width || !image.height) {
    image.close?.();
    throw new Error("无法读取图片尺寸");
  }
  return image;
}
async function loadSingleFile(file) {
  busy.value = true;
  error.value = "";
  try {
    const [image, buffer] = await Promise.all([decodeImage(file), file.arrayBuffer()]);
    resetSource();
    source.value = {
      file,
      image,
      url: URL.createObjectURL(file),
      width: image.width,
      height: image.height,
      exif: parseExif(buffer),
    };
    resizeOptions.width = image.width;
    resizeOptions.height = image.height;
    resizeOptions.crop = "original";
    resizeOptions.rotation = 0;
    resizeOptions.flipX = false;
    resizeOptions.flipY = false;
    const detected = IMAGE_FORMATS.find((item) => item.mime === file.type);
    if (detected) {
      convertOptions.format = detected.key;
      resizeOptions.format = detected.key;
    }
    busy.value = false;
    await runActive();
  } catch (cause) {
    error.value = errorMessage(cause);
    props.showToast(`读取失败：${error.value}`);
  } finally {
    busy.value = false;
  }
}
async function loadBatchFiles(files) {
  batchItems.value.forEach((item) => {
    revokeUrl(item.output);
    item.image?.close?.();
  });
  batchItems.value = files
    .filter((file) => file.type.startsWith("image/"))
    .map((file, index) => ({ id: `${file.name}-${file.lastModified}-${index}`, file, status: "waiting", error: "", output: null }));
  if (batchItems.value.length) props.showToast(`已加入 ${batchItems.value.length} 张图片`);
}
function formatSupportsQuality(key) {
  return imageFormat(key).supportsQuality;
}
async function renderImage(image, options) {
  const plan = calculateRenderPlan(image.width, image.height, options);
  if (plan.outputWidth * plan.outputHeight > 80_000_000) throw new Error("输出图片像素过大，请缩小尺寸");
  const canvas = document.createElement("canvas");
  canvas.width = plan.outputWidth;
  canvas.height = plan.outputHeight;
  const context = canvas.getContext("2d", { alpha: options.format !== "jpeg" });
  if (!context) throw new Error("当前环境无法创建图片画布");
  if (options.format === "jpeg") {
    context.fillStyle = options.background || defaultJpegBackground;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.save();
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(plan.rotation * Math.PI / 180);
  context.scale(plan.flipX ? -1 : 1, plan.flipY ? -1 : 1);
  context.drawImage(
    image,
    plan.crop.x, plan.crop.y, plan.crop.width, plan.crop.height,
    -plan.drawWidth / 2, -plan.drawHeight / 2, plan.drawWidth, plan.drawHeight,
  );
  context.restore();
  let blob;
  if (options.format === "bmp") {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    blob = new Blob([encodeBmp(canvas.width, canvas.height, pixels)], { type: "image/bmp" });
  } else {
    const format = imageFormat(options.format);
    blob = await new Promise((resolve, reject) => canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error("图片编码失败")),
      format.mime,
      clampQuality(Number(options.quality) / 100),
    ));
    if (blob.type !== format.mime) throw new Error(`当前环境不支持 ${format.label} 编码`);
  }
  return { blob, width: canvas.width, height: canvas.height };
}
async function runActive() {
  if (!source.value || busy.value) return;
  if (activeTab.value === "convert") return runConvert();
  if (activeTab.value === "compress") return runCompress();
  if (activeTab.value === "resize") return runResize();
  if (activeTab.value === "palette") return extractPalette();
}
async function processSingle(options, nameOptions) {
  if (!source.value) return props.showToast("请先选择图片");
  busy.value = true;
  error.value = "";
  try {
    const result = await renderImage(source.value.image, options);
    clearOutput();
    output.value = {
      ...result,
      url: URL.createObjectURL(result.blob),
      name: buildImageOutputName(source.value.file.name, nameOptions),
    };
  } catch (cause) {
    clearOutput();
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
function runConvert() {
  return processSingle({
    width: source.value.width,
    height: source.value.height,
    format: convertOptions.format,
    quality: convertOptions.quality,
    background: convertOptions.background,
  }, { format: convertOptions.format, suffix: "-converted" });
}
function runCompress() {
  const size = calculateContainSize(
    source.value.width, source.value.height,
    compressOptions.maxWidth, compressOptions.maxHeight,
    compressOptions.allowUpscale,
  );
  return processSingle({ ...size, format: compressOptions.format, quality: compressOptions.quality }, { format: compressOptions.format, suffix: "-optimized" });
}
function runResize() {
  return processSingle({
    width: resizeOptions.width,
    height: resizeOptions.height,
    cropRatio: cropRatio.value,
    rotation: resizeOptions.rotation,
    flipX: resizeOptions.flipX,
    flipY: resizeOptions.flipY,
    format: resizeOptions.format,
    quality: resizeOptions.quality,
  }, { format: resizeOptions.format, suffix: "-edited" });
}
function updateResize(changed) {
  if (!source.value || !resizeOptions.lock) return;
  try {
    const crop = calculateCenterCrop(source.value.width, source.value.height, cropRatio.value);
    const size = resizeWithAspect(crop.width, crop.height, resizeOptions.width, resizeOptions.height, changed);
    resizeOptions.width = size.width;
    resizeOptions.height = size.height;
  } catch { /* 输入未完成时暂不联动 */ }
}
function chooseCrop(key) {
  resizeOptions.crop = key;
  if (!source.value || key === "free") return;
  const crop = calculateCenterCrop(source.value.width, source.value.height, cropRatio.value);
  resizeOptions.width = crop.width;
  resizeOptions.height = crop.height;
}
function rotate(direction) {
  resizeOptions.rotation = (resizeOptions.rotation + direction + 360) % 360;
}
async function runBatch() {
  if (!batchItems.value.length || batchBusy.value) return props.showToast("请先选择图片");
  batchBusy.value = true;
  for (let index = 0; index < batchItems.value.length; index += 1) {
    const item = batchItems.value[index];
    revokeUrl(item.output);
    item.output = null;
    item.error = "";
    item.status = "processing";
    try {
      const image = item.image || await decodeImage(item.file);
      item.image = image;
      const size = calculateContainSize(image.width, image.height, batchOptions.maxWidth, batchOptions.maxHeight, batchOptions.allowUpscale);
      const result = await renderImage(image, { ...size, format: batchOptions.format, quality: batchOptions.quality });
      item.output = {
        ...result,
        url: URL.createObjectURL(result.blob),
        name: buildImageOutputName(item.file.name, {
          format: batchOptions.format,
          prefix: batchOptions.prefix,
          suffix: batchOptions.suffix,
        }),
      };
      item.status = "done";
    } catch (cause) {
      item.error = errorMessage(cause);
      item.status = "error";
    }
    await new Promise((resolve) => setTimeout(resolve));
  }
  batchBusy.value = false;
  const success = batchItems.value.filter((item) => item.status === "done").length;
  props.showToast(`批量处理完成：${success}/${batchItems.value.length}`);
}
async function blobBase64(blob) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("读取输出文件失败"));
    reader.readAsDataURL(blob);
  });
  return String(dataUrl).split(",")[1] || "";
}
async function saveBlob(blob, name) {
  if (!blob) return;
  if (!isTauri) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  const format = imageFormat(name.split(".").pop() === "jpg" ? "jpeg" : name.split(".").pop());
  const path = await saveDialog({ title: "保存处理后的图片", defaultPath: name, filters: [{ name: format.label, extensions: [format.extension] }] });
  if (!path) return;
  await invoke("export_file_b64", { path, contentB64: await blobBase64(blob) });
}
async function saveOutput() {
  if (!output.value) return props.showToast("请先生成处理结果");
  try {
    await saveBlob(output.value.blob, output.value.name);
    props.showToast("图片已保存");
  } catch (cause) {
    props.showToast(`保存失败：${errorMessage(cause)}`);
  }
}
async function saveBatch() {
  const ready = batchItems.value.filter((item) => item.output);
  if (!ready.length) return props.showToast("请先执行批量处理");
  try {
    if (isTauri) {
      const directory = await openDialog({ directory: true, title: "选择批量图片保存目录" });
      if (!directory) return;
      const separator = String(directory).includes("\\") ? "\\" : "/";
      for (const item of ready) {
        const path = `${String(directory).replace(/[\\/]$/, "")}${separator}${item.output.name}`;
        await invoke("export_file_b64", { path, contentB64: await blobBase64(item.output.blob) });
      }
    } else {
      for (const item of ready) {
        await saveBlob(item.output.blob, item.output.name);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
    props.showToast(`已保存 ${ready.length} 张图片`);
  } catch (cause) {
    props.showToast(`批量保存失败：${errorMessage(cause)}`);
  }
}
async function exportCleanCopy() {
  if (!source.value) return props.showToast("请先选择图片");
  const detected = IMAGE_FORMATS.find((item) => item.mime === source.value.file.type) || IMAGE_FORMATS[0];
  await processSingle({
    width: source.value.width,
    height: source.value.height,
    format: detected.key,
    quality: 96,
  }, { format: detected.key, suffix: "-clean" });
  await saveOutput();
}

async function extractPalette() {
  if (!source.value || paletteBusy.value) return;
  paletteBusy.value = true;
  try {
    const canvas = document.createElement("canvas");
    const size = calculateContainSize(source.value.width, source.value.height, 720, 720);
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前环境无法读取图片颜色");
    context.drawImage(source.value.image, 0, 0, canvas.width, canvas.height);
    palette.value = extractPaletteFromPixels(context.getImageData(0, 0, canvas.width, canvas.height).data, paletteCount.value);
    pickedColor.value = palette.value[0] || null;
    await drawPaletteCanvas();
  } catch (cause) {
    palette.value = [];
    props.showToast(`颜色提取失败：${errorMessage(cause)}`);
  } finally {
    paletteBusy.value = false;
  }
}
async function drawPaletteCanvas() {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const canvas = paletteCanvas.value;
  if (!canvas || !source.value) return;
  const size = calculateContainSize(source.value.width, source.value.height, 1200, 900);
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext("2d")?.drawImage(source.value.image, 0, 0, size.width, size.height);
}
function pickCanvasColor(event) {
  const canvas = paletteCanvas.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  const renderedWidth = canvas.width * scale;
  const renderedHeight = canvas.height * scale;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;
  const localX = event.clientX - rect.left - offsetX;
  const localY = event.clientY - rect.top - offsetY;
  if (localX < 0 || localY < 0 || localX >= renderedWidth || localY >= renderedHeight) return;
  const x = Math.min(canvas.width - 1, Math.floor(localX / scale));
  const y = Math.min(canvas.height - 1, Math.floor(localY / scale));
  const pixel = canvas.getContext("2d", { willReadFrequently: true })?.getImageData(x, y, 1, 1).data;
  if (!pixel || pixel[3] === 0) return props.showToast("这里是透明像素");
  const hsl = rgbToHsl(pixel[0], pixel[1], pixel[2]);
  pickedColor.value = {
    r: pixel[0], g: pixel[1], b: pixel[2],
    hex: rgbToHex(pixel[0], pixel[1], pixel[2]),
    rgb: `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`,
    hsl: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
    percentage: null,
  };
}
async function copyValue(value, key, label) {
  try {
    await navigator.clipboard.writeText(value);
    copiedColor.value = key;
    props.showToast(`已复制${label}`);
    setTimeout(() => {
      if (copiedColor.value === key) copiedColor.value = "";
    }, 1400);
  } catch (cause) {
    props.showToast(`复制失败：${errorMessage(cause)}`);
  }
}
function copyPalette(type) {
  const value = type === "css" ? formatPaletteCss(palette.value, "palette") : formatPaletteJson(palette.value);
  return copyValue(value, `palette-${type}`, type === "css" ? " CSS 变量" : "调色板 JSON");
}
function selectPaletteColor(color) {
  pickedColor.value = color;
  copyValue(color.hex, `color-${color.hex}`, "颜色");
}
function toggleIconSize(size) {
  iconSizes.value = iconSizes.value.includes(size)
    ? iconSizes.value.filter((item) => item !== size)
    : [...iconSizes.value, size];
}
async function generateAiIcon() {
  const prompt = aiIconOptions.prompt.trim();
  if (!prompt) return props.showToast("请先描述要生成的图标");
  if (!(await isAIConfigured())) {
    aiConfigured.value = false;
    return props.showToast("请先在右上角设置中配置 AI 模型");
  }
  aiIconBusy.value = true;
  try {
    const backgroundRule = aiIconOptions.transparent
      ? "透明背景，不要绘制底色矩形"
      : `使用 ${aiIconOptions.color} 作为背景色`;
    const reply = await aiComplete(
      `请生成这个图标：${prompt}\n主色优先使用 ${aiIconOptions.color}。${backgroundRule}。`,
      {
        temperature: 0.4,
        system: "你是应用图标设计师。严格只返回一段完整 SVG，不要解释，不要 Markdown 代码围栏。SVG 必须使用 viewBox=\"0 0 512 512\"，构图居中、轮廓清晰、减少细碎元素，在 32px 下仍可识别。禁止文字、图片、脚本、CSS、滤镜、渐变、蒙版、外链、foreignObject 和 use，只使用 path、circle、rect、line、polyline、polygon、ellipse、g 及基础 fill/stroke 属性。",
      },
    );
    aiIconSvg.value = sanitizeSvg(extractSvgFromAiText(reply));
    props.showToast("AI 图标已生成");
  } catch (cause) {
    aiIconSvg.value = "";
    props.showToast(`AI 图标生成失败：${errorMessage(cause)}`);
  } finally {
    aiIconBusy.value = false;
  }
}
function svgToPngBlob(svg, size) {
  return new Promise((resolve, reject) => {
    const sourceUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("当前环境无法创建图标画布");
        context.drawImage(image, 0, 0, size, size);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(sourceUrl);
          if (blob) resolve(blob);
          else reject(new Error("PNG 编码失败"));
        }, "image/png");
      } catch (cause) {
        URL.revokeObjectURL(sourceUrl);
        reject(cause);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(sourceUrl);
      reject(new Error("SVG 无法渲染"));
    };
    image.src = sourceUrl;
  });
}
async function saveGenericBlob(blob, name, title, filter) {
  if (!isTauri) return saveBlob(blob, name);
  const path = await saveDialog({ title, defaultPath: name, filters: [filter] });
  if (!path) return false;
  await invoke("export_file_b64", { path, contentB64: await blobBase64(blob) });
  return true;
}
async function saveIconSvg() {
  if (!currentIconSvg.value) return props.showToast("请先生成图标");
  try {
    const saved = await saveGenericBlob(
      new Blob([currentIconSvg.value], { type: "image/svg+xml" }),
      iconOutputName(iconOptions.name, 512, "svg"),
      "保存 SVG 图标",
      { name: "SVG", extensions: ["svg"] },
    );
    if (saved !== false) props.showToast("SVG 图标已保存");
  } catch (cause) {
    props.showToast(`SVG 保存失败：${errorMessage(cause)}`);
  }
}
async function saveIconPngs() {
  if (!currentIconSvg.value) return props.showToast("请先生成图标");
  if (!selectedIconSizes.value.length) return props.showToast("请至少选择一个输出尺寸");
  try {
    const outputs = [];
    for (const size of selectedIconSizes.value) {
      outputs.push({ size, blob: await svgToPngBlob(currentIconSvg.value, size) });
    }
    if (isTauri) {
      const directory = await openDialog({ directory: true, title: "选择图标保存目录" });
      if (!directory) return;
      const separator = String(directory).includes("\\") ? "\\" : "/";
      for (const item of outputs) {
        const path = `${String(directory).replace(/[\\\/]$/, "")}${separator}${iconOutputName(iconOptions.name, item.size)}`;
        await invoke("export_file_b64", { path, contentB64: await blobBase64(item.blob) });
      }
    } else {
      for (const item of outputs) {
        await saveBlob(item.blob, iconOutputName(iconOptions.name, item.size));
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
    props.showToast(`已保存 ${outputs.length} 个 PNG 图标`);
  } catch (cause) {
    props.showToast(`图标保存失败：${errorMessage(cause)}`);
  }
}

watch(activeTab, (tab) => {
  error.value = "";
  if (tab !== "batch" && tab !== "icon" && source.value) runActive();
  if (tab === "palette") drawPaletteCanvas();
});
watch(paletteCount, () => {
  clearTimeout(paletteTimer);
  paletteTimer = setTimeout(() => {
    if (activeTab.value === "palette" && source.value) extractPalette();
  }, 120);
});
watch(currentIconSvg, (svg) => {
  if (iconPreviewUrl.value) URL.revokeObjectURL(iconPreviewUrl.value);
  iconPreviewUrl.value = svg ? URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })) : "";
}, { immediate: true });
onMounted(async () => {
  aiConfigured.value = await isAIConfigured();
});
onBeforeUnmount(() => {
  clearTimeout(paletteTimer);
  resetSource();
  batchItems.value.forEach((item) => {
    revokeUrl(item.output);
    item.image?.close?.();
  });
  if (iconPreviewUrl.value) URL.revokeObjectURL(iconPreviewUrl.value);
});
</script>

<template>
  <div class="image-tool" @dragover.prevent="dragOver = true" @dragleave.prevent="dragOver = false" @drop.prevent="onDrop">
    <input ref="singleInput" class="hidden-input" type="file" accept="image/png,image/jpeg,image/webp,image/bmp" @change="onSingleChange" />
    <input ref="batchInput" class="hidden-input" type="file" accept="image/png,image/jpeg,image/webp,image/bmp" multiple @change="onBatchChange" />

    <nav class="mode-tabs" aria-label="图片处理类型">
      <button v-for="tab in TABS" :key="tab.key" class="mode-tab" :class="{ on: activeTab === tab.key }" @click="activeTab = tab.key">{{ tab.label }}</button>
    </nav>

    <div v-if="activeTab !== 'batch' && activeTab !== 'icon'" class="source-bar">
      <button class="btn-ghost" @click="singleInput?.click()"><Icon name="image" :size="15" />选择图片</button>
      <span class="source-name" :title="source?.file.name || ''">{{ source?.file.name || "选择或拖入一张图片" }}</span>
      <span class="source-meta">{{ sourceSummary }}</span>
      <button v-if="source" class="icon-btn xs" title="移除图片" @click="resetSource"><Icon name="x" :size="13" /></button>
    </div>

    <section v-if="activeTab === 'convert'" class="workspace single-layout">
      <aside class="panel controls-panel">
        <header class="panel-head"><b>转换设置</b></header>
        <div class="controls-body">
          <label class="field"><span>输出格式</span><select v-model="convertOptions.format"><option v-for="format in IMAGE_FORMATS" :key="format.key" :value="format.key">{{ format.label }}</option></select></label>
          <label v-if="formatSupportsQuality(convertOptions.format)" class="field"><span>输出质量 <b>{{ convertOptions.quality }}%</b></span><input v-model.number="convertOptions.quality" type="range" min="10" max="100" /></label>
          <label v-if="convertOptions.format === 'jpeg'" class="field"><span>透明区域背景</span><span class="color-control"><input v-model="convertOptions.background" type="color" /><code>{{ convertOptions.background }}</code></span></label>
          <div class="format-note"><Icon name="image" :size="16" /><span>{{ selectedFormat.label }}</span><small>{{ output ? `${output.width} × ${output.height} · ${formatFileSize(output.blob.size)}` : "等待生成" }}</small></div>
          <button class="btn-primary full-btn" :disabled="busy || !source" @click="runConvert"><Icon name="repeat" :size="15" />{{ busy ? "处理中" : "转换图片" }}</button>
        </div>
      </aside>
      <ImagePreview :source="source" :output="output" :error="error" @save="saveOutput" />
    </section>

    <section v-else-if="activeTab === 'compress'" class="workspace single-layout">
      <aside class="panel controls-panel">
        <header class="panel-head"><b>压缩设置</b></header>
        <div class="controls-body">
          <label class="field"><span>输出格式</span><select v-model="compressOptions.format"><option value="jpeg">JPEG</option><option value="webp">WebP</option><option value="png">PNG</option></select></label>
          <label v-if="formatSupportsQuality(compressOptions.format)" class="field"><span>压缩质量 <b>{{ compressOptions.quality }}%</b></span><input v-model.number="compressOptions.quality" type="range" min="10" max="100" /></label>
          <div class="two-fields"><label class="field"><span>最大宽度</span><input v-model.number="compressOptions.maxWidth" type="number" min="1" max="20000" /></label><label class="field"><span>最大高度</span><input v-model.number="compressOptions.maxHeight" type="number" min="1" max="20000" /></label></div>
          <label class="check-control"><input v-model="compressOptions.allowUpscale" type="checkbox" />允许放大小图</label>
          <div v-if="output" class="saving-stat" :class="{ negative: savedPercent < 0 }"><b>{{ savedPercent >= 0 ? `减少 ${savedPercent}%` : `增加 ${Math.abs(savedPercent)}%` }}</b><span>{{ formatFileSize(source.file.size) }} → {{ formatFileSize(output.blob.size) }}</span></div>
          <button class="btn-primary full-btn" :disabled="busy || !source" @click="runCompress"><Icon name="download" :size="15" />{{ busy ? "处理中" : "压缩图片" }}</button>
        </div>
      </aside>
      <ImagePreview :source="source" :output="output" :error="error" @save="saveOutput" />
    </section>

    <section v-else-if="activeTab === 'resize'" class="workspace edit-layout">
      <aside class="panel controls-panel edit-controls">
        <header class="panel-head"><b>尺寸与变换</b></header>
        <div class="controls-body">
          <div class="two-fields"><label class="field"><span>宽度</span><input v-model.number="resizeOptions.width" type="number" min="1" max="20000" @input="updateResize('width')" /></label><label class="field"><span>高度</span><input v-model.number="resizeOptions.height" type="number" min="1" max="20000" @input="updateResize('height')" /></label></div>
          <label class="check-control"><input v-model="resizeOptions.lock" type="checkbox" />锁定宽高比例</label>
          <div class="field"><span>裁剪比例</span><div class="ratio-grid"><button v-for="ratio in CROP_RATIOS" :key="ratio.key" :class="{ on: resizeOptions.crop === ratio.key }" @click="chooseCrop(ratio.key)">{{ ratio.label }}</button></div></div>
          <div class="field"><span>旋转与翻转</span><div class="icon-actions"><button class="icon-btn" title="向左旋转" @click="rotate(-90)"><Icon name="rotate-left" :size="16" /></button><button class="icon-btn" title="向右旋转" @click="rotate(90)"><Icon name="rotate-right" :size="16" /></button><button class="icon-btn" :class="{ active: resizeOptions.flipX }" title="水平翻转" @click="resizeOptions.flipX = !resizeOptions.flipX"><Icon name="flip-horizontal" :size="16" /></button><button class="icon-btn" :class="{ active: resizeOptions.flipY }" title="垂直翻转" @click="resizeOptions.flipY = !resizeOptions.flipY"><Icon name="flip-vertical" :size="16" /></button><span>{{ resizeOptions.rotation }}°</span></div></div>
          <div class="two-fields"><label class="field"><span>输出格式</span><select v-model="resizeOptions.format"><option v-for="format in IMAGE_FORMATS" :key="format.key" :value="format.key">{{ format.label }}</option></select></label><label v-if="formatSupportsQuality(resizeOptions.format)" class="field"><span>质量</span><input v-model.number="resizeOptions.quality" type="number" min="10" max="100" /></label></div>
          <button class="btn-primary full-btn" :disabled="busy || !source" @click="runResize"><Icon name="crop" :size="15" />{{ busy ? "处理中" : "应用编辑" }}</button>
        </div>
      </aside>
      <ImagePreview :source="source" :output="output" :error="error" @save="saveOutput" />
    </section>

    <section v-else-if="activeTab === 'batch'" class="workspace batch-layout">
      <div class="batch-toolbar">
        <button class="btn-ghost" @click="batchInput?.click()"><Icon name="image" :size="15" />选择多张图片</button>
        <label class="compact-field"><span>格式</span><select v-model="batchOptions.format"><option v-for="format in IMAGE_FORMATS" :key="format.key" :value="format.key">{{ format.label }}</option></select></label>
        <label v-if="formatSupportsQuality(batchOptions.format)" class="compact-field quality-field"><span>质量</span><input v-model.number="batchOptions.quality" type="number" min="10" max="100" /></label>
        <label class="compact-field size-field"><span>最大宽</span><input v-model.number="batchOptions.maxWidth" type="number" min="1" max="20000" /></label>
        <label class="compact-field size-field"><span>最大高</span><input v-model.number="batchOptions.maxHeight" type="number" min="1" max="20000" /></label>
        <button class="btn-primary" :disabled="batchBusy || !batchItems.length" @click="runBatch"><Icon name="repeat" :size="15" />{{ batchBusy ? "处理中" : "开始处理" }}</button>
        <button class="btn-outline" :disabled="!batchItems.some((item) => item.output)" @click="saveBatch"><Icon name="download" :size="15" />全部保存</button>
      </div>
      <div class="batch-options">
        <label class="compact-field"><span>前缀</span><input v-model="batchOptions.prefix" /></label>
        <label class="compact-field"><span>后缀</span><input v-model="batchOptions.suffix" /></label>
        <label class="check-control"><input v-model="batchOptions.allowUpscale" type="checkbox" />允许放大</label>
        <span>{{ batchItems.length }} 张</span>
      </div>
      <section class="panel batch-panel" :class="{ dragging: dragOver }">
        <header class="batch-head"><span>文件</span><span>原始大小</span><span>输出尺寸</span><span>输出大小</span><span>状态</span></header>
        <div v-if="batchItems.length" class="batch-list">
          <div v-for="item in batchItems" :key="item.id" class="batch-row" :class="item.status">
            <span class="batch-name" :title="item.file.name"><Icon name="image" :size="15" />{{ item.file.name }}</span>
            <span>{{ formatFileSize(item.file.size) }}</span>
            <span>{{ item.output ? `${item.output.width} × ${item.output.height}` : "-" }}</span>
            <span>{{ item.output ? formatFileSize(item.output.blob.size) : "-" }}</span>
            <span class="batch-status" :title="item.error"><Icon :name="item.status === 'done' ? 'check' : item.status === 'error' ? 'alert' : item.status === 'processing' ? 'refresh' : 'clock'" :size="14" />{{ item.status === 'done' ? "完成" : item.status === 'error' ? "失败" : item.status === 'processing' ? "处理中" : "等待" }}</span>
          </div>
        </div>
        <div v-else class="drop-empty"><span class="empty-ico"><Icon name="image" :size="30" /></span><b>还没有待处理图片</b><button class="btn-outline" @click="batchInput?.click()">选择第一批图片</button></div>
      </section>
    </section>

    <section v-else-if="activeTab === 'palette'" class="workspace palette-layout">
      <section class="panel palette-preview">
        <header class="panel-head"><b>图片取色</b><span>{{ pickedColor ? pickedColor.hex : "点击图片读取颜色" }}</span></header>
        <div v-if="source" class="palette-canvas-wrap">
          <canvas ref="paletteCanvas" class="palette-canvas" aria-label="点击图片提取颜色" @click="pickCanvasColor"></canvas>
          <div v-if="pickedColor" class="picked-bar">
            <span class="picked-swatch" :style="{ background: pickedColor.hex }"></span>
            <button class="color-code" title="复制 HEX" @click="copyValue(pickedColor.hex, 'picked-hex', ' HEX')">{{ pickedColor.hex }}<Icon :name="copiedColor === 'picked-hex' ? 'check' : 'copy'" :size="13" /></button>
            <button class="color-code" title="复制 RGB" @click="copyValue(pickedColor.rgb, 'picked-rgb', ' RGB')">{{ pickedColor.rgb }}<Icon :name="copiedColor === 'picked-rgb' ? 'check' : 'copy'" :size="13" /></button>
            <button class="color-code" title="复制 HSL" @click="copyValue(pickedColor.hsl, 'picked-hsl', ' HSL')">{{ pickedColor.hsl }}<Icon :name="copiedColor === 'picked-hsl' ? 'check' : 'copy'" :size="13" /></button>
          </div>
        </div>
        <div v-else class="info-empty"><span class="empty-ico"><Icon name="image" :size="30" /></span><b>选择图片后提取颜色</b><button class="btn-outline" @click="singleInput?.click()">选择图片</button></div>
      </section>
      <aside class="panel palette-panel">
        <header class="panel-head"><b>主色调色板</b><span>{{ palette.length }} 种颜色</span></header>
        <div class="palette-controls">
          <label class="field"><span>颜色数量 <b>{{ paletteCount }}</b></span><input v-model.number="paletteCount" type="range" min="3" max="12" /></label>
          <button class="btn-outline" :disabled="!source || paletteBusy" @click="extractPalette"><Icon name="refresh" :size="15" />{{ paletteBusy ? "提取中" : "重新提取" }}</button>
        </div>
        <div v-if="palette.length" class="palette-list">
          <button v-for="color in palette" :key="color.hex" class="palette-row" :class="{ selected: pickedColor?.hex === color.hex }" :title="`复制 ${color.hex}`" @click="selectPaletteColor(color)">
            <span class="palette-swatch" :style="{ background: color.hex }"></span>
            <span class="palette-values"><b>{{ color.hex }}</b><small>{{ color.rgb }} · {{ color.hsl }}</small></span>
            <span class="palette-ratio">{{ color.percentage }}%</span>
            <Icon :name="copiedColor === `color-${color.hex}` ? 'check' : 'copy'" :size="14" />
          </button>
        </div>
        <div v-else class="no-exif">{{ source ? "正在等待提取结果" : "还没有调色板" }}</div>
        <footer class="palette-actions">
          <button class="btn-outline" :disabled="!palette.length" @click="copyPalette('css')"><Icon :name="copiedColor === 'palette-css' ? 'check' : 'copy'" :size="14" />复制 CSS</button>
          <button class="btn-outline" :disabled="!palette.length" @click="copyPalette('json')"><Icon :name="copiedColor === 'palette-json' ? 'check' : 'copy'" :size="14" />复制 JSON</button>
        </footer>
      </aside>
    </section>

    <section v-else-if="activeTab === 'icon'" class="workspace icon-layout">
      <aside class="panel controls-panel icon-controls">
        <header class="panel-head"><b>图标设计</b></header>
        <div class="controls-body">
          <div class="segmented icon-mode"><button :class="{ on: iconMode === 'local' }" @click="iconMode = 'local'">文字图标</button><button :class="{ on: iconMode === 'ai' }" @click="iconMode = 'ai'">AI 生成</button></div>
          <template v-if="iconMode === 'local'">
            <label class="field"><span>文字或字母</span><input v-model="iconOptions.text" maxlength="3" placeholder="ZG" /></label>
            <div class="two-fields"><label class="field"><span>背景色</span><span class="color-control"><input v-model="iconOptions.background" type="color" /><code>{{ iconOptions.background }}</code></span></label><label class="field"><span>前景色</span><span class="color-control"><input v-model="iconOptions.foreground" type="color" /><code>{{ iconOptions.foreground }}</code></span></label></div>
            <label class="field"><span>圆角 <b>{{ iconOptions.radius }}</b></span><input v-model.number="iconOptions.radius" type="range" min="0" max="256" /></label>
            <label class="field"><span>文字大小 <b>{{ iconOptions.fontSize }}</b></span><input v-model.number="iconOptions.fontSize" type="range" min="80" max="360" /></label>
            <label class="check-control"><input v-model="iconOptions.transparent" type="checkbox" />透明背景</label>
          </template>
          <template v-else>
            <label class="field"><span>图标描述</span><textarea v-model="aiIconOptions.prompt" class="icon-prompt" rows="5" spellcheck="false" placeholder="例：用于代码片段管理的简洁线性图标，主体是代码括号与书签"></textarea></label>
            <label class="field"><span>主色</span><span class="color-control"><input v-model="aiIconOptions.color" type="color" /><code>{{ aiIconOptions.color }}</code></span></label>
            <label class="check-control"><input v-model="aiIconOptions.transparent" type="checkbox" />透明背景</label>
            <div v-if="!aiConfigured" class="ai-note"><Icon name="settings" :size="16" /><span>需要先在右上角设置中配置 AI 模型</span></div>
            <button class="btn-primary" :disabled="aiIconBusy" @click="generateAiIcon"><Icon name="sparkles" :size="15" />{{ aiIconBusy ? "生成中" : aiIconSvg ? "重新生成" : "生成图标" }}</button>
          </template>
        </div>
      </aside>
      <section class="panel icon-output">
        <header class="panel-head"><b>图标预览</b><span>SVG · 512 × 512</span></header>
        <div class="icon-preview-area">
          <div v-if="iconPreviewUrl" class="icon-preview-stage"><img :src="iconPreviewUrl" alt="生成的图标预览" /></div>
          <div v-else class="info-empty"><span class="empty-ico"><Icon name="sparkles" :size="30" /></span><b>描述图标后开始生成</b></div>
          <div v-if="currentIconSvg" class="mini-previews"><span v-for="size in [16, 32, 64]" :key="size"><img :src="iconPreviewUrl" :alt="`${size} 像素预览`" :width="size" :height="size" /><small>{{ size }}</small></span></div>
        </div>
        <div class="icon-export">
          <label class="field"><span>文件名</span><input v-model="iconOptions.name" placeholder="app-icon" /></label>
          <div class="field"><span>PNG 尺寸</span><div class="size-chips"><button v-for="size in ICON_SIZES" :key="size" :class="{ on: iconSizes.includes(size) }" @click="toggleIconSize(size)">{{ size }}</button></div></div>
          <div class="export-buttons"><button class="btn-outline" :disabled="!currentIconSvg" @click="saveIconSvg"><Icon name="download" :size="15" />保存 SVG</button><button class="btn-primary" :disabled="!currentIconSvg || !selectedIconSizes.length" @click="saveIconPngs"><Icon name="download" :size="15" />保存 {{ selectedIconSizes.length }} 个 PNG</button></div>
        </div>
      </section>
    </section>

    <section v-else-if="activeTab === 'info'" class="workspace info-layout">
      <section v-if="source" class="panel info-preview"><img :src="source.url" :alt="source.file.name" /></section>
      <section class="panel info-panel">
        <header class="panel-head"><b>基础信息</b></header>
        <div v-if="source" class="info-grid">
          <div><span>文件名</span><b :title="source.file.name">{{ source.file.name }}</b></div><div><span>文件类型</span><b>{{ source.file.type || "未知" }}</b></div>
          <div><span>图片尺寸</span><b>{{ source.width }} × {{ source.height }}</b></div><div><span>宽高比</span><b>{{ aspectRatioLabel(source.width, source.height) }}</b></div>
          <div><span>文件大小</span><b>{{ formatFileSize(source.file.size) }}</b></div><div><span>最后修改</span><b>{{ new Date(source.file.lastModified).toLocaleString('zh-CN') }}</b></div>
          <div><span>总像素</span><b>{{ (source.width * source.height / 1_000_000).toFixed(2) }} MP</b></div><div><span>透明通道</span><b>{{ source.file.type === 'image/png' || source.file.type === 'image/webp' ? '可能包含' : '不包含' }}</b></div>
        </div>
        <div v-else class="info-empty"><span class="empty-ico"><Icon name="image" :size="30" /></span><b>还没有图片信息</b><button class="btn-outline" @click="singleInput?.click()">选择第一张图片</button></div>
        <template v-if="source"><header class="panel-head sub-head"><b>EXIF 信息</b><span>{{ exifRows.length }} 项</span></header><div v-if="exifRows.length" class="exif-list"><div v-for="row in exifRows" :key="row.label"><span>{{ row.label }}</span><b>{{ row.value }}</b></div></div><div v-else class="no-exif">未检测到 EXIF 信息</div><footer class="info-actions"><button class="btn-outline" @click="exportCleanCopy"><Icon name="shield" :size="15" />导出无元数据副本</button></footer></template>
      </section>
    </section>

    <div v-if="dragOver && activeTab !== 'icon'" class="drop-overlay"><Icon name="image" :size="36" /><b>{{ activeTab === 'batch' ? '松开加入批量队列' : '松开读取图片' }}</b></div>
  </div>
</template>

<style scoped>
.image-tool { position: relative; height: 100%; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.hidden-input { display: none; }
.mode-tabs { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-1); overflow-x: auto; padding-bottom: var(--sp-1); border-bottom: 1px solid var(--border); }
.mode-tab { flex-shrink: 0; padding: var(--sp-2) var(--sp-4); border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--text-weak); font-size: var(--fs-md); cursor: pointer; }
.mode-tab:hover { color: var(--text); background: var(--ghost); }
.mode-tab.on { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); font-weight: 600; }
.source-bar { flex-shrink: 0; min-height: 38px; display: flex; align-items: center; gap: var(--sp-3); }
.source-name { flex: 1; min-width: 0; overflow: hidden; color: var(--text); font-size: var(--fs-md); text-overflow: ellipsis; white-space: nowrap; }
.source-meta { color: var(--muted); font-family: var(--font-num); font-size: var(--fs-sm); white-space: nowrap; }
.workspace { flex: 1; min-height: 0; }
.single-layout, .edit-layout { display: grid; grid-template-columns: minmax(245px, 0.68fr) minmax(420px, 1.32fr); gap: var(--sp-3); }
.edit-layout { grid-template-columns: minmax(285px, 0.76fr) minmax(400px, 1.24fr); }
.panel { min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.panel-head { flex-shrink: 0; min-height: 38px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--card-soft); }
.panel-head b { font-size: var(--fs-md); }
.panel-head > span { margin-left: auto; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.controls-panel, .preview-panel, .info-panel { display: flex; flex-direction: column; }
.controls-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-4); }
.field { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.field > span, .compact-field > span { color: var(--text-weak); font-size: var(--fs-sm); font-weight: 600; }
.field > span b { color: var(--primary-hover); font-family: var(--font-num); }
.field input:not([type="range"]):not([type="color"]), .field select, .compact-field input, .compact-field select { min-width: 0; height: 34px; padding: 0 var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); outline: none; background: var(--card); color: var(--text); font-size: var(--fs-md); }
.field input:focus, .field select:focus, .compact-field input:focus, .compact-field select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.field input[type="range"] { width: 100%; accent-color: var(--primary); }
.check-control { display: inline-flex; align-items: center; gap: var(--sp-1); color: var(--text-weak); font-size: var(--fs-sm); cursor: pointer; }
.check-control input { accent-color: var(--primary); }
.two-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2); }
.full-btn { width: 100%; justify-content: center; margin-top: auto; }
.color-control { display: flex; align-items: center; gap: var(--sp-3); }
.color-control input { width: 42px; height: 34px; padding: 2px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--card); }
.color-control code { color: var(--text-code); font-size: var(--fs-sm); }
.format-note, .saving-stat { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--card-soft); color: var(--primary-hover); }
.format-note small, .saving-stat span { grid-column: 2; color: var(--muted); font-size: var(--fs-xs); }
.saving-stat b { font-family: var(--font-num); }
.saving-stat.negative b { color: var(--warn-deep); }
.ratio-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-1); }
.ratio-grid button { min-height: 30px; padding: 0 var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--r-xs); background: var(--card); color: var(--text-weak); font-size: var(--fs-xs); cursor: pointer; }
.ratio-grid button.on { border-color: var(--border-blue); background: var(--primary-soft); color: var(--primary-hover); font-weight: 600; }
.icon-actions { display: flex; align-items: center; gap: var(--sp-2); }
.icon-actions .icon-btn.active { border-color: var(--border-blue); background: var(--primary-soft); color: var(--primary-hover); }
.icon-actions > span { margin-left: auto; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-sm); }

.palette-layout { display: grid; grid-template-columns: minmax(360px, 1.2fr) minmax(300px, 0.8fr); gap: var(--sp-3); }
.palette-preview, .palette-panel, .icon-output { display: flex; flex-direction: column; }
.palette-canvas-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: var(--sp-3); background: var(--well); }
.palette-canvas { flex: 1; min-height: 0; width: 100%; object-fit: contain; cursor: crosshair; }
.picked-bar { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-2); min-height: 42px; margin-top: var(--sp-3); padding: var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--card); }
.picked-swatch { flex-shrink: 0; width: 28px; height: 28px; border: 1px solid var(--border-strong); border-radius: var(--r-xs); }
.color-code { min-width: 0; display: inline-flex; align-items: center; gap: var(--sp-1); padding: var(--sp-1) var(--sp-2); overflow: hidden; border: none; border-radius: var(--r-xs); background: transparent; color: var(--text-code); font-family: var(--font-num); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.color-code:hover { background: var(--ghost); color: var(--primary-hover); }
.palette-controls { flex-shrink: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); }
.palette-list { flex: 1; min-height: 0; overflow: auto; }
.palette-row { width: 100%; min-height: 54px; display: grid; grid-template-columns: 34px minmax(0, 1fr) auto 18px; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-4); border: none; border-bottom: 1px solid var(--border); background: transparent; color: var(--muted); text-align: left; cursor: pointer; }
.palette-row:hover, .palette-row.selected { background: var(--primary-soft); }
.palette-swatch { width: 34px; height: 34px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); }
.palette-values { min-width: 0; }
.palette-values b, .palette-values small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.palette-values b { color: var(--text); font-family: var(--font-num); font-size: var(--fs-sm); }
.palette-values small { margin-top: var(--sp-1); color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.palette-ratio { color: var(--text-weak); font-family: var(--font-num); font-size: var(--fs-sm); }
.palette-actions { flex-shrink: 0; display: flex; justify-content: flex-end; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border-top: 1px solid var(--border); }

.icon-layout { display: grid; grid-template-columns: minmax(270px, 0.72fr) minmax(390px, 1.28fr); gap: var(--sp-3); }
.icon-mode { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 2px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--well); }
.icon-mode button { height: 30px; padding: 0 var(--sp-3); border: none; border-radius: var(--r-xs); background: transparent; color: var(--muted); font-size: var(--fs-sm); cursor: pointer; }
.icon-mode button.on { background: var(--card); color: var(--primary-hover); box-shadow: var(--shadow); font-weight: 600; }
.icon-prompt { min-height: 100px; resize: vertical; padding: var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); outline: none; background: var(--card); color: var(--text); font-family: inherit; font-size: var(--fs-md); line-height: var(--lh-body); }
.icon-prompt:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.ai-note { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--card-soft); color: var(--text-weak); font-size: var(--fs-sm); }
.icon-preview-area { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--sp-4); padding: var(--sp-4); background: var(--well); }
.icon-preview-stage { width: min(100%, 300px); aspect-ratio: 1; display: grid; place-items: center; justify-self: center; padding: var(--sp-6); background-image: linear-gradient(45deg, color-mix(in srgb, var(--text) 7%, transparent) 25%, transparent 25%), linear-gradient(-45deg, color-mix(in srgb, var(--text) 7%, transparent) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--text) 7%, transparent) 75%), linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--text) 7%, transparent) 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0; border: 1px solid var(--border-strong); border-radius: var(--r-md); }
.icon-preview-stage img { width: 100%; height: 100%; object-fit: contain; }
.mini-previews { align-self: stretch; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-5); min-width: 72px; padding: var(--sp-3); border-left: 1px solid var(--border); }
.mini-previews > span { display: flex; flex-direction: column; align-items: center; gap: var(--sp-1); }
.mini-previews img { object-fit: contain; }
.mini-previews small { color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.icon-export { flex-shrink: 0; display: grid; grid-template-columns: minmax(150px, 0.72fr) minmax(230px, 1.28fr); align-items: end; gap: var(--sp-3) var(--sp-4); padding: var(--sp-3) var(--sp-4); border-top: 1px solid var(--border); }
.size-chips { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.size-chips button { min-width: 42px; height: 28px; padding: 0 var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--r-xs); background: var(--card); color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); cursor: pointer; }
.size-chips button.on { border-color: var(--border-blue); background: var(--primary-soft); color: var(--primary-hover); font-weight: 600; }
.export-buttons { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: var(--sp-2); }

.info-preview img { flex: 1; min-height: 0; width: 100%; object-fit: contain; background-image: linear-gradient(45deg, color-mix(in srgb, var(--text) 7%, transparent) 25%, transparent 25%), linear-gradient(-45deg, color-mix(in srgb, var(--text) 7%, transparent) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--text) 7%, transparent) 75%), linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--text) 7%, transparent) 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0; }
.info-empty, .drop-empty { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-3); color: var(--muted); }
.info-empty b, .drop-empty b { color: var(--text-weak); font-size: var(--fs-md); }

.batch-layout { display: flex; flex-direction: column; gap: var(--sp-3); }
.batch-toolbar, .batch-options { flex-shrink: 0; display: flex; align-items: flex-end; gap: var(--sp-3); }
.batch-options { align-items: center; }
.batch-options > span { margin-left: auto; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-sm); }
.compact-field { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.compact-field select { min-width: 92px; }
.quality-field, .size-field { width: 90px; }
.batch-panel { flex: 1; display: flex; flex-direction: column; }
.batch-panel.dragging { border-color: var(--primary); }
.batch-head, .batch-row { display: grid; grid-template-columns: minmax(220px, 1.5fr) 100px 110px 100px 100px; align-items: center; gap: var(--sp-3); padding: 0 var(--sp-4); }
.batch-head { flex-shrink: 0; min-height: 36px; border-bottom: 1px solid var(--border); background: var(--card-soft); color: var(--text-dim); font-size: var(--fs-xs); font-weight: 600; }
.batch-list { flex: 1; min-height: 0; overflow: auto; }
.batch-row { min-height: 44px; border-bottom: 1px solid var(--border); color: var(--text-weak); font-size: var(--fs-sm); }
.batch-row.error { background: var(--danger-soft); }
.batch-name { min-width: 0; display: flex; align-items: center; gap: var(--sp-2); overflow: hidden; color: var(--text); text-overflow: ellipsis; white-space: nowrap; }
.batch-status { display: flex; align-items: center; gap: var(--sp-1); }
.batch-row.done .batch-status { color: var(--success-deep); }
.batch-row.error .batch-status { color: var(--danger-deep); }
.batch-row.processing .batch-status { color: var(--primary-hover); }

.info-layout { display: grid; grid-template-columns: minmax(320px, 1fr) minmax(380px, 1.1fr); gap: var(--sp-3); }
.info-preview { display: flex; padding: var(--sp-3); background: var(--well); }
.info-grid { padding: var(--sp-4); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-4); }
.info-grid > div { min-width: 0; }
.info-grid span, .exif-list span { display: block; color: var(--muted); font-size: var(--fs-xs); }
.info-grid b { display: block; margin-top: var(--sp-1); overflow: hidden; color: var(--text); font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.sub-head { border-top: 1px solid var(--border); }
.exif-list { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-content: start; }
.exif-list > div { min-width: 0; padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); }
.exif-list b { display: block; margin-top: var(--sp-1); color: var(--text-code); font-size: var(--fs-sm); }
.no-exif { flex: 1; display: grid; place-items: center; color: var(--muted); font-size: var(--fs-sm); }
.info-actions { flex-shrink: 0; display: flex; justify-content: flex-end; padding: var(--sp-3) var(--sp-4); border-top: 1px solid var(--border); }
.drop-overlay { position: absolute; inset: 0; z-index: 30; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-3); border: 2px dashed var(--primary); border-radius: var(--r-md); background: color-mix(in srgb, var(--card) 92%, transparent); color: var(--primary-hover); pointer-events: none; }

@media (max-width: 820px) {
  .single-layout, .edit-layout { grid-template-columns: minmax(235px, 0.75fr) minmax(360px, 1.25fr); overflow: auto; }
  .batch-toolbar, .batch-options { flex-wrap: wrap; }
  .batch-options > span { margin-left: 0; }
  .batch-panel { min-width: 670px; }
  .batch-layout { overflow: auto; }
  .info-layout { grid-template-columns: minmax(280px, 0.8fr) minmax(380px, 1.2fr); overflow: auto; }
  .palette-layout { grid-template-columns: minmax(340px, 1.05fr) minmax(280px, 0.95fr); overflow: auto; }
  .icon-layout { grid-template-columns: minmax(260px, 0.78fr) minmax(360px, 1.22fr); overflow: auto; }
  .icon-preview-stage { width: min(100%, 230px); }
  .icon-export { grid-template-columns: 1fr; }
  .export-buttons { grid-column: auto; }
}
</style>
