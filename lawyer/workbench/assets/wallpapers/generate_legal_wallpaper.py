#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「法律工作台」品牌高清壁纸（深藏青 · 专业 · 抽象天平纹样）。
产出：legal-navy.jpg (2560x1440)  参考桌面8的清爽/结构感，但做成我们自己的法律风。
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 2560, 1440
ACCENT = (79, 140, 255)      # #4f8cff
NAVY = (10, 15, 36)          # 深藏青
NAVY2 = (18, 27, 58)
NAVY3 = (28, 40, 82)


def smooth_gradient(w, h):
    # 对角渐变 + 次级色相偏移，藏青 → 靛蓝
    x = np.linspace(0, 1, w)[None, :]
    y = np.linspace(0, 1, h)[:, None]
    t = 0.55 * x + 0.45 * y          # 对角
    top = np.array(NAVY, float)
    bot = np.array(NAVY3, float)
    mid = np.array(NAVY2, float)
    # 两段平滑插值
    base = np.where(t[..., None] < 0.5,
                    top + (mid - top) * (t[..., None] / 0.5),
                    mid + (bot - mid) * ((t[..., None] - 0.5) / 0.5))
    return base


def vignette(img):
    # 边缘轻微变暗，聚焦中心
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = w / 2, h / 2
    r = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / (np.sqrt(cx * cx + cy * cy))
    v = 1.0 - 0.28 * np.clip(r - 0.5, 0, 1) ** 1.6
    img *= v[..., None]
    return img


def grain(img, strength=6.0):
    # 细腻颗粒，避免渐变色带
    noise = np.random.normal(0, strength, img.shape[:2])[..., None]
    img = img + noise
    return np.clip(img, 0, 255)


def add_low_grid(base):
    # 细网格线（结构感，参考桌面8）
    over = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    step = 96
    for x in range(0, W, step):
        d.line([(x, 0), (x, H)], fill=(255, 255, 255, 8))
    for y in range(0, H, step):
        d.line([(0, y), (W, y)], fill=(255, 255, 255, 8))
    base.convert("RGBA").alpha_composite(over)


def radial_glow_rgba(cx, cy, r, color, alpha):
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(glow)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (alpha,))
    return glow.filter(ImageFilter.GaussianBlur(180))


def draw_balance(cx, cy, scale, color, alpha):
    # 抽象"天平"纹样：中柱 + 横梁 + 三挂盘 + 外环
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = scale
    # 外环（细）
    d.ellipse([cx - 1.35 * s, cy - 1.35 * s, cx + 1.35 * s, cy + 1.35 * s], outline=color + (alpha,), width=max(2, int(s * 0.02)))
    # 中柱
    d.line([(cx, cy - 0.95 * s), (cx, cy + 0.95 * s)], fill=color + (alpha,), width=max(2, int(s * 0.03)))
    # 横梁
    d.line([(cx - 1.1 * s, cy - 0.42 * s), (cx + 1.1 * s, cy - 0.42 * s)], fill=color + (alpha,), width=max(2, int(s * 0.03)))
    # 支点
    d.polygon([(cx, cy - 0.30 * s), (cx - 0.10 * s, cy - 0.42 * s), (cx + 0.10 * s, cy - 0.42 * s)], fill=color + (alpha,))
    # 两侧吊盘（三角）
    for dirx in (-1, 1):
        px = cx + dirx * 1.1 * s
        # 吊线
        d.line([(px, cy - 0.42 * s), (px, cy - 0.10 * s)], fill=color + (alpha,), width=max(2, int(s * 0.02)))
        # 盘（倒三角 + 圆底）
        d.polygon([(px, cy - 0.10 * s), (px - 0.42 * s, cy + 0.42 * s), (px + 0.42 * s, cy + 0.42 * s)],
                  outline=color + (alpha,), width=max(2, int(s * 0.025)))
        d.ellipse([px - 0.42 * s, cy + 0.42 * s - 0.04 * s, px + 0.42 * s, cy + 0.42 * s + 0.04 * s],
                  fill=color + (alpha,))
    return img


def main():
    base = smooth_gradient(W, H)
    base = vignette(base)
    base = grain(base)
    img = Image.fromarray(base.astype(np.uint8), "RGB").convert("RGBA")

    # 背景结构网格（低透明度）
    add_low_grid(img)

    # 主纹样（偏右，低透明度，蓝强调）
    emblem = draw_balance(int(W * 0.70), int(H * 0.50), int(H * 0.30), ACCENT, 56)
    img.alpha_composite(emblem)

    # 纹样后方氛围光
    glow = radial_glow_rgba(int(W * 0.70), int(H * 0.50), int(H * 0.55), ACCENT, 52)
    img.alpha_composite(glow)

    # 次级靛蓝/紫氛围（左下）
    glow2 = radial_glow_rgba(int(W * 0.16), int(H * 0.82), int(H * 0.48), (110, 60, 210), 34)
    img.alpha_composite(glow2)
    # 顶部淡青蓝微光
    glow3 = radial_glow_rgba(int(W * 0.5), int(H * -0.05), int(H * 0.55), (120, 200, 255), 26)
    img.alpha_composite(glow3)

    # 左上角一道淡蓝斜光（纵深）
    streak = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(streak)
    sd.polygon([(0, 0), (int(W * 0.5), 0), (int(W * 0.20), H), (0, int(H * 0.75))], fill=(140, 180, 255, 16))
    streak = streak.filter(ImageFilter.GaussianBlur(120))
    img.alpha_composite(streak)

    out = img.convert("RGB")
    path = os.path.join(HERE, "legal-navy.jpg")
    out.save(path, quality=92)
    print("wrote", path, out.size)


if __name__ == "__main__":
    main()
