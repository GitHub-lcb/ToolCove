<script setup>
// 加密工具（手机端）：摘要 / HMAC / 密码生成。
//
// 逻辑复用 src/cryptoTool.js（桌面端同一模块），**文案也复用桌面端词条**（toolbox.crypto.*）。
// 三个取舍：
//  1) 只做无状态计算（摘要/HMAC/密码）：AES/RSA 那套涉及「密钥存哪」，
//     手机端要单独设计（走 Android Keystore），留到 Phase 5，不在界面上放半成品。
//  2) MD5/SHA-1 保留但标注不适用于安全场景（老系统校验还在用，直接砍掉会让人困惑）。
//  3) 密码生成显示熵值与字符池大小——"长什么样"比"多少位"更能说明安全性。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { digestText, generatePassword, getPasswordPoolSize, getPasswordStrength, hmacText } from "../../../src/cryptoTool.js";

const { t } = useI18n();

/** 摘要算法：与 digestText/hmacText 支持的集合一致（MD5 走纯 JS 实现）。 */
const ALGOS = ["MD5", "SHA-1", "SHA-256", "SHA-384", "SHA-512"];
/** 这两者已不适用于安全场景，界面上如实提示。 */
const LEGACY = new Set(["MD5", "SHA-1"]);

const tab = ref("digest"); // digest | hmac | password

const input = ref("");
const secret = ref("");
const algo = ref("SHA-256");
const output = ref("");
const error = ref("");
const busy = ref(false);

async function run() {
  error.value = "";
  output.value = "";
  if (!input.value) return;
  busy.value = true;
  try {
    output.value = tab.value === "hmac" ? await hmacText(input.value, secret.value, algo.value, "hex") : await digestText(input.value, algo.value, "hex");
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    busy.value = false;
  }
}

// ── 密码生成 ──────────────────────────────────────────────────────────
/**
 * 字符集开关。
 *
 * ⚠️ 键名必须与 cryptoTool.js 的 PASSWORD_SETS 一致（uppercase/lowercase/numbers/symbols）。
 * 写错名字**不会报错**——generatePassword/getPasswordPoolSize 只认这些键，多出来的键被静默忽略，
 * 表现为"开关点了没反应"（曾经写成 upper/lower/number/symbol，踩过一次；toolContracts.test.js 已钉住）。
 */
const options = ref({ length: 20, uppercase: true, lowercase: true, numbers: true, symbols: true, excludeAmbiguous: false });
const password = ref("");

/**
 * 切换字符集开关。
 * 用显式方法而不是模板里的 `options[k] = !options[k]`：模板里经 ref 解引用后的下标赋值
 * 在编译结果里不是可靠的可写目标（实测点了没反应），脚本里操作 ref 的值才稳。
 */
function toggleOption(key) {
  options.value = { ...options.value, [key]: !options.value[key] };
}

const poolSize = computed(() => {
  try {
    return getPasswordPoolSize(options.value);
  } catch {
    return 0;
  }
});
const strength = computed(() => (password.value ? getPasswordStrength(password.value, poolSize.value) : null));

function regenerate() {
  error.value = "";
  try {
    password.value = generatePassword(options.value);
  } catch (e) {
    password.value = "";
    error.value = e?.message || String(e);
  }
}

const copied = ref("");
async function copy(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = t("toolbox.crypto.copiedLabel");
    setTimeout(() => (copied.value = ""), 2000);
  } catch {
    error.value = t("toolbox.crypto.copyFailed");
  }
}
</script>

