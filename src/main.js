import { createApp } from "vue";
import App from "./App.vue";
import { i18n, initLocale } from "./i18n/index.js";
import { runMigrations } from "./migrate.js";

// 挂载前先落初始语言、跑一次数据迁移；失败也不阻断启动
Promise.all([initLocale(), runMigrations()])
  .catch((e) => console.error("启动预处理失败，按原样启动：", e))
  .finally(() => createApp(App).use(i18n).mount("#app"));
