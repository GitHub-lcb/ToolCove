// 临时压测（不提交）：截图链路各阶段耗时。
// 跑法：cd src-tauri && cargo run --example capture_bench          （debug，对应 tauri dev）
//       cd src-tauri && cargo run --release --example capture_bench （release，对应正式包）
use std::time::Instant;

use image::ImageEncoder;

fn main() {
    let t = Instant::now();
    let mut monitors = xcap::Monitor::all().expect("枚举显示器失败");
    monitors.sort_by_key(|m| (m.x().unwrap_or(0), m.y().unwrap_or(0)));
    println!("Monitor::all()          : {:?}（{} 块屏）", t.elapsed(), monitors.len());

    for (i, m) in monitors.iter().enumerate() {
        let (w, h, scale) = (
            m.width().unwrap_or(0),
            m.height().unwrap_or(0),
            m.scale_factor().unwrap_or(1.0),
        );
        let t = Instant::now();
        let img = m.capture_image().expect("捕获失败");
        let capture = t.elapsed();

        let t = Instant::now();
        let mut default_bytes = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut default_bytes), image::ImageFormat::Png)
            .unwrap();
        let enc_default = t.elapsed();

        let t = Instant::now();
        let mut fast_bytes = Vec::new();
        image::codecs::png::PngEncoder::new_with_quality(
            &mut std::io::Cursor::new(&mut fast_bytes),
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Adaptive,
        )
        .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
        .unwrap();
        let enc_fast = t.elapsed();

        let t = Instant::now();
        let mut fastest_bytes = Vec::new();
        image::codecs::png::PngEncoder::new_with_quality(
            &mut std::io::Cursor::new(&mut fastest_bytes),
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::NoFilter,
        )
        .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
        .unwrap();
        let enc_fastest = t.elapsed();

        let t = Instant::now();
        let mut sub_bytes = Vec::new();
        image::codecs::png::PngEncoder::new_with_quality(
            &mut std::io::Cursor::new(&mut sub_bytes),
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Sub,
        )
        .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
        .unwrap();
        let enc_sub = t.elapsed();

        let t = Instant::now();
        let mut up_bytes = Vec::new();
        image::codecs::png::PngEncoder::new_with_quality(
            &mut std::io::Cursor::new(&mut up_bytes),
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Up,
        )
        .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
        .unwrap();
        let enc_up = t.elapsed();

        println!(
            "屏 {i}（{w}x{h} @{scale:.2}）: capture {capture:?} | 默认 {enc_default:?}（{:.1}MB）| Fast+NoFilter {enc_fastest:?}（{:.1}MB）| Fast+Sub {enc_sub:?}（{:.1}MB）| Fast+Up {enc_up:?}（{:.1}MB）",
            default_bytes.len() as f64 / 1e6,
            fastest_bytes.len() as f64 / 1e6,
            sub_bytes.len() as f64 / 1e6,
            up_bytes.len() as f64 / 1e6,
        );
        let _ = (enc_fast, fast_bytes);
    }
}
