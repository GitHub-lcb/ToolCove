<script setup>
// 照片存档（手机端）：拍照 / 相册 → 本地队列（IndexedDB）→ 直传你自己的对象存储。
//
// 与桌面端共用同一份纯逻辑 src/photo/（签名、命名、队列状态机），这里只做界面与编排。
// 上传走浏览器 fetch 直发：安卓 App（WebView）、iPhone Safari、安卓浏览器是同一条代码路径。
//
// 三条界面语义刻意写死：
//   1. 加照片不需要先配置——照片先安全落盘在队列里，配置好了再传，任何一步中断都不丢；
//   2. 上传只能在前台完成（iOS 的硬限制），提示说清楚，队列负责"下次打开自动续传"；
//   3. 明文直存（用户选择）——凭据的存储安全等级如实告知（网页版没有系统密钥库）。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { formatBytes } from "../../../src/downloader.js";
import { capabilities } from "../../../src/platform/env.js";
import { PHOTO_PROVIDERS, defaultPhotoConfig, exportPhotoConfig, normalizePhotoConfig, parsePhotoConfigExport, validatePhotoConfig } from "../../../src/photo/config.js";
import { visibleFieldsOf } from "../../../src/photo/fields.js";
import { generateDeviceId } from "../../../src/photo/keys.js";
import { QUEUE_STATE } from "../../../src/photo/queue.js";
import { createUploadQueue, filesFromInput, loadPhotoConfig, makePhotoThumb, savePhotoConfig } from "../../../src/photo/session.js";
import { canSendAuthHeader, cloudProviderOf, deleteCloudObject, downloadCloudObject, listCloudObjects, moveCloudObject, objectPreviewUrl } from "../../../src/photo/cloud.js";
import { checkQiniuSpace, probeQiniuUpload } from "../../../src/photo/qiniu.js";
import { testPhotoConnection } from "../../../src/photo/upload.js";

const { t } = useI18n();

const ERROR_KEYS = {
  endpointEmpty: "toolbox.photo.errEndpointEmpty",
  endpointBad: "toolbox.photo.errEndpointBad",
  regionEmpty: "toolbox.photo.errRegionEmpty",
  bucketEmpty: "toolbox.photo.errBucketEmpty",
  bucketBad: "toolbox.photo.errBucketBad",
  keyEmpty: "toolbox.photo.errKeyEmpty",
  secretEmpty: "toolbox.photo.errSecretEmpty",
  prefixBad: "toolbox.photo.errPrefixBad",
  domainEmpty: "toolbox.photo.errDomainEmpty",
  domainBad: "toolbox.photo.errDomainBad",
  uploadHostEmpty: "toolbox.photo.errUploadHostBad",
  uploadHostBad: "toolbox.photo.errUploadHostBad",
  relayUrlBad: "toolbox.photo.errRelayUrlBad",
  userEmpty: "toolbox.photo.errUserEmpty",
  passEmpty: "toolbox.photo.errPassEmpty",
};

const config = ref(defaultPhotoConfig());
const draft = ref(null);
const configErrors = ref({});
const editing = ref(false);
const testing = ref(false);
const testResult = ref("");
const testError = ref("");
const items = ref([]);
const cameraInput = ref(null);
const galleryInput = ref(null);

let queue = null;
const thumbs = new Map();

