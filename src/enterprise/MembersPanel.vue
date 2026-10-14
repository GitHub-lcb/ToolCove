<script setup>
// 成员/席位管理块：抽成独立组件是为了能单独做 SSR 渲染断言——这一块在设置页「管理」段深处，
// 整体渲染看不到它（与 report/WeeklySchedulePanel.vue 同一范式）。
// 刻意保持「哑」：只读 props 并 emit 动作，拉取名册/创建成员/撤销由 SettingsView 负责。
// 样式只用全局基元（.tc-* 与 .btn-*）+ 本组件自己的类：设置页那些 .sect-*/.field 是 scoped 的，
// 跨组件取不到，复用了也只是「看起来没样式」。
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../ui/Icon.vue";

const props = defineProps({
  members: { type: Array, default: () => [] },
  // 当前令牌对应的成员名：用于禁用「撤销自己」（服务端也会拒，这里只是提前拦一下）
  selfName: { type: String, default: "" },
  // 非管理员时整块显示提示而不是隐藏——企业版里普通成员也需要知道自己为什么看不到名册
  isAdmin: { type: Boolean, default: true },
  busy: { type: Boolean, default: false },
  // 创建成功后返回的令牌：**只显示一次**，关闭即由父级清空
  newToken: { type: String, default: "" },
});
const emit = defineEmits(["create", "revoke", "dismiss-token"]);

const { t } = useI18n();

// 本地状态：输入框与角色选择；提交合法性由组件自己判定（name 非空才可提交）
const name = ref("");
const role = ref("member");
const copied = ref(false);

const canSubmit = computed(() => name.value.trim().length > 0 && !props.busy);

function submit() {
  if (!canSubmit.value) return;
  emit("create", { name: name.value.trim(), role: role.value });
}

function isSelf(m) {
  return !!props.selfName && m.name === props.selfName;
}

function roleLabel(r) {
  return r === "admin" ? t("settings.memberRoleAdmin") : t("settings.memberRoleMember");
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(props.newToken);
    copied.value = true;
  } catch {
    /* 复制失败：令牌已在只读输入框里，可手动全选复制兜底 */
  }
}
</script>

<template>
  <div class="members-panel">
    <div class="members-head">
      <span class="members-title"><Icon name="user" :size="15" class="members-ico" /> {{ t("settings.members") }}</span>
    </div>

    <!-- 非管理员：不隐藏，直接说明原因 -->
    <p v-if="!isAdmin" class="members-desc">{{ t("settings.membersForbidden") }}</p>

    <template v-else>
      <p class="members-desc">{{ t("settings.membersHint") }}</p>

      <!-- 新令牌只显示一次：关闭即由父级清空，不再回来 -->
      <div v-if="newToken" class="members-token-box">
        <p class="members-token-warn">{{ t("settings.memberTokenOnce") }}</p>
        <div class="members-token-row">
          <input class="tc-input tc-input--mono" :value="newToken" readonly />
          <button type="button" class="btn-ghost sm" @click="copyToken">
            <Icon name="copy" :size="14" /> {{ copied ? t("settings.memberCopied") : t("settings.memberCopyToken") }}
          </button>
          <button type="button" class="btn-ghost sm" @click="emit('dismiss-token')">
            <Icon name="x" :size="14" /> {{ t("settings.memberTokenClose") }}
          </button>
        </div>
      </div>

      <!-- 添加成员 -->
      <div class="members-add">
        <label class="tc-field members-name-field">
          <span>{{ t("settings.memberName") }}</span>
          <input class="tc-input" v-model="name" :placeholder="t('settings.memberName')" autocomplete="off" @keyup.enter="submit" />
        </label>
        <label class="tc-field members-role-field">
          <span>{{ t("settings.memberRole") }}</span>
          <select class="tc-select" v-model="role">
            <option value="member">{{ t("settings.memberRoleMember") }}</option>
            <option value="admin">{{ t("settings.memberRoleAdmin") }}</option>
          </select>
        </label>
        <button class="btn-primary sm" :disabled="!canSubmit" @click="submit">
          <Icon name="plus" :size="14" /> {{ t("settings.memberAdd") }}
        </button>
      </div>

      <!-- 名册 -->
      <p v-if="!members.length" class="members-desc">{{ t("settings.membersEmpty") }}</p>
      <div v-else class="members-list">
        <div v-for="m in members" :key="m.id" class="members-row">
          <span class="members-row-name">{{ m.name }}</span>
          <span class="members-badge" :class="m.role">{{ roleLabel(m.role) }}</span>
          <button
            class="members-revoke"
            :disabled="busy || isSelf(m)"
            :title="isSelf(m) ? t('settings.memberCannotRevokeSelf') : ''"
            @click="emit('revoke', m)"
          >{{ t("settings.memberRevoke") }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.members-panel { margin-top: var(--sp-6); }
.members-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); margin-bottom: var(--sp-2); }
.members-title { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-base); font-weight: 700; }
.members-ico { flex-shrink: 0; color: var(--primary-hover); }
.members-desc { font-size: var(--fs-sm); color: var(--muted); margin: 0 0 var(--sp-6); line-height: var(--lh-body); }
.members-token-box { margin: var(--sp-3) 0 var(--sp-5); padding: var(--sp-4) var(--sp-5); border: 1px dashed var(--border-strong); border-radius: var(--r-sm); background: var(--well); }
.members-token-warn { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); font-weight: 600; color: var(--warn-deep); }
.members-token-row { display: flex; gap: var(--sp-2); }
.members-token-row .tc-input { flex: 1; min-width: 0; }
.members-add { display: flex; align-items: flex-end; gap: var(--sp-4); flex-wrap: wrap; margin-bottom: var(--sp-5); }
.members-name-field { flex: 1; min-width: 180px; }
.members-role-field { width: 160px; }
.members-list { display: flex; flex-direction: column; gap: 2px; margin-top: var(--sp-2); }
.members-row { display: flex; align-items: center; gap: var(--sp-3); padding: 6px var(--sp-2); border-bottom: 1px solid var(--border); }
.members-row:last-child { border-bottom: none; }
.members-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-md); color: var(--text); }
.members-badge { font-size: var(--fs-xs); color: var(--muted); border: 1px solid var(--border-strong); border-radius: var(--r-pill); padding: 1px 7px; }
.members-badge.admin { color: var(--primary-hover); border-color: var(--border-blue); }
.members-revoke { background: none; border: 1px solid var(--border-danger); color: var(--danger); border-radius: var(--r-sm); padding: 3px var(--sp-3); font-size: var(--fs-xs); cursor: pointer; }
.members-revoke:hover:not(:disabled) { background: var(--danger-soft); }
.members-revoke:disabled { opacity: 0.5; cursor: default; }
</style>
