<script setup>
// 生成器工具（手机端）：标识符（UUID/ULID/NanoID）/ 随机值 / 序列 / mock 数据。
//
// 逻辑复用 src/generatorTool.js（桌面端同一模块），文案复用 toolbox.generator.*。
//
// 四个子页都保留，但**配置项按手机端收敛**：桌面端每种类型有一整套参数面板
// （min/max/precision/length/start/end/charset…），窄屏铺不下也无法一眼看全。
// 这里给每组参数选「最常用的那几个」，其余走默认值——默认值是共享层定的，两端结果一致。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { formatMockOutput, generateIdentifiers, generateMockRows, generateRandomValues, generateSequence, mockFieldTypes, randomTypes } from "../../../src/generatorTool.js";

const { t } = useI18n();

const tab = ref("identifier"); // identifier | random | sequence | mock
const output = ref("");
const error = ref("");

const TABS = [
  { key: "identifier", labelKey: "toolbox.generator.tabIdentifier" },
  { key: "random", labelKey: "toolbox.generator.tabRandom" },
  { key: "sequence", labelKey: "toolbox.generator.tabSequence" },
  { key: "mock", labelKey: "toolbox.generator.tabMock" },
];

/** 计数上限：手机上一次生成太多既看不清也难复制，共享层本身有上限校验。 */
const count = (value, fallback = 10) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(500, Math.trunc(n)) : fallback;
};

// ── 标识符 ────────────────────────────────────────────────────────────
const ID_TYPES = [
  { key: "uuid-v4", label: "UUID v4" },
  { key: "uuid-v7", label: "UUID v7" },
  { key: "ulid", label: "ULID" },
  { key: "nanoid", label: "NanoID" },
];
const idOptions = ref({ type: "uuid-v4", count: 10, seed: "", uppercase: false, hyphens: true, length: 21 });

// ── 随机值 ────────────────────────────────────────────────────────────
const types = computed(() => randomTypes());
const randomOptions = ref({ type: "integer", count: 10, seed: "", min: 0, max: 100 });

// ── 序列 ──────────────────────────────────────────────────────────────
const seqOptions = ref({ count: 10, start: 1, step: 1, radix: 10, padding: 0, prefix: "", suffix: "", uppercase: false });

// ── mock 数据 ─────────────────────────────────────────────────────────
//
// mockFieldTypes() 返回的是**候选类型**清单（{ key, label }），而 generateMockRows 要的是
// **字段定义**（{ name, type }）——两者形状不同，别混用（踩过一次）。
// 手机端的做法：选几个候选类型，字段名直接用类型名（mock 数据本来就是给联调看的）。
const mockTypes = computed(() => mockFieldTypes());
const mockOptions = ref({ count: 5, format: "json" });
const mockSelected = ref([]);

/** 选中的类型 → 字段定义；一个都没选时用前三个，避免出现空结果让人以为坏了。 */
const mockFields = computed(() => {
  const all = mockTypes.value;
  const picked = mockSelected.value.length ? all.filter((type) => mockSelected.value.includes(type.key)) : all.slice(0, 3);
  return picked.map((type) => ({ name: type.key, type: type.key }));
});

