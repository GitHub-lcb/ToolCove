<script setup>
// 请求工具（手机端）：发 HTTP 请求并看响应。
//
// 执行路径**平台无关**：`invoke("http_request")` 在桌面走 Rust 代理、手机端走 Kotlin 桥、
// 都没有时落回浏览器 fetch（src/platform/net.js）。所以本页不需要任何平台分支。
//
// 手机端现状（如实标注在界面上，不装作一样）：
//   · 目前走 WebView 的 fetch，受 CORS 限制——目标站点没给跨域头就会失败；
//   · Kotlin 侧的 HTTP 桥是 Phase 5 的内容，接上之后与桌面端等价（绕过 CORS）。
// 与其让用户看到一句"请求失败"，不如直接说清楚为什么。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../../../src/platform/invoke.js";
import { detectBodyLang, prettyBody, sizeText, statusClass } from "../../../src/tools/request.js";

const { t } = useI18n();

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const method = ref("GET");
const url = ref("");
const headers = ref([]);
const body = ref("");
const loading = ref(false);
const error = ref("");
const response = ref(null);
const respTab = ref("body"); // body | headers
const showCurl = ref(false);
const curlText = ref("");

const sendable = computed(() => url.value.trim().length > 0 && !loading.value);

function addHeader() {
  headers.value = [...headers.value, { name: "", value: "" }];
}
function removeHeader(index) {
  headers.value = headers.value.filter((_, i) => i !== index);
}

/** 只把「名字非空」的头带出去（空行是编辑中的残留，不该发出去）。 */
const activeHeaders = computed(() => headers.value.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]));

async function send() {
  error.value = "";
  response.value = null;
  const target = url.value.trim();
  if (!target) {
    error.value = t("toolbox.request.urlRequired");
    return;
  }
  loading.value = true;
  try {
    const result = await invoke("http_request", {
      method: method.value,
      url: target,
      headers: activeHeaders.value,
      body: body.value,
      timeoutMs: 30000,
    });
    response.value = result;
    respTab.value = "body";
  } catch (e) {
    // 失败原因原样呈现：CORS、DNS、超时在排查时是完全不同的事
    error.value = t("toolbox.request.sendFail", { error: e?.message || String(e) });
  } finally {
    loading.value = false;
  }
}

/** 响应体：JSON 就美化，否则原样（美化失败不吞内容）。 */
const prettyBodyText = computed(() => {
  const raw = response.value?.body;
  if (typeof raw !== "string" || !raw) return "";
  const contentType = (response.value?.headers || []).find(([k]) => String(k).toLowerCase() === "content-type")?.[1] || "";
  const lang = detectBodyLang(contentType, raw);
  if (lang === "json") {
    try {
      return prettyBody(raw, "json");
    } catch {
      return raw;
    }
  }
  return raw;
});

const copied = ref("");
async function copy(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = t("toolbox.request.copied");
    setTimeout(() => (copied.value = ""), 2000);
  } catch {
    error.value = t("toolbox.request.copyFail");
  }
}

/** curl 导入：接受 -X/-H/-d/--data 与裸 URL，够日常粘贴用。 */
function importCurl() {
  const text = curlText.value.trim();
  if (!text) return;
  const tokens = text.replace(/\\\r?\n/g, " ").match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const unquote = (s) => s.replace(/^["']|["']$/g, "");
  let nextMethod = "";
  const nextHeaders = [];
  let nextBody = "";
  let nextUrl = "";
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "-X" || token === "--request") {
      nextMethod = unquote(tokens[++i] || "").toUpperCase();
    } else if (token === "-H" || token === "--header") {
      const raw = unquote(tokens[++i] || "");
      const at = raw.indexOf(":");
      if (at > 0) nextHeaders.push({ name: raw.slice(0, at).trim(), value: raw.slice(at + 1).trim() });
    } else if (token === "-d" || token === "--data" || token === "--data-raw" || token === "--data-binary") {
      nextBody = unquote(tokens[++i] || "");
    } else if (/^https?:\/\//i.test(unquote(token))) {
      nextUrl = unquote(token);
    }
  }
  if (nextUrl) url.value = nextUrl;
  if (nextMethod) method.value = METHODS.includes(nextMethod) ? nextMethod : "POST";
  else if (nextBody && method.value === "GET") method.value = "POST";
  if (nextHeaders.length) headers.value = nextHeaders;
  if (nextBody) body.value = nextBody;
  showCurl.value = false;
  curlText.value = "";
}
</script>

