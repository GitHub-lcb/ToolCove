<script setup>
import { computed, ref } from "vue";
import Icon from "../Icon.vue";
import DiffTool from "./DiffTool.vue";
import {
  buildHighlightSegments,
  convertNaming,
  findRegexMatches,
  getTextStats,
  processLines,
  replaceText,
} from "../textTool.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const TABS = [
  { key: "diff", label: "Diff 对比" },
  { key: "regex", label: "正则匹配" },
  { key: "replace", label: "查找替换" },
  { key: "lines", label: "行处理" },
  { key: "naming", label: "命名转换" },
  { key: "stats", label: "文本统计" },
];
const LINE_ACTIONS = [
  { value: "dedupe", label: "去除重复行" },
  { value: "sort-asc", label: "升序排序" },
  { value: "sort-desc", label: "降序排序" },
  { value: "sort-number", label: "数字排序" },
  { value: "remove-empty", label: "过滤空行" },
  { value: "trim", label: "清理首尾空白" },
  { value: "affix", label: "添加前后缀" },
  { value: "reverse", label: "反转行序" },
];
const NAMING_STYLES = [
  { key: "camel", label: "camelCase" },
  { key: "pascal", label: "PascalCase" },
  { key: "snake", label: "snake_case" },
  { key: "kebab", label: "kebab-case" },
  { key: "constant", label: "CONSTANT_CASE" },
  { key: "dot", label: "dot.case" },
  { key: "space", label: "space case" },
];

const activeTab = ref("diff");

const regexPattern = ref("\\d+");
const regexText = ref("");
const regexFlags = ref({ g: true, i: false, m: false, s: false });
const regexResult = computed(() => safeResult(() => {
  const result = findRegexMatches(regexPattern.value, regexText.value, selectedFlags(regexFlags.value));
  return { ...result, segments: buildHighlightSegments(regexText.value, result.matches) };
}));

const replaceSource = ref("");
const replaceFind = ref("");
const replacement = ref("");
const replaceOptions = ref({ regex: false, replaceAll: true, ignoreCase: false, multiline: false, dotAll: false });
const replaceResult = computed(() => safeResult(() =>
  replaceText(replaceSource.value, replaceFind.value, replacement.value, replaceOptions.value)
));

const lineSource = ref("");
const lineAction = ref("dedupe");
const lineOptions = ref({ trimForCompare: false, ignoreCase: false, prefix: "", suffix: "" });
const lineResult = computed(() => safeResult(() =>
  processLines(lineSource.value, lineAction.value, lineOptions.value)
));

const namingSource = ref("");
const namingResults = computed(() => NAMING_STYLES.map((style) => ({
  ...style,
  value: convertNaming(namingSource.value, style.key),
})));

const statsSource = ref("");
const textStats = computed(() => getTextStats(statsSource.value));
const statItems = computed(() => [
  { label: "字符数", value: textStats.value.characters },
  { label: "非空白字符", value: textStats.value.charactersNoWhitespace },
  { label: "行数", value: textStats.value.lines },
  { label: "词语数", value: textStats.value.words },
  { label: "中文字符", value: textStats.value.chineseCharacters },
  { label: "UTF-8 字节", value: textStats.value.bytes },
  { label: "唯一非空行", value: textStats.value.uniqueLines },
  { label: "重复行", value: textStats.value.duplicateLines },
  { label: "空行", value: textStats.value.emptyLines },
]);

