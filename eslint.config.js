// ESLint 扁平配置。目标不是「风格统一」而是**抓真实缺陷**——本项目已经踩过这些坑：
//   - `retainResult` 引用了不存在的 `args`，异常被 catch 吞成静默降级（no-undef 能抓）；
//   - 死代码与重复键（no-dupe-keys / no-unreachable）；
//   - 在模块级用到未定义的全局（Node 与浏览器两套环境）。
// 因此刻意不开 stylistic 类规则：那类问题交给 code review，开了只会逼出一堆无意义的改动。
import js from "@eslint/js";
import vue from "eslint-plugin-vue";
import globals from "globals";

const browserAndNode = { ...globals.browser, ...globals.node };

export default [
  { ignores: ["dist/**", "node_modules/**", "src-tauri/**", "mobile/android/build/**", "mobile/android/.gradle/**", "mobile/android/.toolchain/**", "test-results/**", "playwright-report/**", "tmp*/**", "release-out/**"] },
  js.configs.recommended,
  ...vue.configs["flat/recommended"],
  {
    files: ["**/*.{js,mjs,vue}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...browserAndNode,
        // Vite 注入的构建期常量
        __BUILD_STAMP__: "readonly",
      },
    },
    rules: {
      // 真实缺陷类：保持开启（recommended 里已有），这里只调几个噪声大的
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // 组件名与文件名一致（本项目都是单词大写文件，如 AgentView.vue）
      "vue/multi-word-component-names": "off",
      // 模板里的属性换行顺序不强制（既有代码风格差异大，开了要改几百行）
      "vue/attributes-order": "off",
      "vue/max-attributes-per-line": "off",
      "vue/singleline-html-element-content-newline": "off",
      "vue/multiline-html-element-content-newline": "off",
      "vue/html-self-closing": "off",
      "vue/html-indent": "off",
      "vue/html-closing-bracket-newline": "off",
      "vue/first-attribute-linebreak": "off",
      // v-html 保持为 error：它是唯一能直接注入 HTML 的出口，必须在每个使用点显式说明为什么安全
      // （现存的 4 处都走 shared.renderMarkdown，而它先做 escapeHtml，已在行内注释里写明）
      "vue/no-v-html": "error",
      "vue/no-unused-components": "error",
      // ── 以下几条是「工具噪音」而非缺陷，降为 warning 保留可见性 ──
      // no-useless-assignment：把「顺手赋个初值再覆盖」当错误，可读性写法被误伤
      "no-useless-assignment": "off",
      // no-control-regex / no-useless-escape：本项目刻意用控制字符与转义（编码检测、GB18030 等）
      "no-control-regex": "warn",
      "no-useless-escape": "warn",
      // vue/no-template-shadow：模板里 t/name 之类的局部遮蔽多数无害（真正致命的 t 遮蔽已由
      // i18nShadowing.test.js 专门守着，那条测试比 lint 规则更懂本项目的约定）
      "vue/no-template-shadow": "warn",
      // vue/no-mutating-props：现存用法都是「子组件就地改父组件传入的对象」（pool / editing），
      // 改起来要动数据流，属于重构而非顺手修；降为 warning 记为已知项
      "vue/no-mutating-props": "warn",
      // vue/use-v-on-exact：只影响同一元素多事件修饰符的写法，非缺陷
      "vue/use-v-on-exact": "warn",
      // preserve-caught-error：源码里的 8 处已补 cause；跨平台脚本（mobile/android）里
      // 抛的是自定义对象而非 Error，规则不适用，降为 warning
      "preserve-caught-error": "warn",
    },
  },
  {
    // Vue 单文件组件：`const props = defineProps({...})` / `const emit = defineEmits([...])` 是常见写法，
    // 有的组件只在模板里用、有的暂时没有 emit 目标。这类「脚手架变量」不是缺陷，
    // 让 no-unused-vars 在 .vue 里只当提示，别把它变成必须改的红灯。
    files: ["**/*.vue"],
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
    },
  },
  {
    // 测试与 E2E：fixture 与临时变量多，未使用变量只作提示；其它规则照旧
    files: ["**/*.test.js", "e2e/**/*.js"],
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
    },
  },
  {
    // 仓库脚本与手机版构建脚本：Node 环境，动态 import 与临时变量多
    files: ["scripts/**/*.js", "mobile/**/*.mjs", "playwright.config.js", "e2e/server.mjs"],
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "preserve-caught-error": "off",
    },
  },
];
