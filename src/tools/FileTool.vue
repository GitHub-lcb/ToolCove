<script setup>
import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import Icon from "../Icon.vue";
import { askConfirm } from "../confirm.js";
import {
  buildRenamePreview,
  convertLineEndings,
  countLineEndings,
  estimateBase64Bytes,
  formatFileSize,
  getFileName,
} from "../fileTool.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const isTauri = !!window.__TAURI_INTERNALS__;
const TABS = [
  { key: "info", label: "文件信息" },
  { key: "md5", label: "修改 MD5" },
  { key: "encoding", label: "编码转换" },
  { key: "base64", label: "Base64" },
  { key: "line", label: "换行符" },
  { key: "rename", label: "批量重命名" },
];
const ENCODINGS = ["AUTO", "UTF-8", "UTF-16LE", "UTF-16BE", "GBK"];
const OUTPUT_ENCODINGS = ENCODINGS.slice(1);
const activeTab = ref("info");

function ensureDesktop() {
  if (isTauri) return true;
  props.showToast("文件处理需要在桌面应用中使用");
  return false;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function formatDate(timestamp) {
  if (!timestamp) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date(timestamp));
}
function siblingPath(path, suffix) {
  const value = String(path ?? "");
  const name = getFileName(value);
  const dot = name.lastIndexOf(".");
  const next = dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`;
  return value.slice(0, value.length - name.length) + next;
}
async function copyText(value, label = "内容") {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(String(value));
    props.showToast(`${label}已复制`);
  } catch {
    props.showToast("复制失败，请手动复制");
  }
}

// 文件信息
const infoItems = ref([]);
const infoState = ref({ loading: false, error: "" });
async function chooseInfoFiles() {
  if (!ensureDesktop()) return;
  const paths = await openDialog({ multiple: true, title: "选择要查看的文件" });
  if (paths) await inspectPaths(Array.isArray(paths) ? paths : [paths]);
}
async function chooseInfoDirectory() {
  if (!ensureDesktop()) return;
  const path = await openDialog({ directory: true, title: "选择要查看的文件夹" });
  if (path) await inspectPaths([path]);
}
async function inspectPaths(paths) {
  infoState.value = { loading: true, error: "" };
  try {
    infoItems.value = await invoke("file_tool_inspect", { paths });
    infoState.value = { loading: false, error: "" };
  } catch (error) {
    infoItems.value = [];
    infoState.value = { loading: false, error: errorMessage(error) };
  }
}

// 修改 MD5
const md5File = ref(null);
const md5Result = ref(null);
const md5State = ref({ loading: false, error: "", label: "" });
async function chooseMd5File() {
  if (!ensureDesktop()) return;
  const path = await openDialog({ title: "选择要修改 MD5 的文件" });
  if (!path) return;
  md5File.value = null;
  md5Result.value = null;
  md5State.value = { loading: true, error: "", label: "正在计算原 MD5" };
  try {
    md5File.value = await invoke("file_tool_calculate_md5", { path });
    md5State.value = { loading: false, error: "", label: "" };
  } catch (error) {
    md5State.value = { loading: false, error: errorMessage(error), label: "" };
  }
}
async function generateMd5Copy() {
  if (!ensureDesktop() || !md5File.value) return props.showToast("请先选择文件");
  const outputPath = await saveDialog({
    title: "保存 MD5 副本",
    defaultPath: siblingPath(md5File.value.path, "_md5"),
  });
  if (!outputPath) return;
  md5Result.value = null;
  md5State.value = { loading: true, error: "", label: "正在生成 MD5 副本" };
  try {
    const result = await invoke("file_tool_modify_md5", {
      sourcePath: md5File.value.path,
      outputPath,
    });
    md5File.value = {
      ...md5File.value,
      size: result.sourceSize,
      md5: result.originalMd5,
    };
    md5Result.value = result;
    md5State.value = { loading: false, error: "", label: "" };
    props.showToast("MD5 副本已生成");
  } catch (error) {
    md5State.value = { loading: false, error: errorMessage(error), label: "" };
  }
}

// 编码转换
const encodingPath = ref("");
const encodingText = ref("");
const inputEncoding = ref("AUTO");
const detectedEncoding = ref("");
const outputEncoding = ref("UTF-8");
const outputBom = ref(false);
const encodingMeta = ref({ size: 0, hasBom: false, lossy: false });
const encodingState = ref({ loading: false, error: "" });
async function chooseEncodingFile() {
  if (!ensureDesktop()) return;
  const path = await openDialog({ title: "选择文本文件" });
  if (path) {
    encodingPath.value = path;
    await loadEncodingFile();
  }
}
async function loadEncodingFile() {
  if (!encodingPath.value) return props.showToast("请先选择文本文件");
  encodingState.value = { loading: true, error: "" };
  try {
    const result = await invoke("file_tool_read_text", { path: encodingPath.value, encoding: inputEncoding.value });
    encodingText.value = result.text;
    detectedEncoding.value = result.encoding;
    encodingMeta.value = { size: result.size, hasBom: result.hasBom, lossy: result.lossy };
    if (inputEncoding.value === "AUTO") outputEncoding.value = result.encoding;
    outputBom.value = result.hasBom && result.encoding !== "GBK";
    encodingState.value = { loading: false, error: "" };
  } catch (error) {
    encodingState.value = { loading: false, error: errorMessage(error) };
  }
}
async function saveEncodedFile() {
  if (!ensureDesktop() || !encodingPath.value) return props.showToast("请先选择文本文件");
  const path = await saveDialog({ title: "另存编码转换结果", defaultPath: siblingPath(encodingPath.value, `_${outputEncoding.value.toLowerCase()}`) });
  if (!path) return;
  try {
    await invoke("file_tool_write_text", {
      path,
      text: encodingText.value,
      encoding: outputEncoding.value,
      bom: outputEncoding.value === "GBK" ? false : outputBom.value,
    });
    props.showToast(`已保存为 ${outputEncoding.value}`);
  } catch (error) {
    props.showToast(`保存失败：${errorMessage(error)}`);
  }
}

// Base64 文件转换
const base64Mode = ref("encode");
const base64Path = ref("");
const base64Name = ref("");
const base64Size = ref(0);
const base64Text = ref("");
const includeDataUrl = ref(false);
const mimeType = ref("application/octet-stream");
const base64State = ref({ loading: false, error: "" });
const base64Display = computed(() => {
  if (!base64Text.value || !includeDataUrl.value || base64Mode.value !== "encode") return base64Text.value;
  return `data:${mimeType.value || "application/octet-stream"};base64,${base64Text.value}`;
});
const decodedSize = computed(() => estimateBase64Bytes(base64Text.value));
async function chooseBase64File() {
  if (!ensureDesktop()) return;
  const path = await openDialog({ title: "选择要编码的文件" });
  if (!path) return;
  base64State.value = { loading: true, error: "" };
  try {
    const result = await invoke("file_tool_read_base64", { path });
    base64Path.value = result.path;
    base64Name.value = result.name;
    base64Size.value = result.size;
    base64Text.value = result.base64;
    base64State.value = { loading: false, error: "" };
  } catch (error) {
    base64State.value = { loading: false, error: errorMessage(error) };
  }
}
function switchBase64Mode(mode) {
  base64Mode.value = mode;
  base64State.value = { loading: false, error: "" };
  base64Text.value = "";
  base64Path.value = "";
  base64Name.value = "";
  base64Size.value = 0;
}
async function saveDecodedFile() {
  if (!ensureDesktop()) return;
  if (!base64Text.value.trim()) return props.showToast("请粘贴 Base64 内容");
  const path = await saveDialog({ title: "保存 Base64 解码结果", defaultPath: "decoded.bin" });
  if (!path) return;
  base64State.value = { loading: true, error: "" };
  try {
    const bytes = await invoke("file_tool_write_base64", { path, content: base64Text.value });
    base64State.value = { loading: false, error: "" };
    props.showToast(`已解码并保存 ${formatFileSize(bytes)}`);
  } catch (error) {
    base64State.value = { loading: false, error: errorMessage(error) };
  }
}

// 换行符
const linePath = ref("");
const lineText = ref("");
const lineEncoding = ref("UTF-8");
const lineHasBom = ref(false);
const lineTarget = ref("LF");
const lineState = ref({ loading: false, error: "" });
const lineStats = computed(() => countLineEndings(lineText.value));
const lineOutput = computed(() => convertLineEndings(lineText.value, lineTarget.value));
async function chooseLineFile() {
  if (!ensureDesktop()) return;
  const path = await openDialog({ title: "选择文本文件" });
  if (!path) return;
  lineState.value = { loading: true, error: "" };
  try {
    const result = await invoke("file_tool_read_text", { path, encoding: "AUTO" });
    linePath.value = result.path;
    lineText.value = result.text;
    lineEncoding.value = result.encoding;
    lineHasBom.value = result.hasBom;
    lineState.value = { loading: false, error: "" };
  } catch (error) {
    lineState.value = { loading: false, error: errorMessage(error) };
  }
}
async function saveLineFile() {
  if (!ensureDesktop() || !linePath.value) return props.showToast("请先选择文本文件");
  const path = await saveDialog({ title: "另存换行符转换结果", defaultPath: siblingPath(linePath.value, `_${lineTarget.value.toLowerCase()}`) });
  if (!path) return;
  try {
    await invoke("file_tool_write_text", { path, text: lineOutput.value, encoding: lineEncoding.value, bom: lineHasBom.value });
    props.showToast(`已转换为 ${lineTarget.value}`);
  } catch (error) {
    props.showToast(`保存失败：${errorMessage(error)}`);
  }
}

// 批量重命名
const renameDirectory = ref("");
const renameFiles = ref([]);
const selectedRenamePaths = ref(new Set());
const renameFilter = ref("");
const renameRules = ref({
  find: "", replace: "", useRegex: false, caseSensitive: false,
  prefix: "", suffix: "", caseMode: "keep", preserveExtension: true,
  numbering: "none", numberStart: 1, numberPadding: 2, numberSeparator: "_",
});
const renameState = ref({ loading: false, error: "" });
const selectedRenameFiles = computed(() => renameFiles.value.filter((file) => selectedRenamePaths.value.has(file.path)));
const visibleRenameFiles = computed(() => {
  const query = renameFilter.value.trim().toLocaleLowerCase();
  return query ? renameFiles.value.filter((file) => file.name.toLocaleLowerCase().includes(query)) : renameFiles.value;
});
const renamePreview = computed(() => buildRenamePreview(selectedRenameFiles.value, renameRules.value));
const renameSummary = computed(() => ({
  selected: renamePreview.value.length,
  changed: renamePreview.value.filter((item) => item.changed).length,
  invalid: renamePreview.value.filter((item) => !item.valid).length,
}));
const canRename = computed(() => renameSummary.value.changed > 0 && renameSummary.value.invalid === 0 && !renameState.value.loading);
async function chooseRenameDirectory() {
  if (!ensureDesktop()) return;
  const path = await openDialog({ directory: true, title: "选择批量重命名文件夹" });
  if (path) await loadRenameDirectory(path);
}
async function loadRenameDirectory(path = renameDirectory.value) {
  if (!path) return;
  renameState.value = { loading: true, error: "" };
  try {
    const files = await invoke("file_tool_list_directory", { path });
    renameDirectory.value = path;
    renameFiles.value = files;
    selectedRenamePaths.value = new Set(files.slice(0, 500).map((file) => file.path));
    renameState.value = { loading: false, error: "" };
    if (files.length > 500) props.showToast("文件较多，已先选择前 500 个");
  } catch (error) {
    renameFiles.value = [];
    selectedRenamePaths.value = new Set();
    renameState.value = { loading: false, error: errorMessage(error) };
  }
}
function toggleRenameFile(path) {
  const next = new Set(selectedRenamePaths.value);
  if (next.has(path)) next.delete(path);
  else if (next.size < 500) next.add(path);
  else return props.showToast("单次最多选择 500 个文件");
  selectedRenamePaths.value = next;
}
function toggleVisibleRenameFiles() {
  const next = new Set(selectedRenamePaths.value);
  const visible = visibleRenameFiles.value;
  const allSelected = visible.length > 0 && visible.every((file) => next.has(file.path));
  if (allSelected) visible.forEach((file) => next.delete(file.path));
  else {
    for (const file of visible) {
      if (next.size >= 500) break;
      next.add(file.path);
    }
  }
  selectedRenamePaths.value = next;
}
async function executeRename() {
  if (!canRename.value) return;
  const count = renameSummary.value.changed;
  const ok = await askConfirm({
    title: "执行批量重命名",
    message: `将重命名 ${count} 个文件。请确认预览结果无误后继续。`,
    okText: "执行重命名",
    danger: false,
  });
  if (!ok) return;
  renameState.value = { loading: true, error: "" };
  try {
    const items = renamePreview.value.filter((item) => item.changed).map((item) => ({ path: item.path, targetName: item.targetName }));
    const renamed = await invoke("file_tool_batch_rename", { items });
    props.showToast(`已重命名 ${renamed} 个文件`);
    await loadRenameDirectory();
  } catch (error) {
    renameState.value = { loading: false, error: errorMessage(error) };
  }
}
</script>

<template>
  <div class="file-tool">
    <nav class="mode-tabs" aria-label="文件处理类型">
      <button v-for="tab in TABS" :key="tab.key" class="mode-tab" :class="{ on: activeTab === tab.key }" @click="activeTab = tab.key">{{ tab.label }}</button>
    </nav>

    <section v-if="activeTab === 'info'" class="workspace column-workspace">
      <div class="control-bar">
        <button class="btn-primary" @click="chooseInfoFiles"><Icon name="file" :size="15" />选择文件</button>
        <button class="btn-outline" @click="chooseInfoDirectory"><Icon name="folder" :size="15" />选择文件夹</button>
        <span v-if="infoItems.length" class="summary-text">{{ infoItems.length }} 项</span>
      </div>
      <div v-if="infoState.loading" class="panel state-panel"><div class="loading-state"><span class="spinner"></span>正在读取文件信息</div></div>
      <div v-else-if="infoState.error" class="panel state-panel"><div class="error-state"><Icon name="alert" :size="20" />{{ infoState.error }}</div></div>
      <div v-else-if="infoItems.length" class="info-list">
        <article v-for="item in infoItems" :key="item.path" class="info-card">
          <header><span class="file-type"><Icon :name="item.isDirectory ? 'folder' : 'file'" :size="18" /></span><b :title="item.name">{{ item.name }}</b><span class="type-chip">{{ item.isDirectory ? "文件夹" : (item.extension || "无扩展名") }}</span></header>
          <dl>
            <div><dt>大小</dt><dd>{{ item.isDirectory ? "不计算目录内容" : formatFileSize(item.size) }}</dd></div>
            <div><dt>修改时间</dt><dd>{{ formatDate(item.modifiedAt) }}</dd></div>
            <div><dt>创建时间</dt><dd>{{ formatDate(item.createdAt) }}</dd></div>
            <div><dt>属性</dt><dd>{{ item.readonly ? "只读" : "可写" }}</dd></div>
          </dl>
          <footer><code :title="item.path">{{ item.path }}</code><button class="icon-btn xs" title="复制路径" @click="copyText(item.path, '路径')"><Icon name="copy" :size="13" /></button></footer>
        </article>
      </div>
      <div v-else class="panel state-panel"><div class="blank-state"><Icon name="file" :size="26" /><span>选择文件或文件夹查看大小、时间、类型和路径</span></div></div>
    </section>

    <section v-else-if="activeTab === 'md5'" class="workspace column-workspace">
      <div class="control-bar">
        <button class="btn-outline" :disabled="md5State.loading" @click="chooseMd5File"><Icon name="file" :size="15" />选择文件</button>
        <span v-if="md5File" class="source-file" :title="md5File.path">{{ md5File.name }} · {{ formatFileSize(md5File.size) }}</span>
        <span class="warn-chip"><Icon name="alert" :size="13" />严格校验与数字签名将失效</span>
        <button class="btn-primary push-right" :disabled="!md5File || md5State.loading" @click="generateMd5Copy"><Icon name="sparkles" :size="15" />生成副本</button>
      </div>
      <div v-if="md5State.error" class="inline-error"><Icon name="alert" :size="16" />{{ md5State.error }}</div>
      <div v-if="md5State.loading" class="panel state-panel"><div class="loading-state"><span class="spinner"></span>{{ md5State.label }}</div></div>
      <section v-else-if="md5File" class="panel md5-panel">
        <header class="panel-head"><Icon name="shield" :size="16" /><b :title="md5File.name">{{ md5File.name }}</b><span>{{ formatFileSize(md5Result?.outputSize ?? md5File.size) }}</span></header>
        <div class="md5-result-body">
          <div v-if="md5Result" class="md5-success"><Icon name="check" :size="15" /><b>副本已生成</b><span>增加 {{ formatFileSize(md5Result.appendedBytes) }}</span></div>
          <div class="md5-hash-list">
            <div class="md5-hash-row"><span>原 MD5</span><code :title="md5File.md5">{{ md5File.md5 }}</code><button class="icon-btn xs" title="复制原 MD5" @click="copyText(md5File.md5, '原 MD5')"><Icon name="copy" :size="13" /></button></div>
            <div v-if="md5Result" class="md5-hash-row changed"><span>新 MD5</span><code :title="md5Result.newMd5">{{ md5Result.newMd5 }}</code><button class="icon-btn xs" title="复制新 MD5" @click="copyText(md5Result.newMd5, '新 MD5')"><Icon name="copy" :size="13" /></button></div>
          </div>
          <div class="md5-path-list">
            <div class="md5-path-row"><span>源文件</span><code :title="md5File.path">{{ md5File.path }}</code><button class="icon-btn xs" title="复制源文件路径" @click="copyText(md5File.path, '源文件路径')"><Icon name="copy" :size="13" /></button></div>
            <div v-if="md5Result" class="md5-path-row"><span>输出副本</span><code :title="md5Result.outputPath">{{ md5Result.outputPath }}</code><button class="icon-btn xs" title="复制副本路径" @click="copyText(md5Result.outputPath, '副本路径')"><Icon name="copy" :size="13" /></button></div>
          </div>
        </div>
      </section>
      <div v-else class="panel state-panel"><div class="blank-state"><Icon name="shield" :size="26" /><span>选择文件后计算 MD5，并生成保留源文件的新副本</span></div></div>
    </section>

    <section v-else-if="activeTab === 'encoding'" class="workspace column-workspace">
      <div class="control-bar encoding-controls">
        <button class="btn-primary" @click="chooseEncodingFile"><Icon name="file" :size="15" />选择文本</button>
        <label class="field encoding-field"><span>读取编码</span><select v-model="inputEncoding"><option v-for="encoding in ENCODINGS" :key="encoding">{{ encoding }}</option></select></label>
        <button class="btn-ghost" :disabled="!encodingPath || encodingState.loading" @click="loadEncodingFile"><Icon name="refresh" :size="14" />重新读取</button>
        <span v-if="encodingPath" class="source-file" :title="encodingPath">{{ getFileName(encodingPath) }}</span>
        <label class="field encoding-field output-field"><span>输出编码</span><select v-model="outputEncoding"><option v-for="encoding in OUTPUT_ENCODINGS" :key="encoding">{{ encoding }}</option></select></label>
        <label v-if="outputEncoding !== 'GBK'" class="check-control"><input v-model="outputBom" type="checkbox" />写入 BOM</label>
        <button class="btn-outline" :disabled="!encodingPath" @click="saveEncodedFile"><Icon name="download" :size="15" />另存为</button>
      </div>
      <div v-if="encodingState.error" class="inline-error"><Icon name="alert" :size="16" />{{ encodingState.error }}</div>
      <div v-if="encodingPath" class="meta-strip"><span>识别编码 <b>{{ detectedEncoding }}</b></span><span>{{ formatFileSize(encodingMeta.size) }}</span><span>{{ encodingMeta.hasBom ? "含 BOM" : "无 BOM" }}</span><span v-if="encodingMeta.lossy" class="warn-text">存在无法解码的字节</span></div>
      <section class="panel editor-panel">
        <header class="panel-head"><b>文本内容</b><span>{{ encodingText.length }} 字符</span></header>
        <div v-if="encodingState.loading" class="loading-state"><span class="spinner"></span>正在读取文本</div>
        <textarea v-else v-model="encodingText" class="text-editor mono" spellcheck="false" placeholder="选择文本文件后可在这里预览和编辑"></textarea>
      </section>
    </section>

    <section v-else-if="activeTab === 'base64'" class="workspace column-workspace">
      <div class="control-bar base64-controls">
        <div class="segmented"><button :class="{ on: base64Mode === 'encode' }" @click="switchBase64Mode('encode')">文件转 Base64</button><button :class="{ on: base64Mode === 'decode' }" @click="switchBase64Mode('decode')">Base64 转文件</button></div>
        <template v-if="base64Mode === 'encode'">
          <button class="btn-primary" @click="chooseBase64File"><Icon name="file" :size="15" />选择文件</button>
          <label class="check-control"><input v-model="includeDataUrl" type="checkbox" />Data URL</label>
          <label v-if="includeDataUrl" class="field mime-field"><span>媒体类型</span><input v-model="mimeType" class="mono" /></label>
          <span v-if="base64Name" class="source-file" :title="base64Path">{{ base64Name }} · {{ formatFileSize(base64Size) }}</span>
          <button class="btn-outline push-right" :disabled="!base64Text" @click="copyText(base64Display, 'Base64')"><Icon name="copy" :size="15" />复制</button>
        </template>
        <template v-else>
          <span class="summary-text">预计 {{ formatFileSize(decodedSize) }}</span>
          <button class="btn-primary push-right" :disabled="!base64Text.trim() || base64State.loading" @click="saveDecodedFile"><Icon name="download" :size="15" />解码并保存</button>
        </template>
      </div>
      <div v-if="base64State.error" class="inline-error"><Icon name="alert" :size="16" />{{ base64State.error }}</div>
      <section class="panel editor-panel">
        <header class="panel-head"><b>{{ base64Mode === 'encode' ? 'Base64 结果' : 'Base64 / Data URL' }}</b><span>{{ base64Display.length }} 字符</span></header>
        <div v-if="base64State.loading" class="loading-state"><span class="spinner"></span>正在处理文件</div>
        <textarea v-else-if="base64Mode === 'encode'" :value="base64Display" class="text-editor mono output" readonly spellcheck="false" placeholder="选择文件后生成 Base64"></textarea>
        <textarea v-else v-model="base64Text" class="text-editor mono" spellcheck="false" placeholder="粘贴 Base64 或 data:...;base64,..."></textarea>
      </section>
    </section>

    <section v-else-if="activeTab === 'line'" class="workspace column-workspace">
      <div class="control-bar">
        <button class="btn-primary" @click="chooseLineFile"><Icon name="file" :size="15" />选择文本</button>
        <label class="field line-field"><span>目标换行符</span><select v-model="lineTarget"><option>LF</option><option>CRLF</option><option>CR</option></select></label>
        <span v-if="linePath" class="source-file" :title="linePath">{{ getFileName(linePath) }} · {{ lineEncoding }}</span>
        <button class="btn-outline push-right" :disabled="!linePath" @click="saveLineFile"><Icon name="download" :size="15" />另存为</button>
      </div>
      <div v-if="lineState.error" class="inline-error"><Icon name="alert" :size="16" />{{ lineState.error }}</div>
      <div v-if="linePath" class="line-stats"><span>总行数 <b>{{ lineStats.lines }}</b></span><span>CRLF <b>{{ lineStats.crlf }}</b></span><span>LF <b>{{ lineStats.lf }}</b></span><span>CR <b>{{ lineStats.cr }}</b></span><span v-if="lineStats.mixed" class="warn-chip">混合换行符</span></div>
      <div class="split-workspace">
        <section class="panel editor-panel"><header class="panel-head"><b>原始文本</b></header><div v-if="lineState.loading" class="loading-state"><span class="spinner"></span>正在读取文本</div><textarea v-else v-model="lineText" class="text-editor mono" spellcheck="false" placeholder="选择文本文件"></textarea></section>
        <section class="panel editor-panel"><header class="panel-head"><b>{{ lineTarget }} 预览</b><button class="icon-btn xs" title="复制转换结果" :disabled="!lineOutput" @click="copyText(lineOutput, '转换结果')"><Icon name="copy" :size="13" /></button></header><textarea :value="lineOutput" class="text-editor mono output" readonly spellcheck="false"></textarea></section>
      </div>
    </section>

    <section v-else-if="activeTab === 'rename'" class="workspace rename-workspace">
      <div class="rename-toolbar">
        <button class="btn-primary" @click="chooseRenameDirectory"><Icon name="folder" :size="15" />选择文件夹</button>
        <span v-if="renameDirectory" class="source-file grow" :title="renameDirectory">{{ renameDirectory }}</span>
        <span class="summary-text">已选 {{ renameSummary.selected }} · 将改名 {{ renameSummary.changed }} · 错误 {{ renameSummary.invalid }}</span>
        <button class="btn-outline" :disabled="!canRename" @click="executeRename"><Icon name="edit" :size="15" />执行重命名</button>
      </div>
      <div v-if="renameState.error" class="inline-error"><Icon name="alert" :size="16" />{{ renameState.error }}</div>
      <div class="rename-layout">
        <aside class="panel rules-panel">
          <header class="panel-head"><b>命名规则</b></header>
          <div class="rules-body">
            <label class="field"><span>查找</span><input v-model="renameRules.find" class="mono" placeholder="留空则不替换" /></label>
            <label class="field"><span>替换为</span><input v-model="renameRules.replace" class="mono" /></label>
            <div class="check-row"><label class="check-control"><input v-model="renameRules.useRegex" type="checkbox" />正则</label><label class="check-control"><input v-model="renameRules.caseSensitive" type="checkbox" />区分大小写</label></div>
            <div class="two-fields"><label class="field"><span>前缀</span><input v-model="renameRules.prefix" /></label><label class="field"><span>后缀</span><input v-model="renameRules.suffix" /></label></div>
            <label class="field"><span>大小写</span><select v-model="renameRules.caseMode"><option value="keep">保持不变</option><option value="lower">转小写</option><option value="upper">转大写</option></select></label>
            <label class="field"><span>序号位置</span><select v-model="renameRules.numbering"><option value="none">不添加</option><option value="prefix">文件名前</option><option value="suffix">文件名后</option></select></label>
            <div v-if="renameRules.numbering !== 'none'" class="number-fields"><label class="field"><span>起始</span><input v-model.number="renameRules.numberStart" type="number" /></label><label class="field"><span>位数</span><input v-model.number="renameRules.numberPadding" type="number" min="1" max="12" /></label><label class="field"><span>分隔符</span><input v-model="renameRules.numberSeparator" /></label></div>
            <label class="check-control"><input v-model="renameRules.preserveExtension" type="checkbox" />保留扩展名，不参与规则</label>
          </div>
        </aside>
        <section class="panel file-select-panel">
          <header class="panel-head"><b>文件</b><span>{{ renameFiles.length }} 个</span></header>
          <div class="file-filter"><input v-model="renameFilter" placeholder="筛选文件名" /><button class="btn-ghost xs" @click="toggleVisibleRenameFiles">全选/取消</button></div>
          <div v-if="renameState.loading" class="loading-state"><span class="spinner"></span>正在读取文件夹</div>
          <div v-else-if="renameFiles.length" class="select-list"><label v-for="file in visibleRenameFiles" :key="file.path" class="select-row"><input type="checkbox" :checked="selectedRenamePaths.has(file.path)" @change="toggleRenameFile(file.path)" /><Icon name="file" :size="14" /><span :title="file.name">{{ file.name }}</span><small>{{ formatFileSize(file.size) }}</small></label></div>
          <div v-else class="blank-state compact"><Icon name="folder" :size="22" /><span>选择文件夹加载第一层文件</span></div>
        </section>
        <section class="panel preview-panel">
          <header class="panel-head"><b>重命名预览</b><span>{{ renameSummary.changed }} 项变更</span></header>
          <div v-if="renamePreview.length" class="preview-list"><div v-for="item in renamePreview" :key="item.path" class="preview-row" :class="{ invalid: !item.valid, unchanged: !item.changed }"><span class="old-name" :title="item.sourceName">{{ item.sourceName }}</span><Icon name="chevron-right" :size="14" /><span class="new-name" :title="item.targetName">{{ item.targetName }}</span><small v-if="item.error" :title="item.error">{{ item.error }}</small><Icon v-else-if="item.changed" name="check" :size="14" class="ok-icon" /><small v-else>无变化</small></div></div>
          <div v-else class="blank-state compact"><Icon name="edit" :size="22" /><span>选择文件并设置规则后查看预览</span></div>
        </section>
      </div>
    </section>
  </div>
</template>

<style scoped>
.file-tool { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.mode-tabs { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-1); overflow-x: auto; padding-bottom: var(--sp-1); border-bottom: 1px solid var(--border); }
.mode-tab { flex-shrink: 0; padding: var(--sp-2) var(--sp-4); border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--text-weak); font-size: var(--fs-md); cursor: pointer; transition: color 0.15s, background 0.15s, border-color 0.15s; }
.mode-tab:hover { color: var(--text); background: var(--ghost); }
.mode-tab.on { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); font-weight: 600; }
.workspace { flex: 1; min-height: 0; }
.column-workspace { display: flex; flex-direction: column; gap: var(--sp-3); }
.control-bar, .rename-toolbar { flex-shrink: 0; min-height: 40px; display: flex; align-items: flex-end; gap: var(--sp-3); }
.panel { min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.panel-head { flex-shrink: 0; min-height: 38px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--card-soft); }
.panel-head b { font-size: var(--fs-md); }
.panel-head > span { margin-left: auto; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.panel-head > button { margin-left: auto; }
.field { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.field > span { color: var(--text-weak); font-size: var(--fs-sm); font-weight: 600; }
.field input, .field select, .file-filter input { min-width: 0; height: 34px; padding: 0 var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); outline: none; background: var(--card); color: var(--text); font-size: var(--fs-md); }
.field input:focus, .field select:focus, .file-filter input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.check-control { display: inline-flex; align-items: center; gap: var(--sp-1); min-height: 34px; color: var(--text-weak); font-size: var(--fs-sm); white-space: nowrap; cursor: pointer; }
.check-control input, .select-row input { accent-color: var(--primary); }
.summary-text, .source-file { align-self: center; color: var(--muted); font-size: var(--fs-sm); }
.source-file { min-width: 0; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grow { flex: 1; max-width: none; }
.push-right { margin-left: auto; }
.encoding-field { width: 122px; }
.output-field { margin-left: auto; }
.mime-field { flex: 1; max-width: 300px; }
.line-field { width: 130px; }
.mono, code { font-family: var(--font-mono); }
.state-panel { flex: 1; display: flex; }
.loading-state, .error-state, .blank-state { flex: 1; min-height: 130px; display: flex; align-items: center; justify-content: center; gap: var(--sp-2); padding: var(--sp-5); color: var(--muted); font-size: var(--fs-sm); text-align: center; }
.error-state { color: var(--danger-deep); background: var(--danger-soft); }
.blank-state svg { color: var(--faint); }
.blank-state.compact { min-height: 100px; }
.inline-error { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border-danger); border-radius: var(--r-sm); background: var(--danger-soft); color: var(--danger-deep); font-size: var(--fs-sm); }
.spinner { width: 16px; height: 16px; border: 2px solid var(--border-strong); border-top-color: var(--primary); border-radius: var(--r-pill); animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.info-list { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--sp-3); align-content: start; }
.info-card { min-width: 0; overflow: hidden; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.info-card header { display: flex; align-items: center; gap: var(--sp-2); min-height: 46px; padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); }
.info-card header b { flex: 1; min-width: 0; overflow: hidden; font-size: var(--fs-md); text-overflow: ellipsis; white-space: nowrap; }
.file-type { width: 30px; height: 30px; display: grid; place-items: center; border-radius: var(--r-sm); background: var(--primary-soft); color: var(--primary-hover); }
.type-chip { padding: 2px var(--sp-2); border-radius: var(--r-pill); background: var(--well); color: var(--text-soft); font-size: var(--fs-xs); }
.info-card dl { margin: 0; padding: var(--sp-3) var(--sp-4); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); }
.info-card dl div { min-width: 0; }
.info-card dt { color: var(--muted); font-size: var(--fs-xs); }
.info-card dd { margin: var(--sp-1) 0 0; overflow: hidden; color: var(--text); font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.info-card footer { display: flex; align-items: center; gap: var(--sp-2); min-height: 38px; padding: 0 var(--sp-4); border-top: 1px solid var(--border); background: var(--card-soft); }
.info-card footer code { flex: 1; min-width: 0; overflow: hidden; color: var(--text-code); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }

.meta-strip, .line-stats { flex-shrink: 0; min-height: 38px; display: flex; align-items: center; gap: var(--sp-5); padding: 0 var(--sp-4); border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--card); color: var(--muted); font-size: var(--fs-sm); }
.meta-strip b, .line-stats b { color: var(--primary-hover); font-family: var(--font-num); }
.warn-text { color: var(--warn-deep); }
.editor-panel { flex: 1; display: flex; flex-direction: column; }
.text-editor { flex: 1; min-height: 0; width: 100%; padding: var(--sp-4); resize: none; border: none; outline: none; background: transparent; color: var(--text-code); font-size: var(--fs-md); line-height: var(--lh-body); overflow: auto; }
.text-editor.output { background: color-mix(in srgb, var(--text) 1.5%, transparent); }
.segmented { flex-shrink: 0; display: inline-grid; grid-auto-flow: column; grid-auto-columns: minmax(96px, auto); padding: 2px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--well); }
.segmented button { min-height: 30px; padding: 0 var(--sp-3); border: none; border-radius: var(--r-xs); background: transparent; color: var(--muted); font-size: var(--fs-sm); cursor: pointer; }
.segmented button.on { background: var(--card); color: var(--primary-hover); box-shadow: var(--shadow); font-weight: 600; }
.split-workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); }
.warn-chip { display: inline-flex; align-items: center; gap: var(--sp-1); padding: var(--sp-1) var(--sp-3); border-radius: var(--r-pill); background: var(--warn-soft); color: var(--warn-deep); font-size: var(--fs-sm); }

.md5-panel { flex: 1; display: flex; flex-direction: column; }
.md5-panel .panel-head b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md5-result-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-5); padding: var(--sp-5); }
.md5-success { display: flex; align-items: center; gap: var(--sp-2); min-height: 36px; padding: 0 var(--sp-3); border: 1px solid var(--success-border); border-radius: var(--r-sm); background: var(--success-soft); color: var(--success-deep); font-size: var(--fs-sm); }
.md5-success span { margin-left: auto; font-family: var(--font-num); }
.md5-hash-list, .md5-path-list { display: flex; flex-direction: column; }
.md5-hash-row, .md5-path-row { min-width: 0; display: grid; grid-template-columns: 76px minmax(0, 1fr) 24px; align-items: center; gap: var(--sp-3); min-height: 52px; border-bottom: 1px solid var(--border); }
.md5-hash-row:first-child, .md5-path-row:first-child { border-top: 1px solid var(--border); }
.md5-hash-row > span, .md5-path-row > span { color: var(--muted); font-size: var(--fs-sm); font-weight: 600; }
.md5-hash-row code, .md5-path-row code { min-width: 0; overflow: hidden; color: var(--text-code); font-size: var(--fs-md); text-overflow: ellipsis; white-space: nowrap; }
.md5-hash-row.changed code { color: var(--success-deep); }
.md5-path-row { min-height: 42px; }
.md5-path-row code { font-size: var(--fs-xs); }

.rename-workspace { display: flex; flex-direction: column; gap: var(--sp-3); }
.rename-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(205px, 0.68fr) minmax(210px, 0.75fr) minmax(320px, 1.35fr); gap: var(--sp-3); }
.rules-panel, .file-select-panel, .preview-panel { display: flex; flex-direction: column; }
.rules-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
.two-fields, .number-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2); }
.number-fields { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.check-row { display: flex; flex-wrap: wrap; gap: var(--sp-4); }
.file-filter { flex-shrink: 0; display: flex; gap: var(--sp-2); padding: var(--sp-3); border-bottom: 1px solid var(--border); }
.file-filter input { flex: 1; }
.select-list, .preview-list { flex: 1; min-height: 0; overflow: auto; }
.select-row { display: grid; grid-template-columns: auto 16px minmax(0, 1fr) auto; align-items: center; gap: var(--sp-2); min-height: 38px; padding: 0 var(--sp-3); border-bottom: 1px solid var(--border); cursor: pointer; }
.select-row:hover { background: var(--card-soft); }
.select-row span { overflow: hidden; font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.select-row small { color: var(--muted); font-size: var(--fs-xs); }
.preview-row { display: grid; grid-template-columns: minmax(0, 1fr) 14px minmax(0, 1fr) minmax(18px, auto); align-items: center; gap: var(--sp-2); min-height: 42px; padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border); }
.preview-row > span { min-width: 0; overflow: hidden; font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.old-name { color: var(--text-weak); }
.new-name { color: var(--primary-hover); font-family: var(--font-mono); }
.preview-row small { max-width: 100px; overflow: hidden; color: var(--muted); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }
.preview-row.invalid { background: var(--danger-soft); }
.preview-row.invalid .new-name, .preview-row.invalid small { color: var(--danger-deep); }
.preview-row.unchanged { opacity: 0.72; }
.ok-icon { color: var(--success); }

@media (max-width: 820px) {
  .control-bar, .rename-toolbar { flex-wrap: wrap; }
  .output-field, .push-right { margin-left: 0; }
  .split-workspace { grid-template-columns: 1fr; grid-template-rows: repeat(2, minmax(160px, 1fr)); overflow: auto; }
  .rename-layout { grid-template-columns: minmax(200px, 0.8fr) minmax(320px, 1.2fr); overflow: auto; }
  .rules-panel { grid-row: span 2; }
  .file-select-panel, .preview-panel { min-height: 240px; }
}
</style>
