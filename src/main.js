import { createApp } from "vue";
import App from "./App.vue";
import { i18n, initLocale } from "./i18n/index.js";
import { runMigrations } from "./migrate.js";

const t = (key, params) => i18n.global.t(key, params);

// 挂载前先落初始语言、跑一次数据迁移；失败也不阻断启动
Promise.all([initLocale(), runMigrations()])
  .catch((e) => console.error(t("common.bootFail", { err: e })))
  .finally(() => createApp(App).use(i18n).mount("#app"));
