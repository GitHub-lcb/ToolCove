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

  // Qoder 国际版（Qoder IDE）：device token 同样是 dt- 前缀，目录与文件名都不同
  // （com.qoder.app.stable\auth.v1.dat，而 CN 是 com.qodercn.app.stable\auth.v1.dat）。
  //
  // 国际版还必须带 umid 机器身份三件套（见 workbuddy_cn_auth.rs 之外的 qoder_intl_auth.rs）：
  // campaigns 接口按机器身份下发每日签到轮次，**缺这组头时不报错，只回常驻的 VIEW_DETAILS 横幅**——
  // 表现与「今天没有活动」一模一样，但那是假的。CN 版不受此门控，不需要这组头。
  "qoder-intl-local": async () => {
    const got = await invoke("qoder_intl_auth_token");
    const token = String(got?.token || "");
    if (!token) throw new Error("本地登录态里没有可用的 token");
    const headers = [["authorization", `Bearer ${token}`]];
    // 读不到机器身份时不抛错：让请求照发（行为退回「只看到横幅」），
    // 好过把整个签到站点报成不可用——后者会让人以为要重装客户端。
    if (got?.machineToken && got?.machineCode && got?.machineType) {
      headers.push(["cosy-machineToken", String(got.machineToken)]);
      headers.push(["cosy-machineCode", String(got.machineCode)]);
      headers.push(["cosy-machineType", String(got.machineType)]);
    }
    return headers;
  },

  // TRAE CN：它的凭据不在标准 OSCrypt 里，是自己一层 "tc" 信封（见 trae_cn_auth.rs）。
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

  // WorkBuddy CN：token 是裸 JWT（见 workbuddy_cn_auth.rs），scheme 是自己拼的 Bearer。
  // uid / domain 只是服务端用来定位账号的元信息，缺了不影响鉴权，所以不给它们抛错。
  "workbuddy-cn-local": async () => {
    const got = await invoke("workbuddy_cn_auth_token");
    const token = String(got?.token || "");
    if (!token) throw new Error("本地登录态里没有可用的 token");
    const headers = [["authorization", `Bearer ${token}`]];
    if (got?.uid) headers.push(["x-user-id", String(got.uid)]);
    if (got?.domain) headers.push(["x-domain", String(got.domain)]);
    // 企业号的计费按企业维度走；个人号没有这个字段，不能凭空加一个空头。
    if (got?.enterpriseId) {
      headers.push(["x-enterprise-id", String(got.enterpriseId)]);
      headers.push(["x-tenant-id", String(got.enterpriseId)]);
    }
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