<template>
  <section class="m-tool" data-tool="request">
    <div class="m-field-row">
      <label class="m-field m-method">
        <span>{{ t("toolbox.request.params") }}</span>
        <select v-model="method" data-role="method">
          <option v-for="m in METHODS" :key="m" :value="m">{{ m }}</option>
        </select>
      </label>
      <label class="m-field m-url">
        <span>URL</span>
        <input v-model="url" spellcheck="false" inputmode="url" data-role="url" placeholder="https://httpbin.org/get" />
      </label>
    </div>

    <div class="m-actions">
      <button class="m-btn primary" :disabled="!sendable" data-role="send" @click="send">
        {{ loading ? t("toolbox.request.loading") : t("toolbox.request.send") }}
      </button>
      <button class="m-btn" @click="showCurl = !showCurl">{{ t("toolbox.request.importCurl") }}</button>
    </div>

    <template v-if="showCurl">
      <label class="m-field">
        <span>{{ t("toolbox.request.importCurlTitle") }}</span>
        <textarea v-model="curlText" rows="3" spellcheck="false" :placeholder="t('toolbox.request.curlPh')" data-role="curl"></textarea>
      </label>
      <div class="m-actions">
        <button class="m-btn" @click="importCurl">{{ t("toolbox.request.parseImport") }}</button>
      </div>
    </template>

    <!-- 请求头 -->
    <div class="m-card">
      <div class="m-card-head">
        <b>{{ t("toolbox.request.params") }}</b>
        <button class="m-op" @click="addHeader">＋</button>
      </div>
      <p v-if="!headers.length" class="m-hint-sm">{{ t("mobile.reqNoHeaders") }}</p>
      <div v-for="(header, index) in headers" :key="index" class="m-field-row m-header-row">
        <label class="m-field">
          <input v-model="header.name" spellcheck="false" :placeholder="t('toolbox.request.paramName')" data-role="header-name" />
        </label>
        <label class="m-field">
          <input v-model="header.value" spellcheck="false" :placeholder="t('toolbox.request.value')" data-role="header-value" />
        </label>
        <button class="m-op danger" @click="removeHeader(index)">×</button>
      </div>
    </div>

    <!-- 请求体（GET/HEAD 不发） -->
    <label v-if="!['GET', 'HEAD'].includes(method)" class="m-field">
      <span>{{ t("toolbox.request.tipBody") }}</span>
      <textarea v-model="body" rows="5" spellcheck="false" :placeholder="t('toolbox.request.bodyTextPh')" data-role="body"></textarea>
    </label>

    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>

    <!-- 响应 -->
    <template v-if="response">
      <div class="m-card" data-role="response">
        <div class="m-card-head">
          <b :class="'st-' + statusClass(response.status)" data-role="status">{{ response.status }} {{ response.statusText }}</b>
          <span class="m-zone" data-role="meta">{{ response.durationMs }}ms · {{ sizeText(response.size) }}</span>
        </div>
        <div class="m-chips">
          <button class="m-chip" :class="{ on: respTab === 'body' }" data-role="tab-body" @click="respTab = 'body'">
            {{ t("toolbox.request.respTitle") }}
          </button>
          <button class="m-chip" :class="{ on: respTab === 'headers' }" data-role="tab-headers" @click="respTab = 'headers'">
            {{ t("toolbox.request.params") }}
          </button>
        </div>
        <textarea
          v-if="respTab === 'body'"
          :value="prettyBodyText"
          rows="10"
          readonly
          spellcheck="false"
          data-role="resp-body"
        ></textarea>
        <ul v-else class="m-stats" data-role="resp-headers">
          <li v-for="([name, value], index) in response.headers" :key="index"><b>{{ name }}</b><span>{{ value }}</span></li>
        </ul>
        <div class="m-actions">
          <button class="m-btn" @click="copy(prettyBodyText)">{{ t("toolbox.request.copyResp") }}</button>
        </div>
      </div>
      <p v-if="response.bodyBase64" class="m-hint-sm">{{ t("toolbox.request.binDesktopOnly") }}</p>
    </template>

    <p v-if="copied" class="m-ok">{{ copied }}</p>
    <p class="m-hint-sm">{{ t("mobile.reqCorsNote") }}</p>
  </section>
</template>
