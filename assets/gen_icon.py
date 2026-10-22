#!/usr/bin/env python3
"""WorkPier App 图标生成：PIL 超采样绘制（2048 -> 1024）+ 生成完整 iconset"""
import os
import shutil
import subprocess

from PIL import Image, ImageDraw

S = 2  # 超采样倍率
BASE = 1024
BLUE = (0, 82, 217, 255)  # #0052D9


def draw_cloud(draw: ImageDraw.ImageDraw, dx: int, dy: int, s: int) -> None:
    """云形：三圆 + 圆角底板（几何与 assets/icon.svg 保持一致）"""
    def circle(cxx, cyy, r):
        return [
            dx + (cxx - r) * s, dy + (cyy - r) * s,
            dx + (cxx + r) * s, dy + (cyy + r) * s,
        ]

    WHITE = (255, 255, 255, 255)
    draw.ellipse(circle(530, 505, 140), fill=WHITE)   # 主 puff
    draw.ellipse(circle(415, 570, 90), fill=WHITE)    # 左
    draw.ellipse(circle(630, 580, 80), fill=WHITE)    # 右
    draw.rounded_rectangle(
        [dx + 400 * s, dy + 560 * s, dx + 660 * s, dy + 660 * s],
        radius=40 * s, fill=WHITE,
    )


def make_master() -> Image.Image:
    size = BASE * S
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # squircle 底板
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(base)
    d.rounded_rectangle(
        [102 * S, 102 * S, 922 * S, 922 * S], radius=190 * S, fill=BLUE,
    )
    img = Image.alpha_composite(img, base)

    # 三层云：后层(半透明, 右上偏移) -> 中层 -> 前层
    for dx, dy, alpha in ((112, -112, 66), (56, -56, 97), (0, 0, 255)):
        layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        draw_cloud(ld, dx, dy, S)
        # 按形状自身 alpha 缩放到目标不透明度（空白区域保持透明）
        a = layer.getchannel("A").point(lambda v: v * alpha // 255)
        layer.putalpha(a)
        img = Image.alpha_composite(img, layer)

    return img.resize((BASE, BASE), Image.LANCZOS)


def main() -> None:
    out_dir = os.path.dirname(os.path.abspath(__file__))
    master = make_master()
    master.save(os.path.join(out_dir, "master-1024.png"))

    iconset = os.path.join(out_dir, "workpier.iconset")
    shutil.rmtree(iconset, ignore_errors=True)
    os.makedirs(iconset)

    sizes = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }
    for name, px in sizes.items():
        master.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, name))

    icns = os.path.join(out_dir, "workpier.icns")
    subprocess.run(
        ["iconutil", "-c", "icns", iconset, "-o", icns], check=True,
    )
    print("OK:", icns)


if __name__ == "__main__":
    main()
