<script setup>
import { ref, computed, onMounted, onBeforeUnmount, onUnmounted, watch, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon.vue";
import { askConfirm } from "./confirm.js";
import AiExtract from "./AiExtract.vue";
import { fieldsToContent, hasFields, fieldValue } from "./snippets.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  jumpId: { type: Object, default: null },
});

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
async function load() {
  try {
    snippets.value = (await invoke("load_data", { key: "snippets" })) || [];
    snippets.value.forEach((s) => {
      if (!Array.isArray(s.images)) s.images = [];
      if (!Array.isArray(s.fields)) s.fields = [];
    });
    loadImages();
  } catch (e) {
    props.showToast("加载速记失败：" + e);
  }
}
async function persist() {
  try {
    await invoke("save_data", { key: "snippets", data: snippets.value });
  } catch (e) {
    props.showToast("保存失败：" + e);
  }
}
onMounted(async () => {
  await load();
  tryJump();
});
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
  if (!s.content) return props.showToast("这条速记没有内容");
  try {
    await navigator.clipboard.writeText(s.content);
    flashCopied(s.id);
    const name = s.title || "速记";
    props.showToast(hasFields(s) ? `已复制「${name}」全部 ${s.fields.length} 项` : `已复制「${name}」`);
  } catch (e) {
    props.showToast("复制失败：" + e);
  }
}
// 单字段复制（分别复制）：只复制该字段的值
async function copyField(f, s) {
  const v = fieldValue(f);
  if (!v) return props.showToast("这个字段没有内容");
  try {
    await navigator.clipboard.writeText(v);
    flashCopied(s.id + ":" + f.id);
    props.showToast(`已复制「${s.title || "速记"}」的 ${f.label || "字段"}`);
  } catch (e) {
    props.showToast("复制失败：" + e);
  }
}

// ------- 密码类脱敏：分类命中敏感词时正文默认打码，眼睛按钮临时查看，复制始终是真内容 -------
const SECRET_CAT = /密码|口令|密钥|秘钥|token|secret|password/i;
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
  s.pinned = !s.pinned;
  s.updatedAt = Date.now();
  await persist();
}

// ------- 图片附件（复用 save_image 机制：文件落盘 images 目录，JSON 只存元数据） -------
const imgCache = ref({}); // name -> dataURL
const previewSrc = ref("");
const removedImages = ref([]); // 编辑时移除的旧图，保存后才删文件

