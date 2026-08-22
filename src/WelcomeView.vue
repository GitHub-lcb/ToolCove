<script setup>
import Icon from "./Icon.vue";
import { useI18n } from "vue-i18n";
const { t } = useI18n();
</script>

<template>
  <div class="welcome">
    <div class="w-logo"><Icon name="wrench" :size="30" /></div>
    <h2>{{ t("welcome.title") }}</h2>
    <p>{{ t("welcome.body") }}</p>
  </div>
</template>

<style scoped>
.welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-4); padding: 40px; text-align: center; }
.w-logo { width: 64px; height: 64px; display: grid; place-items: center; border-radius: var(--r-lg); background: var(--grad-brand); color: var(--text-invert); box-shadow: var(--glow-md); }
.welcome h2 { margin: 0; font-size: var(--fs-xl); }
.welcome p { margin: 0; max-width: 420px; font-size: var(--fs-base); color: var(--muted); line-height: var(--lh-body); }
</style>
