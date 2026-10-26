<script setup>
import { watch } from "vue";
import Icon from "./Icon.vue";
import { confirmState, settleConfirm } from "./confirm.js";
import { vDialog } from './dialog.js'; // 模板里的 v-dialog 由 <script setup> 就地解析（SSR 渲染测试也能用）

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
    <div v-if="confirmState.open" class="modal-mask cf-mask" @click.self="settleConfirm(false)">
      <div class="cf-box" v-dialog>
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
/* 底座（fixed/inset/遮罩色/居中/内边距）走全局 .modal-mask；这里只留两处真差异：
   确认弹窗永远压过普通弹窗，以及那层毛玻璃模糊 */
.cf-mask { z-index: var(--z-confirm); backdrop-filter: blur(3px); }
.cf-box { width: 380px; max-width: calc(100vw - 48px); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: var(--sp-7); box-shadow: var(--shadow-pop); text-align: center; }
.cf-icon { display: inline-grid; place-items: center; width: 46px; height: 46px; border-radius: var(--r-md); background: var(--primary-soft); color: var(--primary); margin-bottom: var(--sp-4); }
.cf-icon.danger { background: var(--danger-soft); color: var(--danger-deep); }
.cf-title { margin: 0 0 var(--sp-1); font-size: var(--fs-lg); font-weight: 700; }
.cf-msg { margin: 0; font-size: var(--fs-md); color: var(--muted); line-height: var(--lh-body); word-break: break-word; }
.cf-foot { display: flex; gap: var(--sp-3); margin-top: var(--sp-7); }
.cf-btn { flex: 1; padding: var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-md); font-weight: 600; cursor: pointer; transition: all 0.15s; }
.cf-btn:active { transform: translateY(1px); }
.cf-btn.ghost { background: var(--ghost); color: var(--text); border: 1px solid var(--border-strong); }
.cf-btn.ghost:hover { background: var(--well-hover); }
.cf-btn.ok { background: var(--primary); color: var(--text-invert); border: none; }
.cf-btn.ok:hover { background: var(--primary-hover); }
.cf-btn.ok.danger { background: var(--danger-deep); }
.cf-btn.ok.danger:hover { background: var(--danger); }

.cf-fade-enter-active, .cf-fade-leave-active { transition: opacity var(--dur-base) var(--ease-out); }
.cf-fade-enter-active .cf-box { animation: cfPop var(--dur-base) var(--ease-out); }
.cf-fade-enter-from, .cf-fade-leave-to { opacity: 0; }
@keyframes cfPop {
  from { transform: scale(0.94); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

</style>