<template>
  <section class="m-tool" data-tool="crypto">
    <div class="m-chips">
      <button class="m-chip" :class="{ on: tab === 'digest' }" data-tab="digest" @click="tab = 'digest'">
        {{ t("toolbox.crypto.tabDigest") }}
      </button>
      <button class="m-chip" :class="{ on: tab === 'hmac' }" data-tab="hmac" @click="tab = 'hmac'">
        {{ t("mobile.cryptoHmacTab") }}
      </button>
      <button class="m-chip" :class="{ on: tab === 'password' }" data-tab="password" @click="tab = 'password'">
        {{ t("toolbox.crypto.tabPassword") }}
      </button>
    </div>

    <!-- 摘要 / HMAC -->
    <template v-if="tab !== 'password'">
      <label class="m-field">
        <span>{{ t(tab === "hmac" ? "toolbox.crypto.hmacMsgTitle" : "toolbox.crypto.digestSrcTitle") }}</span>
        <textarea v-model="input" rows="5" spellcheck="false" :placeholder="t('mobile.cryptoInputPh')"></textarea>
      </label>
      <label v-if="tab === 'hmac'" class="m-field">
        <span>{{ t("toolbox.crypto.secretLabel") }}</span>
        <input v-model="secret" spellcheck="false" data-role="secret" />
      </label>
      <label class="m-field">
        <span>{{ t("toolbox.crypto.algorithmLabel") }}</span>
        <select v-model="algo" data-role="algo">
          <option v-for="name in ALGOS" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <p v-if="LEGACY.has(algo)" class="m-hint-sm">{{ t("toolbox.crypto.warnLegacy") }}</p>
      <div class="m-actions">
        <button class="m-btn primary" :disabled="busy" @click="run">
          {{ busy ? t("toolbox.crypto.processing") : t("mobile.cryptoCompute") }}
        </button>
      </div>
      <p v-if="error" class="m-err" data-role="error">{{ error }}</p>
      <label class="m-field">
        <span>{{ t(tab === "hmac" ? "toolbox.crypto.hmacResultTitle" : "toolbox.crypto.digestResultTitle", { algo }) }}</span>
        <textarea :value="output" rows="4" readonly spellcheck="false" data-role="output"></textarea>
      </label>
      <div class="m-actions">
        <button class="m-btn" :disabled="!output" @click="copy(output)">{{ t("toolbox.crypto.copyAllBtn") }}</button>
      </div>
    </template>

    <!-- 密码生成 -->
    <template v-else>
      <label class="m-field">
        <span>{{ t("toolbox.crypto.lengthLabel") }}</span>
        <input v-model.number="options.length" type="number" min="4" max="256" inputmode="numeric" data-role="pw-length" />
      </label>
      <div class="m-chips">
        <button
          v-for="item in [
            { key: 'uppercase', labelKey: 'toolbox.crypto.optUpper' },
            { key: 'lowercase', labelKey: 'toolbox.crypto.optLower' },
            { key: 'numbers', labelKey: 'toolbox.crypto.optNumber' },
            { key: 'symbols', labelKey: 'toolbox.crypto.optSymbol' },
            { key: 'excludeAmbiguous', labelKey: 'toolbox.crypto.optExcludeAmbiguous' },
          ]"
          :key="item.key"
          class="m-chip"
          :class="{ on: options[item.key] }"
          :data-opt="item.key"
          :data-on="String(!!options[item.key])"
          @click="toggleOption(item.key)"
        >
          {{ t(item.labelKey) }}
        </button>
      </div>
      <div class="m-actions">
        <button class="m-btn primary" @click="regenerate">{{ t("toolbox.crypto.genBtn") }}</button>
      </div>
      <p v-if="error" class="m-err" data-role="error">{{ error }}</p>
      <p v-if="password" class="m-big" data-role="password">{{ password }}</p>
      <ul v-if="strength" class="m-stats" data-role="pw-stats">
        <li><b>{{ t("mobile.cryptoStrength") }}</b><span data-role="pw-strength">{{ strength.label }}</span></li>
        <li><b>{{ t("mobile.cryptoEntropy") }}</b><span>{{ t("toolbox.crypto.entropyText", { bits: strength.entropy }) }}</span></li>
        <li><b>{{ t("mobile.cryptoPool") }}</b><span>{{ t("toolbox.crypto.poolText", { count: poolSize }) }}</span></li>
      </ul>
      <div class="m-actions">
        <button class="m-btn" :disabled="!password" @click="copy(password)">{{ t("toolbox.crypto.copyAllBtn") }}</button>
      </div>
    </template>

    <p v-if="copied" class="m-ok">{{ copied }}</p>
    <p class="m-hint-sm">{{ t("mobile.cryptoLocalNote") }}</p>
  </section>
</template>
