// TRAE Work CN 本地登录态读取：和 Qoder CN 同一套思路——运行时读当场要用的那一份，
// 不再让用户抓包抄 token，也不在磁盘上留一份会过期的副本。
//
// TRAE 把凭据存在 %APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json 的
// iCubeAuthInfo://icube.cloudide 里，外面套了一层它自己的信封（魔数 "tc"）。
// 这层信封用的两个 64 字节表来自 TRAE 自己分发的代码：
//   out-build/vs/platform/iCubeAuth/electron-main/components/userStorage.js 里的 Woe / Voe
// 它是**全局常量**——不绑定机器、不绑定用户，任何装了 TRAE 的人都能解任何人的这个文件。
// 所以这是混淆，不是访问控制；这里复现它只是为了让本机用户读到自己的登录态。
//
// 同样刻意只读不写：不刷新、不回写、不落盘、不进日志。

use base64::Engine;
use serde::Serialize;
use sha2::Digest;
use std::path::{Path, PathBuf};

// 信封头 6 字节（"tc" + 版本），随后 32 字节随机盐，再往后是 AES-128-CBC 密文；
// 明文前 64 字节是内层头，要丢掉，末尾是 PKCS7 填充。这几个数字与 userStorage.js
// 里的 Jm=6 / uv=32 / OO=16 / bh=64 一一对应。
const HEADER_LEN: usize = 6;
const SALT_LEN: usize = 32;
const INNER_PREFIX_LEN: usize = 64;
const MAX_BLOB: usize = 1 << 20;

/// userStorage.js 的 Woe 与 Voe：异或之后才是派生用的盐。
const TABLE_A: [u8; 64] = [
    82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68,
    196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178,
    118, 91, 162, 73, 109, 139, 209, 37,
];
const TABLE_B: [u8; 64] = [
    31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159,
    147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214,
    38, 225, 105, 20, 99, 85, 33, 12, 125,
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraeAuth {
    pub token: String,
    /// TRAE 用的是自定义 scheme，不是 Bearer。
    pub scheme: String,
    /// 接口 base host 就存在凭据里（实测 https://api.trae.cn），不要写死域名。
    pub host: String,
    pub expires_at: String,
    /// aha 注册的设备号；claim 接口缺了它会被拒。
    pub device_id: String,
}

fn appdata() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

fn derive_key(rb: &[u8]) -> ([u8; 16], [u8; 16]) {
    let salt: Vec<u8> = TABLE_A.iter().zip(TABLE_B.iter()).map(|(a, b)| a ^ b).collect();
    let h = sha2::Sha512::digest(rb);
    let mut mix = sha2::Sha512::new();
    mix.update(h);
    mix.update(salt);
    let fh = mix.finalize();
    let mut key = [0u8; 16];
    let mut iv = [0u8; 16];
    key.copy_from_slice(&fh[..16]);
    iv.copy_from_slice(&fh[16..32]);
    (key, iv)
}

fn unpad(mut data: Vec<u8>) -> Vec<u8> {
    match data.last() {
        Some(&n) if (1..=16).contains(&n) && data.len() >= n as usize => {
            data.truncate(data.len() - n as usize);
            data
        }
        _ => {
            while data.last() == Some(&0) {
                data.pop();
            }
            data
        }
    }
}

/// AES-128-CBC 解密：用 aes 的 ECB 单块解密自己串链，不引 cbc crate。
/// （P_i = D(C_i) XOR C_{i-1}，C_{-1} = iv）
fn cbc_decrypt128(key: &[u8], iv: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    use aes::cipher::{Block, BlockDecrypt, KeyInit};
    if data.len() % 16 != 0 {
        return Err("密文长度不是分组大小的整数倍".into());
    }
    let cipher = aes::Aes128::new_from_slice(key).map_err(|_| "密钥长度非法".to_string())?;
    let mut prev = iv.to_vec();
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks_exact(16) {
        let mut block: Block<aes::Aes128> = Default::default();
        for i in 0..16 {
            block[i] = chunk[i];
        }
        cipher.decrypt_block(&mut block);
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev.copy_from_slice(chunk);
    }
    Ok(out)
}

/// 解开一层 "tc" 信封。输入是 storage.json / TinyStorage 里那个 base64 字符串。
fn open_envelope(encoded: &str) -> Result<Vec<u8>, String> {
    let buf = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("凭据不是合法 base64: {e}"))?;
    if buf.len() > MAX_BLOB {
        return Err("凭据异常偏大，拒绝解析".into());
    }
    if buf.len() < HEADER_LEN + SALT_LEN + 16 {
        return Err("凭据长度不对".into());
    }
    if &buf[..2] != b"tc" {
        return Err(format!("不支持的信封格式（魔数 {:?}）", &buf[..2]));
    }
    let (key, iv) = derive_key(&buf[HEADER_LEN..HEADER_LEN + SALT_LEN]);
    let data = cbc_decrypt128(&key, &iv, &buf[HEADER_LEN + SALT_LEN..])?;
    if data.len() < INNER_PREFIX_LEN {
        return Err("解密结果过短".into());
    }
    Ok(unpad(data[INNER_PREFIX_LEN..].to_vec()))
}

fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{} 不是合法 JSON: {e}", path.display()))
}