function safeResult(fn) {
  try {
    return { data: fn(), error: "" };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function selectedFlags(flags) {
  return Object.entries(flags).filter(([, enabled]) => enabled).map(([flag]) => flag).join("");
}

function replaceSourceWithResult() {
  if (replaceResult.value.error) return props.showToast(replaceResult.value.error);
  replaceSource.value = replaceResult.value.data;
  props.showToast("替换结果已应用到原文");
}

function applyLineResult() {
  if (lineResult.value.error) return props.showToast(lineResult.value.error);
  lineSource.value = lineResult.value.data;
  props.showToast("处理结果已应用到原文");
}

async function copyText(value, label = "结果") {
  if (value === "" || value === null || value === undefined) return props.showToast(`没有可复制的${label}`);
  try {
    await navigator.clipboard.writeText(String(value));
    props.showToast(`已复制${label}`);
  } catch (e) {
    props.showToast("复制失败：" + e);
  }
}
</script>

<template>
  <div class="text-tool">
    <nav class="mode-tabs" aria-label="文本处理类型">
      <button v-for="tab in TABS" :key="tab.key" type="button" class="mode-tab" :class="{ on: activeTab === tab.key }" @click="activeTab = tab.key">
        {{ tab.label }}
      </button>
    </nav>

    <DiffTool v-if="activeTab === 'diff'" :show-toast="showToast" class="sub-tool" />

    <section v-else-if="activeTab === 'regex'" class="sub-workspace">
      <div class="control-bar regex-controls">
        <label class="field grow"><span>正则表达式</span><input v-model="regexPattern" class="mono" placeholder="输入正则表达式" /></label>
        <div class="flag-group"><span>Flags</span><label v-for="flag in ['g', 'i', 'm', 's']" :key="flag" :title="`正则标志 ${flag}`"><input v-model="regexFlags[flag]" type="checkbox" /><b>{{ flag }}</b></label></div>
        <span v-if="!regexResult.error" class="count-chip">{{ regexResult.data.matches.length }} 个匹配</span>
      </div>
      <div class="split-workspace">
        <section class="editor-panel">
          <header class="panel-head"><b>测试文本</b><span>{{ regexText.length }} 字符</span></header>
          <textarea v-model="regexText" class="text-editor" spellcheck="false" placeholder="粘贴要匹配的文本" aria-label="正则测试文本"></textarea>
        </section>
        <section class="result-panel">
          <header class="panel-head"><b>匹配结果</b><span v-if="regexResult.data?.truncated">仅显示前 1000 条</span></header>
          <div v-if="regexResult.error" class="error-state" role="alert"><Icon name="alert" :size="20" /><span>{{ regexResult.error }}</span></div>
          <template v-else>
            <pre class="highlight-preview"><template v-for="(segment, index) in regexResult.data.segments" :key="index"><mark v-if="segment.match" :title="`匹配 ${segment.matchIndex + 1}`">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template><span v-if="!regexText" class="placeholder">匹配内容将在这里高亮</span></pre>
            <div class="match-list">
              <div v-for="(match, index) in regexResult.data.matches" :key="`${match.index}-${index}`" class="match-row">
                <span class="match-index">{{ index + 1 }}</span>
                <code :title="match.value">{{ match.value || "（零长度匹配）" }}</code>
                <span>位置 {{ match.index }}–{{ match.end }}</span>
                <div v-if="match.groups.length || Object.keys(match.namedGroups).length" class="group-list">
                  <code v-for="(group, groupIndex) in match.groups" :key="`group-${groupIndex}`">${{ groupIndex + 1 }} = {{ group ?? "未匹配" }}</code>
                  <code v-for="(group, name) in match.namedGroups" :key="`named-${name}`">{{ name }} = {{ group ?? "未匹配" }}</code>
                </div>
              </div>
            </div>
          </template>
        </section>
      </div>
    </section>

    <section v-else-if="activeTab === 'replace'" class="sub-workspace">
      <div class="control-bar replace-controls">
        <label class="field grow"><span>查找</span><input v-model="replaceFind" class="mono" placeholder="输入查找内容" /></label>
        <label class="field grow"><span>替换为</span><input v-model="replacement" class="mono" placeholder="输入替换内容" /></label>
        <div class="option-row">
          <label><input v-model="replaceOptions.regex" type="checkbox" />正则</label>
          <label><input v-model="replaceOptions.replaceAll" type="checkbox" />全部</label>
          <label v-if="replaceOptions.regex"><input v-model="replaceOptions.ignoreCase" type="checkbox" />忽略大小写</label>
        </div>
      </div>
      <div class="split-workspace">
        <section class="editor-panel"><header class="panel-head"><b>原文</b><span>{{ replaceSource.length }} 字符</span></header><textarea v-model="replaceSource" class="text-editor" spellcheck="false" placeholder="粘贴待替换文本"></textarea></section>
        <section class="editor-panel" :class="{ invalid: replaceResult.error }">
          <header class="panel-head"><b>替换预览</b><span class="panel-actions"><button class="btn-ghost xs" :disabled="!!replaceResult.error || !replaceFind" @click="replaceSourceWithResult">应用</button><button class="icon-btn xs" title="复制替换结果" :disabled="!!replaceResult.error || !replaceResult.data" @click="copyText(replaceResult.data)"><Icon name="copy" :size="13" /></button></span></header>
          <div v-if="replaceResult.error" class="error-state" role="alert"><Icon name="alert" :size="20" /><span>{{ replaceResult.error }}</span></div>
          <textarea v-else :value="replaceResult.data" class="text-editor output" readonly spellcheck="false" placeholder="替换结果将在这里显示"></textarea>
        </section>
      </div>
    </section>

    <section v-else-if="activeTab === 'lines'" class="sub-workspace">
      <div class="control-bar line-controls">
        <label class="field action-field"><span>处理方式</span><select v-model="lineAction"><option v-for="action in LINE_ACTIONS" :key="action.value" :value="action.value">{{ action.label }}</option></select></label>
        <template v-if="lineAction === 'dedupe'"><label class="check-option"><input v-model="lineOptions.trimForCompare" type="checkbox" />忽略首尾空白</label><label class="check-option"><input v-model="lineOptions.ignoreCase" type="checkbox" />忽略大小写</label></template>
        <template v-if="lineAction === 'affix'"><label class="field"><span>前缀</span><input v-model="lineOptions.prefix" class="mono" /></label><label class="field"><span>后缀</span><input v-model="lineOptions.suffix" class="mono" /></label></template>
      </div>
      <div class="split-workspace">
        <section class="editor-panel"><header class="panel-head"><b>原文</b><span>{{ lineSource ? lineSource.split(/\r?\n/).length : 0 }} 行</span></header><textarea v-model="lineSource" class="text-editor" spellcheck="false" placeholder="每行一条内容"></textarea></section>
        <section class="editor-panel" :class="{ invalid: lineResult.error }"><header class="panel-head"><b>处理结果</b><span class="panel-actions"><button class="btn-ghost xs" :disabled="!!lineResult.error || !lineSource" @click="applyLineResult">应用</button><button class="icon-btn xs" title="复制处理结果" :disabled="!!lineResult.error || !lineResult.data" @click="copyText(lineResult.data)"><Icon name="copy" :size="13" /></button></span></header><div v-if="lineResult.error" class="error-state" role="alert"><Icon name="alert" :size="20" /><span>{{ lineResult.error }}</span></div><textarea v-else :value="lineResult.data" class="text-editor output" readonly spellcheck="false" placeholder="处理结果将在这里显示"></textarea></section>
      </div>
    </section>

    <section v-else-if="activeTab === 'naming'" class="sub-workspace naming-workspace">
      <section class="editor-panel naming-input"><header class="panel-head"><b>名称</b><span>{{ namingSource.length }} 字符</span></header><textarea v-model="namingSource" class="text-editor" spellcheck="false" placeholder="输入变量名、类名或短语"></textarea></section>
      <div class="naming-results">
        <button v-for="item in namingResults" :key="item.key" type="button" class="naming-row" :disabled="!item.value" :title="item.value ? `复制 ${item.label}` : item.label" @click="copyText(item.value, item.label)"><span>{{ item.label }}</span><code>{{ item.value || "转换结果" }}</code><Icon name="copy" :size="14" /></button>
      </div>
    </section>

    <section v-else class="sub-workspace stats-workspace">
      <section class="editor-panel"><header class="panel-head"><b>文本</b><span>{{ textStats.characters }} 字符</span></header><textarea v-model="statsSource" class="text-editor" spellcheck="false" placeholder="粘贴要统计的文本"></textarea></section>
      <div class="stats-grid"><div v-for="item in statItems" :key="item.label" class="stat-item"><span>{{ item.label }}</span><b>{{ item.value.toLocaleString('zh-CN') }}</b></div></div>
    </section>
  </div>
</template>

<style scoped>
.text-tool { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.mode-tabs { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-1); overflow-x: auto; padding-bottom: var(--sp-1); border-bottom: 1px solid var(--border); }
.mode-tab { flex-shrink: 0; padding: var(--sp-2) var(--sp-4); border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--text-weak); font-size: var(--fs-md); cursor: pointer; transition: color 0.15s, background 0.15s, border-color 0.15s; }
.mode-tab:hover { color: var(--text); background: var(--ghost); }
.mode-tab.on { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); font-weight: 600; }
.sub-tool, .sub-workspace { flex: 1; min-height: 0; }
.sub-workspace { display: flex; flex-direction: column; gap: var(--sp-3); }
.control-bar { flex-shrink: 0; display: flex; align-items: flex-end; gap: var(--sp-3); min-height: 54px; }
.field { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.field.grow { flex: 1; }
.field > span, .flag-group > span { color: var(--text-weak); font-size: var(--fs-sm); font-weight: 600; }
.field input, .field select { min-width: 0; height: 34px; padding: 0 var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); outline: none; background: var(--card); color: var(--text); font-size: var(--fs-md); }
.field input:focus, .field select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.mono, code { font-family: var(--font-mono); }
.flag-group { display: flex; align-items: center; gap: var(--sp-1); height: 34px; }
.flag-group > span { margin-right: var(--sp-1); }
.flag-group label { cursor: pointer; }
.flag-group input { position: absolute; opacity: 0; pointer-events: none; }
.flag-group b { width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid var(--border-strong); border-radius: var(--r-xs); background: var(--card); color: var(--muted); font-family: var(--font-mono); font-size: var(--fs-sm); }
.flag-group input:checked + b { border-color: var(--border-blue); background: var(--primary-soft); color: var(--primary-hover); }
.count-chip { align-self: center; padding: var(--sp-1) var(--sp-3); border-radius: var(--r-pill); background: var(--well); color: var(--text-weak); font-family: var(--font-num); font-size: var(--fs-sm); white-space: nowrap; }
.option-row { display: flex; align-items: center; gap: var(--sp-3); height: 34px; }
.option-row label, .check-option { display: inline-flex; align-items: center; gap: var(--sp-1); color: var(--text-weak); font-size: var(--fs-sm); white-space: nowrap; cursor: pointer; }
.option-row input, .check-option input { accent-color: var(--primary); }
.split-workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); }
.editor-panel, .result-panel { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.editor-panel:focus-within { border-color: var(--primary); }
.editor-panel.invalid { border-color: var(--border-danger); }
.panel-head { flex-shrink: 0; min-height: 38px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--card-soft); }
.panel-head b { font-size: var(--fs-md); }
.panel-head > span { margin-left: auto; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.panel-head .panel-actions { display: flex; align-items: center; gap: var(--sp-1); }
.text-editor { flex: 1; min-height: 0; width: 100%; padding: var(--sp-4); resize: none; border: none; outline: none; background: transparent; color: var(--text-code); font-family: var(--font-mono); font-size: var(--fs-md); line-height: var(--lh-body); overflow: auto; }
.text-editor.output { background: color-mix(in srgb, var(--text) 1.5%, transparent); }
.text-editor::placeholder { color: var(--muted); font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.error-state { flex: 1; display: flex; align-items: center; justify-content: center; gap: var(--sp-2); padding: var(--sp-5); color: var(--danger-deep); background: var(--danger-soft); font-size: var(--fs-sm); }
.highlight-preview { flex: 0 0 42%; min-height: 120px; margin: 0; padding: var(--sp-4); overflow: auto; border-bottom: 1px solid var(--border); color: var(--text-code); font-family: var(--font-mono); font-size: var(--fs-sm); line-height: var(--lh-body); white-space: pre-wrap; word-break: break-word; }
.highlight-preview mark { border-radius: var(--r-xs); background: var(--warn-border); color: var(--text); }
.placeholder { color: var(--muted); font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.match-list { flex: 1; min-height: 0; overflow: auto; }
.match-row { display: grid; grid-template-columns: 28px minmax(80px, 1fr) auto; align-items: center; gap: var(--sp-2); min-height: 38px; padding: var(--sp-1) var(--sp-3); border-bottom: 1px solid var(--border); }
.match-index { width: 22px; height: 22px; display: grid; place-items: center; border-radius: var(--r-pill); background: var(--primary-soft); color: var(--primary-hover); font-family: var(--font-num); font-size: var(--fs-xs); }
.match-row > code { overflow: hidden; color: var(--text-code); font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.match-row > span:not(.match-index) { color: var(--muted); font-size: var(--fs-xs); white-space: nowrap; }
.group-list { grid-column: 2 / 4; display: flex; gap: var(--sp-1); overflow-x: auto; }
.group-list code { flex-shrink: 0; padding: 2px var(--sp-2); border-radius: var(--r-xs); background: var(--well); color: var(--text-weak); font-size: var(--fs-xs); }
.action-field { min-width: 190px; }
.line-controls > .field:not(.action-field) { flex: 1; }
.naming-workspace { display: grid; grid-template-columns: minmax(260px, 0.8fr) minmax(360px, 1.2fr); }
.naming-results { min-height: 0; overflow: auto; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.naming-row { display: grid; grid-template-columns: 130px minmax(0, 1fr) 18px; align-items: center; gap: var(--sp-3); width: 100%; min-height: 52px; padding: 0 var(--sp-4); border: none; border-bottom: 1px solid var(--border); background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.naming-row:last-child { border-bottom: none; }
.naming-row:hover:not(:disabled) { background: var(--primary-soft); }
.naming-row:disabled { cursor: default; }
.naming-row span { color: var(--muted); font-size: var(--fs-sm); }
.naming-row code { overflow: hidden; color: var(--text-code); font-size: var(--fs-md); text-overflow: ellipsis; white-space: nowrap; }
.naming-row svg { color: var(--muted); }
.stats-workspace { display: grid; grid-template-columns: minmax(300px, 1.1fr) minmax(320px, 0.9fr); }
.stats-grid { display: grid; grid-template-columns: repeat(3, minmax(90px, 1fr)); align-content: start; gap: var(--sp-3); overflow: auto; }
.stat-item { display: flex; flex-direction: column; gap: var(--sp-2); min-height: 86px; padding: var(--sp-4); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.stat-item span { color: var(--muted); font-size: var(--fs-sm); }
.stat-item b { color: var(--text); font-family: var(--font-num); font-size: var(--fs-num); }

@media (max-width: 820px) {
  .control-bar { flex-wrap: wrap; }
  .regex-controls .field, .replace-controls .field { flex-basis: 100%; }
  .split-workspace { grid-template-columns: 1fr; grid-template-rows: repeat(2, minmax(170px, 1fr)); overflow: auto; }
  .naming-workspace, .stats-workspace { grid-template-columns: 1fr; grid-template-rows: minmax(150px, 0.7fr) minmax(220px, 1.3fr); overflow: auto; }
}
</style>
