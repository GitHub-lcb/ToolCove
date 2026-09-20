<script setup>
// XML / 报文工具（桌面端）：格式化、压缩、转 JSON、XPath 查询、校验、统计。
//
// 解析器是自己写的（src/xmlTool.js，纯函数、零依赖、64 条单测）——不用 DOMParser 的原因：
// 单测跑在 node 环境（项目刻意不用 jsdom），而且 DOMParser 拿不到错误行号。
// 三端共用同一份实现，行为完全一致。
//
// 与相邻工具的边界：不做 JSON 语法校验（那是 json 工具）、不做通用文本处理（那是 text 工具）。
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { loadToolbox, saveToolbox } from "../toolboxStore.js";
import { formatXml, jsonToXml, minifyXml, queryXPath, statsXml, textOf, validateXml, xmlToJson } from "../xmlTool.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<order id="SO20260101">
  <customer>
    <name>张三</name>
    <phone>13800000000</phone>
  </customer>
  <items>
    <item sku="A-1" qty="2">出库单</item>
    <item sku="B-2" qty="1">装箱单</item>
  </items>
  <remark><![CDATA[客户要求：上午送达 & 提前电话]]></remark>
</order>`;

const input = ref(SAMPLE);
const mode = ref("format"); // format | minify | json | xpath | validate | stats
const xpath = ref("//item");
const error = ref("");
const notice = ref("");

/** 校验结果：每次输入变化都跑，有问题就顶部提示（不阻塞其它操作）。 */
const issues = computed(() => (input.value.trim() ? validateXml(input.value) : []));

/** 当前模式的输出。解析失败时给空串，由 error 显示原因。 */
const output = computed(() => {
  if (!input.value.trim()) return { text: "", error: "" };
  try {
    switch (mode.value) {
      case "minify":
        return { text: minifyXml(input.value), error: "" };
      case "json":
        return { text: JSON.stringify(xmlToJson(input.value), null, 2), error: "" };
      case "xpath": {
        const nodes = queryXPath(input.value, xpath.value);
        // 取属性时返回的是字符串数组，取节点时输出每个节点的文本与属性
        if (nodes.length && typeof nodes[0] === "string") return { text: nodes.join("\n"), error: "" };
        return { text: nodes.map((node) => `${node.name}: ${textOf(node).trim() || "(无文本)"} ${node.attrs.map((a) => `${a.name}="${a.value}"`).join(" ")}`.trim()).join("\n"), error: "" };
      }
      case "validate":
        return { text: issues.value.length ? "" : t("toolbox.xml.valid"), error: "" };
      case "stats": {
        const result = statsXml(input.value);
        return { text: [
          `${t("toolbox.xml.statElements")}: ${result.elements}`,
          `${t("toolbox.xml.statAttributes")}: ${result.attributes}`,
          `${t("toolbox.xml.statDepth")}: ${result.depth}`,
          `${t("toolbox.xml.statNames")}: ${result.distinctNames}`,
          `${t("toolbox.xml.statText")}: ${result.textLength}`,
          "",
          `${t("toolbox.xml.statNameList")}: ${result.names.join(", ")}`,
        ].join("\n"), error: "" };
      }
      default:
        return { text: formatXml(input.value), error: "" };
    }
  } catch (e) {
    // 解析错误带行列，翻成可读文案（错误码 + 行号）
    const message = e?.code
      ? t(`toolbox.xml.err_${e.code}`, { ...(e.params || {}), line: e.line, column: e.column })
      : e?.message || String(e);
    return { text: "", error: message };
  }
});

const issueText = (issue) => t(`toolbox.xml.err_${issue.code}`, { ...(issue.params || {}), line: issue.line, column: issue.column });

/** JSON → XML 用的输入（把当前 XML 转出的 JSON 再转回去，验证往返）。 */
const jsonBack = ref("");
function jsonToXmlBack() {
  try {
    jsonBack.value = jsonToXml(JSON.parse(output.value.text || "{}"), { root: "root" });
    props.showToast(t("toolbox.xml.convertedBack"));
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

async function copyOutput() {
  if (!output.value.text) return;
  try {
    await navigator.clipboard.writeText(output.value.text);
    props.showToast(t("toolbox.xml.copied"));
  } catch {
    props.showToast(t("toolbox.xml.copyFailed"));
  }
}

function downloadOutput() {
  if (!output.value.text) return;
  const extensions = { format: "xml", minify: "xml", json: "json", xpath: "txt", validate: "txt", stats: "txt" };
  const blob = new Blob([output.value.text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `xml-output.${extensions[mode.value] || "txt"}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  props.showToast(t("toolbox.xml.saved"));
}

