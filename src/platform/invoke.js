// 统一 IPC 入口：只做**分发**，不实现任何平台能力。
//
// 三个后端各占一个文件：
//   - 桌面端：直通 Tauri（本文件内联，因为它就是一行转发）
//   - 浏览器端：platform/backends/browser.js（IndexedDB + fetch + 下载）
//   - 手机端：platform/backends/mobile.js（注入式原生桥，失败按条件回退浏览器实现）
//
// 这样分层的收益：读这个文件的人看到的是「哪条分支交给谁」，而不是十几个混在一起的实现。
// 桌面端路径不会被浏览器的实现细节淹没——这正是不让两端耦在同一个文件里的意思。
//
// 用命名空间导入：既有单测会 mock "@tauri-apps/api/core" 且只提供部分导出，
// 具名导入会在链接/求值期直接抛错，命名空间访问则可按需取用。
import * as tauriCore from "@tauri-apps/api/core";
import { isDesktop, isMobile, desktopOnly } from "./env.js";
import { browserHandlers } from "./backends/browser.js";
import { getMobileBridge, isBridgeUnsupported } from "./backends/mobile.js";
import { remoteConfigured, remoteLoad, remoteSave } from "./remoteStore.js";

export { browserHandlers };

// 企业服务器数据路由（二期）：配置存在即走远端（remoteStore.js），否则走原通道
// （桌面 Tauri IPC / 浏览器与手机的 browserHandlers）。三个平台同一路由条件——
// 决策①就是「桌面客户端连企业服务器」，桌面端不例外。
//
// 两条刻意的边界：
// - 只路由 load_data/save_data：versioned 变体（乐观并发）暂留原通道，契约还没有
//   修订号/CAS 语义，接了反而丢语义；企业服务器**配置本身**也不在这里——它存本地
//   （app/enterpriseServer.js），否则自举悖论（读配置要先连服务器）。
// - 远端失败（如 REMOTE_UNREACHABLE）**不自动降级写本地**：本地一半远端一半就是
//   数据分裂，错误抛给调用方如实上报。
async function invokeRemoteData(command, args) {
  return command === "load_data" ? remoteLoad(args.key) : remoteSave(args.key, args.data);
}
const REMOTE_DATA_COMMANDS = new Set(["load_data", "save_data"]);

/** 流式 Channel 是桌面端原语；浏览器端用 fetch 流（见 ai.js），不经过这里。 */
export function createChannel() {
  if (!tauriCore.Channel) throw new Error("Channel 仅桌面端可用");
  return new tauriCore.Channel();
}

/**
 * 手机端分支：先给原生桥，失败按条件退回浏览器实现。
 *
 * 这个回退不是可选项，而是必需的：桥只实现"真正需要原生"的能力（HTTP/TCP/加密/SAF/SQLite），
 * 而存储（load_data/save_data）、下载、图片存取这些纯 Web 能力不需要原生参与。
 * 早先这里写成"桥存在就直接 return"，于是桥不认的命令会把错误直接抛给界面——
 * 实测后果是真机上记录/工作台/设置/Agent 全部读写失败（它们都用 load_data/save_data），
 * 而 E2E 测不出来：E2E 跑在没有桥的浏览器形态下，走的是另一条分支。
 */
async function invokeMobile(command, args) {
  const bridge = getMobileBridge();
  if (bridge) {
    try {
      return await bridge.invoke(command, args || {});
    } catch (error) {
      const handler = browserHandlers[command];
      // 只对"桥明确不认识"的命令回退：桥认识的命令一旦失败（如 HTTP 超时、文件读不到），
      // 那个错误是**真实结果**，回退到浏览器实现只会掩盖它（浏览器实现也没有那个能力）。
      if (!handler || !isBridgeUnsupported(error)) throw error;
      return handler(args || {});
    }
  }
  const handler = browserHandlers[command];
  if (handler) return handler(args || {});
  throw desktopOnly(command);
}

export async function invoke(command, args = {}) {
  // 企业服务器路由先于平台分支：配置存在时三个平台的数据都走远端。
  if (REMOTE_DATA_COMMANDS.has(command) && remoteConfigured()) return invokeRemoteData(command, args);
  if (isMobile) return invokeMobile(command, args);
  // 桌面端：原生 IPC 直通。UI 用 capabilities 提前隐藏不支持的入口，
  // 运行期兜底只用于「入口漏拦」时不至于静默失败。
  if (isDesktop) return tauriCore.invoke(command, args);
  const handler = browserHandlers[command];
  if (!handler) throw desktopOnly(command);
  return handler(args || {});
}
