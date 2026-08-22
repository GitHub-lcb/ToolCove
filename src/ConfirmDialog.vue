<script setup>
import { watch } from "vue";
import Icon from "./Icon.vue";
import { confirmState, settleConfirm } from "./confirm.js";

// 打开期间接管 Esc / Enter（捕获阶段，避免与其他窗口级监听冲突）
function onKey(e) {
  if (e.key === "Escape") {
    e.stopPropagation();
    settleConfirm(false);
  } else if (e.key === "Enter") {
    e.preventDefault();
    settleConfirm(true);
  }
}
watch(
  () => confirmState.open,
  (v) => {
    if (v) window.addEventListener("keydown", onKey, true);
    else window.removeEventListener("keydown", onKey, true);
  }
);
</script>

<template>
  <transition name="cf-fade">
    <div v-if="confirmState.open" class="cf-mask" @click.self="settleConfirm(false)">
      <div class="cf-box">
        <span class="cf-icon" :class="{ danger: confirmState.danger }">
          <Icon :name="confirmState.danger ? 'alert' : 'target'" :size="22" />
        </span>
        <h3 class="cf-title">{{ confirmState.title }}</h3>
        <p v-if="confirmState.message" class="cf-msg">{{ confirmState.message }}</p>
        <div class="cf-foot">
          <button class="cf-btn ghost" @click="settleConfirm(false)">{{ confirmState.cancelText }}</button>
          <button class="cf-btn ok" :class="{ danger: confirmState.danger }" @click="settleConfirm(true)">
            {{ confirmState.okText }}
          </button>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.cf-mask { position: fixed; inset: 0; z-index: 300; background: rgba(15, 18, 24, 0.45); backdrop-filter: blur(3px); display: grid; place-items: center; }
.cf-box { width: 380px; max-width: calc(100vw - 48px); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: 24px 24px 20px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25); text-align: center; }
.cf-icon { display: inline-grid; place-items: center; width: 46px; height: 46px; border-radius: var(--r-md); background: var(--primary-soft); color: var(--primary); margin-bottom: 12px; }
.cf-icon.danger { background: var(--danger-soft); color: var(--danger-deep); }
.cf-title { margin: 0 0 6px; font-size: var(--fs-lg); font-weight: 700; }
.cf-msg { margin: 0; font-size: var(--fs-md); color: var(--muted); line-height: var(--lh-body); word-break: break-word; }
.cf-foot { display: flex; gap: 10px; margin-top: 20px; }
.cf-btn { flex: 1; padding: 10px; border-radius: var(--r-sm); font-size: var(--fs-md); font-weight: 600; cursor: pointer; transition: all 0.15s; }
.cf-btn:active { transform: translateY(1px); }
.cf-btn.ghost { background: var(--ghost); color: var(--text); border: 1px solid var(--border-strong); }
.cf-btn.ghost:hover { background: var(--well-hover); }
.cf-btn.ok { background: var(--primary); color: var(--text-invert); border: none; }
.cf-btn.ok:hover { background: var(--primary-hover); }
.cf-btn.ok.danger { background: var(--danger-deep); }
.cf-btn.ok.danger:hover { background: var(--danger); }

.cf-fade-enter-active, .cf-fade-leave-active { transition: opacity 0.15s; }
.cf-fade-enter-active .cf-box { animation: cfPop 0.18s ease; }
.cf-fade-enter-from, .cf-fade-leave-to { opacity: 0; }
@keyframes cfPop {
  from { transform: scale(0.94); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

@media (prefers-color-scheme: dark) {
  .cf-mask { background: rgba(0, 0, 0, 0.55); }
  .cf-icon.danger { background: var(--danger-soft-deep); color: var(--danger-soft-text); }
}
</style>
