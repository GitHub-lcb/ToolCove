<script setup>
// 文件工具（手机端）：通过系统文件选择器（SAF）打开文本文件，编辑后写回。
//
// ⚠️ 手机端与桌面端的**语义差异**（界面上也写明了）：安卓没有"任意路径读写"，
// 文件必须先经系统选择器授权（拿到 content:// URI），之后才能读写那个文件。
// 所以这一页的入口是「选择文件」按钮，而不是一个路径输入框——路径框在手机上是骗人的。
//
// 编解码（UTF-8/UTF-16/GBK 判定、BOM、lossy 标记）全部由原生侧的 FileCodec 负责，
// 与桌面端 Rust 侧同一套语义；这一页只负责展示与调用。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../../../src/platform/invoke.js";
import { nativeAvailable, pickFile } from "../platform/bridge.js";

const { t } = useI18n();

const ENCODINGS = ["AUTO", "UTF-8", "UTF-16LE", "UTF-16BE", "GBK"];

const uri = ref("");
const encoding = ref("AUTO");
const writeEncoding = ref("UTF-8");
const withBom = ref(false);
const text = ref("");
const meta = ref(null); // { name, size, encoding, hasBom, lossy }
const busy = ref(false);
const error = ref("");
const notice = ref("");
const dirty = ref(false);

const ready = computed(() => nativeAvailable());

async function open() {
  if (busy.value) return;
  error.value = "";
  notice.value = "";
  busy.value = true;
  try {
    const picked = await pickFile("text/*");
    // 空串 = 用户取消：**不是错误**，安静收场即可（选择器停住不会发生，原生侧有超时）
    if (!picked) return;
    uri.value = picked;
    await reload();
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    busy.value = false;
  }
}

async function reload() {
  if (!uri.value) return;
  error.value = "";
  try {
    const result = await invoke("file_tool_read_text", { path: uri.value, encoding: encoding.value });
    text.value = result?.text ?? "";
    meta.value = {
      name: result?.name || "",
      size: result?.size ?? 0,
      encoding: result?.encoding || "",
      hasBom: !!result?.hasBom,
      lossy: !!result?.lossy,
    };
    // 读出来的实际编码作为写回默认值：否则"用 GBK 打开、用 UTF-8 存回"会悄悄改坏文件
    writeEncoding.value = meta.value.encoding || "UTF-8";
    withBom.value = meta.value.hasBom;
    dirty.value = false;
  } catch (e) {
    error.value = e?.message || String(e);
    meta.value = null;
  }
}

async function save() {
  if (!uri.value || busy.value) return;
  error.value = "";
  notice.value = "";
  busy.value = true;
  try {
    await invoke("file_tool_write_text", { path: uri.value, text: text.value, encoding: writeEncoding.value, bom: withBom.value });
    dirty.value = false;
    // 写回后重新读一次：显示的大小/编码/是否有 BOM 都要反映真实落盘结果，而不是我们的假设
    await reload();
    notice.value = t("mobile.fileSaved");
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    busy.value = false;
  }
}

const kb = (bytes) => `${Math.max(1, Math.round(Number(bytes || 0) / 1024))} KB`;
</script>

<template>
  <section class="m-tool" data-tool="file">
    <p v-if="!ready" class="m-err" data-role="no-bridge">{{ t("mobile.fileNeedApp") }}</p>

    <div class="m-actions">
      <button class="m-btn primary" :disabled="busy || !ready" data-role="open" @click="open">
        {{ busy ? t("common.loading") : t("mobile.fileOpen") }}
      </button>
      <button v-if="uri" class="m-btn" :disabled="busy" data-role="reload" @click="reload">{{ t("mobile.fileReload") }}</button>
    </div>

    <p class="m-hint-sm">{{ t("mobile.fileSafNote") }}</p>

    <!-- 文件信息：读出来之后才知道真实编码与是否 lossy，这些必须让用户看到 -->
    <ul v-if="meta" class="m-stats" data-role="file-meta">
      <li><b>{{ t("toolbox.file.fileName") }}</b><span data-role="file-name">{{ meta.name }}</span></li>
      <li><b>{{ t("toolbox.file.fileSize") }}</b><span data-role="file-size">{{ kb(meta.size) }}</span></li>
      <li><b>{{ t("mobile.fileEncoding") }}</b><span data-role="file-encoding">{{ meta.encoding }}</span></li>
      <li v-if="meta.hasBom"><b>BOM</b><span>{{ t("mobile.fileHasBom") }}</span></li>
    </ul>
    <!-- lossy：有字节无法解码、已被替换。不说清会让人以为文件本来就是这样 -->
    <p v-if="meta?.lossy" class="m-err" data-role="lossy">{{ t("mobile.fileLossy") }}</p>

    <label v-if="uri" class="m-field">
      <span>{{ t("mobile.fileContent") }}</span>
      <textarea v-model="text" rows="12" spellcheck="false" data-role="content" @input="dirty = true"></textarea>
    </label>

    <template v-if="uri">
      <div class="m-field-row">
        <label class="m-field">
          <span>{{ t("mobile.fileReadEncoding") }}</span>
          <select v-model="encoding" data-role="encoding">
            <option v-for="item in ENCODINGS" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <label class="m-field">
          <span>{{ t("mobile.fileWriteEncoding") }}</span>
          <select v-model="writeEncoding" data-role="write-encoding">
            <option v-for="item in ENCODINGS.filter((x) => x !== 'AUTO')" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
      </div>
      <div class="m-chips">
        <button class="m-chip" :class="{ on: withBom }" data-role="bom" @click="withBom = !withBom">{{ t("mobile.fileWriteBom") }}</button>
      </div>

      <div class="m-actions">
        <button class="m-btn primary" :disabled="busy || !dirty" data-role="save" @click="save">{{ t("mobile.fileSave") }}</button>
      </div>
      <p v-if="!dirty" class="m-hint-sm">{{ t("mobile.fileNoChange") }}</p>
    </template>

    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>
    <p v-if="notice" class="m-ok" data-role="notice">{{ notice }}</p>
  </section>
</template>
