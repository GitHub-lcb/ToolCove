// 契约共用的零依赖 Schema 小件。
// 契约文件必须是纯数据模块：首屏要同步读（设置归一化、能力面板、画廊），
// 手机端对齐测试用原生 Node ESM 直接 import——所以连这两个小 helper 都不能去外面引。
export const text = { type: "string", maxLength: 16000 };
export const str = (maxLength) => ({ type: "string", maxLength });
export const schema = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