const configured = computed(() => validatePhotoConfig(config.value).ok);
const providers = computed(() => PHOTO_PROVIDERS.map((p) => ({ ...p, label: t(p.labelKey) })));
const currentProvider = computed(() => providers.value.find((p) => p.key === config.value.provider) || providers.value[0]);
const draftProvider = computed(() => providers.value.find((p) => p.key === draft.value?.provider) || currentProvider.value);
// 转发地址只在"这一端发不出 Authorization 头"时才有意义（网页版）
const draftFields = computed(() => visibleFieldsOf(draft.value?.provider, { nativeRequest: canSendAuthHeader() }));
// 浏览器形态只有 S3 系能直接探活（七牛的 rsf、WebDAV 的 PROPFIND 都不放行跨域）；
// 其余后端的连通性验证在桌面端做（走 Rust，不受 CORS 约束）。
// 能在这台设备上直接自检的后端：S3 系列举即可；七牛用区域接口问"AK + 空间名对不对"
// （七牛的列举要走管理接口，网页端做不了——这也是它过去只能靠上传失败来暴露问题的原因）。
// WebDAV 仍然只能到桌面端测：它没有免签名的探活接口，只能用带 Authorization 的请求，受跨域限制。
const canBrowserTest = computed(() => config.value.provider === "s3" || config.value.provider === "qiniu");
const configSummary = computed(() => `${config.value.bucket || config.value.domain || config.value.endpoint} · ${config.value.prefix}/`);
const stats = computed(() => {
  const by = (state) => items.value.filter((item) => item.status === state).length;
  return { pending: by(QUEUE_STATE.pending), uploading: by(QUEUE_STATE.uploading), done: by(QUEUE_STATE.done), error: by(QUEUE_STATE.error), total: items.value.length };
});
const sortedItems = computed(() => [...items.value].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
/** 队列页只显示没传完的；传完的挪到「已上传」页回看（那里有本机预览小图）。 */
const queueItems = computed(() => sortedItems.value.filter((item) => item.status !== QUEUE_STATE.done));
const uploadedItems = computed(() =>
  items.value.filter((item) => item.status === QUEUE_STATE.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
);
const listMode = ref("queue"); // queue | uploaded
const previewItem = ref(null);
const busy = computed(() => stats.value.uploading > 0);
const webSecretWarn = computed(() => !capabilities.secureStore);

function stateLabel(item) {
  if (item.status === QUEUE_STATE.pending) return t("toolbox.photo.statePending");
  if (item.status === QUEUE_STATE.uploading) return t("toolbox.photo.stateUploading");
  if (item.status === QUEUE_STATE.done) return t("toolbox.photo.stateDone");
  return t("toolbox.photo.stateError");
}

function fieldError(name) {
  const code = configErrors.value[name];
  return code ? t(ERROR_KEYS[code] || code) : "";
}

/** 缩略图：优先本机预览小图（上传后仍保留），没有就用待传的原图；
 *  两者都没有（且已传完）时不再占缓存。 */
function thumbOf(item) {
  const media = item?.thumbBlob || item?.blob;
  if (!media) return "";
  if (!thumbs.has(item.id)) thumbs.set(item.id, URL.createObjectURL(media));
  return thumbs.get(item.id);
}

function releaseStaleThumbs() {
  for (const [id, url] of thumbs) {
    const item = items.value.find((row) => row.id === id);
    if (!item || (!item.thumbBlob && !item.blob)) {
      URL.revokeObjectURL(url);
      thumbs.delete(id);
    }
  }
}

/** 完成时间「10-13 22:05」。 */
function doneAtLabel(item) {
  const ts = Number(item?.doneAt || 0);
  if (!ts) return "";
  const date = new Date(ts);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function refresh() {
  items.value = [...(queue?.items || [])];
  releaseStaleThumbs();
}

async function onPicked(event) {
  const files = filesFromInput(event?.target?.files);
  if (event?.target) event.target.value = ""; // 允许再次选同一张
  if (!files.length || !queue) return;
  // 逐张生成本机预览小图（上传成功后原图释放，「已上传」页回看全靠它）
  for (const file of files) file.thumbBlob = await makePhotoThumb(file.blob);
  await queue.addFiles(files, { config: config.value });
  refresh();
  await queue.pump();
}

function startEdit() {
  draft.value = { ...config.value };
  configErrors.value = {};
  testResult.value = "";
  testError.value = "";
  editing.value = true;
}

function cancelEdit() {
  draft.value = null;
  editing.value = false;
  configErrors.value = {};
}

async function saveConfig() {
  const check = validatePhotoConfig(draft.value);
  configErrors.value = check.errors;
  if (!check.ok) return;
  const cfg = normalizePhotoConfig({
    ...check.config,
    deviceId: /^[0-9a-f]{6}$/.test(config.value.deviceId) ? config.value.deviceId : generateDeviceId(),
  });
  config.value = cfg;
  draft.value = null;
  editing.value = false;
  queue?.setConfig(cfg);
  await savePhotoConfig(cfg);
  testResult.value = "";
  testError.value = "";
  await queue?.pump();
}

// ---------- 云端（直接读远程对象：列出 / 预览 / 改名 / 删除） ----------
// 列的是「配置里那个前缀下」的对象，所以手机上传了什么、桌面上传了什么，这里看到的是同一份。
const CLOUD_PAGE = 50;
const cloudProvider = computed(() => cloudProviderOf(config.value));
const cloud = ref({ items: [], marker: "", truncated: false, loaded: false });
const cloudBusy = ref(false);
const cloudError = ref("");
const cloudNotice = ref("");
const cloudUrls = ref({}); // key → 预览 URL（私有桶带 1 小时有效的下载令牌）
const renaming = ref("");
const renameDraft = ref("");
const confirmingDelete = ref("");

/** 给新到的对象签预览 URL（签过的不重复签：私有令牌的有效期不短，重复签只是浪费）。 */
async function signCloudUrls(items) {
  const next = { ...cloudUrls.value };
  for (const item of items) {
    if (next[item.key]) continue;
    try {
      next[item.key] = await objectPreviewUrl({ config: config.value, key: item.key });
    } catch {
      next[item.key] = "";
    }
  }
  cloudUrls.value = next;
}

async function loadCloud({ append = false } = {}) {
  if (!cloudProvider.value) {
    cloudError.value = t("toolbox.photo.cloudUnsupported");
    return;
  }
  cloudBusy.value = true;
  cloudError.value = "";
  cloudNotice.value = "";
  try {
    const page = await listCloudObjects({
      config: config.value,
      prefix: `${config.value.prefix}/`,
      marker: append ? cloud.value.marker : "",
      limit: CLOUD_PAGE,
    });
    cloud.value = {
      items: append ? [...cloud.value.items, ...page.objects] : page.objects,
      marker: page.nextMarker,
      truncated: page.truncated,
      loaded: true,
    };
    await signCloudUrls(page.objects);
  } catch (e) {
    cloudError.value = String(e?.message || e);
  } finally {
    cloudBusy.value = false;
  }
}

function openCloud() {
  listMode.value = "cloud";
  if (!cloud.value.loaded) loadCloud();
}

function startRename(item) {
  renaming.value = item.key;
  renameDraft.value = item.key;
}

function cancelRename() {
  renaming.value = "";
  renameDraft.value = "";
}

/** 改名 = 改目录：对象 key 就是它的路径，改完桌面归档/设备分段都不受影响（纯服务端移动）。 */
async function saveRename(item) {
  const to = String(renameDraft.value || "").trim();
  if (!to || to === item.key) {
    cancelRename();
    return;
  }
  cloudBusy.value = true;
  cloudError.value = "";
  try {
    await moveCloudObject({ config: config.value, from: item.key, to });
    cancelRename();
    await loadCloud();
    cloudNotice.value = t("toolbox.photo.cloudMoved", { to });
  } catch (e) {
    cloudError.value = String(e?.message || e);
  } finally {
    cloudBusy.value = false;
  }
}

const downloading = ref("");

/**
 * 把 Blob 交给浏览器落地。
 *
 * iPhone 优先走系统分享：Safari 对 Blob 的 `<a download>` 支持一向含糊，
 * 而分享面板里就有「存储到图像」（相册）——用户要的正是那个动作。
 * 其余平台用 `<a download>`：Chrome / Edge / 桌面浏览器都稳。
 */
async function saveBlobToDevice(blob, fileName) {
  const file = typeof File === "function" ? new File([blob], fileName, { type: blob.type || "application/octet-stream" }) : null;
  if (file && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return "share";
    } catch {
      // 用户取消分享不算失败，继续走下载链接这条更普适的路
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立刻 revoke 会让部分浏览器拿到空文件，留一分钟
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "download";
}

/**
 * 下载一张云端照片。
 *
 * 两条落地路径由 [downloadCloudObject] 自己挑：手机 App 交给原生写进系统「下载」目录，
 * 浏览器取成 Blob 再保存/分享。
 */
async function downloadItem(item) {
  if (downloading.value) return;
  downloading.value = item.key;
  cloudError.value = "";
  cloudNotice.value = "";
  try {
    const out = await downloadCloudObject({ config: config.value, key: item.key });
    if (out.native) {
      // 原生落盘分两处：图片进相册（相簿名 ToolCove），其余进下载目录。
      // 文案只给"去哪儿找"，不带完整路径——路径又长又占地方（真机反馈过）。
      const where = out.kind === "image"
        ? t("toolbox.photo.cloudSavedGallery", { folder: out.folder || "ToolCove" })
        : t("toolbox.photo.cloudSavedDownloads");
      cloudNotice.value = t("toolbox.photo.cloudDownloadedNative", { where, name: out.fileName || "" });
      return;
    }
    const how = await saveBlobToDevice(out.blob, out.fileName);
    cloudNotice.value = how === "share" ? "" : t("toolbox.photo.cloudDownloaded", { name: out.fileName });
  } catch (e) {
    cloudError.value = t("toolbox.photo.cloudDownloadFailed", { msg: String(e?.message || e) });
  } finally {
    downloading.value = "";
  }
}
/**
 * 删除：点两次（第二次才是确认），不弹系统 confirm——WebView 里那个框的样式与语言都不受控。
 * 网页版读不到删除响应（七牛不给 CORS），所以**成败以"删完再列一次"为准**：
 * 列不到了就是删掉了，还列得到就是没删掉。
 */
async function removeCloudObject(item) {
  if (confirmingDelete.value !== item.key) {
    confirmingDelete.value = item.key;
    return;
  }
  confirmingDelete.value = "";
  cloudBusy.value = true;
  cloudError.value = "";
  cloudNotice.value = "";
  try {
    let requestFailed = null;
    try {
      await deleteCloudObject({ config: config.value, key: item.key });
    } catch (e) {
      requestFailed = e;
    }
    await loadCloud();
    const gone = !cloud.value.items.some((row) => row.key === item.key);
    if (gone) {
      cloudNotice.value = t("toolbox.photo.cloudDeleted", { name: item.name });
    } else if (canSendAuthHeader()) {
      throw requestFailed || new Error(t("toolbox.photo.cloudDeleteUnknown"));
    } else if (requestFailed) {
      throw requestFailed;
    } else {
      cloudError.value = t("toolbox.photo.cloudDeleteUnknown");
    }
  } catch (e) {
    cloudError.value = String(e?.message || e);
  } finally {
    cloudBusy.value = false;
  }
}

async function runTest() {
  if (!canBrowserTest.value) return;
  testing.value = true;
  testResult.value = "";
  testError.value = "";
  try {
    if (config.value.provider === "qiniu") {
      // 七牛：问区域接口这套 AK + 空间名对不对，并把解析到的上传域名亮出来。
      // 上传失败时那句 401 BadToken 就是靠这一步归因的（见 src/photo/qiniu.js 的 diagnoseQiniuUploadFailure）。
      const check = await checkQiniuSpace({ accessKey: config.value.accessKey, bucket: config.value.bucket });
      if (!check.ok) {
        const key = `toolbox.photo.qiniu_${check.reason || "unknown"}`;
        testError.value = t(key, { message: check.message, default: t("toolbox.photo.qiniu_unknown", { message: check.message }) });
        return;
      }
      // 区域解析只能证明 AK 与空间名；真正能把 BadToken 的三种原因分开的是下面这一次真传。
      // 只解析不真传，用户拿到的结论还是"可能 SK、可能时钟"，等于没答。
      const probe = await probeQiniuUpload({ config: config.value });
      if (probe.ok) {
        testResult.value = t("toolbox.photo.qiniuProbeOk", { key: probe.key });
        return;
      }
      if (probe.reason === "secretKey") testError.value = t("toolbox.photo.qiniuSecretKey");
      else if (probe.reason === "clock") testError.value = t("toolbox.photo.qiniuClock");
      else testError.value = t("toolbox.photo.qiniuProbeFailed", { message: probe.message });
      return;
    }
    const result = await testPhotoConnection({ config: config.value });
    testResult.value = t("toolbox.photo.configOk", { n: result.sampleCount });
  } catch (e) {
    testError.value = String(e?.message || e);
  } finally {
    testing.value = false;
  }
}

// ---- 配置的导出 / 导入（多设备快速配置） ----
const transferMode = ref(""); // "" | "export" | "import"
const transferText = ref("");
const transferError = ref("");
const transferOk = ref("");
const copyState = ref(""); // "" | "ok" | "fail"

const IMPORT_ERROR_KEYS = {
  badJson: "toolbox.photo.importBadJson",
  badKind: "toolbox.photo.importBadKind",
  badVersion: "toolbox.photo.importBadVersion",
  badProvider: "toolbox.photo.importBadProvider",
};

function openExport() {
  transferMode.value = "export";
  transferText.value = exportPhotoConfig(config.value);
  transferError.value = "";
  transferOk.value = "";
  copyState.value = "";
}

function openImport() {
  transferMode.value = "import";
  transferText.value = "";
  transferError.value = "";
  transferOk.value = "";
  copyState.value = "";
}

function closeTransfer() {
  transferMode.value = "";
  transferText.value = "";
  transferError.value = "";
  transferOk.value = "";
  copyState.value = "";
}

function importErrorText(result) {
  if (result.error === "invalid" && result.errors) {
    // 指到第一个出问题的字段（与编辑表单同一套原因码 → 文案）
    const first = Object.values(result.errors)[0];
    return t(ERROR_KEYS[first] || first);
  }
  return t(IMPORT_ERROR_KEYS[result.error] || IMPORT_ERROR_KEYS.badJson);
}

async function applyImported() {
  const result = parsePhotoConfigExport(transferText.value);
  if (!result.ok) {
    transferOk.value = "";
    transferError.value = importErrorText(result);
    return;
  }
  const cfg = normalizePhotoConfig({
    ...result.config,
    deviceId: /^[0-9a-f]{6}$/.test(config.value.deviceId) ? config.value.deviceId : generateDeviceId(),
  });
  config.value = cfg;
  queue?.setConfig(cfg);
  await savePhotoConfig(cfg);
  transferText.value = "";
  transferError.value = "";
  transferOk.value = t("toolbox.photo.importOk");
  await queue?.pump();
}

async function copyExport() {
  try {
    await navigator.clipboard.writeText(transferText.value);
    copyState.value = "ok";
  } catch {
    copyState.value = "fail"; // 自动复制不可用（权限/旧 WebView）→ 提示手动长按复制
  }
}

async function retryItem(id) {
  await queue?.retry(id);
  refresh();
}

async function removeItem(id) {
  await queue?.remove(id);
  refresh();
}

async function retryAll() {
  await queue?.retryAllErrors();
  refresh();
}

async function clearDone() {
  await queue?.clearDone();
  refresh();
}

function onOnline() {
  queue?.pump();
}

onMounted(async () => {
  config.value = await loadPhotoConfig();
  queue = await createUploadQueue({ onUpdate: () => refresh() });
  queue.setConfig(config.value);
  refresh();
  window.addEventListener("online", onOnline);
  await queue.pump(); // 打开页面自动续传上次没传完的
});

onBeforeUnmount(() => {
  window.removeEventListener("online", onOnline);
  for (const url of thumbs.values()) URL.revokeObjectURL(url);
  thumbs.clear();
});
</script>

<template>
  <section class="m-tool" data-tool="photo">
    <!-- 存储配置 -->
    <div class="m-card">
      <div class="m-card-head">
        <b>{{ t("toolbox.photo.configTitle") }}</b>
        <span class="m-zone">{{ currentProvider?.label }}</span>
      </div>

      <template v-if="!editing">
        <p v-if="configured" class="m-hint-sm" data-role="config-summary">{{ configSummary }}</p>
        <p v-else class="m-hint-sm" data-role="config-missing">{{ t("toolbox.photo.notConfigured") }}</p>
        <div class="m-actions">
          <button class="m-btn" data-role="config-edit" @click="startEdit">
            {{ configured ? t("toolbox.photo.configEdit") : t("toolbox.photo.configOpen") }}
          </button>
          <button class="m-btn" :disabled="!configured || testing || !canBrowserTest" data-role="config-test" @click="runTest">
            {{ testing ? t("toolbox.photo.configTesting") : t("toolbox.photo.configTest") }}
          </button>
          <button class="m-btn" data-role="config-export" @click="openExport">{{ t("toolbox.photo.exportBtn") }}</button>
          <button class="m-btn" data-role="config-import" @click="openImport">{{ t("toolbox.photo.importBtn") }}</button>
        </div>
        <p v-if="!canBrowserTest" class="m-hint-sm" data-role="test-desktop-only">{{ t("toolbox.photo.configTestDesktopOnly") }}</p>
        <p class="m-hint-sm" data-role="transfer-hint">{{ t("toolbox.photo.transferHint") }}</p>
        <p v-if="testResult" class="m-ok" data-role="test-result">{{ testResult }}</p>
        <p v-if="testError" class="m-err" data-role="test-error">{{ testError }}</p>

        <!-- 导出 / 导入面板：同一套配置在多台设备间复制，不用逐字段重敲 -->
        <div v-if="transferMode" class="m-photo-transfer" data-role="transfer-box">
          <p class="m-hint-sm">{{ transferMode === "export" ? t("toolbox.photo.exportHint") : t("toolbox.photo.importHint") }}</p>
          <textarea
            v-model="transferText"
            class="m-mono m-photo-transfer-text"
            :readonly="transferMode === 'export'"
            data-role="transfer-text"
            spellcheck="false"
          ></textarea>
          <p v-if="transferError" class="m-err" data-role="transfer-error">{{ transferError }}</p>
          <p v-if="transferOk" class="m-ok" data-role="transfer-ok">{{ transferOk }}</p>
          <p v-if="copyState === 'fail'" class="m-err" data-role="copy-fail">{{ t("toolbox.photo.copyFail") }}</p>
          <div class="m-actions">
            <button v-if="transferMode === 'export'" class="m-btn primary" data-role="transfer-copy" @click="copyExport">
              {{ copyState === "ok" ? t("toolbox.photo.copied") : t("toolbox.photo.copyBtn") }}
            </button>
            <button
              v-else
              class="m-btn primary"
              data-role="transfer-apply"
              :disabled="!transferText.trim()"
              @click="applyImported"
            >
              {{ t("toolbox.photo.importApply") }}
            </button>
            <button class="m-btn" data-role="transfer-close" @click="closeTransfer">{{ t("toolbox.photo.closeBtn") }}</button>
          </div>
        </div>
      </template>

      <template v-else>
        <label class="m-field">
          <span>{{ t("toolbox.photo.fieldProvider") }}</span>
          <select v-model="draft.provider" data-role="provider">
            <option v-for="item in providers" :key="item.key" :value="item.key">{{ item.label }}</option>
          </select>
        </label>
        <p class="m-hint-sm" data-role="provider-hint">{{ t(draftProvider?.hintKey || "toolbox.photo.providerS3Hint") }}</p>
        <p v-if="draft.provider === 'webdav'" class="m-photo-warn" data-role="webdav-warn">{{ t("toolbox.photo.providerWebdavBrowserWarn") }}</p>

        <template v-for="f in draftFields" :key="f.key">
          <label v-if="f.type === 'checkbox'" class="m-check">
            <input v-model="draft[f.key]" type="checkbox" :data-role="`field-${f.kebab}`" />
            <span>{{ t(f.labelKey) }}</span>
          </label>
          <label v-else class="m-field">
            <span>{{ t(f.labelKey) }}</span>
            <input
              v-model="draft[f.key]"
              :type="f.type === 'password' ? 'password' : 'text'"
              :class="{ 'm-mono': f.mono }"
              :data-role="`field-${f.kebab}`"
              :placeholder="f.phKey ? t(f.phKey) : ''"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
          <p v-if="fieldError(f.key)" class="m-field-err" :data-role="`err-${f.kebab}`">{{ fieldError(f.key) }}</p>
        </template>

        <p v-if="webSecretWarn" class="m-photo-warn" data-role="secret-warn">{{ t("toolbox.photo.webSecretWarn") }}</p>
        <div class="m-actions">
          <button class="m-btn primary" data-role="config-save" @click="saveConfig">{{ t("toolbox.photo.configSave") }}</button>
          <button class="m-btn" data-role="config-cancel" @click="cancelEdit">{{ t("toolbox.photo.configCancel") }}</button>
        </div>
      </template>
    </div>

    <!-- 拍照 / 相册 -->
    <div class="m-card">
      <div class="m-card-head">
        <b>{{ t("toolbox.photo.captureTitle") }}</b>
        <span v-if="busy" class="m-zone" data-role="uploading-hint">{{ t("toolbox.photo.uploadingHint") }}</span>
      </div>
      <div class="m-actions">
        <button class="m-btn primary" data-role="take-photo" @click="cameraInput.click()">{{ t("toolbox.photo.takePhoto") }}</button>
        <button class="m-btn" data-role="pick-photos" @click="galleryInput.click()">{{ t("toolbox.photo.pickPhotos") }}</button>
      </div>
      <input ref="cameraInput" class="m-file-hidden" type="file" accept="image/*" capture="environment" data-role="camera-input" @change="onPicked" />
      <input ref="galleryInput" class="m-file-hidden" type="file" accept="image/*" multiple data-role="gallery-input" @change="onPicked" />
      <p class="m-hint-sm" data-role="web-hint">{{ t("toolbox.photo.webHint") }}</p>
    </div>

    <!-- 上传队列 / 已上传 -->
    <div class="m-card">
      <div class="m-card-head">
        <b>{{ listMode === "queue" ? t("toolbox.photo.queueTitle") : listMode === "cloud" ? t("toolbox.photo.cloudTitle") : t("toolbox.photo.stateDone") }}</b>
        <span class="m-zone" data-role="queue-meta">{{ t("toolbox.photo.queueMeta", { done: stats.done, total: stats.total }) }}</span>
      </div>
      <div class="m-chips m-photo-tabs">
        <button class="m-chip" :class="{ on: listMode === 'queue' }" data-role="tab-queue" @click="listMode = 'queue'">
          {{ t("toolbox.photo.queueTitle") }}
        </button>
        <button class="m-chip" :class="{ on: listMode === 'uploaded' }" data-role="tab-uploaded" @click="listMode = 'uploaded'">
          {{ t("toolbox.photo.stateDone") }}
        </button>
        <button class="m-chip" :class="{ on: listMode === 'cloud' }" data-role="tab-cloud" @click="openCloud">
          {{ t("toolbox.photo.cloudTitle") }}
        </button>
      </div>

      <template v-if="listMode === 'queue'">
        <p v-if="!queueItems.length" class="m-hint-sm" data-role="empty">{{ t("toolbox.photo.emptyQueue") }}</p>
        <ul v-else class="m-photo-list">
          <li v-for="item in queueItems" :key="item.id" class="m-photo-row" :data-state="item.status" :data-role="`item-${item.id}`">
            <img v-if="thumbOf(item)" :src="thumbOf(item)" class="m-photo-thumb" alt="" />
            <div class="m-photo-main">
              <span class="m-photo-name">{{ item.name }}</span>
              <span class="m-hint-sm m-photo-meta">{{ formatBytes(item.size) }}</span>
              <span class="m-mono m-photo-key" :title="item.key">{{ item.key }}</span>
              <span v-if="item.error" class="m-err" data-role="item-error">{{ item.error }}</span>
            </div>
            <div class="m-photo-ops">
              <span class="m-photo-chip" :data-state="item.status" data-role="item-state">{{ stateLabel(item) }}</span>
              <button v-if="item.status === QUEUE_STATE.error" class="m-btn sm" data-role="item-retry" @click="retryItem(item.id)">
                {{ t("toolbox.photo.retry") }}
              </button>
              <button
                v-if="item.status !== QUEUE_STATE.uploading"
                class="m-btn sm danger"
                data-role="item-remove"
                @click="removeItem(item.id)"
              >
              {{ t("toolbox.photo.remove") }}
            </button>
          </div>
        </li>
        </ul>
        <div v-if="queueItems.length" class="m-actions">
          <button v-if="stats.error" class="m-btn" data-role="retry-all" @click="retryAll">{{ t("toolbox.photo.retryAll") }}</button>
        </div>
      </template>

      <!-- 云端：直接读远程对象。列的是配置里那个前缀下的东西，所以手机上/桌面上传的都在这里。 -->
      <template v-else-if="listMode === 'cloud'">
        <p class="m-hint-sm" data-role="cloud-hint">{{ t("toolbox.photo.cloudHint", { prefix: config.prefix }) }}</p>
        <div class="m-actions">
          <button class="m-btn sm" :disabled="cloudBusy" data-role="cloud-refresh" @click="loadCloud()">
            {{ cloudBusy ? t("common.loading") : t("toolbox.photo.cloudRefresh") }}
          </button>
        </div>
        <p v-if="cloudError" class="m-err" data-role="cloud-error">{{ cloudError }}</p>
        <p v-else-if="cloudNotice" class="m-ok" data-role="cloud-notice">{{ cloudNotice }}</p>
        <p v-else-if="cloud.loaded && !cloud.items.length" class="m-hint-sm" data-role="cloud-empty">{{ t("toolbox.photo.cloudEmpty") }}</p>
        <ul v-if="cloud.items.length" class="m-photo-list">
          <li v-for="item in cloud.items" :key="item.key" class="m-photo-row" data-state="done" :data-role="`cloud-${item.key}`">
            <img
              v-if="cloudUrls[item.key]"
              :src="cloudUrls[item.key]"
              class="m-photo-thumb"
              alt=""
              loading="lazy"
              data-role="cloud-thumb"
            />
            <div class="m-photo-main">
              <span class="m-photo-name">{{ item.name }}</span>
              <span class="m-hint-sm m-photo-meta">{{ formatBytes(item.size) }}{{ item.lastModified ? ` · ${item.lastModified}` : "" }}</span>
              <span class="m-mono m-photo-key" :title="item.key">{{ item.key }}</span>
              <input
                v-if="renaming === item.key"
                v-model="renameDraft"
                class="m-mono"
                spellcheck="false"
                data-role="cloud-rename-input"
              />
            </div>
            <div class="m-photo-ops">
              <template v-if="renaming === item.key">
                <button class="m-btn sm primary" :disabled="cloudBusy" data-role="cloud-rename-save" @click="saveRename(item)">
                  {{ t("common.confirm") }}
                </button>
                <button class="m-btn sm" data-role="cloud-rename-cancel" @click="cancelRename">{{ t("toolbox.photo.configCancel") }}</button>
              </template>
              <template v-else>
                <button
                  class="m-btn sm"
                  :disabled="cloudBusy || !!downloading"
                  data-role="cloud-download"
                  @click="downloadItem(item)"
                >
                  {{ downloading === item.key ? t("common.loading") : t("toolbox.photo.cloudDownload") }}
                </button>
                <button class="m-btn sm" :disabled="cloudBusy" data-role="cloud-rename" @click="startRename(item)">
                  {{ t("toolbox.photo.cloudRename") }}
                </button>
                <button
                  class="m-btn sm danger"
                  :disabled="cloudBusy"
                  :data-role="confirmingDelete === item.key ? 'cloud-delete-confirm' : 'cloud-delete'"
                  @click="removeCloudObject(item)"
                >
                  {{ confirmingDelete === item.key ? t("toolbox.photo.cloudDeleteConfirm") : t("toolbox.photo.remove") }}
                </button>
              </template>
            </div>
          </li>
        </ul>
        <div v-if="cloud.truncated" class="m-actions">
          <button class="m-btn sm" :disabled="cloudBusy" data-role="cloud-more" @click="loadCloud({ append: true })">
            {{ t("toolbox.photo.cloudMore") }}
          </button>
        </div>
      </template>

      <!-- 已上传：本机上传记录 + 本机预览小图（原图已释放，云端原图不在这里回看） -->
      <template v-else>
        <p v-if="!uploadedItems.length" class="m-hint-sm" data-role="uploaded-empty">{{ t("toolbox.photo.uploadedEmpty") }}</p>
        <template v-else>
          <p class="m-hint-sm" data-role="uploaded-hint">{{ t("toolbox.photo.uploadedHint") }}</p>
          <ul class="m-photo-list">
            <li v-for="item in uploadedItems" :key="item.id" class="m-photo-row" data-state="done" :data-role="`up-${item.id}`">
              <img v-if="thumbOf(item)" :src="thumbOf(item)" class="m-photo-thumb" alt="" @click="previewItem = item" />
              <div class="m-photo-main" @click="previewItem = item">
                <span class="m-photo-name">{{ item.name }}</span>
                <span class="m-hint-sm m-photo-meta">{{ formatBytes(item.size) }} · {{ doneAtLabel(item) }}</span>
                <span class="m-mono m-photo-key" :title="item.key">{{ item.key }}</span>
              </div>
              <div class="m-photo-ops">
                <button class="m-btn sm danger" data-role="up-remove" @click="removeItem(item.id)">{{ t("toolbox.photo.remove") }}</button>
              </div>
            </li>
          </ul>
          <div class="m-actions">
            <button class="m-btn" data-role="clear-done" @click="clearDone">{{ t("toolbox.photo.clearDone") }}</button>
          </div>
        </template>
      </template>
    </div>

    <!-- 本机预览：放大本机预览小图（不是云端原图，不占流量） -->
    <div v-if="previewItem" class="m-photo-preview" data-role="preview" @click.self="previewItem = null">
      <div class="m-photo-preview-card">
        <img v-if="thumbOf(previewItem)" :src="thumbOf(previewItem)" alt="" data-role="preview-img" />
        <p class="m-photo-name">{{ previewItem.name }}</p>
        <p class="m-mono m-photo-key">{{ previewItem.key }}</p>
        <p class="m-hint-sm" data-role="preview-note">{{ t("toolbox.photo.previewLocal") }}</p>
        <div class="m-actions">
          <button class="m-btn" data-role="preview-close" @click="previewItem = null">{{ t("toolbox.photo.closeBtn") }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.m-photo-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.m-photo-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid var(--m-border);
}

.m-photo-row:first-child {
  border-top: none;
}

.m-photo-thumb {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border: 1px solid var(--m-border);
  border-radius: 8px;
  background: var(--m-soft);
  object-fit: cover;
}

.m-photo-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.m-photo-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.m-photo-meta {
  color: var(--m-muted);
}

.m-photo-key {
  overflow: hidden;
  color: var(--m-muted);
  font-size: 0.72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.m-photo-ops {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;
}

.m-photo-chip {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--m-soft);
  color: var(--m-muted);
  font-size: 0.72rem;
  white-space: nowrap;
}

.m-photo-chip[data-state="uploading"] {
  background: var(--m-primary-soft);
  color: var(--m-primary);
}

.m-photo-chip[data-state="done"] {
  background: var(--m-ok-soft);
  color: var(--m-ok);
}

.m-photo-chip[data-state="error"] {
  background: var(--m-danger-soft);
  color: var(--m-danger);
}

.m-btn.sm {
  min-height: 32px;
  padding: 0 10px;
  font-size: 0.8rem;
}

.m-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 0;
  font-size: 0.85rem;
}

.m-photo-warn {
  margin: 10px 0 0;
  padding: 8px 10px;
  border-radius: var(--m-radius);
  background: var(--m-warn-soft);
  color: var(--m-warn);
  font-size: 0.8rem;
  line-height: 1.5;
}

.m-photo-transfer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--m-border);
}

.m-photo-tabs {
  margin: 0 0 10px;
}

/* 本机预览层：全屏遮罩 + 卡片；点遮罩空白处关闭 */
.m-photo-preview {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.72);
}

.m-photo-preview-card {
  width: 100%;
  max-width: 560px;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
  padding: 14px;
  border-radius: var(--m-radius);
  background: var(--m-card);
}

.m-photo-preview-card img {
  width: 100%;
  max-height: 56vh;
  object-fit: contain;
  border-radius: 8px;
  background: var(--m-soft);
}

.m-photo-transfer-text {
  width: 100%;
  min-height: 160px;
  padding: 8px;
  border: 1px solid var(--m-border);
  border-radius: var(--m-radius);
  background: var(--m-soft);
  color: var(--m-text);
  font-size: 0.78rem;
  line-height: 1.5;
  resize: vertical;
}
</style>
