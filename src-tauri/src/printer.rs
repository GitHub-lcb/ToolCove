//! Windows 打印后台（Print Spooler）交互。
//!
//! 标签打印机（如佳博 GP-2120TF）自带 TSPL 指令解释器，工具发的是打印指令而不是位图，
//! 所以这里只需要做两件事：
//!
//!   1. 列出本机已安装的打印机（[`list_printers`]，带默认机标记）
//!   2. 把原始字节流直接塞进打印队列（[`print_raw`]，datatype = RAW）
//!
//! 只用到 `winspool.drv` 里少量导出函数，因此手写 FFI，不引入额外 crate，
//! 免得跟着 windows-sys 的 API 变动来回改。
//! 移植自 print-tool（佳博 GP-2120TF 标签打印工具）的 printer.rs。

use std::ffi::{c_void, OsStr};
use std::os::windows::ffi::OsStrExt;

type Handle = *mut c_void;
type Bool = i32;

/// DOC_INFO_1W
#[repr(C)]
struct DocInfo1W {
    doc_name: *const u16,
    output_file: *const u16,
    data_type: *const u16,
}

/// PRINTER_INFO_4W（level 4，只需要名字，结构最简单）
#[repr(C)]
struct PrinterInfo4W {
    printer_name: *mut u16,
    server_name: *mut u16,
    attributes: u32,
}

const PRINTER_ENUM_LOCAL: u32 = 0x0000_0002;
const PRINTER_ENUM_CONNECTIONS: u32 = 0x0000_0004;

#[link(name = "winspool")]
extern "system" {
    fn OpenPrinterW(name: *const u16, handle: *mut Handle, defaults: *const c_void) -> Bool;
    fn ClosePrinter(handle: Handle) -> Bool;
    fn StartDocPrinterW(handle: Handle, level: u32, info: *const DocInfo1W) -> u32;
    fn EndDocPrinter(handle: Handle) -> Bool;
    fn StartPagePrinter(handle: Handle) -> Bool;
    fn EndPagePrinter(handle: Handle) -> Bool;
    fn WritePrinter(handle: Handle, buf: *const c_void, len: u32, written: *mut u32) -> Bool;
    fn EnumPrintersW(
        flags: u32,
        name: *const u16,
        level: u32,
        buf: *mut u8,
        cb_buf: u32,
        needed: *mut u32,
        returned: *mut u32,
    ) -> Bool;
    fn GetDefaultPrinterW(buf: *mut u16, size: *mut u32) -> Bool;
}

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 读取以 NUL 结尾的宽字符串。
unsafe fn from_wide(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while *p.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
}

/// 把 Win32 错误码翻译成人话。
fn last_error(context: &str) -> String {
    let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    let msg = match code {
        0 => "系统没有返回错误码".to_string(),
        2 => "找不到指定的打印机（系统错误 2）".to_string(),
        5 => "拒绝访问（系统错误 5），请确认当前账户有打印权限".to_string(),
        1801 => "打印机名称无效（系统错误 1801），请点「刷新」重新选择".to_string(),
        1722 => "RPC 服务器不可用（系统错误 1722），Print Spooler 服务可能没有启动".to_string(),
        _ => format!("系统错误 {code}：{}", std::io::Error::from_raw_os_error(code)),
    };
    format!("{context}：{msg}")
}

/// 一台已安装的打印机。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
}

/// 系统默认打印机名。
pub fn default_printer() -> Option<String> {
    unsafe {
        let mut size: u32 = 0;
        GetDefaultPrinterW(std::ptr::null_mut(), &mut size);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u16; size as usize];
        if GetDefaultPrinterW(buf.as_mut_ptr(), &mut size) == 0 {
            return None;
        }
        let name = from_wide(buf.as_ptr());
        if name.is_empty() {
            None
        } else {
            Some(name)
        }
    }
}

