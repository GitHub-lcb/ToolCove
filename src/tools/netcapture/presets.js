// 已知应用的启动怪癖。
//
// 为什么要有这张表：不同应用开调试端口的办法**各不相同**，而这属于应用内部实现，
// 不该让用户去记。实测到的两种：
//   - Qoder：命令行参数可用，但它的启动器会吞参数、且外层 exe 是 Node SFA；
//   - WorkBuddy：**完全不吃命令行参数**，只认 WORKBUDDY_REMOTE_DEBUGGING_PORT 环境变量。
// 用户视角里这两件事长得一模一样（"点启动"），要求他分辨是不合理的。
//
// 所以：路径一填进来就认出是哪个应用，然后把参数/环境变量/提示全部自动配好。
// 认不出来就退回通用做法（只传命令行参数），并说明可能失败的原因。

export const PRESETS = [
  {
    id: "workbuddy",
    label: "WorkBuddy",
    // 匹配可执行文件名，不匹配整条路径——用户可能把它装在任何地方
    exe: /^workbuddy\.exe$/i,
    // 这个变量名是应用自己写死在代码里的（app.asar 里 WORKBUDDY_REMOTE_DEBUGGING_PORT）
    envKey: "WORKBUDDY_REMOTE_DEBUGGING_PORT",
    useArgs: false,
    note: "WorkBuddy 不吃命令行参数，只认环境变量；它还会自己补上 --remote-allow-origins。",
  },
  {
    id: "qoder",
    label: "Qoder CN",
    exe: /^qoder cn\.exe$/i,
    envKey: "",
    useArgs: true,
    note: "Qoder 用命令行参数即可。（若启动后没界面、没端口，多半是它的启动器吞了参数。）",
  },
];

/** 从完整路径里取文件名，再和预设比对。 */
export function matchPreset(exePath) {
  const name = String(exePath ?? "").trim().split(/[\\/]/).pop() || "";
  if (!name) return null;
  return PRESETS.find((p) => p.exe.test(name)) || null;
}

/** 这个预设要靠环境变量才能开端口吗？ */
export function needsEnv(preset) {
  return !!(preset && preset.envKey);
}

/** 给出该预设需要的环境变量文本（每行一个 KEY=VALUE）。 */
export function envTextFor(preset, port) {
  if (!needsEnv(preset)) return "";
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return "";
  return `${preset.envKey}=${p}`;
}

/** 该不该把 --remote-debugging-port 作为命令行参数传过去。 */
export function shouldPassArgs(preset) {
  return !preset || preset.useArgs !== false;
}