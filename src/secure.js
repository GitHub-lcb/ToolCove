// 敏感配置加密（Windows DPAPI，经 Rust 命令 encrypt_text/decrypt_text）
// 约定：加密值以 "enc:" 前缀标记，明文兼容旧数据（保存时会自动转加密）。
import { invoke } from "@tauri-apps/api/core";

// 敏感数据必须加密成功才允许保存，避免 DPAPI 异常时降级为明文落盘。
export async function encryptValue(v) {
  if (!v || v.startsWith("enc:")) return v;
  return "enc:" + (await invoke("encrypt_text", { plain: String(v) }));
}

// 带 enc: 前缀才解；明文原样返回兼容旧数据。解密失败向上抛出，不能把密文
// 片段当成可用密码继续请求或再次保存。
export async function decryptValue(v) {
  if (!v || !v.startsWith("enc:")) return v;
  return await invoke("decrypt_text", { cipher: v.slice(4) });
}
