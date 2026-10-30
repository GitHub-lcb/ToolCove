<script setup>
import { ref, computed, onMounted, onBeforeUnmount, onUnmounted, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../platform/invoke.js";
import { imageSrc } from "../platform/image.js";
import Icon from "../ui/Icon.vue";
import { askConfirm } from "../ui/confirm.js";
import AiExtract from "./AiExtract.vue";
import { fieldsToContent, hasFields, fieldValue } from "../snippets.js";
import { create, load as loadRecords, onDataChanged, remove as removeRecord, restore as restoreRecord, update as updateRecord } from "../data/repository.js";
import { vDialog } from '../ui/dialog.js'; // 模板里的 v-dialog 由 <script setup> 就地解析（SSR 渲染测试也能用）

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  jumpId: { type: Object, default: null },
});

const { t } = useI18n();

const snippets = ref([]);
const search = ref("");
const cat = ref("all"); // 当前分类筛选
const showForm = ref(false);
const form = ref(newForm());
const jumpHi = ref(null); // 全局搜索高亮的速记 id

function newForm() {
  return { id: "", title: "", category: "", content: "", fields: [], images: [] };
}

// ------- 加载 / 保存 -------
// 读写统一走 repository：记录级写（create/update/remove）避免整表覆盖，写后自动入队云同步。
async function load() {
  try {
    snippets.value = await loadRecords("snippets");
    snippets.value.forEach((s) => {
      if (!Array.isArray(s.images)) s.images = [];
      if (!Array.isArray(s.fields)) s.fields = [];
    });
    loadImages();
  } catch (e) {
    props.showToast(t("snippet.loadFailed", { err: e }));
  }
}
onMounted(async () => {
  await load();
  tryJump();
});
// Agent / 云同步 / 另一窗口改了数据：重新加载；正在编辑表单时额外提示（表单持有自己的副本，不打断输入）
let offDataChanged = null;
onMounted(() => {
  offDataChanged = onDataChanged(async ({ kind, source }) => {
    if (kind !== "snippets" || source === "view") return;
    await load();
    if (showForm.value) props.showToast(t("snippet.updatedExternally"));
  });
});
onBeforeUnmount(() => offDataChanged?.());
// 配置类弹窗：禁点遮罩关闭，仅 Esc 可关（表单较长，防误触丢输入）
function onEsc(e) {
  if (e.key === "Escape" && showForm.value) showForm.value = false;
}
onMounted(() => window.addEventListener("keydown", onEsc));
onUnmounted(() => window.removeEventListener("keydown", onEsc));

