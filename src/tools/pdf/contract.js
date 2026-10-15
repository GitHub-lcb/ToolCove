// PDF 工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, str } from "../../contracts/kit.js";

/**
 * 三个动作共用同一段演示脚本：它们的产物都是**磁盘上的新文件**，而工具窗口里能看见的
 * 只有「刚被交进来的那份文件」与「它的内容概览」，所以演示就是把这两处指出来。
 *
 * 注意它是纯 reveal 脚本：挑文件是人的环节（原生对话框），不假装替用户点过。
 * 锚点名由本工具视图注册（见 View.vue 的 useToolDemo），一致性由 app/toolDemoContract.test.js 强制。
 */
const PDF_DEMO = {
  steps: [
    { anchor: "file-chip", action: "reveal", captionKey: "toolbox.demo.revealSource" },
    { anchor: "source-panel", action: "reveal", captionKey: "toolbox.demo.revealPanel" },
  ],
};

export default {
  key: "pdf",
  order: 170,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolPdf",
    icon: "file",
    category: "file",
    descKey: "toolbox.registry.toolPdfDesc",
    keywordsKey: "toolbox.registry.kwPdf",
    ready: true,
  },
  actions: [
    {
      name: "pdf.merge",
      description: "按顺序合并多个本地 PDF 为新文件（桌面端；单文件 ≤20MB，原生限制）",
      descriptionKey: "agent.toolPdfMerge",
      toolKey: "pdf",
      risk: "write",
      retryable: false,
      desktopOnly: true,
      inputSchema: schema({ paths: { type: "array", minItems: 2, maxItems: 10, items: str(4096) }, output: str(4096) }, ["paths", "output"]),
      demo: PDF_DEMO,
    },
    {
      name: "pdf.extract_pages",
      description: "从本地 PDF 提取指定页（如 1-3,5，1 基页码）另存为新文件（桌面端；≤20MB）",
      descriptionKey: "agent.toolPdfExtractPages",
      toolKey: "pdf",
      risk: "write",
      retryable: false,
      desktopOnly: true,
      inputSchema: schema({ path: str(4096), ranges: str(512), output: str(4096) }, ["path", "ranges", "output"]),
      demo: PDF_DEMO,
    },
    {
      name: "pdf.split",
      description: "把本地 PDF 拆成多个文件：groups 留空则每页一个，否则每个逗号分段（如 1-3,4-6）产出一个（桌面端；≤20MB）",
      descriptionKey: "agent.toolPdfSplit",
      toolKey: "pdf",
      risk: "write",
      retryable: false,
      desktopOnly: true,
      inputSchema: schema({ path: str(4096), groups: str(1024), outputDir: str(4096) }, ["path", "outputDir"]),
      demo: PDF_DEMO,
    },
  ],
};
