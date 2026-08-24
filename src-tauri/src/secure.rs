
// ------- 敏感配置加密（Windows DPAPI，当前用户作用域）-------
// settings.json 里的 token / 邮件密码 / AI key 明文落盘可被直接读取，
// 保存时经 DPAPI 加密（前缀 enc:），读取时解密；仅限当前 Windows 用户可解开。
#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        let in_blob = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr() as *mut u8 };
        let mut out_blob = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = unsafe {
            CryptProtectData(
                &in_blob,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        if ok == 0 {
            return Err("DPAPI 加密失败".into());
        }
        let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
        unsafe { LocalFree(out_blob.pbData as _) };
        Ok(out)
    }

    pub fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
        let in_blob = CRYPT_INTEGER_BLOB { cbData: cipher.len() as u32, pbData: cipher.as_ptr() as *mut u8 };
        let mut out_blob = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = unsafe {
            CryptUnprotectData(
                &in_blob,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        if ok == 0 {
            return Err("DPAPI 解密失败".into());
        }
        let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
        unsafe { LocalFree(out_blob.pbData as _) };
        Ok(out)
    }
}

/// 加密字符串：返回 base64（前端存 settings.json 时加 enc: 前缀）
#[tauri::command]
pub fn encrypt_text(plain: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        use base64::Engine;
        let blob = dpapi::protect(plain.as_bytes())?;
        return Ok(base64::engine::general_purpose::STANDARD.encode(blob));
    }
    #[cfg(not(windows))]
    {
        Ok(plain) // 非 Windows 平台降级为明文（本项目仅 Windows）
    }
}

/// 解密字符串：入参为 encrypt_text 的 base64 输出
#[tauri::command]
pub fn decrypt_text(cipher: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(cipher.trim())
            .map_err(|e| format!("密文格式错误: {e}"))?;
        let plain = dpapi::unprotect(&bytes)?;
        return String::from_utf8(plain).map_err(|e| format!("解密结果非 UTF-8: {e}"));
    }
    #[cfg(not(windows))]
    {
        Ok(cipher)
    }
}
