import { createApp } from "vue";
import App from "./app/App.vue";
import { i18n, initLocale, warmFallbackLocale } from "./i18n/index.js";
import { runMigrations } from "./app/migrate.js";
import { restoreEnterpriseConfig } from "./app/enterpriseServer.js";
import { loadPolicy } from "./enterprise/policyStore.js";
import { applyThemeAttribute, syncDensityAttribute } from "./app/theme.js";
// 设计令牌与组件原语：此前内联在 App.vue 的非 scoped 块里（395 行，与全局工具类混在一起）。
// 抽成独立 CSS 后，改主题不必碰组件文件，令牌缺口也能在一个屏幕内对照出来。
// 顺序要紧：tokens 先（primitives 与 globals 都引用它），globals 最后（含旧类名兼容别名）。
import "./styles/tokens.css";
import "./styles/primitives.css";
import "./styles/globals.css";

const t = (key, params) => i18n.global.t(key, params);

// 主题与密度属性必须落在首帧之前：否则手动选深色的用户会先看到一帧浅色。
// 这里与 index.html 的内联脚本是同一件事的两道保险（内联脚本负责"JS 还没加载时"）。
applyThemeAttribute();
syncDensityAttribute();

// 挂载前先落初始语言、跑一次数据迁移；失败也不阻断启动。
// 企业服务器配置必须**最先**恢复：它决定数据桥往哪路由——initLocale/runMigrations
// 都会 load_data("settings")，恢复晚于它们，首屏读到的就是本地而不是企业服务器上的数据。
// 企业权限门禁同样在这里载入：投影是同步纯函数（不能 await 读盘），必须在界面开始投影前把
// 策略填进内存缓存，否则企业态首帧会先按「不限制」渲染再跳变。
restoreEnterpriseConfig()
  .catch(() => {})
  .then(() => Promise.all([initLocale(), runMigrations(), loadPolicy()]))
  .catch((e) => console.error(t("common.bootFail", { err: e })))
  .finally(() => {
    createApp(App).use(i18n).mount("#app");
    // 另一种语言的字典在挂载之后才预热：排在 mount 之前会被算进首屏字节（见 i18n/index.js 的说明）
    warmFallbackLocale();
  });
