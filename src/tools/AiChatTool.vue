<script setup>
// AI 对话工具：多会话管理 + 流式对话（可停止）+ 图片输入 + 提示词预设 + Markdown 渲染。
// 会话与预设持久化走 toolboxStore（chat / chatPresets）；图片走 save_image/load_image（JSON 只存文件名）。
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import Icon from "../Icon.vue";
import MarkdownRender from "./MarkdownRender.vue";
import { aiChatStream, isAIConfigured } from "../ai.js";
import { loadToolbox, saveToolbox, flushToolbox } from "../toolboxStore.js";
import {
  DEFAULT_PRESETS,
  createSession,
  sessionTitle,
  deleteSession,
  trimMessages,
  buildContextMessages,
} from "../chatSession.js";
import { askConfirm } from "../confirm.js";
import { invoke } from "@tauri-apps/api/core";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const MAX_MESSAGES = 100; // 每会话消息上限
const MAX_ROUNDS = 10; // 上下文保留轮数
const RENDER_THROTTLE = 150; // 流式渲染节流 ms
const IMG_MAX = 4; // 单条消息最多图片

const sessions = ref([]);
const activeId = ref("");
const presets = ref([]);
const input = ref("");
const images = ref([]); // 待发送图片 [{ url }]
const imgCache = new Map(); // 已落盘图片 name -> data URL
const sending = ref(false);
const currentAssistant = ref(null); // 正在流式生成的助手消息
const streamText = ref(""); // 流式完整文本
const streamShown = ref(""); // 节流后的渲染文本
let streamStop = null; // 停止句柄
let renderTimer = null;
const msgsRef = ref(null);

