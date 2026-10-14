// 相册归档工具契约：UI 元数据 + Agent 豁免声明，单一真相源（聚合见 index.js）。
export default {
  key: "photo",
  order: 130,
  scope: "personal",
  ui: {
    labelKey: "toolbox.registry.toolPhoto",
    icon: "camera",
    category: "file",
    descKey: "toolbox.registry.toolPhotoDesc",
    keywordsKey: "toolbox.registry.kwPhoto",
    ready: true,
  },
  // 人工采集流：手机拍照、挑选与导入本身就是环节；桌面归档由既有计划任务执行，
  // Agent 驱动它既没有收益也绕开了人的筛选。
  agentExempt: "human-in-the-loop：拍照与挑选是人的环节，归档由既有计划任务完成",
};
