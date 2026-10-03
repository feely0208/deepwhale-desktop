#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「青色大肥鱼」桌面宠物（spritesheet 标准：manifest.json + spritesheet.png + preview.png）。

背景（2026-10-03 用户要求）：
    「我想再根据我们的青色大肥鱼做一个桌面宠物，一个小女娃太单调了」
    「动作要流畅不要生硬，动作也多一些，包括身下有海浪之类的，你自己拿主意」
→ 所以这里不做"整图刚性旋转"那种廉价动画，而是：
    ① **逐列亚像素波动**（premultiplied 双线性插值）—— 身体像真的在游，尾巴摆幅大于头部；
    ② **呼吸式挤压拉伸**（squash & stretch）；
    ③ **身下海浪**：软边水面（越往下越深、左右两端渐隐）+ 浪脊高光 + 泡沫线，
       鲸鱼腹部会被水面盖住 → 有"浮在水上/半潜"的感觉；
    ④ 水花、水柱、气泡、速度线按状态各自驱动；
    ⑤ 单循环 8~12 帧，帧时长由 manifest 的 speed 控制（pet.js 按真实时间推进，不用定时器漂移）。

素材：assets/pet-src/whale-clean.png（官方 logo 那条带喷水的青鲸，透明底、无字标）。
用法：
    python3 scripts/make-whale-pet.py             # 生成到 assets/pets/大青鲸/
    python3 scripts/make-whale-pet.py --preview   # 额外输出总览图 + 动图到 /tmp（肉眼验收）
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "pet-src", "whale-clean.png")
OUT_DIR = os.path.join(ROOT, "assets", "pets", "青色大肥鱼")

CELL = 200          # 单元格边长（方形，和宠物窗口一致，避免拉伸）
SPOUT_ART_SCALE = 2.0  # 喷泉素材层按 2 倍分辨率保底：放大时是从源分辨率缩下来，不糊
COLS = 12           # 最大帧数
DISPLAY_NAME = "青色大肥鱼"

# 深鲸品牌色
CYAN = (20, 165, 184)
CYAN_L = (150, 226, 240)
CYAN_D = (10, 96, 138)
DEEP = (7, 62, 104)
WHITE = (255, 255, 255)
FOAM = (236, 250, 255)

TAU = math.pi * 2


# ───────────────────────────── 素材 ─────────────────────────────

def _dilate(mask: np.ndarray, iterations: int = 1) -> np.ndarray:
    for _ in range(iterations):
        mask = (mask | np.roll(mask, 1, 0) | np.roll(mask, -1, 0)
                | np.roll(mask, 1, 1) | np.roll(mask, -1, 1))
    return mask


def _components(mask: np.ndarray):
    """8 邻域连通域标记（不引 scipy，够用就好）。返回 (标签图, [每域的像素坐标列表])。"""
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    comps = []
    for y0, x0 in zip(*np.nonzero(mask)):
        if lab[y0, x0]:
            continue
        cid = len(comps) + 1
        stack = [(int(y0), int(x0))]
        lab[y0, x0] = cid
        pts = []
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = cid
                        stack.append((ny, nx))
        comps.append(pts)
    return lab, comps


