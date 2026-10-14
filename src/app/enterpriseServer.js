// 企业服务器配置的**本地**持久化与启动恢复（二期）。
//
// 为什么配置不走 invoke 数据桥（settings.json）：数据桥在企业配置生效后整体路由到远端，
// 配置若也存远端就是自举悖论——要读配置得先连服务器，要连服务器得先读配置。
// 因此配置落 localStorage（桌面 WebView / 浏览器 / 手机端都有），token 按 secure.js
// 惯例加密（桌面 DPAPI / 安卓 Keystore；浏览器端为明文往返，见 backends/browser.js 的说明）。
import { configureRemote } from "../platform/remoteStore.js";
import { encryptValue, decryptValue } from "../secure.js";

const STORAGE_KEY = "toolcove.enterpriseServer";

function storage() {
  // Node 单测环境没有 localStorage：按「无配置」处理，不抛错
  return typeof localStorage === "undefined" ? null : localStorage;
}

/** 保存配置（连接测试成功后调用）：baseUrl 非敏感明文存，token 加密后存。 */
export async function saveEnterpriseConfig({ baseUrl, token }) {
  const payload = { baseUrl: String(baseUrl || "").trim(), tokenEnc: await encryptValue(String(token || "").trim()) };
  storage()?.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function clearEnterpriseConfig() {
  storage()?.removeItem(STORAGE_KEY);
}

/** 读回配置（设置页回填表单 + 启动恢复共用）；无配置或数据损坏返回 null。 */
export async function loadEnterpriseConfig() {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.baseUrl !== "string" || !parsed.baseUrl) return null;
    return { baseUrl: parsed.baseUrl, token: await decryptValue(parsed.tokenEnc || "") };
  } catch {
    return null;
  }
}

/**
 * 启动恢复：main.js 在首屏数据加载（initLocale/runMigrations）之前调用，
 * 把本地配置灌回数据桥——恢复完成之后的 load_data/save_data 才会路由到企业服务器。
 */
export async function restoreEnterpriseConfig() {
  const config = await loadEnterpriseConfig();
  configureRemote(config && config.token ? config : null);
  return config;
}