function mimeOf(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
}
async function loadImages() {
  for (const s of snippets.value) {
    for (const img of s.images || []) {
      if (imgCache.value[img.name] !== undefined) continue;
      try {
        const b64 = await invoke("load_image", { name: img.name });
        imgCache.value[img.name] = `data:${mimeOf(img.name)};base64,${b64}`;
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
    if (!added) props.showToast("剪贴板里没有图片");
  } catch (err) {
    props.showToast("读取剪贴板失败：" + err);
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
    for (const it of imgs) {
      const blob = it.getAsFile();
      if (blob) await addFormImage(blob, it.type);
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

// AI 识图字段定义
const AI_FIELDS = [
  { key: "title", label: "标题", desc: "这条速记的简短名称/用途" },
  { key: "category", label: "分类", desc: "如：命令 / SQL / 账号 / 链接 / Token 等，无法判断则留空" },
  { key: "content", label: "内容", desc: "需要保存、方便复制的正文（如命令、SQL、链接、一段文本）", multiline: true },
];
async function createSnippetsFromAI(list) {
  const rows = Array.isArray(list) ? list : [list];
  const now = Date.now();
  let added = 0;
  // 倒序 unshift 以保持图中原顺序
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const content = (r.content || "").trim();
    if (!content) continue;
    snippets.value.unshift({
      id: crypto.randomUUID(),
      title: (r.title || "").trim(),
      category: (r.category || "").trim(),
      content: r.content,
      fields: [],
      images: [],
      pinned: false,
      createdAt: now,
      updatedAt: now,
    });
    added++;
  }
  await persist();
  props.showToast(added ? `已新增 ${added} 条速记` : "没有可录入的内容");
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
  if (!f.content.trim() && !f.images.length) return props.showToast("请填写内容或添加字段/图片");
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
    return props.showToast("保存图片失败：" + e);
  }
  const existing = f.id ? snippets.value.find((s) => s.id === f.id) : null;
  if (existing) {
    Object.assign(existing, {
      title: f.title.trim(),
      category: f.category.trim(),
      content: f.content,
      fields: f.fields,
      images: metas,
      updatedAt: now,
    });
  } else {
    snippets.value.unshift({
      id: crypto.randomUUID(),
      title: f.title.trim(),
      category: f.category.trim(),
      content: f.content,
      fields: f.fields,
      images: metas,
      pinned: false,
      createdAt: now,
      updatedAt: now,
    });
  }
  await persist();
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
  const ok = await askConfirm({ title: "删除速记", message: `速记「${s.title || "无标题"}」将被删除，5 秒内可撤销。`, okText: "删除" });
  if (!ok) return;
  const idx = snippets.value.findIndex((x) => x.id === s.id);
  snippets.value = snippets.value.filter((x) => x.id !== s.id);
  await persist();
  props.showToast("已删除速记", {
    actionLabel: "撤销",
    onAction: async () => {
      snippets.value.splice(Math.min(Math.max(idx, 0), snippets.value.length), 0, s);
      await persist();
      props.showToast("已恢复");
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
      <h3 class="section-title">速记 · {{ snippets.length }}</h3>
      <div class="filters">
        <button class="chip" :class="{ active: cat === 'all' }" @click="cat = 'all'">全部</button>
        <button v-for="c in categories" :key="c" class="chip" :class="{ active: cat === c }" @click="cat = c">{{ c }}</button>
      </div>
      <div class="search-mini">
        <Icon name="search" :size="15" class="s-icon" />
        <input v-model="search" placeholder="搜索标题 / 内容 / 分类..." />
      </div>
    </div>
    <div class="tb-right">
      <button class="btn-primary sm" @click="openCreate"><Icon name="plus" :size="15" /> 新建速记</button>
            <AiExtract :fields="AI_FIELDS" :multiple="true" hint="这是一张包含命令/SQL/表格/配置/文本的截图，可能有多条，请把每一条可保存为速记的条目提取为一条记录（标题、分类与内容）。" title="AI 识图录入速记" :show-toast="showToast" @apply="createSnippetsFromAI" />
    </div>
  </div>

  <main class="content">
    <div v-if="filteredList.length" class="snip-grid">
      <div
        v-for="(s, i) in filteredList"
        :key="s.id"
        :id="'snip-' + s.id"
        class="snip-card"
        :class="{ pinned: s.pinned, hi: jumpHi === s.id }"
        :style="{ animationDelay: i * 0.04 + 's' }"
      >
        <div class="snip-head">
          <span v-if="s.category" class="snip-cat">{{ s.category }}</span>
          <h4 class="snip-title" :title="s.title || '无标题'">{{ s.title || "无标题" }}</h4>
          <div class="snip-ops">
            <button
              v-if="isSecret(s) && s.content"
              class="op"
              :class="{ on: revealed[s.id] }"
              :title="revealed[s.id] ? '隐藏内容' : '查看内容'"
              @click="revealed[s.id] = !revealed[s.id]"
            >
              <Icon :name="revealed[s.id] ? 'eye-off' : 'eye'" :size="14" />
            </button>
            <button class="op" :class="{ on: s.pinned }" :title="s.pinned ? '取消置顶' : '置顶'" @click="togglePin(s)"><Icon name="target" :size="14" /></button>
            <button class="op" title="编辑" @click="openEdit(s)"><Icon name="edit" :size="14" /></button>
            <button class="op del" title="删除" @click="removeSnippet(s)"><Icon name="trash" :size="14" /></button>
          </div>
        </div>
        <pre v-if="s.content && !hasFields(s)" class="snip-content" :class="{ masked: isSecret(s) && !revealed[s.id] }" title="点击复制" @click="copy(s)">{{ isSecret(s) && !revealed[s.id] ? maskOf() : s.content }}</pre>
        <div v-else-if="hasFields(s)" class="snip-fields" :class="{ masked: isSecret(s) && !revealed[s.id] }">
          <div v-for="f in s.fields" :key="f.id" class="snip-field" :title="f.label ? `${f.label}：点击行复制` : '点击复制'" @click="copyField(f, s)">
            <span v-if="f.label" class="snip-field-label">{{ f.label }}</span>
            <span class="snip-field-val">{{ isSecret(s) && !revealed[s.id] ? maskOf() : fieldValue(f) || "-" }}</span>
            <button class="snip-field-copy" :class="{ done: copiedId === s.id + ':' + f.id }" :title="`复制${f.label || '该字段'}`" @click.stop="copyField(f, s)"><Icon :name="copiedId === s.id + ':' + f.id ? 'check' : 'copy'" :size="12" /></button>
          </div>
        </div>
        <div v-if="(s.images || []).length" class="snip-imgs">
          <div v-for="img in s.images" :key="img.id" class="snip-img-cell">
            <img v-if="imgCache[img.name]" :src="imgCache[img.name]" title="点击放大" @click="previewSrc = imgCache[img.name]" />
            <span v-else class="snip-img-miss"><Icon name="image" :size="16" /></span>
          </div>
        </div>
        <div class="snip-foot">
          <span class="snip-time">{{ fmtTime(s.updatedAt) }}</span>
          <button class="copy-btn" :class="{ done: copiedId === s.id }" @click="copy(s)"><Icon :name="copiedId === s.id ? 'check' : 'copy'" :size="14" /> {{ hasFields(s) ? "复制全部" : "复制" }}</button>
        </div>
      </div>
    </div>

    <div v-else class="empty">
          <span class="empty-ico"><Icon name="copy" :size="32" /></span>
      <h2>还没有速记</h2>
      <p>把常用的命令、token、SQL、账号、链接等存在这里，随时一键复制，不用再翻聊天记录。</p>
      <button class="btn-outline lg" @click="openCreate"><Icon name="plus" :size="16" /> 新建第一条速记</button>
    </div>
  </main>

  <!-- 新建 / 编辑弹窗 -->
  <div v-if="showForm" class="modal-mask">
    <div class="modal">
      <h2>{{ form.id ? "编辑速记" : "新建速记" }}</h2>

      <div class="row2">
        <label class="field">
          <span>标题</span>
          <input v-model="form.title" placeholder="例如：测试环境数据库连接" />
        </label>
        <label class="field">
          <span>分类（可选）</span>
          <input v-model="form.category" placeholder="例如：命令 / SQL / 账号" list="snip-cats" />
          <datalist id="snip-cats">
            <option v-for="c in categories" :key="c" :value="c" />
          </datalist>
        </label>
      </div>

      <label class="field">
        <span>内容<span v-if="form.fields.length" class="field-hint">（已有字段，保存时自动按「标签: 值」生成，无需手填）</span></span>
        <textarea v-model="form.content" rows="6" placeholder="要随时复制的内容，支持多行；纯图速记可留空" class="mono"></textarea>
      </label>

      <div class="field">
        <span>字段（可选，账号/密码等多条信息，每条可单独复制）</span>
        <div class="field-rows">
          <div v-for="f in form.fields" :key="f.id" class="field-row">
            <input v-model="f.label" placeholder="标签（如：账号）" class="field-row-label" />
            <input v-model="f.value" placeholder="值" class="field-row-val mono" />
            <button class="op del" type="button" title="删除该字段" @click="removeFormField(f)"><Icon name="x" :size="12" /></button>
          </div>
        </div>
        <button class="btn-ghost sm" type="button" @click="addFormField"><Icon name="plus" :size="13" /> 添加字段</button>
      </div>

      <div class="field">
        <span>图片（可选，弹窗内可直接 Ctrl+V 贴图）</span>
        <div class="form-imgs">
          <div v-for="img in form.images" :key="img.id" class="form-img-cell">
            <img v-if="formImgSrc(img)" :src="formImgSrc(img)" title="点击放大" @click="previewSrc = formImgSrc(img)" />
            <span v-else class="snip-img-miss"><Icon name="image" :size="16" /></span>
            <button class="form-img-del" title="移除" @click="removeFormImage(img)"><Icon name="x" :size="10" /></button>
          </div>
          <label class="form-img-add">
            <Icon name="plus" :size="13" /> 选图
            <input type="file" accept="image/*" multiple hidden @change="onPickFormImages" />
          </label>
          <button class="form-img-add" type="button" @click="pasteFormImages"><Icon name="copy" :size="12" /> 粘贴</button>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn-ghost" @click="showForm = false">取消</button>
        <button class="btn-primary" @click="saveForm">保存</button>
      </div>
    </div>
  </div>

  <!-- 图片放大预览 -->
  <div v-if="previewSrc" class="img-preview" @click="previewSrc = ''">
    <img :src="previewSrc" />
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 28px; flex-wrap: wrap; }
.tb-left { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.section-title { margin: 0; font-size: var(--fs-lg); font-weight: 700; }
.filters { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { display: inline-flex; align-items: center; gap: 6px; background: var(--card); border: 1px solid var(--border-strong); padding: 8px 13px; border-radius: var(--r-sm); font-size: var(--fs-md); font-weight: 600; cursor: pointer; color: var(--text-soft); transition: all 0.15s; }
.chip:hover { border-color: var(--border-steel); }
.chip.active { background: var(--accent-hover); color: var(--text-invert); border-color: var(--accent-hover); }
.tb-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.search-mini { position: relative; display: flex; align-items: center; }
.search-mini .s-icon { position: absolute; left: 10px; color: var(--muted); pointer-events: none; }
.search-mini input { padding: 7px 12px 7px 30px; border: 1px solid transparent; border-radius: var(--r-sm); font-size: var(--fs-md); background: color-mix(in srgb, var(--text-weak) 9%, transparent); color: var(--text); outline: none; width: 190px; transition: background 0.15s, border-color 0.15s; }
.search-mini input:focus { background: var(--card); border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }

.content { flex: 1; padding: 18px 28px 36px; }
.snip-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; }
.snip-card { position: relative; display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: 16px 16px 14px; box-shadow: var(--shadow); overflow: hidden; opacity: 0; transform: translateY(14px); animation: snipIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards; transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.25s, border-color 0.25s; }
@keyframes snipIn { to { opacity: 1; transform: none; } }
.snip-card:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--primary) 40%, var(--card)); box-shadow: 0 16px 40px color-mix(in srgb, var(--primary) 16%, transparent); }
.snip-card.pinned { border-color: color-mix(in srgb, var(--amber) 40%, var(--card)); }
.snip-card.pinned::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, var(--amber-bright), var(--amber-light)); }
.snip-card.hi { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft), 0 16px 40px color-mix(in srgb, var(--primary) 22%, transparent); }

.snip-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.snip-cat { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 600; color: var(--primary); background: var(--primary-soft); padding: 2px 9px; border-radius: var(--r-pill); }
.snip-title { flex: 1; min-width: 0; margin: 0; font-size: var(--fs-base); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.snip-ops { display: flex; gap: 5px; opacity: 0; transform: translateY(-3px); transition: opacity 0.15s, transform 0.15s; flex-shrink: 0; }
.snip-card:hover .snip-ops { opacity: 1; transform: none; }
.op { width: 28px; height: 28px; padding: 0; display: grid; place-items: center; border: 1px solid var(--card-border); background: var(--card); border-radius: var(--r-sm); color: var(--muted); cursor: pointer; transition: all 0.15s; }
.op:hover { color: var(--primary); border-color: var(--primary); background: var(--primary-soft); }
.op.on { color: var(--amber); border-color: var(--amber-border); background: var(--amber-soft); }
.op.del:hover { color: var(--danger-deep); border-color: var(--border-danger); background: var(--danger-soft); }

.snip-content { flex: 1; margin: 0 0 12px; font-family: var(--font-mono); font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--text-code); background: color-mix(in srgb, var(--text) 4%, transparent); border: 1px solid var(--card-border); border-radius: var(--r-sm); padding: 10px 12px; max-height: 132px; overflow: auto; white-space: pre-wrap; word-break: break-word; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
.snip-content:hover { background: var(--primary-soft); border-color: var(--border-blue); }
/* 密码类打码态：加大字距更像密码框，点击仍复制真内容 */
.snip-content.masked { letter-spacing: 3px; color: var(--muted); user-select: none; }

/* 字段模式：标签+值多行展示，每行可单独复制 */
.snip-fields { flex: 1; margin: 0 0 12px; font-size: var(--fs-sm); line-height: var(--lh-body); background: color-mix(in srgb, var(--text) 4%, transparent); border: 1px solid var(--card-border); border-radius: var(--r-sm); padding: 4px 10px; max-height: 132px; overflow: auto; }
.snip-field { display: flex; align-items: center; gap: 10px; padding: 5px 2px; border-bottom: 1px dashed var(--border); border-radius: var(--r-xs); cursor: pointer; transition: background 0.15s; }
.snip-field:last-child { border-bottom: none; }
.snip-field:hover { background: var(--primary-soft); }
.snip-field-label { flex-shrink: 0; max-width: 96px; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.snip-field-val { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-code); white-space: pre-wrap; word-break: break-all; }
.snip-field-copy { width: 22px; height: 22px; flex-shrink: 0; padding: 0; display: grid; place-items: center; border: 1px solid var(--card-border); background: var(--card); border-radius: var(--r-xs); color: var(--muted); cursor: pointer; transition: all 0.15s; }
.snip-field-copy:hover { color: var(--primary); border-color: var(--primary); background: var(--primary-soft); }
.snip-fields.masked .snip-field-val { letter-spacing: 3px; color: var(--muted); user-select: none; }

.snip-imgs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
.snip-img-cell { width: 64px; height: 64px; border-radius: var(--r-sm); overflow: hidden; border: 1px solid var(--card-border); background: var(--ghost); }
.snip-img-cell img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; display: block; }
.snip-img-miss { width: 100%; height: 100%; display: grid; place-items: center; color: var(--muted); }

.form-imgs { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.form-img-cell { position: relative; width: 72px; height: 72px; border-radius: var(--r-sm); overflow: hidden; border: 1px solid var(--border-strong); background: var(--ghost); }
.form-img-cell img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; display: block; }
.form-img-del { position: absolute; top: 3px; right: 3px; width: 17px; height: 17px; border: none; border-radius: var(--r-pill); background: rgba(10, 12, 16, 0.55); color: var(--text-invert); display: grid; place-items: center; cursor: pointer; padding: 0; }
.form-img-del:hover { background: var(--danger); }
.form-img-add { display: inline-flex; align-items: center; gap: 4px; padding: 8px 12px; border: 1px dashed var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-sm); color: var(--muted); background: none; cursor: pointer; font-family: inherit; }
.form-img-add:hover { color: var(--primary); border-color: var(--primary); }

