// 凭据来源：描述文件里不存 token，运行时现取。
//
// 为什么必须有这层：签到工具的前提是「无人值守」，而 Qoder 这类客户端的 device token
// 会随登录轮换——抓包抄来的那份一两天就作废，用户得隔天重抓一次，工具就白做了。
// 客户端自己会把有效 token 持续写在本地（同一登录用户可解），所以「当场读」比「抄一份」
// 既更准也更安全：磁盘上不再躺着一份会过期的凭据副本。
//
// 取到的值只在内存里活到请求发完：不落盘、不进日志、不进历史。
import { invoke } from "../platform/invoke.js";

// 每个来源返回**一组请求头**，不是一个 token 字符串：TRAE 除了自己的 JWT 还要求
// x-device-id（它注册过的设备号），只回一条头就装不下第二个来源这种形态。
const SOURCES = {
  // Qoder CN 桌面端：Rust 命令解出当前有效的 device token（浏览器/手机端没有本地文件可读）。
  // 名字里带 cn 是有意的：CN 与国际版是两个应用、两套登录态，不能混着读。
  "qoder-cn-local": async () => {
    const got = await invoke("qoder_cn_auth_token");
    const token = String(got?.token || "");
    if (!token) throw new Error("本地登录态里没有可用的 token");
    return [["authorization", `Bearer ${token}`]];
  },

  // TRAE Work CN：它的凭据不在标准 OSCrypt 里，是自己一层 "tc" 信封（见 trae_cn_auth.rs）。
  // scheme 也不是 Bearer，是 Cloud-IDE-JWT。
  "trae-cn-local": async () => {
    const got = await invoke("trae_cn_auth_token");
    const token = String(got?.token || "");
    if (!token) throw new Error("本地登录态里没有可用的 token");
    const headers = [["authorization", `Cloud-IDE-JWT ${token}`]];
    // 缺设备号时服务端会拒；但没读到也不要把整条链路堵死——让请求发出去，错误由服务端给。
    if (got?.deviceId) headers.push(["x-device-id", String(got.deviceId)]);
    return headers;
  },
};

export const CREDENTIAL_SOURCES = Object.keys(SOURCES);

export function isCredentialSource(name) {
  return Object.prototype.hasOwnProperty.call(SOURCES, String(name || ""));
}

/** @returns {Promise<Array<[string, string]>>} 要覆盖到请求上的动态头 */
export async function resolveCredential(name) {
  const read = SOURCES[String(name || "")];
  if (!read) throw new Error(`未知的凭据来源：${name}`);
  return read();
}