function run() {
  error.value = "";
  output.value = "";
  try {
    if (tab.value === "identifier") {
      output.value = generateIdentifiers(idOptions.value.type, count(idOptions.value.count), idOptions.value).join("\n");
    } else if (tab.value === "random") {
      output.value = generateRandomValues(randomOptions.value.type, count(randomOptions.value.count), randomOptions.value)
        .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
        .join("\n");
    } else if (tab.value === "sequence") {
      output.value = generateSequence({ ...seqOptions.value, count: count(seqOptions.value.count) }).join("\n");
    } else {
      const rows = generateMockRows(mockFields.value, count(mockOptions.value.count, 5), {});
      output.value = formatMockOutput(rows, mockOptions.value.format);
    }
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

const copied = ref("");
async function copyOutput() {
  if (!output.value) return;
  try {
    await navigator.clipboard.writeText(output.value);
    copied.value = t("toolbox.generator.resultCopied");
    setTimeout(() => (copied.value = ""), 2000);
  } catch {
    error.value = t("toolbox.generator.copyFailed");
  }
}
</script>

<template>
  <section class="m-tool" data-tool="generator">
    <div class="m-chips">
      <button v-for="item in TABS" :key="item.key" class="m-chip" :class="{ on: tab === item.key }" :data-tab="item.key" @click="tab = item.key">
        {{ t(item.labelKey) }}
      </button>
    </div>

    <!-- 标识符 -->
    <template v-if="tab === 'identifier'">
      <label class="m-field">
        <span>{{ t("toolbox.generator.idTypeLabel") }}</span>
        <select v-model="idOptions.type" data-role="id-type">
          <option v-for="item in ID_TYPES" :key="item.key" :value="item.key">{{ item.label }}</option>
        </select>
      </label>
      <div class="m-field-row">
        <label class="m-field">
          <span>{{ t("toolbox.generator.countLabel") }}</span>
          <input v-model.number="idOptions.count" type="number" min="1" max="500" inputmode="numeric" />
        </label>
        <label class="m-field">
          <span>{{ t("toolbox.generator.seedLabel") }}</span>
          <input v-model="idOptions.seed" spellcheck="false" :placeholder="t('mobile.genSeedPh')" />
        </label>
      </div>
      <div v-if="idOptions.type === 'nanoid'" class="m-chips">
        <button class="m-chip" :class="{ on: idOptions.length === 21 }" @click="idOptions.length = 21">21</button>
        <button class="m-chip" :class="{ on: idOptions.length === 10 }" @click="idOptions.length = 10">10</button>
      </div>
    </template>

    <!-- 随机值 -->
    <template v-else-if="tab === 'random'">
      <label class="m-field">
        <span>{{ t("toolbox.generator.dataTypeLabel") }}</span>
        <select v-model="randomOptions.type" data-role="random-type">
          <option v-for="type in types" :key="type.key" :value="type.key">{{ type.label }}</option>
        </select>
      </label>
      <div class="m-field-row">
        <label class="m-field">
          <span>{{ t("toolbox.generator.countLabel") }}</span>
          <input v-model.number="randomOptions.count" type="number" min="1" max="500" inputmode="numeric" />
        </label>
        <label class="m-field">
          <span>{{ t("toolbox.generator.seedLabel") }}</span>
          <input v-model="randomOptions.seed" spellcheck="false" :placeholder="t('mobile.genSeedPh')" />
        </label>
      </div>
    </template>

    <!-- 序列 -->
    <template v-else-if="tab === 'sequence'">
      <div class="m-field-row">
        <label class="m-field">
          <span>{{ t("toolbox.generator.countLabel") }}</span>
          <input v-model.number="seqOptions.count" type="number" min="1" max="500" inputmode="numeric" />
        </label>
        <label class="m-field">
          <span>{{ t("toolbox.generator.startValueLabel") }}</span>
          <input v-model.number="seqOptions.start" type="number" inputmode="numeric" />
        </label>
      </div>
      <div class="m-field-row">
        <label class="m-field">
          <span>{{ t("toolbox.generator.stepLabel") }}</span>
          <input v-model.number="seqOptions.step" type="number" inputmode="numeric" />
        </label>
        <label class="m-field">
          <span>{{ t("toolbox.generator.paddingLabel") }}</span>
          <input v-model.number="seqOptions.padding" type="number" min="0" max="128" inputmode="numeric" />
        </label>
      </div>
      <div class="m-field-row">
        <label class="m-field">
          <span>{{ t("toolbox.generator.prefixLabel") }}</span>
          <input v-model="seqOptions.prefix" spellcheck="false" />
        </label>
        <label class="m-field">
          <span>{{ t("toolbox.generator.suffixLabel") }}</span>
          <input v-model="seqOptions.suffix" spellcheck="false" />
        </label>
      </div>
    </template>

    <!-- mock 数据 -->
    <template v-else>
      <p class="m-hint-sm">{{ t("mobile.genMockNote") }}</p>
      <div class="m-chips">
        <button
          v-for="type in mockTypes.slice(0, 8)"
          :key="type.key"
          class="m-chip"
          :class="{ on: mockSelected.includes(type.key) }"
          :data-field="type.key"
          @click="mockSelected.includes(type.key) ? (mockSelected = mockSelected.filter((k) => k !== type.key)) : mockSelected.push(type.key)"
        >
          {{ type.label }}
        </button>
      </div>
      <div class="m-field-row">
        <label class="m-field">
          <span>{{ t("toolbox.generator.rowCountLabel") }}</span>
          <input v-model.number="mockOptions.count" type="number" min="1" max="200" inputmode="numeric" />
        </label>
        <label class="m-field">
          <span>{{ t("toolbox.generator.formatLabel") }}</span>
          <select v-model="mockOptions.format" data-role="mock-format">
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
            <option value="sql">SQL</option>
          </select>
        </label>
      </div>
    </template>

    <div class="m-actions">
      <button class="m-btn primary" @click="run">
        {{ tab === "identifier" ? t("toolbox.generator.genIdentifierBtn") : tab === "random" ? t("toolbox.generator.generateBtn") : tab === "sequence" ? t("toolbox.generator.genSeqBtn") : t("toolbox.generator.genMockBtn") }}
      </button>
    </div>

    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>

    <label class="m-field">
      <span>{{ t("toolbox.generator.outputLabel") }}</span>
      <textarea :value="output" rows="8" readonly spellcheck="false" data-role="output"></textarea>
    </label>
    <div class="m-actions">
      <button class="m-btn" :disabled="!output" @click="copyOutput">{{ t("toolbox.crypto.copyAllBtn") }}</button>
    </div>
    <p v-if="copied" class="m-ok">{{ copied }}</p>
  </section>
</template>