// ------- 全局搜索深链 -------
function tryJump() {
  const j = props.jumpId;
  if (!j || !j.id) return;
  const s = snippets.value.find((x) => x.id === j.id);
  if (!s) return;
  cat.value = "all";
  search.value = "";
  jumpHi.value = s.id;
  nextTick(() => {
    const el = document.getElementById("snip-" + s.id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  setTimeout(() => {
    if (jumpHi.value === s.id) jumpHi.value = null;
  }, 2200);
}
watch(() => props.jumpId, tryJump);

// ------- 派生 -------
const categories = computed(() => {
  const set = new Set();
  snippets.value.forEach((s) => s.category && set.add(s.category));
  return [...set];
});
const selectedId = ref("");
const selected = computed(() => filteredList.value.find((s) => s.id === selectedId.value) || filteredList.value[0] || null);
function excerptOf(s) {
  if (hasFields(s)) return (s.fields || []).map((f) => (f.label ? f.label + "：" : "") + (fieldValue(f) || "")).join(" · ");
  return String(s.content || "").replace(/\s+/g, " ").trim();
}

const filteredList = computed(() => {
  const kw = search.value.trim().toLowerCase();
  return [...snippets.value]
    .filter((s) => (cat.value === "all" ? true : (s.category || "") === cat.value))
    .filter(
      (s) =>
        !kw ||
        (s.title || "").toLowerCase().includes(kw) ||
        (s.content || "").toLowerCase().includes(kw) ||
        (s.category || "").toLowerCase().includes(kw)
    )
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
});

// ------- 复制 -------
// 整体复制：文本速记复制 content；字段速记 content 是「标签: 值」拼接快照，即全部字段
const copiedId = ref(""); // 复制成功反馈：按钮短暂变 check（copyKey = 速记 id 或 "id:fieldId"）
let copiedTimer = null;
function flashCopied(key) {
  copiedId.value = key;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copiedId.value = ""), 900);
}
async function copy(s) {
  if (!s.content) return props.showToast(t("snippet.copyEmpty"));
  try {
    await navigator.clipboard.writeText(s.content);
    flashCopied(s.id);
    const name = s.title || t("snippet.copyNameFallback");
    props.showToast(hasFields(s) ? t("snippet.copiedAll", { name, count: s.fields.length }) : t("snippet.copied", { name }));
  } catch (e) {
    props.showToast(t("snippet.copyFailed", { err: e }));
  }
}
// 单字段复制（分别复制）：只复制该字段的值
async function copyField(f, s) {
  const v = fieldValue(f);
  if (!v) return props.showToast(t("snippet.fieldEmpty"));
  try {
    await navigator.clipboard.writeText(v);
    flashCopied(s.id + ":" + f.id);
    props.showToast(t("snippet.copiedField", { title: s.title || t("snippet.copyNameFallback"), label: f.label || t("snippet.fieldDefault") }));
  } catch (e) {
    props.showToast(t("snippet.copyFailed", { err: e }));
  }
}

// ------- 密码类脱敏：分类命中敏感词时正文默认打码，眼睛按钮临时查看，复制始终是真内容 -------
// 中文敏感词用 unicode 转义书写（源码保持纯 ASCII），功能等价
const SECRET_CAT = /\u5bc6\u7801|\u53e3\u4ee4|\u5bc6\u94a5|\u79d8\u94a5|token|secret|password/i;
const revealed = ref({}); // id -> true，仅当次会话生效，不落盘
function isSecret(s) {
  return SECRET_CAT.test(s.category || "");
}
// 固定长度打码，不暴露真实长度与行数
function maskOf() {
  return "••••••••••••";
}

// ------- 置顶 -------
async function togglePin(s) {
  const next = !s.pinned;
  s.pinned = next;
  try {
    await updateRecord("snippets", s.id, { pinned: next }, { source: "view" });
  } catch (e) {
    s.pinned = !next;
    props.showToast(t("snippet.saveFailed", { err: e }));
  }
}

// ------- 图片附件（复用 save_image 机制：文件落盘 images 目录，JSON 只存元数据） -------
const imgCache = ref({}); // name -> 显示 URL（桌面 asset 协议 / 浏览器 dataURL）
const previewSrc = ref("");
const removedImages = ref([]); // 编辑时移除的旧图，保存后才删文件

async function loadImages() {
  for (const s of snippets.value) {
    for (const img of s.images || []) {
      if (imgCache.value[img.name] !== undefined) continue;
      try {
        imgCache.value[img.name] = await imageSrc(img.name);
      } catch (e) {
        imgCache.value[img.name] = "";
      }
    }
  }
}
function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
// 新图先暂存内存（pending），点保存才落盘：取消弹窗不留垃圾文件
async function addFormImage(blob, mime) {
  const b64 = await blobToB64(blob);
  form.value.images.push({ id: crypto.randomUUID(), pending: true, mime: mime || "image/png", b64 });
}
function formImgSrc(img) {
  return img.pending ? `data:${img.mime};base64,${img.b64}` : imgCache.value[img.name] || "";
}
async function onPickFormImages(e) {
  const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith("image/"));
  e.target.value = "";
  for (const f of files) await addFormImage(f, f.type);
}
async function pasteFormImages() {
  try {
    const items = await navigator.clipboard.read();
    let added = 0;
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      await addFormImage(await it.getType(type), type);
      added++;
    }
    if (!added) props.showToast(t("snippet.clipboardNoImage"));
  } catch (err) {
    props.showToast(t("snippet.clipboardReadFailed", { err }));
  }
}
function removeFormImage(img) {
  form.value.images = form.value.images.filter((x) => x.id !== img.id);
  if (!img.pending) removedImages.value.push(img.name);
}
// 弹窗打开时支持直接 Ctrl+V 贴图
function onFormPaste(e) {
  const imgs = Array.from(e.clipboardData?.items || []).filter((it) => it.type.startsWith("image/"));
  if (!imgs.length) return;
  e.preventDefault();
  (async () => {
    try {
      for (const it of imgs) {
        const blob = it.getAsFile();
        if (blob) await addFormImage(blob, it.type);
      }
    } catch (err) {
      props.showToast(t("snippet.saveImageFailed", { err }));
    }
  })();
}
watch(showForm, (v) => {
  if (v) window.addEventListener("paste", onFormPaste);
  else window.removeEventListener("paste", onFormPaste);
});
onBeforeUnmount(() => window.removeEventListener("paste", onFormPaste));

// ------- 新建 / 编辑 -------
function openCreate() {
  form.value = newForm();
  removedImages.value = [];
  showForm.value = true;
}

