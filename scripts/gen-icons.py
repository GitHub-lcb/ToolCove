#!/usr/bin/env python3
"""ToolCove 图标切图脚本。

两套母版：
- 大尺寸母版 src-tauri/icons/icon.png（手工稿）：用于 128/256 帧与 Store 磁贴。
- 小尺寸母版（本脚本程序化绘制）：圆角品牌渐变底 + 加粗白色环与笑脸，
  用于 16/24/32/48/64 帧（任务栏/托盘/alt-tab 实际渲染区间）。

改品牌时：同步修改 icon.png 与本脚本几何/配色，然后重跑本脚本。
依赖：pillow。用法：python scripts/gen-icons.py
"""
import struct
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"
SS = 4096  # 超采样边长，最后 LANCZOS 降到 1024 消锯齿

# 品牌色（与 src/App.vue --grad-brand 对齐）
GRAD = ((0, (0x09, 0x69, 0xDA)), (0.55, (0x44, 0x93, 0xF8)), (1.0, (0x79, 0xC0, 0xFF)))
FACE = (0xF8, 0xFA, 0xFC)
INK = 0x0969DA  # 笑脸上的眼睛/嘴，白底上对比度约 5:1


def _lerp_stops(t):
    for (t0, c0), (t1, c1) in zip(GRAD, GRAD[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * k) for a, b in zip(c0, c1))
    return GRAD[-1][1]


def gradient_1024():
    lut = [_lerp_stops(i / 2046) for i in range(2047)]
    data = []
    for y in range(1024):
        data.extend(lut[x + y] for x in range(1024))
    return Image.frombytes("RGB", (1024, 1024), bytes(b for px in data for b in px))


def _mask():
    return Image.new("L", (SS, SS), 0)


def _circle(d, cx, cy, r):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)


def build_small_master():
    s = SS / 1024.0

    bg = _mask()
    ImageDraw.Draw(bg).rounded_rectangle([0, 0, SS - 1, SS - 1], radius=int(225 * s), fill=255)

    outer, inner = _mask(), _mask()
    _circle(ImageDraw.Draw(outer), 512 * s, 512 * s, 450 * s)
    _circle(ImageDraw.Draw(inner), 512 * s, 512 * s, 355 * s)
    ring = ImageChops.subtract(outer, inner)

    face = _mask()
    fw, cx, cy = 500 * s, 512 * s, 522 * s
    ImageDraw.Draw(face).rounded_rectangle(
        [cx - fw / 2, cy - fw / 2, cx + fw / 2, cy + fw / 2], radius=int(140 * s), fill=255
    )

    eyes = _mask()
    d = ImageDraw.Draw(eyes)
    _circle(d, (512 - 105) * s, (522 - 45) * s, 52 * s)
    _circle(d, (512 + 105) * s, (522 - 45) * s, 52 * s)

    wedge, hole = _mask(), _mask()
    sr, scx, scy = 150 * s, 512 * s, 500 * s
    ImageDraw.Draw(wedge).pieslice([scx - sr, scy - sr, scx + sr, scy + sr], 20, 160, fill=255)
    _circle(ImageDraw.Draw(hole), scx, scy, (150 - 60) * s)
    smile = ImageChops.subtract(wedge, hole)

    down = lambda im: im.resize((1024, 1024), Image.LANCZOS)
    bg, ring, face, eyes, smile = (down(im) for im in (bg, ring, face, eyes, smile))

    out = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    out.paste(gradient_1024(), (0, 0), bg)
    out.paste(Image.new("RGBA", (1024, 1024), (*FACE, 255)), (0, 0), ImageChops.lighter(ring, face))
    out.paste(Image.new("RGBA", (1024, 1024), (*INK.to_bytes(3, "big"), 255)), (0, 0), ImageChops.lighter(eyes, smile))
    return out


def write_ico(path, frames):
    blobs = []
    for size, im in frames:
        buf = __import__("io").BytesIO()
        im.save(buf, format="PNG")
        blobs.append((size, buf.getvalue()))
    header = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries, payload = b"", b""
    for size, data in blobs:
        b = 0 if size == 256 else size
        entries += struct.pack("<BBBBHHII", b, b, 0, 0, 1, 32, len(data), offset)
        payload += data
        offset += len(data)
    path.write_bytes(header + entries + payload)


def main():
    small = build_small_master()
    large = Image.open(ICONS / "icon.png").convert("RGBA")

    small.save(ICONS / "icon-small.png")
    for size in (32, 64):
        small.resize((size, size), Image.LANCZOS).save(ICONS / f"{size}x{size}.png")

    frames = [(s, small.resize((s, s), Image.LANCZOS)) for s in (32, 16, 24, 48, 64)]
    frames += [(s, large.resize((s, s), Image.LANCZOS)) for s in (128, 256)]
    write_ico(ICONS / "icon.ico", frames)

    order = ", ".join(f"{s}x{s}" for s, _ in frames)
    print("icon.ico frames:", order)


if __name__ == "__main__":
    main()