def load_whale():
    """载入素材 → 抠掉静态喷泉 → 缩放。

    为什么要抠：原图那束喷水是"死"的，只会跟着身体晃。用户要求头顶喷水做成动效，
    所以把它去掉，改由 draw_spout() 逐帧程序化绘制（脉冲水柱 + 抛物线水珠）。

    怎么抠准（试错两轮才稳）：
      ① 喷泉是**浅青**色，但背脊上沿/尾鳍/腹部边缘也都有浅青高光 —— 只按颜色抠会啃掉身体；
      ② 于是先按颜色取浅青（在左上角喷泉活动区内），再做**连通域**：
         与图顶（喷泉被画布裁掉的那一截）相连的那一坨就是主喷泉柱，
         其余只挑**完全落在主柱包围盒附近**的小块（那就是飞溅的水珠）；
      ③ 背脊那条高光很长、一直延伸出去，包围盒超出范围 → 自动被排除。
    返回 (鲸鱼图, 喷口坐标)。
    """
    if not os.path.exists(SRC):
        sys.exit(f"找不到素材：{SRC}")
    im = Image.open(SRC).convert("RGBA")
    arr = np.asarray(im).astype(np.int16)
    H, W = arr.shape[:2]
    R, G, B = arr[..., 0], arr[..., 1], arr[..., 2]
    alpha = arr[..., 3]
    lum = R * 0.299 + G * 0.587 + B * 0.114
    yy = np.arange(H, dtype=np.int32)[:, None]
    xx = np.arange(W, dtype=np.int32)[None, :]

    light_cyan = (
        (alpha > 40) & ((B - R) > 25) & (lum > 170)
        & (xx < W * 0.5) & (yy < H * 0.5)          # 喷泉只在左上角活动
    )
    lab, comps = _components(light_cyan)
    if not comps:
        sys.exit("没找到喷泉区域，素材或判据变了")

    # 主喷泉柱 = 区域里最大的那一坨（喷泉被画布裁过顶，顶上一小截可能和柱身断开，
    # 但它的包围盒落在主柱范围内，下面按"包围盒附近"的规则会被一并收进来）
    top_id = 1 + int(np.argmax([len(c) for c in comps]))
    main_pts = comps[top_id - 1]
    my = [p[0] for p in main_pts]
    mx = [p[1] for p in main_pts]
    by0, by1, bx0, bx1 = min(my), max(my), min(mx), max(mx)

    spout = np.zeros_like(light_cyan)
    for i, pts in enumerate(comps, start=1):
        if len(pts) < 4:
            continue
        py = [p[0] for p in pts]
        px = [p[1] for p in pts]
        inside = (min(px) >= bx0 - 18 and max(px) <= bx1 + 18
                  and min(py) >= by0 - 18 and max(py) <= by1 + 18)
        if i == top_id or inside:
            for (py_, px_) in pts:
                spout[py_, px_] = True
    spout_px = int(spout.sum())

    # 喷口取**主柱自己**的最底一行 —— 合并进来的水珠可能落在更下方，
    # 用合并后的掩码去找会把喷口算到身体中间去（第一次就是这么错的）。
    my_ys = [p[0] for p in main_pts]
    my_xs = [p[1] for p in main_pts]
    ybot = max(my_ys)
    root_x = float(np.mean([x for y, x in zip(my_ys, my_xs) if y >= ybot - 2]))
    root_y = float(ybot)

    # ★ 2026-10-03 定稿：不再程序化"画"水柱（试了两版，用户看着像灰漏斗/细水管）。
    #   改为**把原画这束水花整块抠出来**当动画层 —— 形状是设计师画的，好看；
    #   动画只负责"长高↔回落"的缩放 + 少量飞溅水珠，喷得动、又不失真。
    ys_all, xs_all = np.nonzero(spout)
    sx0, sx1 = int(xs_all.min()), int(xs_all.max())
    sy0, sy1 = int(ys_all.min()), int(ys_all.max())
    spout_src = im.crop((sx0, sy0, sx1 + 1, sy1 + 1))
    root_in_spout = (root_x - sx0, root_y - sy0)

    # 抹掉喷泉（向外扩 1 像素，避免边缘残留彩边）
    arr[_dilate(spout, 1)] = [0, 0, 0, 0]
    im = Image.fromarray(arr.astype(np.uint8), "RGBA")

    bbox = im.getbbox()
    if bbox:
        left, top = bbox[0], bbox[1]
        im = im.crop(bbox)
    else:
        left = top = 0

    target_w = int(CELL * 0.82)
    scale = target_w / im.width
    target_h = max(1, round(im.height * scale))
    out = im.resize((target_w, target_h), Image.LANCZOS)

    # 喷泉水花层按同一比例缩放，喷口锚点也跟着缩
    # 喷泉层留 2 倍分辨率（用户要求喷水再大一号；直接放大一份缩小过的层会发糊）
    sp_s = scale * SPOUT_ART_SCALE
    spout_img = spout_src.resize(
        (max(1, round(spout_src.width * sp_s)), max(1, round(spout_src.height * sp_s))),
        Image.LANCZOS,
    )
    spout_root = (root_in_spout[0] * sp_s, root_in_spout[1] * sp_s)

    blowhole = ((root_x - left) * scale, (root_y - top) * scale)
    print(f"   抠掉喷泉 {spout_px} px；喷口在鲸鱼图内的坐标 ≈ ({blowhole[0]:.1f}, {blowhole[1]:.1f})"
          f" / 图 {out.width}×{out.height}；水花层 {spout_img.width}×{spout_img.height}")
    return out, blowhole, spout_img, spout_root