// AI 识图字段定义（computed：语言切换后重新求值）
const AI_FIELDS = computed(() => [
  { key: "title", label: t("snippet.aiFieldTitle"), desc: t("snippet.aiFieldTitleDesc") },
  { key: "category", label: t("snippet.aiFieldCategory"), desc: t("snippet.aiFieldCategoryDesc") },
  { key: "content", label: t("snippet.aiFieldContent"), desc: t("snippet.aiFieldContentDesc"), multiline: true },
]);
async function createSnippetsFromAI(list) {
  const rows = Array.isArray(list) ? list : [list];
  let added = 0;
  // 倒序落盘以保持图中原顺序（create 返回补全后的记录）
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!(r.content || "").trim()) continue;
    try {
      const record = await create("snippets", {
        title: (r.title || "").trim(),
        category: (r.category || "").trim(),
        content: r.content,
        fields: [],
        images: [],
        pinned: false,
      }, { source: "view" });
      snippets.value.unshift(record);
      added++;
    } catch (e) {
      props.showToast(t("snippet.saveFailed", { err: e }));
    }
  }
  props.showToast(added ? t("snippet.aiAdded", { count: added }) : t("snippet.aiNothing"));
}
const editing = ref(false);
function startCreate() {
  form.value = { id: "", title: "", category: "", content: "", fields: [], images: [] };
  removedImages.value = [];
  selectedId.value = "";
  editing.value = true;
}
function startEdit(s) {
  form.value = {
    id: s.id,
    title: s.title || "",
    category: s.category || "",
    content: s.content || "",
    fields: (s.fields || []).map((f) => ({ ...f })),
    images: (s.images || []).map((img) => ({ ...img })),
  };
  removedImages.value = [];
  editing.value = true;
}
function cancelEdit() { editing.value = false; }
async function saveInline() {
  const f = form.value;
  if (!f.content.trim()) return props.showToast(t("snippet.saveRequire"));
  const payload = {
    title: f.title.trim(),
    category: f.category.trim(),
    content: f.content,
    fields: f.fields,
    images: f.images,
  };
  try {
    if (f.id) {
      const saved = await updateRecord("snippets", f.id, payload, { source: "view" });
      const idx = snippets.value.findIndex((s) => s.id === f.id);
      if (idx >= 0) snippets.value[idx] = saved;
    } else {
      const saved = await create("snippets", { ...payload, pinned: false }, { source: "view" });
      snippets.value.unshift(saved);
      selectedId.value = saved.id;
    }
    editing.value = false;
  } catch (e) {
    props.showToast(t("snippet.saveFailed", { err: e }));
  }
}

function openEdit(s) {
  form.value = {
    id: s.id,
    title: s.title || "",
    category: s.category || "",
    content: s.content || "",
    fields: (s.fields || []).map((f) => ({ ...f })),
    images: (s.images || []).map((img) => ({ ...img })),
  };
  removedImages.value = [];
  showForm.value = true;
}