/// 列出本机已安装的打印机（含网络连接），按名称排序并标记默认机。
pub fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    let default = default_printer();
    unsafe {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut needed: u32 = 0;
        let mut returned: u32 = 0;

        // 第一次调用只为拿所需缓冲区大小
        EnumPrintersW(
            flags,
            std::ptr::null(),
            4,
            std::ptr::null_mut(),
            0,
            &mut needed,
            &mut returned,
        );
        if needed == 0 {
            return Ok(Vec::new());
        }

        // 用 u64 分配，保证 PRINTER_INFO_4W 需要的指针对齐
        let mut buf: Vec<u64> = vec![0; (needed as usize).div_ceil(8)];
        let ok = EnumPrintersW(
            flags,
            std::ptr::null(),
            4,
            buf.as_mut_ptr() as *mut u8,
            needed,
            &mut needed,
            &mut returned,
        );
        if ok == 0 {
            return Err(last_error("枚举打印机失败"));
        }

        let infos = std::slice::from_raw_parts(buf.as_ptr() as *const PrinterInfo4W, returned as usize);
        let mut names: Vec<String> = infos
            .iter()
            .filter(|i| !i.printer_name.is_null())
            .map(|i| from_wide(i.printer_name))
            .filter(|n| !n.is_empty())
            .collect();
        names.sort_by_key(|n| n.to_lowercase());
        names.dedup();

        Ok(names
            .into_iter()
            .map(|name| PrinterInfo {
                is_default: default.as_deref() == Some(name.as_str()),
                name,
            })
            .collect())
    }
}

/// 把原始字节流交给打印队列（datatype = RAW）。
///
/// 注意：驱动里的纸张尺寸最好和实际标签一致，个别驱动会按驱动纸张分页；
/// 实际版面由 TSPL 的 `SIZE` 指令决定。
pub fn print_raw(printer: &str, data: &[u8], doc_name: &str) -> Result<(), String> {
    if printer.trim().is_empty() {
        return Err("没有选择打印机".to_string());
    }
    if data.is_empty() {
        return Err("打印内容为空".to_string());
    }

    unsafe {
        let name = to_wide(printer);
        let mut handle: Handle = std::ptr::null_mut();
        if OpenPrinterW(name.as_ptr(), &mut handle, std::ptr::null()) == 0 {
            return Err(last_error(&format!("打开打印机「{printer}」失败")));
        }

        let doc = to_wide(doc_name);
        let raw = to_wide("RAW");
        let info = DocInfo1W {
            doc_name: doc.as_ptr(),
            output_file: std::ptr::null(),
            data_type: raw.as_ptr(),
        };

        let job = StartDocPrinterW(handle, 1, &info);
        if job == 0 {
            let err = last_error("创建打印任务失败");
            ClosePrinter(handle);
            return Err(err);
        }

        let mut result = Ok(());

        if StartPagePrinter(handle) == 0 {
            result = Err(last_error("开始打印页失败"));
        } else {
            let mut offset = 0usize;
            while offset < data.len() {
                let rest = &data[offset..];
                let chunk = &rest[..rest.len().min(u32::MAX as usize)];
                let mut written: u32 = 0;
                let ok = WritePrinter(
                    handle,
                    chunk.as_ptr() as *const c_void,
                    chunk.len() as u32,
                    &mut written,
                );
                if ok == 0 {
                    result = Err(last_error("发送数据到打印机失败"));
                    break;
                }
                if written == 0 {
                    result = Err("打印机拒绝接收数据（写入 0 字节）".to_string());
                    break;
                }
                offset += written as usize;
            }
            EndPagePrinter(handle);
        }

        if EndDocPrinter(handle) == 0 && result.is_ok() {
            result = Err(last_error("结束打印任务失败"));
        }
        ClosePrinter(handle);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widening_adds_nul_terminator() {
        assert_eq!(to_wide("AB"), vec![0x41, 0x42, 0x00]);
    }

    #[test]
    fn rejects_empty_input() {
        assert!(print_raw("", b"x", "t").is_err());
        assert!(print_raw("打印机", b"", "t").is_err());
    }

    /// 不依赖真实设备，只验证枚举接口能正常返回。
    #[test]
    fn enumerate_does_not_panic() {
        match list_printers() {
            Ok(list) => println!("发现 {} 台打印机: {list:?}", list.len()),
            Err(e) => println!("枚举失败(环境相关): {e}"),
        }
    }
}