const active = computed(() => sessions.value.find((s) => s.id === activeId.value) || null);
const sortedSessions = computed(() => [...sessions.value].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
const allPresets = computed(() => [...DEFAULT_PRESETS, ...presets.value]);
const activePreset = computed(() => allPresets.value.find((p) => p.id === active.value?.presetId) || DEFAULT_PRESETS[0]);
const canSend = computed(() => (input.value.trim() || images.value.length > 0) && !sending.value);

// ---------- 持久化 ----------
function persist() {
  saveToolbox("chat", { sessions: sessions.value });
}
function touch(session) {
  session.updatedAt = Date.now();
  persist();
}

// ---------- 生命周期 ----------
onMounted(async () => {
  const [chatData, presetData] = await Promise.all([
    loadToolbox("chat", { sessions: [] }),
    loadToolbox("chatPresets", []),
  ]);
  sessions.value = Array.isArray(chatData?.sessions) ? chatData.sessions : [];
  presets.value = Array.isArray(presetData) ? presetData : [];
  if (sessions.value.length) {
    activeId.value = sessions.value[0].id;
    await loadSessionImages(sessions.value[0]);
  }
});
onBeforeUnmount(() => {
  stopSend();
  flushToolbox();
});

// ---------- 会话管理 ----------
function newChat() {
  stopSend();
  const s = createSession(activePreset.value.id);
  sessions.value.unshift(s);
  activeId.value = s.id;
  persist();
  input.value = "";
  images.value = [];
}
async function switchTo(s) {
  if (s.id === activeId.value) return;
  stopSend();
  activeId.value = s.id;
  await loadSessionImages(s);
}
async function removeSession(s) {
  if (!(await askConfirm({ title: "删除会话", message: `确定删除「${s.title}」？对话记录将不可恢复。` }))) return;
  const others = sessions.value.filter((x) => x.id !== s.id);
  // 清理孤儿图片：仅当没有其他会话引用时才删（复用 delete_image，SnippetView 同款先例）
  const referenced = new Set();
  for (const o of others) {
    for (const m of o.messages) {
      for (const img of m.images || []) referenced.add(img.name);
    }
  }
  for (const m of s.messages) {
    for (const img of m.images || []) {
      if (!referenced.has(img.name)) invoke("delete_image", { name: img.name }).catch(() => {});
      imgCache.delete(img.name);
    }
  }
  sessions.value = deleteSession(sessions.value, s.id);
  if (activeId.value === s.id) activeId.value = sessions.value[0]?.id || "";
  persist();
}
const renameId = ref("");
const renameText = ref("");
function startRename(s) {
  renameId.value = s.id;
  renameText.value = s.title;
}
function commitRename(s) {
  if (renameId.value !== s.id) return;
  s.title = renameText.value.trim() || sessionTitle(s.messages);
  renameId.value = "";
  touch(s);
}

// ---------- 图片 ----------
function mimeOf(name) {
  const ext = String(name || "").split(".").pop()?.toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
}
async function loadSessionImages(s) {
  for (const m of s.messages) {
    for (const img of m.images || []) {
      if (imgCache.has(img.name)) continue;
      try {
        const b64 = await invoke("load_image", { name: img.name });
        imgCache.set(img.name, `data:${mimeOf(img.name)};base64,${b64}`);
      } catch {
        imgCache.set(img.name, "");
      }
    }
  }
}
function addImages(e) {
  const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith("image/"));
  e.target.value = "";
  if (!files.length) return props.showToast("请选择图片文件");
  const remain = IMG_MAX - images.value.length;
  if (remain <= 0) return props.showToast(`最多附带 ${IMG_MAX} 张图片`);
  const pick = files.slice(0, remain);
  if (pick.length < files.length) props.showToast(`最多附带 ${IMG_MAX} 张图片，已截取前 ${pick.length} 张`);
  for (const f of pick) {
    const r = new FileReader();
    r.onload = () => images.value.push({ url: String(r.result || "") });
    r.onerror = () => props.showToast("读取图片失败：" + f.name);
    r.readAsDataURL(f);
  }
}
function removeImage(i) {
  images.value.splice(i, 1);
}
function blobToB64(dataUrl) {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

// ---------- 发送 / 流式 ----------
async function send() {
  if (!canSend.value) return;
  if (!(await isAIConfigured())) return props.showToast("请先在右上角设置中配置 AI 模型");
  let session = active.value;
  if (!session) {
    session = createSession(activePreset.value.id);
    sessions.value.unshift(session);
    activeId.value = session.id;
  }
  // 1. 待发送图片落盘（文件名入消息，data URL 留在内存缓存）
  const savedImgs = [];
  const contentBlocks = [];
  for (const img of images.value) {
    try {
      const name = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`;
      await invoke("save_image", { name, dataB64: blobToB64(img.url) });
      savedImgs.push({ name });
      imgCache.set(name, img.url);
      contentBlocks.push({ type: "image_url", image_url: { url: img.url } });
    } catch {
      props.showToast("图片保存失败，已跳过该图");
    }
  }
  const text = input.value.trim();
  if (text) contentBlocks.unshift({ type: "text", text });
  // 只有纯文本时用字符串，否则用 content 块数组（视觉模型）
  const content = contentBlocks.length === 1 && contentBlocks[0].type === "text" ? text : contentBlocks;

  const userMsg = { id: crypto.randomUUID(), role: "user", content, images: savedImgs, ts: Date.now() };
  session.messages.push(userMsg);
  const assistantMsg = { id: crypto.randomUUID(), role: "assistant", content: "", images: [], ts: Date.now() };
  session.messages.push(assistantMsg);
  session.messages = trimMessages(session.messages, MAX_MESSAGES);
  touch(session);
  input.value = "";
  images.value = [];
  currentAssistant.value = assistantMsg;
  streamText.value = "";
  streamShown.value = "";
  sending.value = true;
  await scrollBottom();

  const context = buildContextMessages(session.messages, activePreset.value.content, MAX_ROUNDS);
  streamStop = aiChatStream(context, {}, {
    onDelta: (d) => {
      streamText.value += d;
      scheduleRender();
    },
    onDone: () => finalizeAssistant(),
    onError: (err) => {
      props.showToast("对话失败：" + (err?.message || err));
      finalizeAssistant();
    },
  });
}
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    streamShown.value = streamText.value;
    scrollBottom();
  }, RENDER_THROTTLE);
}
function stopSend() {
  if (streamStop) {
    try {
      streamStop();
    } catch {
      /* 忽略 */
    }
    streamStop = null;
  }
  if (sending.value) finalizeAssistant();
}
function finalizeAssistant() {
  if (!currentAssistant.value) return;
  const msg = currentAssistant.value;
  msg.content = streamText.value || msg.content;
  msg.ts = Date.now();
  const session = active.value;
  if (session) {
    session.messages = trimMessages(session.messages, MAX_MESSAGES);
    touch(session);
  }
  streamText.value = "";
  streamShown.value = "";
  currentAssistant.value = null;
  sending.value = false;
  streamStop = null;
  scrollBottom();
}
async function scrollBottom() {
  await nextTick();
  const el = msgsRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

// ---------- 提示词预设 ----------
const presetOpen = ref(false);
const presetManage = ref(false);
const presetDraftName = ref("");
const presetDraftContent = ref("");
function setActivePreset(id) {
  const s = active.value;
  if (s) {
    s.presetId = id;
    touch(s);
  }
  presetOpen.value = false;
}
function addPreset() {
  const name = presetDraftName.value.trim();
  const content = presetDraftContent.value.trim();
  if (!name || !content) return props.showToast("请填写模板名称与内容");
  presets.value.push({ id: "p-" + crypto.randomUUID(), name, content });
  saveToolbox("chatPresets", presets.value);
  presetDraftName.value = "";
  presetDraftContent.value = "";
  props.showToast("已添加提示词模板");
}
function removePreset(p) {
  presets.value = presets.value.filter((x) => x.id !== p.id);
  saveToolbox("chatPresets", presets.value);
  for (const s of sessions.value) {
    if (s.presetId === p.id) delete s.presetId;
  }
  persist();
}
</script>

<template>
  <div class="ai-chat">
    <aside class="side">
      <button class="new-btn" @click="newChat"><Icon name="plus" :size="14" />新建对话</button>
      <div class="sess-list">
        <div
          v-for="s in sortedSessions"
          :key="s.id"
          class="sess-item"
          :class="{ active: s.id === activeId }"
          @click="switchTo(s)"
        >
          <input
            v-if="renameId === s.id"
            v-model="renameText"
            class="rename-input"
            @keydown.enter="commitRename(s)"
            @keydown.esc="renameId = ''"
            @blur="commitRename(s)"
          />
          <template v-else>
            <span class="sess-title" :title="s.title">{{ s.title }}</span>
            <span class="sess-ops">
              <button class="op" title="重命名" @click.stop="startRename(s)"><Icon name="edit" :size="13" /></button>
              <button class="op danger" title="删除" @click.stop="removeSession(s)"><Icon name="trash" :size="13" /></button>
            </span>
          </template>
        </div>
        <p v-if="!sortedSessions.length" class="side-empty">还没有会话，点「新建对话」开始</p>
      </div>
      <div class="preset-bar">
        <button class="preset-btn" @click="presetOpen = !presetOpen"><Icon name="sparkles" :size="13" />{{ activePreset.name }}</button>
        <button class="op" title="管理提示词模板" @click="presetManage = true"><Icon name="settings" :size="13" /></button>
      </div>
      <div v-if="presetOpen" class="preset-menu">
        <button
          v-for="p in allPresets"
          :key="p.id"
          class="preset-item"
          :class="{ cur: p.id === (active?.presetId || DEFAULT_PRESETS[0].id) }"
          @click="setActivePreset(p.id)"
        >
          <span class="pi-name">{{ p.name }}</span>
          <span class="pi-desc" :title="p.content">{{ p.content }}</span>
        </button>
      </div>
    </aside>

    <section class="main">
      <div ref="msgsRef" class="msgs">
        <template v-if="active">
          <div v-for="m in active.messages" :key="m.id" class="msg" :class="m.role">
            <div class="bubble">
              <div v-if="m.images && m.images.length" class="msg-imgs">
                <img v-for="img in m.images" :key="img.name" class="msg-img" :src="imgCache.get(img.name) || ''" alt="" />
              </div>
              <div v-if="m.role === 'user' && typeof m.content === 'string' && m.content" class="user-text">{{ m.content }}</div>
              <div v-else-if="m.role === 'user' && Array.isArray(m.content)" class="user-text">
                <template v-for="(c, i) in m.content" :key="i">
                  <span v-if="c.type === 'text'">{{ c.text }}</span>
                </template>
              </div>
              <MarkdownRender
                v-else
                :text="m.id === currentAssistant?.id ? streamShown : m.content"
                :highlight="m.role === 'assistant'"
                :show-toast="props.showToast"
              />
              <span v-if="m.id === currentAssistant?.id" class="caret">▍</span>
            </div>
          </div>
        </template>
        <p v-else class="msgs-empty">输入下方内容开始第一段对话，或先选一个提示词模板</p>
      </div>

      <div class="composer">
        <div v-if="images.length" class="img-row">
          <div v-for="(img, i) in images" :key="i" class="pick-img">
            <img :src="img.url" alt="" />
            <button class="rm" title="移除" @click="removeImage(i)"><Icon name="x" :size="12" /></button>
          </div>
        </div>
        <textarea
          v-model="input"
          class="input"
          rows="3"
          :placeholder="sending ? 'AI 正在回复…' : '输入消息，Enter 发送，Shift+Enter 换行'"
          @keydown.enter.exact.prevent="send"
        ></textarea>
        <div class="actions">
          <label class="act img-btn"><Icon name="image" :size="15" />图片<input type="file" accept="image/*" multiple hidden @change="addImages" /></label>
          <button v-if="sending" class="act stop" @click="stopSend"><Icon name="square" :size="13" />停止</button>
          <button v-else class="act send" :disabled="!canSend" @click="send"><Icon name="send" :size="13" />发送</button>
        </div>
      </div>
    </section>

    <div v-if="presetManage" class="mask" @click.self="presetManage = false">
      <div class="preset-dlg">
        <div class="dlg-head">
          <b>提示词模板</b>
          <button class="x" @click="presetManage = false"><Icon name="x" :size="14" /></button>
        </div>
        <div class="dlg-body">
          <div v-for="p in allPresets" :key="p.id" class="preset-row">
            <b class="pr-name">{{ p.name }}</b>
            <span class="pr-content" :title="p.content">{{ p.content }}</span>
            <button v-if="!DEFAULT_PRESETS.some((d) => d.id === p.id)" class="pr-del" title="删除" @click="removePreset(p)">
              <Icon name="trash" :size="13" />
            </button>
          </div>
          <div class="preset-add">
            <input v-model="presetDraftName" placeholder="模板名称" />
            <input v-model="presetDraftContent" placeholder="模板内容（system 提示词）" />
            <button @click="addPreset"><Icon name="plus" :size="13" />添加</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-chat {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  gap: 14px;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 12px;
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  position: relative;
}
.new-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 0;
  font-weight: 600;
  color: #fff;
  background: var(--primary);
  border: none;
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: background 0.15s;
}
.new-btn:hover {
  background: var(--primary-hover);
}
.sess-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sess-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 7px 8px;
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: background 0.15s;
}
.sess-item:hover {
  background: color-mix(in srgb, var(--text) 4%, transparent);
}
.sess-item.active {
  background: var(--primary-soft);
}
.sess-title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-md);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sess-ops {
  display: none;
  gap: 2px;
}
.sess-item:hover .sess-ops,
.sess-item.active .sess-ops {
  display: inline-flex;
}
.op {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  width: 22px;
  height: 22px;
  color: var(--muted);
  background: transparent;
  border: none;
  border-radius: var(--r-xs);
  cursor: pointer;
}
.op:hover {
  color: var(--primary-hover);
  background: var(--primary-soft);
}
.op.danger:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
.rename-input {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  font-size: var(--fs-md);
  color: var(--text);
  background: var(--well);
  border: 1px solid var(--border-blue);
  border-radius: var(--r-xs);
  outline: none;
}
.side-empty {
  margin: 8px 0;
  font-size: var(--fs-sm);
  color: var(--muted);
  text-align: center;
}
.preset-bar {
  display: flex;
  align-items: center;
  gap: 6px;
}
.preset-btn {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  font-size: var(--fs-sm);
  color: var(--text-soft);
  background: var(--well);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  cursor: pointer;
}
.preset-btn:hover {
  color: var(--primary-hover);
  border-color: var(--border-blue);
}
.preset-menu {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 52px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  background: var(--card);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  box-shadow: var(--shadow);
}
.preset-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 6px 8px;
  background: transparent;
  border: none;
  border-radius: var(--r-xs);
  cursor: pointer;
  text-align: left;
}
.preset-item:hover,
.preset-item.cur {
  background: var(--primary-soft);
}
.pi-name {
  font-size: var(--fs-md);
  font-weight: 600;
}
.pi-desc {
  width: 100%;
  font-size: var(--fs-xs);
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 10px;
}
.msgs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 2px;
}
.msgs-empty {
  margin: auto;
  font-size: var(--fs-sm);
  color: var(--muted);
}
.msg {
  display: flex;
}
.msg.user {
  justify-content: flex-end;
}
.msg.ai {
  justify-content: flex-start;
}
.bubble {
  max-width: 82%;
  padding: 9px 12px;
  border-radius: var(--r-md);
  font-size: var(--fs-md);
  line-height: var(--lh-body);
  word-break: break-word;
}
.msg.user .bubble {
  background: var(--primary);
  color: #fff;
}
.msg.ai .bubble {
  background: var(--card);
  border: 1px solid var(--card-border);
  color: var(--text);
}
.user-text {
  white-space: pre-wrap;
}
.msg-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 4px;
}
.msg-img,
.pick-img img {
  max-width: 160px;
  max-height: 120px;
  border-radius: var(--r-xs);
  object-fit: cover;
}
.caret {
  animation: blink 1s steps(2) infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
}
.img-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.pick-img {
  position: relative;
}
.pick-img .rm {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  padding: 0;
  color: #fff;
  background: var(--danger);
  border: none;
  border-radius: 50%;
  cursor: pointer;
}
.input {
  width: 100%;
  padding: 8px 10px;
  font-family: inherit;
  font-size: var(--fs-md);
  color: var(--text);
  background: var(--well);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  resize: vertical;
  outline: none;
}
.input:focus {
  border-color: var(--border-blue);
}
.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.act {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  font-size: var(--fs-sm);
  border-radius: var(--r-sm);
  cursor: pointer;
}
.img-btn {
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--card-border);
}
.img-btn:hover {
  color: var(--primary-hover);
  border-color: var(--border-blue);
}
.send {
  color: #fff;
  background: var(--primary);
  border: none;
  font-weight: 600;
}
.send:hover:not(:disabled) {
  background: var(--primary-hover);
}
.send:disabled {
  opacity: 0.5;
  cursor: default;
}
.stop {
  color: var(--danger);
  background: var(--danger-soft);
  border: 1px solid transparent;
}
.mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.35);
}
.preset-dlg {
  width: 480px;
  max-width: 90vw;
  padding: 14px;
  background: var(--card);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
}
.dlg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.dlg-head .x {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--muted);
  background: transparent;
  border: none;
  border-radius: var(--r-xs);
  cursor: pointer;
}
.dlg-head .x:hover {
  color: var(--text);
  background: var(--well);
}
.dlg-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 50vh;
  overflow-y: auto;
}
.preset-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--r-xs);
}
.preset-row:hover {
  background: var(--well);
}
.pr-name {
  flex-shrink: 0;
  font-size: var(--fs-md);
}
.pr-content {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pr-del {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  color: var(--muted);
  background: transparent;
  border: none;
  border-radius: var(--r-xs);
  cursor: pointer;
}
.pr-del:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
.preset-add {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--card-border);
}
.preset-add input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  font-size: var(--fs-sm);
  color: var(--text);
  background: var(--well);
  border: 1px solid var(--card-border);
  border-radius: var(--r-xs);
  outline: none;
}
.preset-add input:focus {
  border-color: var(--border-blue);
}
.preset-add button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: #fff;
  background: var(--primary);
  border: none;
  border-radius: var(--r-xs);
  cursor: pointer;
}
.preset-add button:hover {
  background: var(--primary-hover);
}
</style>
