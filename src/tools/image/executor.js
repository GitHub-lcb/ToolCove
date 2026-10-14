// 图片处理工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据在同一包的 ./contract.js。
//
// 等比缩放 / 居中裁剪 / 旋转计划的纯逻辑在**中立共享层** src/imageTool.js：
// 工具界面与手机端也在用同一份实现，故留在根级而非沉入本包。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { calculateCenterCrop, calculateContainSize, calculateRenderPlan } from "../../imageTool.js";

export default {
  "image.plan": {
    execute: ({ width, height, maxWidth, maxHeight, cropRatio = 0, rotation = 0, allowUpscale = false }) => ({
      contain: calculateContainSize(width, height, maxWidth || width, maxHeight || height, allowUpscale),
      crop: calculateCenterCrop(width, height, cropRatio),
      renderPlan: calculateRenderPlan(width, height, { cropRatio, rotation }),
    }),
  },
};
