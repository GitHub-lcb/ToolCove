// 工具箱注册表：工具画廊、全局搜索等入口共用，避免名称和能力描述漂移。
export const TOOLBOX_GROUPS = [
  { key: "data", label: "数据与文本", icon: "braces", desc: "转换、文本、时间、结构化与数据生成" },
  { key: "network", label: "网络与接口", icon: "network", desc: "网络诊断与 API 接口调试" },
  { key: "file", label: "文件与媒体", icon: "folder", desc: "文件、图片与媒体资源处理" },
  { key: "development", label: "开发调试", icon: "wrench", desc: "安全校验、数据库与开发调试" },
  { key: "ai", label: "AI 助手", icon: "sparkles", desc: "AI 驱动的对话与生成工具" },
];

export const TOOLBOX_TOOLS = [
  { key: "convert", label: "数据转换", icon: "repeat", category: "数据与文本", desc: "Base64、URL、Unicode、Hex、JWT 与 JSON 转义", keywords: ["数据处理"], ready: true },
  { key: "diff", label: "文本处理", icon: "text", category: "数据与文本", desc: "Diff、正则、替换、行处理、命名转换与统计", keywords: ["数据处理"], ready: true },
  { key: "time", label: "时间调度", icon: "clock", category: "数据与文本", desc: "时间戳、时区、日期计算与 Cron 执行时间", keywords: ["数据处理"], ready: true },
  {
    key: "json",
    label: "结构化数据",
    icon: "braces",
    category: "数据与文本",
    desc: "JSON、YAML 校验、格式化、结构查看与双向转换",
    keywords: ["数据处理", "YAML", "YML", "YAML 校验", "YAML 格式化", "YAML 转 JSON", "JSON 转 YAML", "JSON 压缩", "JSON 转义", "树视图"],
    ready: true,
  },
  { key: "network", label: "网络诊断", icon: "network", category: "网络与接口", desc: "URL、CIDR、DNS、端口、Ping、路由与本机网络", keywords: ["网络工具"], ready: true },
  { key: "crypto", label: "加密与校验", icon: "shield", category: "开发调试", desc: "摘要、HMAC、AES、RSA、文件校验与密码生成", ready: true },
  { key: "file", label: "文件处理", icon: "folder", category: "文件与媒体", desc: "文件信息、编码、Base64、换行符与批量重命名", keywords: ["文件工具"], ready: true },
  {
    key: "image",
    label: "图片处理",
    icon: "image",
    category: "文件与媒体",
    desc: "格式转换、压缩、尺寸编辑、颜色提取、图标生成与图片信息",
    keywords: ["PNG", "JPEG", "JPG", "WebP", "BMP", "图片压缩", "图片转换", "尺寸调整", "缩放", "裁剪", "旋转", "翻转", "批量图片", "颜色提取", "主色", "调色板", "HEX", "RGB", "HSL", "图标生成", "AI 图标", "应用图标", "多尺寸图标", "EXIF", "清除元数据"],
    ready: true,
  },
  {
    key: "generator",
    label: "数据生成",
    icon: "dice",
    category: "数据与文本",
    desc: "标识符、随机数据、Mock 结构、序列与常用模板",
    keywords: ["数据处理", "开发辅助", "UUID", "UUID v4", "UUID v7", "ULID", "Nano ID", "NanoID", "随机数", "测试数据", "假数据", "Mock 数据", "序列生成", "JSON", "CSV", "SQL INSERT", "用户模板", "订单模板", "商品模板", "地址模板"],
    ready: true,
  },
  { key: "request", label: "API 调试", icon: "send", category: "网络与接口", desc: "发送请求，调试 API 接口", keywords: ["网络工具"], ready: true },
  { key: "db", label: "数据库管理", icon: "database", category: "开发调试", desc: "连接数据库，执行 SQL，管理数据", ready: true },
  {
    key: "chat",
    label: "AI 对话",
    icon: "chat",
    category: "AI 助手",
    desc: "多会话 AI 对话，支持图片与提示词模板",
    keywords: ["AI", "对话", "Chat", "聊天", "GPT", "提示词", "智能问答"],
    ready: true,
  },
  {
    key: "harness",
    label: "Harness",
    icon: "terminal",
    category: "AI 助手",
    desc: "本机 AI 工程工作台",
    keywords: ["Harness", "Agent", "工程工作台", "本地 AI"],
    ready: true,
  },
];

export function groupToolboxTools(tools = TOOLBOX_TOOLS, groups = TOOLBOX_GROUPS) {
  return groups
    .map((group) => ({ ...group, tools: tools.filter((tool) => tool.category === group.label) }))
    .filter((group) => group.tools.length > 0);
}

export function searchToolboxTools(query, tools = TOOLBOX_TOOLS) {
  const keyword = String(query ?? "").trim().toLowerCase();
  if (!keyword) return [];
  return tools.filter((tool) =>
    [tool.key, tool.label, tool.category, tool.desc, ...(tool.keywords || [])]
      .some((value) => String(value ?? "").toLowerCase().includes(keyword))
  );
}
