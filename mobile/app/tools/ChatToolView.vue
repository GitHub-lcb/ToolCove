<script setup>
// AI 对话（手机端）：多会话 + 流式回复（可停止）+ 提示词预设 + Markdown 渲染。
//
// 与桌面端共用同一份纯逻辑 src/chatSession.js（会话创建、标题、裁剪、上下文构建），
// 所以"会话怎么切分、上下文保留几轮"这些规则两端一致，不会各写一套。
//
// 手机端**不做 Agent 任务模式**：那已经是「Agent」标签的完整工作台（确认卡、时间线、技能库），
// 在这里再放一个入口只会让人分不清该用哪个。桌面的 chat 工具有两个模式，是因为它没有独立工作台。
import { computed, nextTick, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { DEFAULT_PRESETS, buildContextMessages, createSession, deleteSession, renameSession, sessionTitle, trimMessages } from "../../../src/chatSession.js";
import { aiChatStream, isAIConfigured } from "../../../src/ai.js";
import { loadToolbox, saveToolbox } from "../../../src/toolboxStore.js";
import { renderMarkdown } from "../../../src/shared.js";

const { t } = useI18n();

const MAX_MESSAGES = 100;

const sessions = ref([]);
const presets = ref([]);
const activeId = ref("");
const input = ref("");
const sending = ref(false);
const streamText = ref("");
const error = ref("");
const notice = ref("");
const scroller = ref(null);
const showPresets = ref(false);
let stopHandle = null;

const active = computed(() => sessions.value.find((s) => s.id === activeId.value) || null);
const messages = computed(() => active.value?.messages || []);
const canSend = computed(() => input.value.trim().length > 0 && !sending.value);

const allPresets = computed(() => [
  // DEFAULT_PRESETS 只有 nameKey/contentKey（文案在字典里），不是现成文本——
  // 直接读 preset.content 会得到 undefined（踩过一次）
  ...DEFAULT_PRESETS.map((preset) => ({ id: preset.id, name: t(`toolbox.ai.${preset.nameKey}`), content: t(preset.contentKey) })),
  ...presets.value,
]);

/** 消息正文：兼容字符串与 content 块数组（视觉模型的图片消息用后者）。 */
function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
  }
  return "";
}

/** Markdown 渲染（与桌面端同一入口，先 escapeHtml 再套标记）。 */
const html = (text) => renderMarkdown(text, { highlight: false });

async function persist() {
  await saveToolbox("chat", { sessions: sessions.value }).catch(() => {});
}

onMounted(async () => {
  const [chatData, presetData] = await Promise.all([loadToolbox("chat", { sessions: [] }), loadToolbox("chatPresets", [])]);
  sessions.value = Array.isArray(chatData?.sessions) ? chatData.sessions : [];
  presets.value = Array.isArray(presetData) ? presetData : [];
  activeId.value = sessions.value[0]?.id || "";
});

function newSession() {
  const session = createSession("");
  sessions.value = [session, ...sessions.value];
  activeId.value = session.id;
  persist();
}

function removeSession(id) {
  sessions.value = deleteSession(sessions.value, id);
  if (activeId.value === id) activeId.value = sessions.value[0]?.id || "";
  persist();
}

function rename(id) {
  const session = sessions.value.find((s) => s.id === id);
  if (!session) return;
  const next = prompt(t("toolbox.ai.rename"), session.title || "");
  if (next == null) return;
  const updated = renameSession(session, next);
  sessions.value = sessions.value.map((s) => (s.id === id ? updated : s));
  persist();
}

async function scrollToEnd() {
  await nextTick();
  const node = scroller.value;
  if (node) node.scrollTop = node.scrollHeight;
}

async function send() {
  if (!canSend.value) return;
  error.value = "";
  notice.value = "";
  if (!(await isAIConfigured().catch(() => false))) {
    error.value = t("toolbox.ai.aiNotConfigured");
    return;
  }
  let session = active.value;
  if (!session) {
    session = createSession("");
    sessions.value = [session, ...sessions.value];
    activeId.value = session.id;
  }

  const text = input.value.trim();
  session.messages.push({ id: crypto.randomUUID(), role: "user", content: text, images: [], ts: Date.now() });
  const assistant = { id: crypto.randomUUID(), role: "assistant", content: "", images: [], ts: Date.now() };
  session.messages.push(assistant);
  session.messages = trimMessages(session.messages, MAX_MESSAGES);
  session.title = sessionTitle(session.messages);
  session.updatedAt = Date.now();
  input.value = "";
  sending.value = true;
  streamText.value = "";
  await scrollToEnd();

  // 上下文按桌面端同一规则构建（保留最近 N 轮 + system）
  const context = buildContextMessages(session.messages.slice(0, -1));
  // aiChatStream 返回的是 { stop }，且 onDone **不传参**（内容靠 onDelta 累积）——
  // 这两点都按真实契约来（踩过一次：写成 onDone(full) 会拿到 undefined）
  const handle = aiChatStream(context, {}, {
    onDelta: (delta) => {
      streamText.value += delta;
      // 节流渲染：每个 delta 都触发 Markdown 重排会在长回复时明显卡顿
      if (streamText.value.length % 40 === 0) {
        assistant.content = streamText.value;
        scrollToEnd();
      }
    },
    onDone: () => {
      assistant.content = streamText.value;
      sending.value = false;
      streamText.value = "";
      stopHandle = null;
      persist();
      scrollToEnd();
    },
    onError: (e) => {
      // 失败也把已收到的部分留下——用户可能已经看到了有用内容
      assistant.content = streamText.value;
      error.value = t("toolbox.ai.chatFail", { error: e?.message || String(e) });
      sending.value = false;
      streamText.value = "";
      stopHandle = null;
      persist();
    },
  });
  stopHandle = handle?.stop || null;
}