fn value_str(v: Option<&serde_json::Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// aha 的设备记录解出来是一段 JSON，不是裸设备号：
///   {"device_id_str":"766808751080906","install_id_str":"…","uuid":"…","version":"1.2"}
/// 整串当设备号发出去，服务端会回一句「当前参与用户太多」这种通用文案（实测踩过 9074）。
fn read_device_id(dir: &Path) -> Result<String, String> {
    let tiny = read_json(&dir.join("aha").join("TinyStorage"))?;
    let store = tiny.get("tiny_storage_data").unwrap_or(&tiny);
    let encoded = store
        .get("aha.device.device_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "aha/TinyStorage 里没有 aha.device.device_id".to_string())?;
    let plain: serde_json::Value =
        serde_json::from_slice(&open_envelope(encoded)?).map_err(|_| "设备号记录不是合法 JSON".to_string())?;
    let id = plain
        .get("device_id_str")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if !is_safe_header_value(&id) {
        return Err("设备号记录里没有 device_id_str".into());
    }
    Ok(id)
}

/// TRAE 的 token 会直接进 HTTP 头，字符必须收口：一个 \r\n 就是一条注入出去的响应头。
fn is_safe_header_value(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 2048
        && text.bytes().all(|b| b.is_ascii_graphic() || b == b' ')
}

#[tauri::command]
pub fn trae_cn_auth_token() -> Result<TraeAuth, String> {
    let root = match appdata() {
        Some(dir) => dir,
        None => return Err("找不到 %APPDATA% 目录".to_string()),
    };
    // 国际版与 CN 的目录名不同；这里只认 CN。
    let mut last_error = String::new();
    for name in ["TRAE SOLO CN", "Trae CN"] {
        let dir = root.join(name);
        let result = (|| -> Result<TraeAuth, String> {
            let storage = read_json(&dir.join("User").join("globalStorage").join("storage.json"))?;
            let wrapped = storage
                .get("iCubeAuthInfo://icube.cloudide")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "storage.json 里没有 iCubeAuthInfo://icube.cloudide（TRAE 未登录或格式已变）".to_string())?;
            let auth: serde_json::Value = serde_json::from_slice(&open_envelope(wrapped)?)
                .map_err(|_| "登录态内容不是合法 JSON".to_string())?;
            let token = value_str(auth.get("token"));
            if !is_safe_header_value(&token) {
                return Err("登录态里没有可用的 token".into());
            }
            // 设备号读不到时不拦：让请求发出去，由服务端给准确错误
            let device_id = read_device_id(&dir).unwrap_or_default();
            Ok(TraeAuth {
                token,
                scheme: "Cloud-IDE-JWT".into(),
                host: value_str(auth.get("host")),
                expires_at: value_str(auth.get("expiredAt")),
                device_id,
            })
        })();
        match result {
            Ok(auth) => return Ok(auth),
            Err(e) => last_error = format!("{name}: {e}"),
        }
    }
    Err(last_error)
}

#[cfg(test)]
mod tests {
    use super::{open_envelope, unpad};
    use base64::Engine;

    #[test]
    fn rejects_non_tc_magic() {
        // 要长过 头6+盐32+一个分组16，否则会先被长度检查拦下、测不到魔数那条分支
        let bogus = base64::engine::general_purpose::STANDARD.encode(&[b'x'; 60]);
        assert!(open_envelope(&bogus).unwrap_err().contains("魔数"));
    }

    #[test]
    fn bad_base64_and_short_input_do_not_panic() {
        assert!(open_envelope("!!!not base64!!!").is_err());
        assert!(open_envelope(&base64::engine::general_purpose::STANDARD.encode(b"tc\x05\x10")).is_err());
    }

    #[test]
    fn accepts_both_pkcs7_and_zero_padding() {
        let mut data = b"payload".to_vec();
        data.extend(std::iter::repeat(0x09).take(9));
        assert_eq!(unpad(data), b"payload");
        let mut zeros = b"payload".to_vec();
        zeros.extend(std::iter::repeat(0).take(6));
        assert_eq!(unpad(zeros), b"payload");
    }
}

#[cfg(all(test, windows))]
mod windows_live_tests {
    /// 真机验证：读的是本机当前登录用户自己的 TRAE 登录态，需要这台机器装过并登录过 TRAE Work CN。
    /// CI 与别人的机器上必然失败，所以默认跳过。
    /// 用法：cargo test trae_cn_auth -- --ignored --nocapture
    #[test]
    #[ignore]
    fn reads_live_trae_credential_on_this_machine() {
        let auth = super::trae_cn_auth_token().expect("本机应能读到 TRAE 登录态");
        // 断言与输出里都不出现 token / 设备号本身，只验形状与元信息。
        assert!(auth.token.starts_with("eyJ"), "token 不像 JWT");
        assert!(auth.host.starts_with("https://"), "host 形状不对: {}", auth.host);
        assert!(!auth.expires_at.is_empty(), "响应里没有 expiredAt");
        // 设备号必须是取出来的那一个字段，不能是整条 JSON 记录——曾经把整串发出去，
        // 服务端回的是「当前参与用户太多」这种通用文案，看着像限流，其实是请求错了。
        assert!(
            auth.device_id.len() <= 64 && !auth.device_id.contains('{') && !auth.device_id.contains('"'),
            "设备号形状不对（像是整条记录）"
        );
        println!("host={} expiredAt={} token长度={} 设备号长度={}", auth.host, auth.expires_at, auth.token.len(), auth.device_id.len());
    }
}
