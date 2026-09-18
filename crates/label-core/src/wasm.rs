// WASM 导出层：给 JS 调用的最小接口。
//
// 为什么不用 wasm-bindgen：它会引入一整套工具链（wasm-pack、JS glue 生成、额外的 JS 胶水文件），
// 而这里只需要「传一段 JSON 进去、拿一段 JSON 出来」——用裸的 `extern "C"` 导出 +
// 手写十几行内存读写就够了，产物也只有几十 KB。少一层工具链就少一类"本地能编、CI 编不过"的问题。
//
// 内存协议（JS 侧照此实现，见 mobile/app/platform/labelEngine.js）：
//   1) JS 调 `alloc(len)` 拿到一块 wasm 内存的指针，把 UTF-8 字节写进去；
//   2) JS 调 `layout_json(ptr, len)`，返回**结果字符串的指针**；
//   3) JS 调 `last_len()` 拿结果长度，从内存读出 UTF-8 字节；
//   4) JS 调 `release_last()` 释放结果（**不需要传长度**，见下）。
//
// ⚠️ 关于释放：结果的容量由 wasm 侧记着，`release_last()` 自己按真实容量释放。
// 早先的设计是让 JS 传 `last_len()` 回去释放，但那会崩——`Vec::into_raw_parts` 之后
// 容量可能大于长度（String 增长时的预留），用 len 去 dealloc 会触发分配器断言
// `__rdl_dealloc`（实测踩过）。**让分配方负责释放**是唯一稳妥的做法。

use std::alloc::{alloc as rust_alloc, dealloc as rust_dealloc, Layout as AllocLayout};

use crate::{build_render_payload, Settings};

/// 上次结果的长度与容量（由 wasm 侧记录，释放时按容量来）。
static mut LAST_LEN: usize = 0;
static mut LAST_CAP: usize = 0;
static mut LAST_PTR: *mut u8 = std::ptr::null_mut();

/// 分配一块内存给 JS 写入参数。返回指针；len 为 0 时返回 1（非空指针，避免 JS 侧判空）。
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return 1 as *mut u8;
    }
    // 对齐 1 即可：这里只放 UTF-8 字节
    unsafe { rust_alloc(AllocLayout::from_size_align_unchecked(len, 1)) }
}

/// 释放 alloc 分配的内存。
#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if len == 0 || ptr.is_null() {
        return;
    }
    unsafe { rust_dealloc(ptr, AllocLayout::from_size_align_unchecked(len, 1)) }
}

/// 上次结果的字节长度。
#[no_mangle]
pub extern "C" fn last_len() -> usize {
    unsafe { LAST_LEN }
}

/// 释放上次 `layout_json` / `source_json` 返回的内存。
///
/// 由 wasm 侧按**真实容量**释放，JS 不需要（也不该）传长度——见文件头关于 `__rdl_dealloc` 的说明。
/// 重复调用是安全的（释放后指针置空）。
#[no_mangle]
pub extern "C" fn release_last() {
    unsafe {
        if !LAST_PTR.is_null() && LAST_CAP > 0 {
            rust_dealloc(LAST_PTR, AllocLayout::from_size_align_unchecked(LAST_CAP, 1));
        }
        LAST_PTR = std::ptr::null_mut();
        LAST_LEN = 0;
        LAST_CAP = 0;
    }
}

/// 排版：入参是 Settings 的 JSON，返回 Render 的 JSON。
///
/// 与桌面端 `label_layout` 命令走的是**同一个** build_render_payload——
/// 这就是「所见即所打」的实现方式：两端不是"看起来一样"，而是同一份代码算出来的。
#[no_mangle]
pub extern "C" fn layout_json(ptr: *const u8, len: usize) -> *mut u8 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    let text = match std::str::from_utf8(input) {
        Ok(value) => value,
        Err(error) => return error_json(&format!("参数不是合法 UTF-8：{error}")),
    };
    let settings: Settings = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(error) => return error_json(&format!("参数不是合法设置：{error}")),
    };
    match serde_json::to_string(&build_render_payload(&settings)) {
        Ok(json) => into_result(json),
        Err(error) => error_json(&format!("序列化失败：{error}")),
    }
}

/// 只算 TSPL 指令文本（不含预览绘制模型），用于"想快速看指令"或校验。
///
/// 与 `layout_json` 的区别只是少构造 DrawItem —— 布局与指令仍来自同一份 `layout`/`build_source`，
/// 所以两者永远不会互相矛盾。
#[no_mangle]
pub extern "C" fn source_json(ptr: *const u8, len: usize) -> *mut u8 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    let text = match std::str::from_utf8(input) {
        Ok(value) => value,
        Err(error) => return error_json(&format!("参数不是合法 UTF-8：{error}")),
    };
    let settings: Settings = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(error) => return error_json(&format!("参数不是合法设置：{error}")),
    };
    let layout = crate::layout(&settings.label, &settings.job);
    let source = crate::build_source(&settings.label, &layout, settings.job.copies);
    into_result(serde_json::json!({ "source": source }).to_string())
}

/// 把字符串交给 JS：记下长度与**容量**，返回指针。
/// 所有权转移给 JS 的读取阶段，由 `release_last()` 按容量释放。
fn into_result(text: String) -> *mut u8 {
    // 先释放上一次的结果，避免连续调用时泄漏
    release_last();
    let mut bytes = text.into_bytes();
    let len = bytes.len();
    let cap = bytes.capacity();
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes); // 交给 JS 读取，由 release_last 释放
    unsafe {
        LAST_LEN = len;
        LAST_CAP = cap;
        LAST_PTR = ptr;
    }
    ptr
}

/// 错误也走同一条返回路径（JS 侧按 __error 字段判定），不 panic——
/// wasm 里 panic 会直接把整个模块废掉，比返回错误糟得多。
fn error_json(message: &str) -> *mut u8 {
    into_result(format!("{{\"__error\":{}}}", serde_json::to_string(message).unwrap_or_else(|_| "\"未知错误\"".into())))
}
