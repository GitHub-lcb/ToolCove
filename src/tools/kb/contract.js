// 知识库工具契约：UI 元数据 + Agent 豁免声明，单一真相源（聚合见 index.js）。
//
// 为什么刻意没有 Agent 动作：kb 是仓库层的一个数据类别（见 data/repository.js 的 KINDS），
// 通用数据工具 data.query / data.get / data.create / data.update / data.remove 已按 kind="kb"
// 覆盖了检索与写回（与提示词库的豁免同一理由，见 src/tools/prompt/contract.js）——
// 再声明一套 kb.search / kb.save 只会让同一件事有两个入口，且两处口径迟早漂移。
export default {
  key: "kb",
  order: 35,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolKb",
    icon: "archive",
    category: "data",
    descKey: "toolbox.registry.toolKbDesc",
    keywordsKey: "toolbox.registry.kwKb",
    ready: true,
  },
  agentExempt: "条目读写已由通用 data.* 数据工具覆盖（kb 是仓库层数据类别），再声明动作是重复能力",
};