function stop() {
  // 停止后保留已收到的内容：直接丢弃会让用户白等一场
  stopHandle?.();
  const session = active.value;
  const last = session?.messages?.[session.messages.length - 1];
  if (last?.role === "assistant" && !last.content) last.content = streamText.value;
  sending.value = false;
  stopHandle = null;
  streamText.value = "";
  persist();
  notice.value = t("mobile.chatStopped");
}

function usePreset(preset) {
  // 预设的正文是"系统提示词"，不是直接发出去的消息——按桌面端口径填进输入框让人可改
  input.value = preset.content || input.value;
  showPresets.value = false;
}

/** 流式期间显示的部分文本优先于已落盘内容。 */
const shownContent = (message) =>
  sending.value && message === messages.value[messages.value.length - 1] && message.role === "assistant" && streamText.value
    ? streamText.value
    : textOf(message);
</script>

<template>
  <section class="m-tool" data-tool="chat">
    <!-- 会话栏：手机上用横向 chips，比侧栏省地方 -->
    <div class="m-chips" data-role="sessions">
      <button class="m-chip" :class="{ on: !activeId }" data-role="new-session" @click="newSession">＋ {{ t("toolbox.ai.newChat") }}</button>
      <button
        v-for="session in sessions"
        :key="session.id"
        class="m-chip"
        :class="{ on: session.id === activeId }"
        :data-session="session.id"
        @click="activeId = session.id"
      >
        {{ session.title || t("toolbox.ai.noSession") }}
      </button>
    </div>

    <div v-if="active" class="m-actions">
      <button class="m-btn" data-role="rename" @click="rename(active.id)">{{ t("toolbox.ai.rename") }}</button>
      <button class="m-btn danger" data-role="delete-session" @click="removeSession(active.id)">{{ t("toolbox.ai.delete") }}</button>
      <button class="m-btn" data-role="toggle-presets" @click="showPresets = !showPresets">{{ t("toolbox.ai.managePresets") }}</button>
    </div>

    <div v-if="showPresets" class="m-chips" data-role="presets">
      <button v-for="preset in allPresets" :key="preset.id" class="m-chip" :data-preset="preset.id" @click="usePreset(preset)">
        {{ preset.name }}
      </button>
    </div>

    <!-- 消息区 -->
    <div ref="scroller" class="m-chat" data-role="messages">
      <p v-if="!active || !messages.length" class="m-hint-sm" data-role="empty">{{ t("toolbox.ai.msgsEmpty") }}</p>
      <article v-for="message in messages" :key="message.id" class="m-msg" :data-role="message.role">
        <span class="m-msg-role">{{ message.role === "user" ? "我" : "AI" }}</span>
        <!-- eslint-disable-next-line vue/no-v-html -- 唯一渲染入口是 shared.renderMarkdown（先 escapeHtml 再套行内标记） -->
        <div v-if="message.role === 'assistant'" class="m-md" v-html="html(shownContent(message))"></div>
        <p v-else class="m-msg-text">{{ shownContent(message) }}</p>
      </article>
    </div>

    <label class="m-field">
      <span>{{ t("toolbox.ai.newChat") }}</span>
      <textarea v-model="input" rows="3" :placeholder="t('toolbox.ai.inputPh', { defaultValue: '输入消息…' })" data-role="input"></textarea>
    </label>
    <div class="m-actions">
      <button class="m-btn primary" :disabled="!canSend" data-role="send" @click="send">{{ sending ? t("common.loading") : t("toolbox.ai.send") }}</button>
      <button v-if="sending" class="m-btn danger" data-role="stop" @click="stop">{{ t("toolbox.ai.stop") }}</button>
    </div>

    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>
    <p v-if="notice" class="m-ok" data-role="notice">{{ notice }}</p>
    <p class="m-hint-sm">{{ t("mobile.chatLocalNote") }}</p>
  </section>
</template>
