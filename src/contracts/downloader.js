// 多线程下载工具契约：UI 元数据 + Agent 豁免声明，单一真相源（聚合见 index.js）。
export default {
  key: "downloader",
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolDownloader",
    icon: "download",
    category: "network",
    descKey: "toolbox.registry.toolDownloaderDesc",
    keywordsKey: "toolbox.registry.kwDownloader",
    ready: true,
    desktopOnly: true,
  },
  // 下载队列挂在工具窗口的会话状态上，Agent 入队看不到也管不了进度——
  // 需要先把队列沉到共享 Store；且多 GB 分片下载远超单步执行预算。
  agentExempt: "队列有态且体量超预算：需共享 Store 与进度协议先行",
};
