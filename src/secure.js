// 敏感配置加密（Windows DPAPI，经 Rust 命令 encrypt_text/decrypt_text）
// 约定：加密值以 "enc:" 前缀标记，明文兼容旧数据（保存时会自动转加密）。
import { invoke } from "./platform/invoke.js";

// 敏感数据必须加密成功才允许保存，避免 DPAPI 异常时降级为明文落盘。
//
// 三种平台把结果包成不同形状：桌面 Rust 返回裸字符串、浏览器实现同样裸字符串、
// 安卓桥返回 {cipher}/{plain}。按裸串拼接会让手机端把 AI Key 存成 "enc:[object Object]"（不可逆）。
export async function encryptValue(v) {
  if (!v || v.startsWith("enc:")) return v;
  const out = await invoke("encrypt_text", { plain: String(v) });
  const cipher = typeof out === "string" ? out : String(out?.cipher ?? "");
  if (!cipher) throw new Error("加密没有返回密文");
  return "enc:" + cipher;
}

// 带 enc: 前缀才解；明文原样返回兼容旧数据。解密失败向上抛出，不能把密文
// 片段当成可用密码继续请求或再次保存。
export async function decryptValue(v) {
  if (!v || !v.startsWith("enc:")) return v;
  const out = await invoke("decrypt_text", { cipher: v.slice(4) });
  return typeof out === "string" ? out : String(out?.plain ?? "");
}
