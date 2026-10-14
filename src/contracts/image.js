// 图片处理工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, str } from "./kit.js";

export default {
  key: "image",
  ui: {
    labelKey: "toolbox.registry.toolImage",
    icon: "image",
    category: "file",
    descKey: "toolbox.registry.toolImageDesc",
    keywordsKey: "toolbox.registry.kwImage",
    ready: true,
  },
  actions: [
    {
      name: "image.plan",
      description: "按源图尺寸计算等比缩放、居中裁剪与旋转后的输出尺寸计划",
      descriptionKey: "agent.toolImagePlan",
      toolKey: "image",
      risk: "transform",
      retryable: false,
      inputSchema: schema(
        {
          width: { type: "integer", minimum: 1 },
          height: { type: "integer", minimum: 1 },
          maxWidth: { type: "integer", minimum: 1 },
          maxHeight: { type: "integer", minimum: 1 },
          cropRatio: { type: "number", minimum: 0 },
          rotation: { type: "number", enum: [0, 90, 180, 270] },
          allowUpscale: { type: "boolean" },
        },
        ["width", "height"]
      ),
    },
  ],
};
