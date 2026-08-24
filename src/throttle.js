// 节流工具：首拍立即执行 + ms 窗口内合并（只保留最新参数）+ 窗口末补发一次。
// 持续流（如 SSE 增量）中保证至少每 ms 出一次结果，且首拍不延迟。
export function throttleFlush(fn, ms) {
  let timer = null;
  let pending = null;
  let last = 0;
  const run = (arg) => {
    last = Date.now();
    fn(arg);
  };
  const flush = (arg) => {
    pending = arg;
    const now = Date.now();
    if (timer) return; // 窗口内：合并，窗口末补发 pending
    if (now - last >= ms) {
      run(arg); // 距上次执行已超过窗口：立即执行
      pending = null;
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      const arg2 = pending;
      pending = null;
      if (arg2 !== null) run(arg2);
    }, ms - (now - last));
  };
  const dispose = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };
  return { flush, dispose };
}