/** 一键格式化（写回输入区）。 */
function applyFormat() {
  try {
    const formatted = formatXml(input.value);
    if (formatted === input.value) {
      props.showToast(t("toolbox.xml.noChange"));
      return;
    }
    input.value = formatted;
    props.showToast(t("toolbox.xml.formatted"));
  } catch (e) {
    error.value = e?.code ? t(`toolbox.xml.err_${e.code}`, { ...(e.params || {}), line: e.line, column: e.column }) : e?.message;
  }
}

const MODES = computed(() => [
  { key: "format", label: t("toolbox.xml.modeFormat") },
  { key: "minify", label: t("toolbox.xml.modeMinify") },
  { key: "json", label: t("toolbox.xml.modeJson") },
  { key: "xpath", label: t("toolbox.xml.modeXpath") },
  { key: "validate", label: t("toolbox.xml.modeValidate") },
  { key: "stats", label: t("toolbox.xml.modeStats") },
]);

loadToolbox("xml", {}).then((saved) => {
  if (!saved || typeof saved !== "object") return;
  if (typeof saved.input === "string" && saved.input) input.value = saved.input;
  if (typeof saved.mode === "string") mode.value = saved.mode;
  if (typeof saved.xpath === "string") xpath.value = saved.xpath;
});

watch([input, mode, xpath], () => {
  saveToolbox("xml", { input: input.value, mode: mode.value, xpath: xpath.value });
});
</script>

<template>
  <div class="tool-xml">
    <div class="x-toolbar">
      <div class="x-seg">
        <button v-for="item in MODES" :key="item.key" :class="{ on: mode === item.key }" :data-mode="item.key" @click="mode = item.key">
          {{ item.label }}
        </button>
      </div>
      <button class="x-btn" data-role="apply-format" @click="applyFormat">{{ t("toolbox.xml.applyFormat") }}</button>
      <span class="x-spacer"></span>
      <button class="x-btn" data-role="copy" @click="copyOutput">{{ t("toolbox.xml.copy") }}</button>
      <button class="x-btn primary" data-role="download" @click="downloadOutput">{{ t("toolbox.xml.download") }}</button>
    </div>

    <!-- 校验状态：始终显示，编辑时就能看到有没有写坏 -->
    <p v-if="issues.length" class="x-err" data-role="issue">
      {{ issueText(issues[0]) }}
    </p>
    <p v-else-if="input.trim()" class="x-ok" data-role="valid-hint">{{ t("toolbox.xml.validHint") }}</p>

    <div class="x-body">
      <label class="x-pane">
        <span class="x-label">{{ t("toolbox.xml.input") }}</span>
        <textarea v-model="input" class="x-text" spellcheck="false" data-role="input"></textarea>
      </label>
      <label class="x-pane">
        <span class="x-label">
          {{ t("toolbox.xml.output") }}
          <template v-if="mode === 'xpath'">
            <input v-model="xpath" class="x-xpath" data-role="xpath" :placeholder="t('toolbox.xml.xpathPh')" />
          </template>
        </span>
        <textarea class="x-text" readonly spellcheck="false" data-role="output" :value="output.text"></textarea>
      </label>
    </div>

    <div v-if="mode === 'json'" class="x-toolbar">
      <button class="x-btn" data-role="json-back" @click="jsonToXmlBack">{{ t("toolbox.xml.jsonBack") }}</button>
      <textarea v-if="jsonBack" class="x-back" readonly data-role="json-back-output" :value="jsonBack"></textarea>
    </div>

    <p v-if="error" class="x-err" data-role="error">{{ error }}</p>
    <p class="x-hint">{{ t("toolbox.xml.xpathNote") }}</p>
  </div>
</template>

<style scoped>
.tool-xml {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
}

.x-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.x-spacer {
  flex: 1;
}

.x-seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.x-seg button {
  padding: 5px 10px;
  border: 0;
  background: var(--card);
  color: var(--muted);
  cursor: pointer;
  font-size: 0.82rem;
}

.x-seg button.on {
  background: var(--primary-soft);
  color: var(--primary);
}

.x-btn {
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  color: var(--text);
  cursor: pointer;
  font-size: 0.85rem;
}

.x-btn:hover {
  border-color: var(--primary);
}

.x-btn.primary {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
}

.x-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  flex: 1;
  min-height: 0;
}

.x-pane {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.x-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8rem;
  color: var(--muted);
}

.x-xpath {
  flex: 1;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
}

.x-text {
  flex: 1;
  min-height: 240px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.82rem;
  line-height: 1.55;
  resize: none;
}

.x-back {
  flex: 1;
  min-height: 80px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--soft);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
}

.x-err {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 0.85rem;
}

.x-ok {
  margin: 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--ok-soft);
  color: var(--ok);
  font-size: 0.82rem;
}

.x-hint {
  margin: 0;
  font-size: 0.78rem;
  color: var(--muted);
}
</style>
