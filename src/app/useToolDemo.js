// 工具侧接入点：工具视图一行接入，就能在自己的界面上把 Agent 的操作「演一遍」。
//
// 分工是刻意的：
//   · 工具只提供「锚点名 → 真实元素」和「动作 → 真实写入」两件事（元素与行为都在工具手里）；
//   · 节奏、聚光、字幕、进度、回执全部由这里统一负责——每个工具各写一套动画必然走形。
//
// 演示改的是**真数据**：fill 直接写进工具自己的状态，click 调工具自己的函数。
// 所以演示结束后用户看到的结果就是真结果，可以接着改——这也是「教学」而不是「看动画」。
import { onBeforeUnmount, onMounted, reactive } from "vue";
import { isPlayable } from "./toolDemo.js";
import { notifySignal, subscribeDemo, takeDemo } from "./toolDemoLink.js";

/** 每步停留：够读一句字幕，又不至于让人等 */
const STEP_MS = 900;
/** 降低动效偏好下的停留：不播动画，但仍要让人看清这一步做了什么 */
const STEP_MS_REDUCED = 400;
/**
 * 等锚点出现的上限（毫秒）。
 *
 * 有些工具的目标控件是**异步才渲染**的：pdf 要先经预填读文件、拿到页数才会出现内容面板。
 * 不等的话那一步就只有字幕、没有聚光——而「聚光」正是这一步的全部信息量。
 * 上限刻意很短：等不到就如实降级（留字幕、不假装演过），不能把演示卡在这儿。
 */
const ANCHOR_WAIT_MS = 1200;
const ANCHOR_POLL_MS = 80;
/** 聚光类名（定义在 styles/globals.css，全局生效——工具视图是 scoped 样式，类必须来自全局） */
export const FOCUS_CLASS = "tc-demo-focus";

const prefersReducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? !!window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 锚点声明可以是 ref / DOM 元素 / 返回元素的函数，统一取出元素（取不到返回 null） */
function toElement(source) {
  const value = typeof source === "function" ? source() : source;
  return value && value.nodeType === 1 ? value : null;
}

export function useToolDemo(toolKey, { anchors = {}, handlers = {} } = {}) {
  // 刻意用 reactive 而不是 ref：工具视图要在模板里写 demo.state.active，
  // 而 setup 返回的普通对象里的 ref **不会被模板自动解包**（只有顶层 ref 会），
  // 用 ref 的话每个工具作者都会踩一次「传进去是 ref、读到的字段全是 undefined」。
  const state = reactive({
    active: false, // 本次是被 Agent 打开的（否则整层不出现，工具手动打开时不该有任何演示痕迹）
    done: false,
    skipped: false,
    index: 0,
    total: 0,
    captionKey: "",
    captionValue: null,
    script: [],
    runId: "",
  });
  let token = 0; // 递增即作废上一次播放（跳过 / 重播 / 卸载）
  let focused = null;
  const setState = (patch) => Object.assign(state, patch);

  function clearFocus() {
    if (focused) focused.classList.remove(FOCUS_CLASS);
    focused = null;
  }
  function focus(el) {
    clearFocus();
    if (!el) return null;
    el.classList.add(FOCUS_CLASS);
    focused = el;
    return el;
  }

  /** 锚点可能在挂载后才渲染出来（异步载入的内容），所以给一小段等待窗口 */
  async function waitForAnchor(name) {
    const deadline = Date.now() + ANCHOR_WAIT_MS;
    for (;;) {
      const el = toElement(anchors[name]);
      if (el) return el;
      if (Date.now() >= deadline) return null;
      await sleep(ANCHOR_POLL_MS);
    }
  }

  async function play(script, runId) {
    const mine = ++token;
    const step = prefersReducedMotion() ? STEP_MS_REDUCED : STEP_MS;
    for (let i = 0; i < script.length; i++) {
      if (mine !== token) return;
      const current = script[i];
      setState({ index: i, captionKey: current.captionKey, captionValue: current.value });
      const el = focus(await waitForAnchor(current.anchor));
      if (mine !== token) return;
      const handler = handlers[current.action];
      // 元素找不到（如该控件在当前状态下不渲染）或工具没实现该动作：留字幕，不假装做过
      if (el && typeof handler === "function") {
        try {
          await handler(current, el);
        } catch (error) {
          console.error("toolDemo step failed", error);
        }
      }
      await sleep(step);
      if (mine !== token) return;
      clearFocus();
      await sleep(Math.round(step / 3));
    }
    if (mine !== token) return;
    setState({ done: true, index: script.length - 1 });
    notifySignal("done", { toolKey, runId, steps: script.length, skipped: false });
  }

  function start(payload) {
    if (!payload || !isPlayable(payload.script)) return;
    setState({ active: true, done: false, skipped: false, index: 0, total: payload.script.length, script: payload.script, runId: payload.runId || "" });
    // 先回 ready：主窗口据此知道「工具那边已经就绪、开播了」，而不是两眼一抹黑
    notifySignal("ready", { toolKey, runId: payload.runId || "", steps: payload.script.length });
    play(payload.script, payload.runId || "");
  }

  /** 跳过演示：立刻停在「已完成」态（回执里如实标 skipped，不谎称演完了） */
  function skip() {
    token++;
    clearFocus();
    setState({ done: true, skipped: true });
    notifySignal("done", { toolKey, runId: state.runId, steps: state.total, skipped: true });
  }

  /** 重播：工具卡上的「看它怎么操作」再次进来时也走这里 */
  function replay() {
    if (!isPlayable(state.script)) return;
    setState({ done: false, skipped: false, index: 0 });
    play(state.script, state.runId);
  }

  let offLive = null;
  onMounted(async () => {
    // 热路径优先注册：已挂载的工具收到新脚本也能立刻开播（桌面独立窗口经事件通道送达）
    offLive = subscribeDemo(toolKey, (payload) => {
      if (payload && payload.toolKey === toolKey) start(payload);
    });
    // 冷启动：新开的窗口在自己的挂载点消费一次性脚本
    const payload = await takeDemo(toolKey);
    if (payload) start(payload);
  });
  onBeforeUnmount(() => {
    token++;
    clearFocus();
    offLive?.();
  });

  return { state, skip, replay };
}