def draw_spout(ox: float, oy: float, t: float, spout_img: Image.Image, root,
               floor: float = 0.30, peak: float = 1.05, drops: int = 4) -> Image.Image:
    """把原画那束水花当动画层：一个循环里走完「猛冲 → 顿住 → 回落」。

    为什么不用程序化画水柱（试过两版，都被用户否了）：
      多层半透明叠色在深色桌面上发灰 → 像银色漏斗；改成实色窄柱 → 又像一根细水管。
      手绘的水花形状（扇形水柱 + 水珠）根本不是几条多边形能凑出来的。
    → 所以直接**复用设计师画的那束水花**：整块抠出来，按"喷口"锚点做纵向缩放，
      再补几颗飞溅水珠；形状永远是对的，动画只负责"喷得动"。

    floor/peak：缩放（喷高）的下限与峰值；drops：额外飞溅水珠数量。
    """
    ss = 1
    im = Image.new("RGBA", (CELL * ss, CELL * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(im, "RGBA")

    # 递进包络：0→0.34 猛冲（缓出）、0.34→0.54 顿在最高处、0.54→1 回落（缓入）
    up_end, hold_end = 0.34, 0.54
    if t < up_end:
        env = 1.0 - (1.0 - t / up_end) ** 2.2
    elif t < hold_end:
        env = 1.0
    else:
        u = (t - hold_end) / (1.0 - hold_end)
        env = 1.0 - u ** 1.7
    env = floor + (1.0 - floor) * env

    # 喷高 = floor..peak 之间缩放；横向略窄一点，长高时更有"冲"的感觉
    sy = (floor + (peak - floor) * env) / SPOUT_ART_SCALE
    sx = (0.90 + 0.16 * (env - floor) / max(1e-6, (1.0 - floor))) / SPOUT_ART_SCALE
    sway = 0.05 * math.sin(t * TAU * 0.5 + 1.1)      # 轻微左右摆

    scaled = spout_img.resize(
        (max(1, round(spout_img.width * sx)), max(1, round(spout_img.height * sy))),
        Image.LANCZOS,
    )
    px = ox - root[0] * sx + sway * spout_img.width
    py = oy - root[1] * sy
    im.alpha_composite(scaled, (round(px), round(py)))

    # 额外飞溅水珠：分批发射，抛物线起落（让"喷"的感觉更明显）
    crown_y = py                                        # 水花顶点附近
    crown_h = max(4.0, spout_img.height * sy * 0.9)
    for k in range(drops):
        launch = 0.10 + 0.50 * (k / max(1, drops - 1))
        age = (t - launch) % 1.0
        life = 0.60
        if age > life:
            continue
        sg = age / life
        rnd = (math.sin(k * 12.9898) * 43758.5453) % 1.0
        ang = ((k / max(1, drops - 1)) - 0.5) * 2.0
        rise = crown_h * (0.30 + 0.35 * rnd)
        x = ox + ang * (crown_h * 0.32) * (0.25 + sg)
        y = crown_y - 4.0 * rise * sg * (1.0 - sg)
        r = 1.0 + 1.5 * (1.0 - sg)
        col = FOAM if (k % 3 == 0) else CYAN_L
        d.ellipse([(x - r), (y - r), (x + r), (y + r)], fill=col + (235,))

    return im


# ─────────────────────── 亚像素形变（游动/呼吸） ───────────────────────

def warp_columns(img: Image.Image, dy_of_x, dx_of_x=None) -> Image.Image:
    """按列做亚像素竖直（可选水平）位移，模拟游动时的身体波动。

    关键点：先把颜色按 alpha 预乘再插值，最后还原 —— 否则透明边缘会插出
    黑边/彩边（这是最容易被看出来的"脏"）。
    """
    arr = np.asarray(img).astype(np.float32)
    h, w = arr.shape[:2]
    alpha = arr[..., 3:4] / 255.0
    prem = arr[..., :3] * alpha

    xs = np.arange(w, dtype=np.float32)[None, :]
    ys = np.arange(h, dtype=np.float32)[:, None]

    sy = np.repeat(ys, w, axis=1) - dy_of_x(xs)
    sx = np.repeat(xs, h, axis=0)
    if dx_of_x is not None:
        sx = sx - dx_of_x(xs)

    y0 = np.floor(sy)
    x0 = np.floor(sx)
    wy = (sy - y0)[..., None]
    wx = (sx - x0)[..., None]
    y1, x1 = y0 + 1, x0 + 1

    def gather(fy, fx):
        yy = np.clip(fy, 0, h - 1).astype(np.int32)
        xx = np.clip(fx, 0, w - 1).astype(np.int32)
        inside = ((fy >= 0) & (fy <= h - 1) & (fx >= 0) & (fx <= w - 1))[..., None].astype(np.float32)
        return prem[yy, xx] * inside, alpha[yy, xx] * inside

    p00, a00 = gather(y0, x0)
    p01, a01 = gather(y0, x1)
    p10, a10 = gather(y1, x0)
    p11, a11 = gather(y1, x1)

    wp = p00 * (1 - wx) * (1 - wy) + p01 * wx * (1 - wy) + p10 * (1 - wx) * wy + p11 * wx * wy
    wa = a00 * (1 - wx) * (1 - wy) + a01 * wx * (1 - wy) + a10 * (1 - wx) * wy + a11 * wx * wy

    out = np.zeros((h, w, 4), dtype=np.float32)
    safe = np.maximum(wa, 1e-6)
    out[..., :3] = np.where(wa > 1e-4, wp / safe, 0)
    out[..., 3:4] = wa * 255.0
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def squash(img: Image.Image, sx: float, sy: float) -> Image.Image:
    w, h = img.size
    nw, nh = max(1, round(w * sx)), max(1, round(h * sy))
    out = img.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.alpha_composite(out, ((w - nw) // 2, (h - nh) // 2))
    return canvas


# ─────────────────────────── 身下的海浪 ───────────────────────────

def water_mask(x: np.ndarray, y: np.ndarray, t: float, base: float, amp: float,
               wl: float, alpha: float, soft: float, crest: float,
               bow: tuple | None = None) -> tuple:
    """返回 (水面深度场, 水面线)。全 numpy 计算 → 天然平滑，无锯齿。

    ⚠️ 这版是用户明确认可过的（"水波可以的"），别再"顺手优化"它 ——
    2026-10-03 我一度把它改成细亮线，反而没了原来的浪感。
    """
    phase = t * TAU
    line = (
        base
        + amp * np.sin(TAU * x / wl + phase)
        + amp * 0.35 * np.sin(TAU * x / (wl * 0.43) - phase * 1.6)
    )
    if bow is not None:
        # 船头把水推起来：水线局部抬高（浪脊/泡沫都跟着抬，视觉上就是"劈水前进"）
        bx, bh, bw = bow
        line = line - bh * np.exp(-((x - bx) / bw) ** 2)
    depth = y - line
    a = np.clip(depth / soft, 0.0, 1.0) * alpha
    # 越深越淡 → 是一条"浮着的浪带"，不是贴在桌面上的硬色块
    a = a * np.clip(1.0 - (depth - 10.0) / 26.0, 0.0, 1.0)
    # 浪脊：紧贴水面的一圈高光
    a = np.maximum(a, np.exp(-((depth - 1.5) / 2.2) ** 2) * crest * alpha)
    # 泡沫：水面上方一条柔和的白色带（随浪起伏）
    a = np.maximum(a, np.exp(-((depth + 2.6) / 2.0) ** 2) * (crest * 0.9))
    return a, line


def water_layer(t: float, base: float, amp: float, wl: float, alpha: float,
                soft: float = 7.0, crest: float = 0.55, sink: float = 0.0,
                bow: tuple | None = None) -> Image.Image:
    x = np.arange(CELL, dtype=np.float32)[None, :]
    y = np.arange(CELL, dtype=np.float32)[:, None]
    a, _ = water_mask(x, y, t, base + sink, amp, wl, alpha, soft, crest,
                      bow=(bow[0], bow[1], bow[2]) if bow else None)

    # 左右两端渐隐：避免一条硬邦邦的"水条"贴在透明桌面上
    edge = np.clip(np.minimum(x, CELL - 1 - x) / (CELL * 0.20), 0.0, 1.0)
    a = a * (edge ** 1.2)

    depth = np.clip((y - (base + sink)) / 46.0, 0.0, 1.0)
    col = np.zeros((CELL, CELL, 3), dtype=np.float32)
    for i in range(3):
        col[..., i] = CYAN_L[i] * (1 - depth[..., 0]) + DEEP[i] * depth[..., 0]
    # 泡沫偏白
    foam = np.clip(np.exp(-(((y - (base + sink)) + 2.6) / 2.0) ** 2), 0, 1) * 0.8
    for i in range(3):
        col[..., i] = col[..., i] * (1 - foam) + FOAM[i] * foam

    out = np.zeros((CELL, CELL, 4), dtype=np.float32)
    out[..., :3] = col
    out[..., 3] = np.clip(a, 0, 1) * 255.0
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def spray_layer(t: float, origin: tuple, count: int, spread: float, rise: float,
                size: float, alpha: float, seed: int = 7) -> Image.Image:
    """水柱/水花/气泡：超采样绘制再缩小 → 边缘平滑。"""
    ss = 4
    im = Image.new("RGBA", (CELL * ss, CELL * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(im, "RGBA")
    ox, oy = origin
    for k in range(count):
        rnd = math.sin(seed * 12.9898 + k * 78.233) * 43758.5453
        rnd = rnd - math.floor(rnd)
        phase = (t + k / max(1, count)) % 1.0
        x = ox + (rnd - 0.5) * spread + math.sin(phase * TAU) * spread * 0.18
        y = oy - phase * rise
        r = size * (0.55 + 0.75 * rnd) * (1 - phase * 0.55)
        a = int(alpha * (1 - phase) * 255)
        if a <= 6 or r <= 0:
            continue
        d.ellipse([(x - r) * ss, (y - r) * ss, (x + r) * ss, (y + r) * ss], fill=CYAN_L + (a,))
    return im.resize((CELL, CELL), Image.LANCZOS)


def splash_layer(strength: float, cy: float, width: float) -> Image.Image:
    """入水/跃起的水花弧 + 飞溅。"""
    if strength <= 0.01:
        return Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    ss = 4
    im = Image.new("RGBA", (CELL * ss, CELL * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(im, "RGBA")
    a = int(210 * min(1.0, strength))
    w = width * (0.7 + 0.5 * strength)
    cx = CELL / 2
    d.arc([(cx - w / 2) * ss, (cy - 12) * ss, (cx + w / 2) * ss, (cy + 12) * ss],
          start=195, end=345, fill=WHITE + (a,), width=3 * ss)
    d.arc([(cx - w * 0.34) * ss, (cy - 26) * ss, (cx + w * 0.34) * ss, (cy + 6) * ss],
          start=200, end=340, fill=FOAM + (int(a * 0.8),), width=2 * ss)
    for k, dx in enumerate((-0.42, -0.2, 0.05, 0.3, 0.46)):
        px = cx + dx * w
        py = cy - 18 - strength * 26 - (k % 3) * 6
        r = 3.2 - (k % 2)
        d.ellipse([(px - r) * ss, (py - r) * ss, (px + r) * ss, (py + r) * ss], fill=FOAM + (a,))
    return im.resize((CELL, CELL), Image.LANCZOS)


def churn_layer(t: float, ox: float, oy: float, scale: float, alpha: float) -> Image.Image:
    """劈浪层：船头卷起的水墙 + 沿船身翻涌的白泡沫 + 水雾 + 向后拖的水流。

    ox/oy：船头与水线交点；scale：水墙高度（px）。只为"冲刺划水"用，其它动作保持干净水面。
    用户要的是"披荆斩棘、浪花翻涌"——所以这层故意画得比常规浪大一号：
    外缘浅青、内里亮白，泡沫一路从船头翻到船尾。
    """
    ss = 4
    im = Image.new("RGBA", (CELL * ss, CELL * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(im, "RGBA")

    def P(x, y):
        return (x * ss, y * ss)

    u = scale / 30.0  # 以 30px 水墙为基准等比缩放

    # ① 船头水墙：向前上方卷起的水舌（两层：浅青外缘 + 亮白内芯）
    for j, (grow, col, a) in enumerate(((1.0, CYAN_L, 130), (0.7, FOAM, 200))):
        pulse = 0.82 + 0.18 * math.sin(t * TAU * 2 + j * 1.7)
        h = scale * grow * pulse
        d.polygon([
            P(ox + 3 * u, oy + 2),
            P(ox - 4 * u, oy - h * 0.22),
            P(ox - 2 * u, oy - h * 0.55),
            P(ox + 5 * u, oy - h * 0.85),
            P(ox + 14 * u, oy - h),
            P(ox + 23 * u, oy - h * 0.80),
            P(ox + 27 * u, oy - h * 0.42),
            P(ox + 30 * u, oy + 2),
        ], fill=col + (a,))

    # ② 沿船身翻涌的白泡沫（一簇簇冒上来，向后漂）
    for k in range(7):
        ph = (t * 1.6 + k / 7.0) % 1.0
        x = ox + (10 + k * 12) * u
        y = oy + 2 - 2.0 * math.sin(ph * TAU)
        r = (1.8 + 3.0 * abs(math.sin(ph * TAU))) * u
        a = int(alpha * 255 * (0.30 + 0.55 * abs(math.sin(ph * TAU))))
        if a <= 8:
            continue
        d.ellipse([P(x - r, y - r * 0.62), P(x + r, y + r * 0.62)], fill=FOAM + (a,))

    # ③ 向后拖的水流（细长streak，越往后越淡）
    for k in range(4):
        ph = (t + k * 0.25) % 1.0
        ln = (26 + 30 * abs(math.sin(ph * TAU))) * u
        x0 = ox + (34 + k * 9) * u
        y0 = oy + 1 + k * 2.0
        a = int(alpha * 150 * (1 - k / 5.0) * (0.4 + 0.6 * abs(math.sin(ph * TAU))))
        if a <= 8:
            continue
        d.line([P(x0, y0), P(x0 + ln, y0 - 1.5)], fill=CYAN_L + (a,), width=max(1, int(1.6 * ss)))

    # ④ 水雾：船头上方几团很淡的白雾
    for k in range(4):
        ph = (t * 0.9 + k * 0.25) % 1.0
        x = ox + (2 + k * 7) * u
        y = oy - (scale * 0.9) - 6 * u - 4 * math.sin(ph * TAU)
        r = (9 + 7 * abs(math.sin(ph * TAU))) * u
        a = int(46 * alpha * (0.5 + 0.5 * abs(math.sin(ph * TAU))))
        if a <= 6:
            continue
        d.ellipse([P(x - r, y - r * 0.55), P(x + r, y + r * 0.55)], fill=FOAM + (a,))

    return im.resize((CELL, CELL), Image.LANCZOS)


def bow_splash_layer(t: float, ox: float, oy: float, scale: float, alpha: float) -> Image.Image:
    """船头水花：几根斜向上方的短水柱 + 抛物线水珠，做出"劈水"的观感。"""
    ss = 4
    im = Image.new("RGBA", (CELL * ss, CELL * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(im, "RGBA")
    for k in range(4):
        ph = (t + k * 0.25) % 1.0
        grow = math.sin(math.pi * ph)
        ln = scale * (0.55 + 0.80 * grow)
        ang = math.radians(96 + k * 9)          # 朝左前上方（素材朝左）
        x1 = ox + math.cos(ang) * ln
        y1 = oy - math.sin(ang) * ln
        a = int(alpha * 255 * (0.28 + 0.72 * grow))
        if a <= 8 or ln <= 1:
            continue
        d.line([ox * ss, oy * ss, x1 * ss, y1 * ss], fill=CYAN_L + (a,),
               width=max(1, int((1.4 + 1.8 * grow) * ss)))
    for k in range(5):
        ph = (t + k / 5.0) % 1.0
        grow = math.sin(math.pi * ph)
        ang = math.radians(100 + (k - 2) * 14)
        dist = scale * (0.6 + 0.95 * grow)
        x = ox + math.cos(ang) * dist
        y = oy - math.sin(ang) * dist - 4.0 * grow
        r = 1.0 + 1.8 * (1 - ph)
        a = int(alpha * 255 * (1 - ph) * 0.9)
        if a <= 8:
            continue
        d.ellipse([(x - r) * ss, (y - r) * ss, (x + r) * ss, (y + r) * ss], fill=FOAM + (a,))
    return im.resize((CELL, CELL), Image.LANCZOS)


def wake_layer(t: float, to_right: bool, strength: float) -> Image.Image:
    """游动尾迹：尾巴后方水面上一圈圈扩散的涟漪（比"速度线"更融进水里）。"""
    ss = 4
    im = Image.new("RGBA", (CELL * ss, CELL * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(im, "RGBA")
    cx = CELL * (0.20 if to_right else 0.80)   # 尾巴那一侧
    for k in range(3):
        ph = (t + k * 0.33) % 1.0
        rx = 10 + 30 * ph
        ry = rx * 0.30
        a = int(150 * strength * (1 - ph))
        if a <= 4:
            continue
        cy = WATER_BASE + 2 + k * 4
        d.ellipse([(cx - rx) * ss, (cy - ry) * ss, (cx + rx) * ss, (cy + ry) * ss],
                  outline=FOAM + (a,), width=2 * ss)
    return im.resize((CELL, CELL), Image.LANCZOS)


# ─────────────────────────── 动作定义 ───────────────────────────
# 每个状态一个函数：输入 t∈[0,1) 与帧序号，输出这一帧。
# 统一约定：dy 负值向上、angle 正值顺时针。

def ball_layer(cx: float, cy: float, r: float, phase: float) -> Image.Image:
    """顶在鼻尖上的彩球：白底 + 青/深蓝条纹，条纹随 phase 平移 → 有"在滚"的感觉。"""
    ss = 4
    size = max(12, int(math.ceil(2 * r * ss)))
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    cc = (size - 1) / 2.0
    dist = np.sqrt((xx - cc) ** 2 + (yy - cc) ** 2)
    inside = dist <= r * ss

    rgb = np.full((size, size, 3), 252.0, dtype=np.float32)
    band_w = max(4.0, r * ss * 0.62)
    band = ((xx + phase * band_w * 2.0) % (band_w * 3.0))
    rgb[inside & (band < band_w)] = CYAN
    rgb[inside & (band >= band_w * 2.0)] = DEEP

    # 立体感：右下压暗、左上提亮
    shade = np.clip(1.12 - (0.55 * (xx - cc) + 0.80 * (yy - cc)) / (r * ss), 0.62, 1.06)
    rgb = np.clip(rgb * shade[..., None], 0, 255)
    alpha = np.where(inside, 255.0, 0.0)
    layer = Image.fromarray(np.dstack([rgb, alpha]).astype(np.uint8), "RGBA")
    # 超采样画完必须缩回去，否则球会大 ss 倍（第一次就栽在这）
    layer = layer.resize((max(1, round(size / ss)), max(1, round(size / ss))), Image.LANCZOS)
    out = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    out.alpha_composite(layer, (round(cx - layer.width / 2), round(cy - layer.height / 2)))
    return out


def _undulation(t: float, amp_tail: float, wl: float, cycles: float, width: float):
    """返回 dy_of_x：头尾摆动 —— 越靠尾（x 越大）摆幅越大。"""
    def dy(x):
        u = np.clip(np.asarray(x, dtype=np.float32) / max(1.0, width), 0.0, 1.0)
        grow = u ** 1.8
        return (amp_tail * grow) * np.sin(TAU * x / wl - t * TAU * cycles)
    return dy


WATER_BASE = CELL - 56.0  # 水面线（用户认可的浪带位置，别动）



# 每个动作的喷泉参数：(高度, 张开, 水珠数, 不透明度, 脉冲幅度)；None = 不喷
SPOUT = {
    # (喷高下限, 喷高峰值, 额外飞溅水珠数) —— 峰值整体调大一档
    "idle": (0.62, 1.34, 4),
    "swimming": (0.56, 1.28, 3),
    "waving": (0.42, 1.66, 8),
    "jumping": (0.46, 1.55, 6),
    "diving": (0.40, 1.08, 3),
    "dash": (0.46, 1.40, 4),
    "running-right": (0.52, 1.45, 5),
    "running-left": (0.52, 1.45, 5),
    "walking-right": (0.56, 1.38, 4),
    "walking-left": (0.56, 1.38, 4),
    "waiting": (0.62, 1.28, 3),
    "sleeping": (0.50, 1.04, 2),
    "review": (0.56, 1.36, 4),
    "look": (0.56, 1.32, 4),
}


def spout_origin(bx, by, dy_at_bh, img_w, img_h, sq, angle, left, top):
    """喷口经过 形变/挤压/旋转/粘贴 之后在单元格里的位置。"""
    px, py = bx, by + dy_at_bh
    cx, cy = img_w / 2.0, img_h / 2.0
    if sq:
        px = cx + (px - cx) * (1 + sq)
        py = cy + (py - cy) * (1 - sq)
    if angle:
        a = math.radians(angle)
        dx, dy_ = px - cx, py - cy
        px = cx + dx * math.cos(a) + dy_ * math.sin(a)
        py = cy - dx * math.sin(a) + dy_ * math.cos(a)
    return left + px, top + py


def render(base: Image.Image, blowhole, spout_img: Image.Image, spout_root,
           state: str, i: int, n: int) -> Image.Image:
    t = i / n
    cell = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))

    facing_right = state.endswith("-right")
    whale = base.transpose(Image.FLIP_LEFT_RIGHT) if facing_right else base

    def s(k):
        return math.sin(t * TAU * k)

    def c(k):
        return math.cos(t * TAU * k)

    dy = 0.0
    angle = 0.0            # 小幅倾斜（不扩张画布）
    pose = 0.0             # 姿态旋转（扩画布；站立/顶球/翻跟头用）
    center_pose = False    # 按"身体中心"定位（翻跟头要原地转）
    pose_scale = 1.0
    sq = 0.0
    und_amp, und_wl, und_cyc = 2.6, 150.0, 1.0
    water = dict(base=WATER_BASE, amp=3.2, wl=118.0, alpha=0.80, crest=0.5, sink=0.0)
    nozzle = None          # 尾迹气泡：(kind, count, spread, rise, size, alpha)
    bow = None             # 冲刺时鼻尖前的破水花：(count, spread, rise, size, alpha)
    bow_wave = None        # 冲刺时船头水面隆起：(高度, 宽度)
    bow_splash = 0.0       # 冲刺时船头水花尺度
    churn = 0.0            # 冲刺时劈浪层尺度
    splash = 0.0
    speed = 0.0
    ball = None            # (相对头顶的偏移, 半径, 滚动相位)

    if state == "idle":
        dy = -2.2 * s(1)
        sq = 0.018 * c(1)
        angle = 1.2 * math.sin(t * TAU + 0.7)
        und_amp, und_cyc = 2.8, 1.0
        water.update(amp=3.0, wl=124.0)
    elif state == "swimming":
        dy = -3.0 * s(1) - 1.5
        sq = 0.02 * c(2)
        angle = 1.6 * s(1)
        und_amp, und_cyc, und_wl = 6.4, 1.6, 128.0
        water.update(amp=4.6, wl=104.0, alpha=0.86)
        nozzle = ("trail", 5, 34, 52, 2.2, 0.4)
        speed = 0.7
    elif state == "waving":
        dy = -3.6 * abs(s(1))
        sq = 0.022 * c(2)
        angle = -2.4 * s(1)
        und_amp, und_cyc = 3.4, 1.2
        water.update(amp=4.0, wl=112.0, crest=0.7)
    elif state == "jumping":
        p = math.sin(t * math.pi)
        dy = -34.0 * p
        angle = -8.0 * math.cos(t * math.pi) * 0.9
        sq = 0.05 * p - 0.03
        und_amp, und_cyc = 5.0, 1.0
        water.update(amp=3.6, wl=110.0, crest=0.75)
        splash = max(0.0, 1.0 - p * 1.7)
    elif state == "flip":
        # 翻跟头：整只翻 360°，中间带一个小抛物线；结尾入水水花。
        # 用"绕中心"定位（不是贴水面），翻的时候才是原地打转而不是忽高忽低。
        # 方向：素材空间顺时针（PIL 负角）—— 朝左时看到的就是顺时针（向前翻）；
        # 朝右时画布会整体镜像，于是自然变成另一侧的"向前翻"。
        # ⚠️ 别再自作聪明加一行反向的：那次就是把朝右的翻跟头搞成了"向后翻"（用户：逆向）。
        pose = -360.0 * t
        pose_scale = 0.74
        center_pose = True
        und_amp, und_cyc = 2.2, 0.8
        water.update(amp=3.6, wl=110.0, crest=0.75)
        splash = max(0.0, (t - 0.76) / 0.24)
    elif state == "diving":
        dive = math.sin(t * math.pi)
        dy = 20.0 * dive
        angle = 7.0 * dive
        und_amp, und_cyc = 4.4, 1.2
        water.update(amp=3.0, wl=120.0, alpha=0.9, crest=0.6)
        nozzle = ("trail", 5, 30, 52, 2.8, 0.45)
    elif state == "dash":
        # 冲刺划水：身体前倾、尾巴高频大幅摆动、破水花 + 长尾迹 + 大浪。
        # 不新画素材，靠参数拉满 + 额外的鼻尖水花做出"冲"的观感。
        dy = -5.5 * s(2) - 2.5
        angle = -7.5 + 2.2 * s(2)
        sq = 0.02 * c(2)
        und_amp, und_cyc, und_wl = 11.0, 2.6, 100.0
        water.update(amp=8.0, wl=84.0, crest=0.95, alpha=0.9)
        nozzle = ("trail", 8, 44, 54, 2.4, 0.5)
        bow = (5, 30, 26, 2.6, 0.55)
        bow_wave = (11.0, 54.0)     # 船头水面隆起：(高度, 宽度)
        bow_splash = 34.0           # 船头水花尺度
        churn = 30.0                # 劈浪层尺度（水墙高度）
        speed = 2.1
    elif state in ("running-right", "running-left"):
        dy = -4.4 * s(2) - 2.0
        angle = (5.2 if not facing_right else -5.2) * 0.65 + 1.4 * s(2)
        sq = 0.03 * c(2)
        und_amp, und_cyc, und_wl = 8.2, 2.0, 118.0
        water.update(amp=6.2, wl=94.0, crest=0.8, alpha=0.86)
        nozzle = ("trail", 5, 34, 46, 2.2, 0.42)
        speed = 1.0
    elif state in ("walking-right", "walking-left"):
        dy = -3.0 * s(1) - 1.0
        angle = (2.6 if not facing_right else -2.6) + 0.8 * s(1)
        und_amp, und_cyc = 5.2, 1.3
        water.update(amp=4.4, wl=106.0, crest=0.6)
        nozzle = ("trail", 3, 26, 40, 2.0, 0.32)
    elif state == "standing":
        # 立在浪上：顺时针转 ~78° 让头朝上，尾部压在水线上，身体轻轻晃
        pose = -78.0 + 3.2 * s(1)
        pose_scale = 0.72
        dy = 1.4 * s(1)
        und_amp, und_cyc = 1.6, 0.8
        water.update(amp=3.0, wl=120.0, crest=0.6)
    elif state == "ball":
        # 顶球：立起来 + 鼻尖一个滚动的彩球
        pose = -80.0 + 2.6 * s(1)
        pose_scale = 0.62
        dy = 0.8 * s(1)
        und_amp, und_cyc = 1.2, 0.6
        water.update(amp=3.2, wl=116.0, crest=0.65)
        ball = (2.5 * s(1), 14.0, t)
    elif state == "waiting":
        dy = -1.8 * s(1)
        angle = 0.8 * s(1)
        und_amp, und_cyc = 2.0, 0.8
        water.update(amp=2.4, wl=140.0, crest=0.4)
    elif state == "sleeping":
        dy = -1.4 * s(1) + 1.2
        sq = 0.03 * c(1)
        und_amp, und_cyc = 1.6, 0.6
        water.update(amp=2.0, wl=150.0, alpha=0.85, crest=0.35)
    elif state == "review":
        dy = -2.0 * s(1)
        angle = -3.6 + 0.9 * s(1)
        und_amp, und_cyc = 2.4, 0.9
        water.update(amp=2.8, wl=130.0)
    elif state == "look":
        angle = 4.2 * s(1)
        dy = -2.0 * s(2)
        und_amp, und_cyc = 2.2, 1.0
        water.update(amp=2.6, wl=134.0)
    elif state == "failed":
        dy = 6.0 + 1.2 * s(1)
        angle = 9.5
        und_amp, und_cyc = 1.2, 0.5
        water.update(amp=1.6, wl=150.0, alpha=0.8, crest=0.25)
        whale = ImageEnhance.Brightness(ImageEnhance.Color(whale).enhance(0.30)).enhance(0.82)

    dy_fn = _undulation(t, und_amp, und_wl, und_cyc, whale.width)
    warped = warp_columns(whale, dy_fn)
    if sq:
        warped = squash(warped, 1 + sq, 1 - sq)
    if pose:
        warped = warped.rotate(pose, resample=Image.BICUBIC, expand=True)
    elif angle:
        warped = warped.rotate(angle, resample=Image.BICUBIC)
    if pose_scale != 1.0:
        warped = warped.resize(
            (max(1, round(warped.width * pose_scale)), max(1, round(warped.height * pose_scale))),
            Image.LANCZOS,
        )

    left = round((CELL - warped.width) / 2)
    if center_pose:
        top = round(WATER_BASE - 16 - warped.height / 2 + dy)
    else:
        top = round(WATER_BASE + 8 - warped.height + dy)
    cell.alpha_composite(warped, (left, top))

    # 动态喷泉：位置取"形变后"的喷口（用同一套变换算出来，不会脱位）
    spout_cfg = SPOUT.get(state)
    if spout_cfg and not pose:
        bx, by = blowhole
        sp_img, sp_root = spout_img, spout_root
        if facing_right:                       # 朝右游时，水花层与锚点一起镜像
            bx = base.width - bx
            sp_img = spout_img.transpose(Image.FLIP_LEFT_RIGHT)
            sp_root = (spout_img.width - spout_root[0], spout_root[1])
        dy_at_bh = float(np.asarray(dy_fn(np.array([[bx]], dtype=np.float32))).ravel()[0])
        sx, sy = spout_origin(bx, by, dy_at_bh, warped.width, warped.height,
                              sq, angle, left, top)
        cell.alpha_composite(draw_spout(sx, sy, t, sp_img, sp_root, *spout_cfg))

    # 身下的海浪（盖住腹部 → 半潜感）；冲刺时船头把水推起一个隆起
    if bow_wave:
        bwx = left + warped.width * 0.16
        water = dict(water, bow=(bwx, bow_wave[0], bow_wave[1]))
    cell.alpha_composite(water_layer(t, **water))
    if churn:
        cell.alpha_composite(churn_layer(
            t, left + warped.width * 0.13, WATER_BASE + 2.0, churn, 0.8))
    if bow_splash:
        cell.alpha_composite(bow_splash_layer(
            t, left + warped.width * 0.10, WATER_BASE + 3.0, bow_splash, 0.7))

    if speed > 0:
        cell.alpha_composite(wake_layer(t, facing_right, speed))
    if bow:
        bcnt, bspread, brise, bsize, bal = bow
        box = left + warped.width * (0.13 if not facing_right else 0.87)
        boy = top + warped.height * 0.50
        cell.alpha_composite(spray_layer(t, (box, boy), bcnt, bspread, brise, bsize, bal, seed=i + 11))
    if nozzle:
        kind, cnt, spread, rise, size, al = nozzle
        # 尾迹气泡：画在尾巴那一侧
        ox = left + warped.width * (0.96 if not facing_right else 0.04)
        oy = top + warped.height * 0.78
        cell.alpha_composite(spray_layer(t, (ox, oy), cnt, spread, rise, size, al, seed=i + 3))
    if ball is not None:
        offset, r, phase = ball
        cell.alpha_composite(ball_layer(CELL / 2 + offset, top - r - 1, r, phase))
    if splash > 0:
        cell.alpha_composite(splash_layer(splash, WATER_BASE, 96.0))
    return cell


# ───────────────────────────── 组装 ─────────────────────────────

# (state, 帧数, 每帧毫秒倍率)
ROWS = [
    # speed 是"每帧时长倍率"（配合壳的 petFrameMs 默认 80ms）：<1 更快、>1 更慢。
    # 2026-10-03 用户反馈"是不是帧率太低了"——确实，原来壳默认 130ms/帧 ≈ 7fps，一顿一顿的。
    ("idle", 12, 1.0),
    ("swimming", 12, 0.8),
    ("waving", 10, 0.9),
    ("jumping", 12, 0.8),
    ("flip", 12, 0.7),
    ("diving", 10, 0.9),
    ("dash", 12, 0.55),
    ("running-right", 12, 0.65),
    ("running-left", 12, 0.65),
    ("walking-right", 10, 0.85),
    ("walking-left", 10, 0.85),
    ("standing", 10, 1.0),
    ("ball", 10, 0.95),
    ("waiting", 8, 1.15),
    ("sleeping", 8, 1.45),
    ("review", 8, 1.05),
    ("look", 10, 1.0),
    ("failed", 6, 1.25),
]


def build() -> None:
    base, blowhole, spout_img, spout_root = load_whale()
    sheet = Image.new("RGBA", (CELL * COLS, CELL * len(ROWS)), (0, 0, 0, 0))
    rows_meta = []
    preview_src = None

    for r, (state, frames, speed) in enumerate(ROWS):
        assert frames <= COLS, f"{state} 帧数 {frames} 超过 {COLS} 列"
        for f in range(frames):
            cell = render(base, blowhole, spout_img, spout_root, state, f, frames)
            sheet.alpha_composite(cell, (f * CELL, r * CELL))
            if state == "idle" and f == 0:
                preview_src = cell
        rows_meta.append({"state": state, "row": r, "frames": frames, "speed": speed})

    os.makedirs(OUT_DIR, exist_ok=True)
    sheet_path = os.path.join(OUT_DIR, "spritesheet.png")
    sheet.save(sheet_path, optimize=True)
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump({"displayName": DISPLAY_NAME, "cellWidth": CELL, "cellHeight": CELL,
                   "columns": COLS, "rows": rows_meta,
                   # sideView：这是侧面视角的宠物。渲染层据此在屏幕左半边把它翻成朝右
                   # （用户要求：拖到左边应面向屏幕中间，小助理那种正面宠物不需要翻）。
                   "sideView": True}, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    if preview_src is not None:
        preview_src.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT_DIR, "preview.png"), optimize=True)

    print(f"✅ 已生成 {OUT_DIR}")
    print(f"   spritesheet.png {sheet.width}×{sheet.height}  {os.path.getsize(sheet_path) // 1024} KB")
    print(f"   {len(ROWS)} 组动作 / 共 {sum(n for _, n, _ in ROWS)} 帧：{', '.join(s for s, _, _ in ROWS)}")


def build_preview() -> None:
    """总览图（全部动作拼一张，浅底）+ 几个动作的动图，供肉眼验收。"""
    sheet = Image.open(os.path.join(OUT_DIR, "spritesheet.png")).convert("RGBA")
    bg = Image.new("RGBA", sheet.size, (247, 249, 252, 255))
    bg.alpha_composite(sheet)
    bg.convert("RGB").save("/tmp/whale-pet-overview.png")

    # 动图：各来一段，一次看全（含站立 / 顶球）
    frames, durs = [], []
    for state in ("idle", "swimming", "waving", "jumping", "standing", "ball", "running-right"):
        row = next(m for m in json.load(open(os.path.join(OUT_DIR, "manifest.json"), encoding="utf-8"))["rows"]
                   if m["state"] == state)
        for f in range(row["frames"]):
            img = sheet.crop((f * CELL, row["row"] * CELL, (f + 1) * CELL, (row["row"] + 1) * CELL))
            canvas = Image.new("RGBA", (CELL, CELL), (32, 44, 60, 255))
            canvas.alpha_composite(img)
            frames.append(canvas.convert("P", palette=Image.ADAPTIVE, colors=128))
            durs.append(int(110 * row.get("speed", 1.0)))
        # 每个动作之间停两帧，方便看清单个动作的循环
        frames.append(frames[-1])
        durs.append(320)
    frames[0].save("/tmp/whale-pet-preview.gif", save_all=True, append_images=frames[1:],
                   duration=durs, loop=0, disposal=2, optimize=True)
    print("总览图：/tmp/whale-pet-overview.png")
    print("动图：  /tmp/whale-pet-preview.gif")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true", help="额外输出总览图与动图到 /tmp")
    args = ap.parse_args()
    build()
    if args.preview:
        build_preview()
