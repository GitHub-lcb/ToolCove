// 持久化数据均为 JSON；通过序列化生成快照，同时去除 Vue 响应式 Proxy。
export function cloneJsonData(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}
