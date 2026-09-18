// 统一 IPC 入口：桌面端直通 Tauri；浏览器端对同名命令给出 Web 实现。
// 浏览器未实现的命令一律抛 DESKTOP_ONLY —— UI 用 capabilities 提前隐藏对应入口，
// 运行期兜底只用于「入口漏拦」时不至于静默失败。
// 用命名空间导入：既有单测会 mock "@tauri-apps/api/core" 且只提供部分导出，
// 具名导入会在链接/求值期直接抛错，命名空间访问则可按需取用。
import * as tauriCore from "@tauri-apps/api/core";
import { isDesktop, isMobile, desktopOnly } from "./env.js";
import { kvGet, kvSet, kvDelete } from "./kv.js";
import { browserHttpRequest } from "./net.js";
import { downloadBase64, downloadText } from "./download.js";

/** 流式 Channel 是桌面端原语；浏览器端用 fetch 流（见 ai.js），不经过这里。 */
export function createChannel() {
  if (!tauriCore.Channel) throw new Error("Channel 仅桌面端可用");
  return new tauriCore.Channel();
}

const IMAGE_PREFIX = "img:";

/**
 * IndexedDB 的结构化克隆不接受 Vue 响应式代理（DataCloneError: [object Array] could not be cloned），
 * 落盘前统一归一化为普通 JSON 值——与 localStorage 后端的既有语义一致，也与桌面端 JSON 文件一致。
 */
function plainValue(value) {
  const text = JSON.stringify(value ?? null);
  return text === undefined ? null : JSON.parse(text);
}

/** 内容修订号（浏览器端等价物：桌面端是文件内容 SHA-256，这里用 JSON 文本的哈希） */
function contentRevision(value) {
  const text = JSON.stringify(value ?? null) ?? "null";
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `b1-${hash.toString(16)}-${text.length.toString(16)}`;
}

/** 浏览器端命令实现：语义与 Rust 侧同名命令对齐。 */
export const browserHandlers = {
  // 主数据：与桌面端一致，文件不存在返回空数组（load_data 的既有约定）
  async load_data({ key }) {
    const value = await kvGet(key);
    return value === undefined ? [] : value;
  },

  async save_data({ key, data }) {
    await kvSet(key, plainValue(data));
  },

  // 带修订号读写：仓库存取层据此做乐观并发（对齐 Rust load/save_data_versioned）
  async load_data_versioned({ key }) {
    const value = await kvGet(key);
    const data = value === undefined ? [] : value;
    return { data, revision: contentRevision(data) };
  },

  async save_data_versioned({ key, data, expected_revision }) {
    const plain = plainValue(data);
    const current = await kvGet(key);
    if (contentRevision(current === undefined ? [] : current) !== String(expected_revision ?? "")) {
      throw new Error("数据已被其他页面或后台任务更新，本次保存已拒绝；请重新进入页面后再修改");
    }
    await kvSet(key, plain);
    return contentRevision(plain);
  },

  // 图片附件：IndexedDB 存 base64，与 save_image/load_image 的入参出参一致
  async save_image({ name, dataB64, data_b64 }) {
    await kvSet(IMAGE_PREFIX + String(name), String(dataB64 ?? data_b64 ?? ""));
  },

  async load_image({ name }) {
    const value = await kvGet(IMAGE_PREFIX + String(name));
    if (typeof value !== "string" || !value) throw new Error("图片不存在");
    return value;
  },

  async delete_image({ name }) {
    await kvDelete(IMAGE_PREFIX + String(name));
  },

  // 导出：浏览器没有本地路径，改为触发下载（文件名取 path 末段，与调用方提示一致）
  async export_file({ path, content }) {
    downloadText(content, path);
  },

  async export_file_b64({ path, contentB64, content_b64 }) {
    downloadBase64(contentB64 ?? content_b64, path);
  },

  http_request: (args) => browserHttpRequest(args),

  // 浏览器没有系统密钥库：明文往返。enc: 前缀协议因此仍自洽（存 "enc:明文"，读回明文），
  // 安全性等同普通站点数据（落 IndexedDB），敏感 Key 请只在受信设备使用。
  async encrypt_text({ plain }) {
    return String(plain ?? "");
  },

  async decrypt_text({ cipher }) {
    return String(cipher ?? "");
  },

  // 遥测上传与本地备份依赖桌面能力：浏览器端静默跳过，不报错打扰用户
  async telemetry_submit() {},

  async auto_backup() {
    return "";
  },
};

/**
 * 手机端原生桥（安卓）：由 App 启动时注入，形状为 `{ invoke(cmd, args) }`。
 *
 * 为什么用注入而不是在 src/ 里 import 安卓代码：这套前端要能**在浏览器里跑**——
 * 于是移动端的平台能力可以被 Playwright（移动视口）自动化验证，而不必先有 APK 可跑。
 * 注入点只有这一个，桌面端与网页端的行为完全不受影响（它们永远不会设置这个桥）。
 */
let mobileBridge = null;
export function setMobileBridge(bridge) {
  mobileBridge = bridge && typeof bridge.invoke === "function" ? bridge : null;
  return mobileBridge;
}
export const hasMobileBridge = () => !!mobileBridge;

export async function invoke(command, args = {}) {
  if (isMobile) {
    // 手机端：先给原生桥，再退回浏览器实现（存储、下载等纯 Web 能力不需要原生参与）
    if (mobileBridge) return mobileBridge.invoke(command, args || {});
    const handler = browserHandlers[command];
    if (handler) return handler(args || {});
    throw desktopOnly(command);
  }
  if (isDesktop) return tauriCore.invoke(command, args);
  const handler = browserHandlers[command];
  if (!handler) throw desktopOnly(command);
  return handler(args || {});
}
