// 网络诊断工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据在同一包的 ./contract.js。
//
// 四个动作都是桌面独占，经**中立原生 IPC 桥** src/nativeInvoke.js 调用原生命令；
// 不 import agent/transport.js（那会形成 tools→agent 反向边）。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { desktopInvoke } from "../../nativeInvoke.js";

export default {
  "network.ping": { execute: ({ target, count = 4 }) => desktopInvoke("network_ping", { target, count }) },
  "network.trace": { execute: ({ target, maxHops = 10 }) => desktopInvoke("network_trace", { target, maxHops }) },
  "network.dns": { execute: ({ host }) => desktopInvoke("network_dns_lookup", { host }) },
  "network.tcp_check": { execute: ({ host, port }) => desktopInvoke("network_tcp_check", { host, port }) },
};
