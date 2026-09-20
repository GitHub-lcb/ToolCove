<script setup>
// XML / 报文工具（手机端）：格式化、压缩、转 JSON、XPath 查询、校验、统计。
//
// 与桌面端**共用同一份纯逻辑**（src/xmlTool.js，64 条单测），所以结果两端一致。
// 界面按手机重排：输入/输出**不能并排**（393px 宽并排两边都没法看），改成切换式。
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { loadToolbox, saveToolbox } from "../../../src/toolboxStore.js";
import { formatXml, jsonToXml, minifyXml, queryXPath, statsXml, textOf, validateXml, xmlToJson } from "../../../src/xmlTool.js";

const { t } = useI18n();

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<order id="SO20260101">
  <customer><name>张三</name></customer>
  <items>
    <item sku="A-1" qty="2">出库单</item>
    <item sku="B-2" qty="1">装箱单</item>
  </items>
</order>`;

const input = ref(SAMPLE);
const mode = ref("format");
const xpath = ref("//item");
const view = ref("input"); // input | output
const error = ref("");
const notice = ref("");

const issues = computed(() => (input.value.trim() ? validateXml(input.value) : []));

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
    const message = e?.code
      ? t(`toolbox.xml.err_${e.code}`, { ...(e.params || {}), line: e.line, column: e.column })
      : e?.message || String(e);
    return { text: "", error: message };
  }
});

const issueText = (issue) => t(`toolbox.xml.err_${issue.code}`, { ...(issue.params || {}), line: issue.line, column: issue.column });

function flash(message) {
  notice.value = message;
  setTimeout(() => (notice.value = ""), 2000);
}

function applyFormat() {
  try {
    const formatted = formatXml(input.value);
    if (formatted === input.value) {
      flash(t("toolbox.xml.noChange"));
      return;
    }
    input.value = formatted;
    flash(t("toolbox.xml.formatted"));
  } catch (e) {
    error.value = e?.code ? t(`toolbox.xml.err_${e.code}`, { ...(e.params || {}), line: e.line, column: e.column }) : e?.message;
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
  flash(t("toolbox.xml.saved"));
}

async function copyOutput() {
  if (!output.value.text) return;
  try {
    await navigator.clipboard.writeText(output.value.text);
    flash(t("toolbox.xml.copied"));
  } catch {
    flash(t("toolbox.xml.copyFailed"));
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
  <section class="m-tool" data-tool="xml">
    <!-- 校验状态常驻：编辑时就能看到有没有写坏 -->
    <p v-if="issues.length" class="m-err" data-role="issue">{{ issueText(issues[0]) }}</p>
    <p v-else-if="input.trim()" class="m-hint-sm" data-role="valid-hint">{{ t("toolbox.xml.validHint") }}</p>

    <div class="m-chips" data-role="modes">
      <button v-for="item in MODES" :key="item.key" class="m-chip" :class="{ on: mode === item.key }" :data-mode="item.key" @click="mode = item.key">
        {{ item.label }}
      </button>
    </div>

    <div class="m-chips" data-role="views">
      <button class="m-chip" :class="{ on: view === 'input' }" data-view="input" @click="view = 'input'">{{ t("toolbox.xml.input") }}</button>
      <button class="m-chip" :class="{ on: view === 'output' }" data-view="output" @click="view = 'output'">{{ t("toolbox.xml.output") }}</button>
    </div>

    <template v-if="view === 'input'">
      <label class="m-field">
        <span>{{ t("toolbox.xml.input") }}</span>
        <textarea v-model="input" rows="12" spellcheck="false" data-role="input"></textarea>
      </label>
    </template>
    <template v-else>
      <label v-if="mode === 'xpath'" class="m-field">
        <span>{{ t("toolbox.xml.xpathLabel") }}</span>
        <input v-model="xpath" spellcheck="false" data-role="xpath" :placeholder="t('toolbox.xml.xpathPh')" />
      </label>
      <label class="m-field">
        <span>{{ t("toolbox.xml.output") }}</span>
        <textarea readonly rows="12" spellcheck="false" data-role="output" :value="output.text"></textarea>
      </label>
    </template>

    <div class="m-actions">
      <button class="m-btn" data-role="apply-format" @click="applyFormat">{{ t("toolbox.xml.applyFormat") }}</button>
      <button class="m-btn primary" data-role="download" @click="downloadOutput">{{ t("toolbox.xml.download") }}</button>
      <button class="m-btn" data-role="copy" @click="copyOutput">{{ t("toolbox.xml.copy") }}</button>
    </div>

    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>
    <p v-if="notice" class="m-ok" data-role="notice">{{ notice }}</p>
    <p class="m-hint-sm">{{ t("toolbox.xml.xpathNote") }}</p>
  </section>
</template>