.img-preview { position: fixed; inset: 0; z-index: 200; background: rgba(10, 12, 16, 0.82); display: grid; place-items: center; cursor: zoom-out; padding: 32px; }
.img-preview img { max-width: 100%; max-height: 100%; border-radius: var(--r-sm); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); }

.snip-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.snip-time { font-size: var(--fs-xs); color: var(--muted); }
.copy-btn { display: inline-flex; align-items: center; gap: 5px; background: var(--primary); color: var(--text-invert); border: none; padding: 6px 12px; border-radius: var(--r-sm); font-size: var(--fs-sm); font-weight: 600; cursor: pointer; transition: background 0.15s; }
.copy-btn:hover { background: var(--primary-hover); }
.copy-btn:active { transform: translateY(1px); }
/* 复制成功反馈：按钮短暂变绿 + check 图标 */
.copy-btn.done { background: var(--success-deep); }
.snip-field-copy.done { color: var(--success-deep); border-color: var(--success); background: var(--success-tint); }

.empty { text-align: center; padding: 56px 20px; }
.empty-ico { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 50%; background: var(--primary-soft); color: var(--primary); margin-bottom: 6px; }
.empty h2 { font-size: var(--fs-xl); margin: 8px 0 6px; font-weight: 700; }
.empty p { color: var(--muted); font-size: var(--fs-base); margin: 0 0 22px; max-width: 460px; margin-left: auto; margin-right: auto; }

.row2 { display: flex; gap: 12px; }
.row2 .field { flex: 1; }
.field { display: block; margin-bottom: 16px; }
.field > span { display: block; font-size: var(--fs-md); color: var(--muted); margin-bottom: 7px; font-weight: 600; }
.field input, .field textarea { width: 100%; padding: 10px 13px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-base); font-family: inherit; outline: none; resize: vertical; background: var(--card); color: var(--text); }
.field input:focus, .field textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.field textarea.mono { font-family: var(--font-mono); font-size: var(--fs-md); line-height: var(--lh-body); }

/* 字段编辑器（标签+值多行） */
.field-hint { font-size: var(--fs-xs); color: var(--muted); font-weight: 400; margin-left: 6px; }
.field-rows { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.field-row { display: flex; gap: 8px; align-items: center; }
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
</style>