// ------- 字段编辑器（标签+值）-------
function addFormField() {
  form.value.fields.push({ id: crypto.randomUUID(), label: "", value: "" });
}
function removeFormField(f) {
  form.value.fields = form.value.fields.filter((x) => x.id !== f.id);
}
async function saveForm() {
  const f = form.value;
  // 字段模式：content 由字段自动生成拼接快照（保证搜索/全局搜索/整体复制一致）
  if (f.fields.length) f.content = fieldsToContent(f.fields);
  if (!f.content.trim() && !f.images.length) return props.showToast(t("snippet.saveRequire"));
  const now = Date.now();
  // 新图落盘，换成元数据
  const metas = [];
  try {
    for (const img of f.images) {
      if (!img.pending) {
        metas.push(img);
        continue;
      }
      const ext = (img.mime || "").includes("jpeg") ? "jpg" : (img.mime || "").includes("webp") ? "webp" : "png";
      const name = `snip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      await invoke("save_image", { name, dataB64: img.b64 });
      imgCache.value[name] = `data:${img.mime};base64,${img.b64}`;
      metas.push({ id: img.id, name, createdAt: now });
    }
  } catch (e) {
    return props.showToast(t("snippet.saveImageFailed", { err: e }));
  }
  const payload = {
    title: f.title.trim(),
    category: f.category.trim(),
    content: f.content,
    fields: f.fields,
    images: metas,
  };
  try {
    if (f.id) {
      const saved = await updateRecord("snippets", f.id, payload, { source: "view" });
      const idx = snippets.value.findIndex((s) => s.id === f.id);
      if (idx >= 0) snippets.value[idx] = saved;
    } else {
      const saved = await create("snippets", { ...payload, pinned: false }, { source: "view" });
      snippets.value.unshift(saved);
    }
  } catch (e) {
    return props.showToast(t("snippet.saveFailed", { err: e }));
  }
  // 保存成功后才删被移除的旧图文件
  for (const name of removedImages.value) {
    try {
      await invoke("delete_image", { name });
    } catch (e) {}
  }
  removedImages.value = [];
  showForm.value = false;
}
async function removeSnippet(s) {
  const ok = await askConfirm({
    title: t("snippet.deleteTitle"),
    message: t("snippet.deleteMsg", { title: s.title || t("snippet.untitled") }),
    okText: t("snippet.deleteOk"),
  });
  if (!ok) return;
  const idx = snippets.value.findIndex((x) => x.id === s.id);
  try {
    await removeRecord("snippets", s.id, { source: "view" });
  } catch (e) {
    return props.showToast(t("snippet.saveFailed", { err: e }));
  }
  snippets.value = snippets.value.filter((x) => x.id !== s.id);
  props.showToast(t("snippet.deleted"), {
    actionLabel: t("snippet.undo"),
    onAction: async () => {
      try {
        const restored = await restoreRecord("snippets", s, { source: "view" });
        snippets.value.splice(Math.min(Math.max(idx, 0), snippets.value.length), 0, restored);
      } catch (e) {
        props.showToast(t("snippet.saveFailed", { err: e }));
        return;
      }
      props.showToast(t("snippet.restored"));
    },
    // 撤销窗口结束后才删图片文件
    onExpire: async () => {
      for (const img of s.images || []) {
        try {
          await invoke("delete_image", { name: img.name });
        } catch (e) {}
      }
    },
  });
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
</script>

<template>
  <div class="toolbar">
    <div class="tb-left">
      <h3 class="section-title">{{ t("snippet.titleCount", { count: snippets.length }) }}</h3>
      <div class="filters">
        <button class="chip" :class="{ active: cat === 'all' }" @click="cat = 'all'">{{ t("snippet.filterAll") }}</button>
        <button v-for="c in categories" :key="c" class="chip" :class="{ active: cat === c }" @click="cat = c">{{ c }}</button>
      </div>
      <div class="search-mini">
        <Icon name="search" :size="15" class="s-icon" />
        <input v-model="search" :placeholder="t('snippet.searchPh')" />
      </div>
    </div>
    <div class="tb-right">
      <button class="btn-primary sm" @click="startCreate"><Icon name="plus" :size="15" /> {{ t("snippet.create") }}</button>
            <AiExtract :fields="AI_FIELDS" :multiple="true" :hint="t('prompt.snippetExtractHint')" :title="t('snippet.extractTitle')" :show-toast="showToast" @apply="createSnippetsFromAI" />
    </div>
  </div>

  <main class="content rec">
    <section class="rec-list" :aria-label="t('nav.snippet')">
      <div class="rec-list-head"><span>{{ t("snippet.titleCount", { count: filteredList.length }) }}</span><span>{{ t("snippet.filterAll") }}</span></div>
      <template v-if="filteredList.length">
        <button
          v-for="s in filteredList"
          :key="s.id"
          type="button"
          class="rec-row"
          :class="{ on: selected && selected.id === s.id, pinned: s.pinned, hi: jumpHi === s.id }"
          @click="selectedId = s.id"
        >
          <span class="rr-title">{{ s.title || t("snippet.untitled") }}</span>
          <span class="rr-ex">{{ excerptOf(s) }}</span>
          <span class="rr-meta">
            <span v-if="s.category" class="rtag">{{ s.category }}</span>
            <span v-if="s.pinned" class="rtag">{{ t("snippet.pin") }}</span>
            <span class="rr-time">{{ fmtTime(s.updatedAt) }}</span>
          </span>
        </button>
      </template>
      <div v-else class="empty rec-empty">
        <span class="empty-ico"><Icon name="copy" :size="26" /></span>
        <h2>{{ t("snippet.emptyTitle") }}</h2>
        <p>{{ t("snippet.emptyDesc") }}</p>
        <button class="btn-outline sm" @click="startCreate"><Icon name="plus" :size="15" />{{ t("snippet.emptyCreate") }}</button>
      </div>
    </section>

    <article v-if="selected || editing" class="rec-detail" :aria-label="t('snippet.edit')">
      <template v-if="!editing && selected">
      <p class="rd-kicker">{{ t("nav.snippet") }}<span v-if="selected.category"> · {{ selected.category }}</span></p>
      <h2 class="rd-title">{{ selected.title || t("snippet.untitled") }}</h2>
      <div class="rd-meta">
        <span v-if="selected.category" class="rtag">{{ selected.category }}</span>
        <span class="rr-time">{{ fmtTime(selected.updatedAt) }}</span>
        <button v-if="isSecret(selected) && selected.content" class="link xs" @click="revealed[selected.id] = !revealed[selected.id]">
          {{ revealed[selected.id] ? t("snippet.hideContent") : t("snippet.revealContent") }}
        </button>
        <button class="link xs" @click="togglePin(selected)">{{ selected.pinned ? t("snippet.unpin") : t("snippet.pin") }}</button>
      </div>

      <pre
        v-if="selected.content && !hasFields(selected)"
        class="rd-content"
        :class="{ masked: isSecret(selected) && !revealed[selected.id] }"
        :title="t('snippet.clickCopy')"
        @click="copy(selected)"
      >{{ isSecret(selected) && !revealed[selected.id] ? maskOf() : selected.content }}</pre>

      <div v-else-if="hasFields(selected)" class="rd-fields">
        <div
          v-for="f in selected.fields"
          :key="f.id"
          class="rd-field"
          :title="f.label ? t('snippet.fieldClickCopy', { label: f.label }) : t('snippet.clickCopy')"
          @click="copyField(f, selected)"
        >
          <span v-if="f.label" class="rd-field-label">{{ f.label }}</span>
          <span class="rd-field-val">{{ isSecret(selected) && !revealed[selected.id] ? maskOf() : fieldValue(f) || "-" }}</span>
          <button
            class="snip-field-copy"
            :class="{ done: copiedId === selected.id + ':' + f.id }"
            :title="t('snippet.copyFieldBtn', { label: f.label || t('snippet.fieldDefault') })"
            @click.stop="copyField(f, selected)"
          >
            <Icon :name="copiedId === selected.id + ':' + f.id ? 'check' : 'copy'" :size="12" />
          </button>
        </div>
      </div>

      <div v-if="(selected.images || []).length" class="rd-imgs">
        <div v-for="img in selected.images" :key="img.id" class="snip-img-cell">
          <img v-if="imgCache[img.name]" :src="imgCache[img.name]" :title="t('snippet.zoomIn')" @click="previewSrc = imgCache[img.name]" />
          <span v-else class="snip-img-miss"><Icon name="image" :size="16" /></span>
        </div>
      </div>

      <div class="rd-acts">
        <button class="btn-ghost sm" @click="copy(selected)">
          <Icon :name="copiedId === selected.id ? 'check' : 'copy'" :size="14" />{{ hasFields(selected) ? t("snippet.copyAll") : t("snippet.copy") }}
        </button>
        <button class="btn-ghost sm" @click="startEdit(selected)"><Icon name="edit" :size="14" />{{ t("snippet.edit") }}</button>
        <button class="btn-ghost sm" @click="removeSnippet(selected)"><Icon name="trash" :size="14" />{{ t("snippet.delete") }}</button>
      </div>
      </template>
      <div v-else class="inline-edit">
        <p class="rd-kicker">{{ form.id ? t("snippet.formEditTitle") : t("snippet.formCreateTitle") }}</p>
        <div class="ie-row">
          <label class="ie-field"><span>{{ t("snippet.formTitle") }}</span><input v-model="form.title" :placeholder="t('snippet.formTitlePh')" /></label>
          <label class="ie-field"><span>{{ t("snippet.formCategory") }}</span><input v-model="form.category" :placeholder="t('snippet.formCategoryPh')" /></label>
        </div>
        <label class="ie-field"><span>{{ t("snippet.formContent") }}</span><textarea v-model="form.content" rows="8" class="mono" :placeholder="t('snippet.formContentPh')"></textarea></label>
        <p v-if="form.fields.length || form.images.length" class="ie-note">{{ t("snippet.formContentHint") }}</p>
        <div class="rd-acts">
          <button class="btn-primary sm" @click="saveInline">{{ t("snippet.saveBtn") }}</button>
          <button class="btn-ghost sm" @click="cancelEdit">{{ t("common.cancel") }}</button>
          <button class="btn-ghost sm" @click="openEdit(selected)">{{ t("snippet.fullEditor") }}</button>
        </div>
      </div>
    </article>
    <div v-else class="rec-detail rec-blank">{{ t("snippet.emptyDesc") }}</div>
  </main>

  <!-- 新建 / 编辑弹窗 -->
  <div v-if="showForm" class="modal-mask">
    <div class="modal" v-dialog>
      <h2>{{ form.id ? t("snippet.formEditTitle") : t("snippet.formCreateTitle") }}</h2>

      <div class="row2">
        <label class="field">
          <span>{{ t("snippet.formTitle") }}</span>
          <input v-model="form.title" :placeholder="t('snippet.formTitlePh')" />
        </label>
        <label class="field">
          <span>{{ t("snippet.formCategory") }}</span>
          <input v-model="form.category" :placeholder="t('snippet.formCategoryPh')" list="snip-cats" />
          <datalist id="snip-cats">
            <option v-for="c in categories" :key="c" :value="c" />
          </datalist>
        </label>
      </div>

      <label class="field">
        <span>{{ t("snippet.formContent") }}<span v-if="form.fields.length" class="field-hint">{{ t("snippet.formContentHint") }}</span></span>
        <textarea v-model="form.content" rows="6" :placeholder="t('snippet.formContentPh')" class="mono"></textarea>
      </label>

      <div class="field">
        <span>{{ t("snippet.formFields") }}</span>
        <div class="field-rows">
          <div v-for="f in form.fields" :key="f.id" class="field-row">
            <input v-model="f.label" :placeholder="t('snippet.fieldLabelPh')" class="field-row-label" />
            <input v-model="f.value" :placeholder="t('snippet.fieldValuePh')" class="field-row-val mono" />
            <button class="op del" type="button" :title="t('snippet.removeField')" @click="removeFormField(f)"><Icon name="x" :size="12" /></button>
          </div>
        </div>
        <button class="btn-ghost sm" type="button" @click="addFormField"><Icon name="plus" :size="13" /> {{ t("snippet.addField") }}</button>
      </div>

      <div class="field">
        <span>{{ t("snippet.formImages") }}</span>
        <div class="form-imgs">
          <div v-for="img in form.images" :key="img.id" class="form-img-cell">
            <img v-if="formImgSrc(img)" :src="formImgSrc(img)" :title="t('snippet.zoomIn')" @click="previewSrc = formImgSrc(img)" />
            <span v-else class="snip-img-miss"><Icon name="image" :size="16" /></span>
            <button class="form-img-del" :title="t('snippet.removeImage')" @click="removeFormImage(img)"><Icon name="x" :size="10" /></button>
          </div>
          <label class="form-img-add">
            <Icon name="plus" :size="13" /> {{ t("snippet.pickImage") }}
            <input type="file" accept="image/*" multiple hidden @change="onPickFormImages" />
          </label>
          <button class="form-img-add" type="button" @click="pasteFormImages"><Icon name="copy" :size="12" /> {{ t("snippet.pasteImage") }}</button>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn-ghost" @click="showForm = false">{{ t("common.cancel") }}</button>
        <button class="btn-primary" @click="saveForm">{{ t("snippet.saveBtn") }}</button>
      </div>
    </div>
  </div>

  <!-- 图片放大预览 -->
  <div v-if="previewSrc" class="modal-mask img-preview" v-dialog="{ label: t('common.preview') }" @click="previewSrc = ''">
    <img :src="previewSrc" />
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); padding: var(--sp-6) 28px; flex-wrap: wrap; }
.tb-left { display: flex; align-items: center; gap: var(--sp-6); flex-wrap: wrap; }
.section-title { margin: 0; font-size: var(--fs-lg); font-weight: 700; }
.filters { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.chip { display: inline-flex; align-items: center; gap: var(--sp-1); background: var(--card); border: 1px solid var(--border-strong); padding: var(--sp-2) 13px; border-radius: var(--r-sm); font-size: var(--fs-md); font-weight: 600; cursor: pointer; color: var(--text-soft); transition: all 0.15s; }
.chip:hover { border-color: var(--border-strong); }
.chip.active { background: var(--accent-hover); color: var(--text-invert); border-color: var(--accent-hover); }
.tb-right { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
.search-mini { position: relative; display: flex; align-items: center; }
.search-mini .s-icon { position: absolute; left: 10px; color: var(--muted); pointer-events: none; }
.search-mini input { padding: 7px var(--sp-4) 7px 30px; border: 1px solid transparent; border-radius: var(--r-sm); font-size: var(--fs-md); background: color-mix(in srgb, var(--text-weak) 9%, transparent); color: var(--text); outline: none; width: 190px; transition: background 0.15s, border-color 0.15s; }
.search-mini input:focus { background: var(--card); border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }

.content { flex: 1; padding: 18px 28px 36px; }
.snip-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; }
.snip-card { position: relative; display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: var(--sp-6) var(--sp-6) var(--sp-5); box-shadow: var(--shadow); overflow: hidden; opacity: 0; transform: translateY(14px); animation: snipIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards; transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.25s, border-color 0.25s; }
@keyframes snipIn { to { opacity: 1; transform: none; } }
.snip-card:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--primary) 40%, var(--card)); box-shadow: 0 16px 40px color-mix(in srgb, var(--primary) 16%, transparent); }
.snip-card.pinned { border-color: color-mix(in srgb, var(--amber) 40%, var(--card)); }
.snip-card.pinned::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, var(--amber-bright), var(--amber-light)); }
.snip-card.hi { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft), 0 16px 40px color-mix(in srgb, var(--primary) 22%, transparent); }

.snip-head { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
.snip-cat { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 600; color: var(--primary); background: var(--primary-soft); padding: var(--sp-0) 9px; border-radius: var(--r-pill); }
.snip-title { flex: 1; min-width: 0; margin: 0; font-size: var(--fs-base); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.snip-ops { display: flex; gap: 5px; opacity: 0; transform: translateY(-3px); transition: opacity 0.15s, transform 0.15s; flex-shrink: 0; }
.snip-card:hover .snip-ops { opacity: 1; transform: none; }
.op { width: 28px; height: 28px; padding: 0; display: grid; place-items: center; border: 1px solid var(--card-border); background: var(--card); border-radius: var(--r-sm); color: var(--muted); cursor: pointer; transition: all 0.15s; }
.op:hover { color: var(--primary); border-color: var(--primary); background: var(--primary-soft); }
.op.on { color: var(--amber); border-color: var(--amber-border); background: var(--amber-soft); }
.op.del:hover { color: var(--danger-deep); border-color: var(--border-danger); background: var(--danger-soft); }

.snip-content { flex: 1; margin: 0 0 var(--sp-4); font-family: var(--font-mono); font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--text-code); background: color-mix(in srgb, var(--text) 4%, transparent); border: 1px solid var(--card-border); border-radius: var(--r-sm); padding: var(--sp-3) var(--sp-4); max-height: 132px; overflow: auto; white-space: pre-wrap; word-break: break-word; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
.snip-content:hover { background: var(--primary-soft); border-color: var(--border-blue); }
/* 密码类打码态：加大字距更像密码框，点击仍复制真内容 */
.snip-content.masked { letter-spacing: 3px; color: var(--muted); user-select: none; }

/* 字段模式：标签+值多行展示，每行可单独复制 */
.snip-fields { flex: 1; margin: 0 0 var(--sp-4); font-size: var(--fs-sm); line-height: var(--lh-body); background: color-mix(in srgb, var(--text) 4%, transparent); border: 1px solid var(--card-border); border-radius: var(--r-sm); padding: 4px var(--sp-3); max-height: 132px; overflow: auto; }
.snip-field { display: flex; align-items: center; gap: var(--sp-3); padding: 5px var(--sp-0); border-bottom: 1px dashed var(--border); border-radius: var(--r-xs); cursor: pointer; transition: background 0.15s; }
.snip-field:last-child { border-bottom: none; }
.snip-field:hover { background: var(--primary-soft); }
.snip-field-label { flex-shrink: 0; max-width: 96px; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.snip-field-val { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-code); white-space: pre-wrap; word-break: break-all; }
.snip-field-copy { width: 22px; height: 22px; flex-shrink: 0; padding: 0; display: grid; place-items: center; border: 1px solid var(--card-border); background: var(--card); border-radius: var(--r-xs); color: var(--muted); cursor: pointer; transition: all 0.15s; }
.snip-field-copy:hover { color: var(--primary); border-color: var(--primary); background: var(--primary-soft); }
.snip-fields.masked .snip-field-val { letter-spacing: 3px; color: var(--muted); user-select: none; }

.snip-imgs { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin: 0 0 var(--sp-4); }
.snip-img-cell { width: 64px; height: 64px; border-radius: var(--r-sm); overflow: hidden; border: 1px solid var(--card-border); background: var(--ghost); }
.snip-img-cell img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; display: block; }
.snip-img-miss { width: 100%; height: 100%; display: grid; place-items: center; color: var(--muted); }

.form-imgs { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
.form-img-cell { position: relative; width: 72px; height: 72px; border-radius: var(--r-sm); overflow: hidden; border: 1px solid var(--border-strong); background: var(--ghost); }
.form-img-cell img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; display: block; }
.form-img-del { position: absolute; top: 3px; right: 3px; width: 17px; height: 17px; border: none; border-radius: var(--r-pill); background: rgba(10, 12, 16, 0.55); color: var(--text-invert); display: grid; place-items: center; cursor: pointer; padding: 0; }
.form-img-del:hover { background: var(--danger); }
.form-img-add { display: inline-flex; align-items: center; gap: var(--sp-05); padding: var(--sp-2) var(--sp-4); border: 1px dashed var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-sm); color: var(--muted); background: none; cursor: pointer; font-family: inherit; }
.form-img-add:hover { color: var(--primary); border-color: var(--primary); }

.img-preview {
  z-index: var(--z-front);
  background: var(--overlay-strong);
  cursor: zoom-out;
}
.img-preview img { max-width: 100%; max-height: 100%; border-radius: var(--r-sm); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); }

.snip-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.snip-time { font-size: var(--fs-xs); color: var(--muted); }
.copy-btn { display: inline-flex; align-items: center; gap: 5px; background: var(--primary); color: var(--text-invert); border: none; padding: var(--sp-1) var(--sp-4); border-radius: var(--r-sm); font-size: var(--fs-sm); font-weight: 600; cursor: pointer; transition: background 0.15s; }
.copy-btn:hover { background: var(--primary-hover); }
.copy-btn:active { transform: translateY(1px); }
/* 复制成功反馈：按钮短暂变绿 + check 图标 */
.copy-btn.done { background: var(--success-deep); }
.snip-field-copy.done { color: var(--success-deep); border-color: var(--success); background: var(--success-tint); }

/* 空状态：底座见 globals.css（.empty / .empty-ico），这里只留本页特有的间距 */
.empty-ico { margin-bottom: var(--sp-1); }
.empty h2 { font-size: var(--fs-xl); margin: var(--sp-2) 0 var(--sp-1); font-weight: 700; }
.empty p { color: var(--muted); font-size: var(--fs-base); margin: 0 0 22px; max-width: 460px; margin-left: auto; margin-right: auto; }

.row2 { display: flex; gap: var(--sp-4); }
.row2 .field { flex: 1; }
.field { display: block; margin-bottom: var(--sp-6); }
.field > span { display: block; font-size: var(--fs-md); color: var(--muted); margin-bottom: 7px; font-weight: 600; }
.field input, .field textarea { width: 100%; padding: var(--sp-3) 13px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-base); font-family: inherit; outline: none; resize: vertical; background: var(--card); color: var(--text); }
.field input:focus, .field textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.field textarea.mono { font-family: var(--font-mono); font-size: var(--fs-md); line-height: var(--lh-body); }

/* 字段编辑器（标签+值多行） */
.field-hint { font-size: var(--fs-xs); color: var(--muted); font-weight: 400; margin-left: var(--sp-1); }
.field-rows { display: flex; flex-direction: column; gap: var(--sp-2); margin-bottom: var(--sp-3); }
.field-row { display: flex; gap: var(--sp-2); align-items: center; }
.field-row input { width: auto; margin-bottom: 0; }
.field-row .field-row-label { flex: 0 0 112px; }
.field-row .field-row-val { flex: 1; min-width: 0; }
.field-row .op { flex-shrink: 0; }

@media (prefers-color-scheme: dark) {
  .snip-card { background: var(--card); border-color: var(--border-strong); }
  .op.on { background: var(--warn-soft); border-color: var(--warn-border); color: var(--amber-light); }
  .field input, .field textarea, .search-mini input, .op { background: var(--card-raised); }
  .snip-content { background: var(--card-raised); color: var(--text-code); }
  .snip-fields { background: var(--card-raised); }
  .snip-field-val { color: var(--text-code); }
}

/* ---------- B · Pipeline 收口：卡片与空态 ---------- */
.section-title { font-size: var(--fs-xl); font-weight: 650; letter-spacing: -0.3px; }
.snip-card { border-color: var(--border); border-radius: var(--r-xs); box-shadow: none; }
.snip-card:hover { transform: none; border-color: var(--primary); box-shadow: none; }
.snip-card.hi { box-shadow: none; border-color: var(--primary); }
.snip-card.pinned::before { background: var(--amber); height: 2px; }
.snip-cat { background: transparent; border: 1px solid var(--border-blue); border-radius: var(--r-xs); padding: 0 var(--sp-05); }
.snip-content { border-radius: var(--r-xs); }

/* ---------- 记录：左列表 + 右详情 ---------- */
.content.rec { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 0; padding: 0; overflow: hidden; }
.rec-list { min-height: 0; overflow: auto; background: var(--card); border-right: 1px solid var(--border); }
.rec-list-head { position: sticky; top: 0; z-index: 1; display: flex; justify-content: space-between; padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border); background: var(--card); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--faint); }
.rec-row { display: flex; flex-direction: column; gap: var(--sp-1); width: 100%; padding: var(--sp-3); border: 0; border-bottom: 1px solid var(--border); background: transparent; text-align: left; cursor: pointer; }
.rec-row:hover { background: var(--card-soft); }
.rec-row.on { background: var(--card-soft); box-shadow: inset 2px 0 0 var(--primary); }
.rr-title { font-size: var(--fs-md); font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rr-ex { font-size: var(--fs-sm); line-height: 1.45; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.rr-meta { display: flex; align-items: center; gap: var(--sp-1); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--faint); }
.rr-time { margin-left: auto; }
.rtag { border: 1px solid var(--border-strong); border-radius: var(--r-xs); padding: 0 var(--sp-05); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--muted); }
.rec-empty { padding: var(--sp-7) var(--sp-4); align-items: flex-start; text-align: left; }
.rec-detail { min-height: 0; overflow: auto; padding: var(--sp-6) var(--sp-7); background: var(--card); }
.rd-kicker { margin: 0 0 var(--sp-1); font-family: var(--font-mono); font-size: var(--fs-xs); letter-spacing: 0.1em; text-transform: uppercase; color: var(--faint); }
.rd-title { margin: 0 0 var(--sp-2); font-size: var(--fs-xl); line-height: 1.35; letter-spacing: -0.3px; }
.rd-meta { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--faint); }
.rd-meta .rr-time { margin-left: 0; }
.rd-content { margin: var(--sp-4) 0 0; padding: var(--sp-4); background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--r-xs); font-family: var(--font-mono); font-size: var(--fs-md); line-height: var(--lh-body); color: var(--text-code); white-space: pre-wrap; word-break: break-word; cursor: pointer; }
.rd-content.masked { letter-spacing: 3px; color: var(--muted); }
.rd-fields { margin-top: var(--sp-4); border: 1px solid var(--border); border-radius: var(--r-xs); }
.rd-field { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border); cursor: pointer; }
.rd-field:last-child { border-bottom: 0; }
.rd-field:hover { background: var(--card-soft); }
.rd-field-label { flex: 0 0 96px; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); }
.rd-field-val { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-code); word-break: break-all; }
.rd-imgs { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-4); }
.rd-acts { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-5); padding-top: var(--sp-3); border-top: 1px solid var(--border); }
.rec-blank { display: flex; align-items: center; justify-content: center; color: var(--faint); font-size: var(--fs-sm); }

/* ---------- 详情内就地编辑 ---------- */
.inline-edit { display: flex; flex-direction: column; gap: var(--sp-3); max-width: 720px; }
.ie-row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
.ie-field { display: flex; flex-direction: column; gap: var(--sp-1); }
.ie-field > span { font-family: var(--font-mono); font-size: var(--fs-xs); letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); }
.ie-field input, .ie-field textarea { width: 100%; padding: var(--sp-2); border: 1px solid var(--border-strong); background: var(--card); color: var(--text); font-size: var(--fs-md); }
.ie-field input:focus, .ie-field textarea:focus { outline: 2px solid var(--primary); outline-offset: -1px; }
.ie-field textarea { resize: vertical; line-height: var(--lh-body); font-family: var(--font-mono); font-size: var(--fs-sm); }
.ie-note { margin: 0; font-size: var(--fs-xs); color: var(--muted); }
</style>
