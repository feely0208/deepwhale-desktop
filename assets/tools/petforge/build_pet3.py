#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""宠物动画引擎 v3 —— 分层动画（头 / 身体分离）

为什么重做（2026-10-20 用户现场）：
  v2 只做整图 1~3% 的位移/缩放，缩小到 192×208 后**肉眼几乎静止**，
  12 生肖看起来动作一模一样，只有 dash（横移）能看出来。
  用户原话：「像个鬼一样的」「你以为什么桌宠都能套用大肥鱼的动作吗」。

v3 的做法：
  ① 用 alpha 宽度分析找「脖子」，把角色切成 head（头）和 body（身体）两层；
  ② 头绕脖子点独立旋转/位移 —— 点头、歪头、扫视、低头打字都成为可见动作；
  ③ 每个职业/物种有自己的动作配方（不是只改参数，而是换动作类型与节奏）；
  ④ 幅度按桌宠实际显示尺寸（约 100px）标定，确保看得见。

用法：
  python3 build_pet3.py <原图> <输出目录> <显示名> <动作档案名>
"""
import json
import math
import os
import sys

from PIL import Image, ImageEnhance

CW, CH, COLS = 192, 208, 8

# ─────────────────────────────────────────────────────────────────────
# 动作类型（头 / 身体分别变换）
#   head_*: 头部相对脖子的变换；body_*: 身体变换
#   freq:   周期数（越大越快）；amp: 幅度倍数
# ─────────────────────────────────────────────────────────────────────
# 每个动作 = (head_mode, head_amp, body_mode, body_amp, freq)
ACTIONS = {
    # 静息
    "breath":      ("none",  0.0, "breathe", 1.0, 1),
    "still":       ("none",  0.0, "still",   0.4, 1),
    # 头部动作（最可见）
    "nod":         ("nod",   1.0, "breathe", 0.8, 1),    # 缓慢点头
    "nod_fast":    ("nod",   1.3, "breathe", 0.5, 2.5),  # 高频小点头（频率必须非整数倍，见下）
    "tilt":        ("tilt",  1.0, "breathe", 0.8, 1),    # 歪头（思考）
    "sway_head":   ("rot",   1.2, "breathe", 0.6, 1),    # 左右扫视（审视）
    "glance":      ("shift", 1.0, "breathe", 0.6, 2),    # 左右看
    "bow":         ("bow",   1.0, "still",   0.5, 1),    # 低头/俯身观察
    # 整体动作
    "bounce":      ("nod",   0.5, "bounce",  1.4, 2),    # 弹跳（颠勺）
    "slam":        ("bow",   0.6, "slam",    1.3, 2),    # 下压（敲槌/拍案）
    "salute":      ("none",  0.0, "lift",    1.5, 1),    # 上抬定格（敬礼）
    "raise":       ("tilt",  0.7, "lift",    1.2, 1),    # 举手/起身
    "stride":      ("nod",   0.6, "stride",  1.2, 1),    # 奔走
    "turn":        ("shift", 0.8, "stride",  0.8, 1),    # 转身
    "scan":        ("rot",   0.9, "shift",   1.0, 1),    # 环视
    "read":        ("nod",   1.1, "breathe", 0.5, 2),    # 阅卷
    "rest":        ("nod",   0.5, "breathe", 0.6, 1),    # 小憩
}

# ─────────────────────────────────────────────────────────────────────
# 动作档案：同名字槽位在不同职业下演不同动作
# 槽位对齐壳的 pet.js（18 个）
# ─────────────────────────────────────────────────────────────────────
PROFILES = {
    # 法官：极静、缓慢点头审视、敲槌下压
    "judge": {
        "idle": "still", "waving": "raise", "jumping": "slam", "dash": "stride",
        "flip": "turn", "ball": "slam", "swimming": "nod", "diving": "bow",
        "standing": "still", "look": "sway_head", "review": "nod", "sleeping": "rest",
        "walking-left": "stride", "walking-right": "stride",
        "jogging-left": "stride", "jogging-right": "stride",
        "fast-running-left": "stride", "fast-running-right": "stride",
    },
    # 律师：活跃、歪头思考、举手陈述
    "lawyer": {
        "idle": "breath", "waving": "raise", "jumping": "raise", "dash": "stride",
        "flip": "turn", "ball": "tilt", "swimming": "nod", "diving": "bow",
        "standing": "still", "look": "glance", "review": "read", "sleeping": "rest",
        "walking-left": "stride", "walking-right": "stride",
        "jogging-left": "stride", "jogging-right": "stride",
        "fast-running-left": "stride", "fast-running-right": "stride",
    },
    # 检察官：严谨、拍案、翻材料
    "prosecutor": {
        "idle": "nod", "waving": "raise", "jumping": "slam", "dash": "stride",
        "flip": "turn", "ball": "read", "swimming": "nod", "diving": "bow",
        "standing": "still", "look": "glance", "review": "read", "sleeping": "rest",
        "walking-left": "stride", "walking-right": "stride",
        "jogging-left": "stride", "jogging-right": "stride",
        "fast-running-left": "stride", "fast-running-right": "stride",
    },
    # 法警：立正不动、敬礼、踏步
    "bailiff": {
        "idle": "still", "waving": "salute", "jumping": "bounce", "dash": "stride",
        "flip": "turn", "ball": "glance", "swimming": "sway_head", "diving": "bow",
        "standing": "still", "look": "sway_head", "review": "still", "sleeping": "rest",
        "walking-left": "stride", "walking-right": "stride",
        "jogging-left": "stride", "jogging-right": "stride",
        "fast-running-left": "stride", "fast-running-right": "stride",
    },
    # 书记员：干活的人。核心是「速记」——低头、手快、间歇停下听人说话。
    # 2026-10-20 按用户要求重做：不追求花哨动作，要贴职业身份。
    #   review   = 速记（快速小幅点头，最高频）
    #   jumping  = 落笔/敲键盘（快速下压）
    #   ball     = 翻材料（小幅快摆）
    #   diving   = 低头看材料（持续低头）
    #   look     = 抬头听人说话
    #   idle     = 安静待命（极轻呼吸，偶尔点一下头）
    # 书记员：干活的人。核心是「速记」——低头、手快、间歇停下听人说话。
    # 2026-10-20 按用户要求重做：不追求花哨，要贴职业身份。
    #   review=速记  jumping=落笔/敲键盘  ball=翻材料  diving=低头看  look=抬头听  idle=安静待命
    "clerk": {
        "idle": "breath", "waving": "raise", "jumping": "slam", "dash": "stride",
        "flip": "turn", "ball": "read", "swimming": "read", "diving": "bow",
        "standing": "still", "look": "glance", "review": "nod_fast", "sleeping": "rest",
        "walking-left": "stride", "walking-right": "stride",
        "jogging-left": "stride", "jogging-right": "stride",
        "fast-running-left": "stride", "fast-running-right": "stride",
    },
    # 法医：俯身观察、缓慢
    "forensic": {
        "idle": "bow", "waving": "raise", "jumping": "bow", "dash": "stride",
        "flip": "turn", "ball": "nod", "swimming": "read", "diving": "bow",
        "standing": "still", "look": "glance", "review": "nod", "sleeping": "rest",
        "walking-left": "stride", "walking-right": "stride",
        "jogging-left": "stride", "jogging-right": "stride",
        "fast-running-left": "stride", "fast-running-right": "stride",
    },
    # 厨师：颠勺弹跳
    "chef": {
        "idle": "breath", "waving": "raise", "jumping": "bounce", "dash": "stride",
        "flip": "turn", "ball": "bounce", "swimming": "bounce", "diving": "bow",
        "standing": "still", "look": "glance", "review": "nod", "sleeping": "rest",
        "walking-left": "stride", "walking-right": "stride",
        "jogging-left": "stride", "jogging-right": "stride",
        "fast-running-left": "stride", "fast-running-right": "stride",
    },
    # 教师：讲解、点头、板书
    "teacher": {
        "idle": "nod", "waving": "raise", "jumping": "raise", "dash": "stride",
        "flip": "turn", "ball": "nod", "swimming": "read", "diving": "bow",
        "standing": "still", "look": "sway_head", "review": "read", "sleeping": "rest",
        "walking-left": "stride", "walking-right": "stride",
        "jogging-left": "stride", "jogging-right": "stride",
        "fast-running-left": "stride", "fast-running-right": "stride",
    },
    # 消防/警察：敬礼、警戒扫视
    "rescue": {
        "idle": "still", "waving": "salute", "jumping": "bounce", "dash": "stride",
        "flip": "turn", "ball": "glance", "swimming": "scan", "diving": "bow",
        "standing": "still", "look": "scan", "review": "still", "sleeping": "rest",
        "walking-left": "stride", "walking-right": "stride",
        "jogging-left": "stride", "jogging-right": "stride",
        "fast-running-left": "stride", "fast-running-right": "stride",
    },
    # 通用
    "generic": {
        "idle": "breath", "waving": "raise", "jumping": "bounce", "dash": "stride",
        "flip": "turn", "ball": "glance", "swimming": "nod", "diving": "bow",
        "standing": "still", "look": "glance", "review": "nod", "sleeping": "rest",
        "walking-left": "stride", "walking-right": "stride",
        "jogging-left": "stride", "jogging-right": "stride",
        "fast-running-left": "stride", "fast-running-right": "stride",
    },
}

SLOTS = ["idle", "waving", "jumping", "dash", "flip", "ball", "swimming", "diving",
         "standing", "look", "review", "sleeping",
         "walking-left", "walking-right", "jogging-left", "jogging-right",
         "fast-running-left", "fast-running-right"]

FRAMES = {"idle": 6, "waving": 5, "jumping": 6, "dash": 6, "flip": 6, "ball": 6,
          "swimming": 6, "diving": 6, "standing": 4, "look": 6, "review": 6, "sleeping": 6,
          "walking-left": 6, "walking-right": 6, "jogging-left": 6, "jogging-right": 6,
          "fast-running-left": 6, "fast-running-right": 6}

# 每个槽位速度倍率（<1 更快）——体现职业节奏差
SPEED = {
    "judge":      {"idle": 1.5, "jumping": 0.75, "waving": 1.3, "default": 1.2},
    "lawyer":     {"idle": 0.95, "jumping": 0.8, "waving": 0.85, "default": 0.9},
    "prosecutor": {"idle": 1.05, "jumping": 0.8, "waving": 0.9, "default": 0.9},
    "bailiff":    {"idle": 1.3, "jumping": 0.65, "waving": 0.9, "default": 0.8},
    "clerk":      {"idle": 2.6, "jumping": 1.6, "waving": 1.8, "review": 2.2, "ball": 2.0, "swimming": 2.0, "diving": 2.2, "look": 2.0, "default": 1.8},
    "forensic":   {"idle": 1.25, "jumping": 1.0, "waving": 1.1, "default": 1.05},
    "chef":       {"idle": 0.85, "jumping": 0.6, "waving": 0.8, "default": 0.8},
    "teacher":    {"idle": 1.0, "jumping": 0.85, "waving": 0.9, "default": 0.95},
    "rescue":     {"idle": 1.15, "jumping": 0.7, "waving": 0.9, "default": 0.85},
    "generic":    {"idle": 1.0, "jumping": 0.85, "waving": 0.9, "default": 0.95},
}


# ─────────────────────────────────────────────────────────────────────
# 图像处理
# ─────────────────────────────────────────────────────────────────────
def detect_bg(im):
    """从四角判断背景是绿幕还是品红幕。

    2026-10-20 加：绿底对灰白毛角色会"溢色"到身上（实测鼠书记员下巴一片绿，
    抠图后被挖成洞）。品红对灰白/黑毛安全，但对粉色角色（猪、兔耳）危险。
    所以按图自动判断，两种都支持。
    """
    w, h = im.size
    px = im.load()
    pts = [(3, 3), (w - 4, 3), (3, h - 4), (w - 4, h - 4)]
    votes = {"green": 0, "magenta": 0}
    for x, y in pts:
        r, g, b = px[x, y][:3]
        if g > r + 25 and g > b + 25 and g > 90:
            votes["green"] += 1
        elif r > 150 and b > 150 and g < min(r, b) - 60:
            votes["magenta"] += 1
    return "magenta" if votes["magenta"] > votes["green"] else "green"


def is_bg(c, mode="green"):
    """按「色度差」判定背景，不用绝对阈值。

    2026-10-20 修：原来品红判定要求 `r>140 and b>140`，而实际背景色是
    (227,0,152) —— 压缩噪点只要 b 掉到 140 以下就漏判，留下成片脏点。
    改成「绿远小于红蓝中的较小者」这种相对判据，对明暗变化都成立。
    """
    r, g, b = c[:3]
    if mode == "green":
        # 绿远高于红蓝
        return (g - max(r, b)) > 32 and g > 80
    # 品红：红蓝中的较小者远高于绿
    return (min(r, b) - g) > 42


def is_green(c):
    """保留旧接口（trim_padding 用）"""
    return is_bg(c, "green")


def trim_padding(img, max_pad=16):
    im = img.convert("RGB")
    w, h = im.size
    px = im.load()

    mode = detect_bg(im)

    def row_ok(y):
        return any(is_bg(px[x, y], mode) for x in range(0, w, 9))

    def col_ok(x):
        return any(is_bg(px[x, y], mode) for y in range(0, h, 9))

    t = b = l = r = 0
    while t < max_pad and not row_ok(t):
        t += 1
    while b < max_pad and not row_ok(h - 1 - b):
        b += 1
    while l < max_pad and not col_ok(l):
        l += 1
    while r < max_pad and not col_ok(w - 1 - r):
        r += 1
    return im.crop((l, t, w - r, h - b)) if (t or b or l or r) else im


def key_out_green(img):
    """色键抠图：自动识别绿幕/品红幕。"""
    img = img.convert("RGBA")
    mode = detect_bg(img)
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if is_bg((r, g, b), mode):
                px[x, y] = (r, g, b, 0)
    return img


def clean_alpha(img, hard=60):
    """清理抠图残留：硬阈值去半透明噪点 + 中值滤波去孤立点。

    2026-10-20 加：品红/绿幕背景都有压缩噪点，会被判成"角色"留下散点
    （实测左上角 3% 像素 alpha>20，在桌面上像是脏点）。
    """
    from PIL import ImageFilter
    a = img.split()[-1]
    a = a.point(lambda v: 0 if v < hard else v)
    a = a.filter(ImageFilter.MedianFilter(3))
    img.putalpha(a)
    return img


def keep_largest_blob(img, min_ratio=0.02):
    """只保留最大的连通块（角色本体），其余透明。

    2026-10-20 加：色键抠图后背景压缩噪点会成片残留（实测左上角 3% 像素不透明），
    硬阈值和中值滤波都去不干净。连通域分析是根本解法，且不依赖 scipy
    （包内 python 没有 numpy/scipy，所以用 PIL 的 floodfill 实现）。
    """
    from PIL import ImageDraw
    w, h = img.size
    a = img.split()[-1]
    # 二值化：>100 算实体
    bin_mask = a.point(lambda v: 255 if v >= 100 else 0)
    # 用 floodfill 从四角标记"外部背景"（8 邻域）
    ext = bin_mask.copy()
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        if ext.getpixel(seed) == 0:
            ImageDraw.floodfill(ext, seed, 128)
    # 剩余未标记的 0 = 被角色包围的内部空洞或最大块之外的小块
    # 反向：实体 = 原二值 255 且不是外部背景 → 但我们要的是"最大块"
    # 简单可靠做法：从图像中心向外找实体，取其连通块
    px = bin_mask.load()
    ex = ext.load()
    # 统计所有"实体但不在外部"的区域 —— 用并查集代价高，改用迭代标记找最大块
    visited = [[False] * w for _ in range(h)]
    best = None
    best_size = 0
    step = 4  # 抽样加速：每 4 像素取一个种子
    for sy in range(0, h, step):
        for sx in range(0, w, step):
            if px[sx, sy] == 0 or visited[sy][sx]:
                continue
            # BFS 找这块的大小（用低分辨率网格估算，够判断大小）
            stack = [(sx, sy)]
            seen = set()
            size = 0
            while stack and size < 200000:
                x, y = stack.pop()
                key = y * w + x
                if key in seen:
                    continue
                seen.add(key)
                if x < 0 or y < 0 or x >= w or y >= h:
                    continue
                if px[x, y] == 0:
                    continue
                size += 1
                for nx, ny in ((x + 2, y), (x - 2, y), (x, y + 2), (x, y - 2)):
                    if 0 <= nx < w and 0 <= ny < h and px[nx, ny] and (ny * w + nx) not in seen:
                        stack.append((nx, ny))
            if size > best_size:
                best_size = size
                best = (sx, sy)
    if best is None:
        return img
    # 用 floodfill 在 alpha 上精确标记角色本体（4 邻域，避免从缝隙漏出）
    mask = bin_mask.copy()
    ImageDraw.floodfill(mask, best, 200)
    mp = mask.load()
    ap = a.load()
    for y in range(h):
        for x in range(w):
            if mp[x, y] != 200:
                ap[x, y] = 0
    img.putalpha(a)
    return img


def fit_cell(img, pad=6):
    mw, mh = CW - pad * 2, CH - pad * 2
    s = min(mw / img.width, mh / img.height)
    return img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))), Image.LANCZOS)


def find_neck(img):
    """用 alpha 宽度找脖子：头部区间内宽度最小的一行。

    Q 版角色头大身小，脖子处 alpha 宽度会出现局部极小值。
    找不到（比如鲸鱼这类流线型）就退化为固定 44% 高度。
    """
    a = img.split()[-1]
    w, h = img.size
    widths = []
    for y in range(h):
        cnt = 0
        for x in range(0, w, 2):
            if a.getpixel((x, y)) > 40:
                cnt += 1
        widths.append(cnt)
    lo, hi = int(h * 0.30), int(h * 0.62)
    if hi - lo < 4:
        return int(h * 0.44)
    best = min(range(lo, hi), key=lambda y: widths[y])
    # 极小值不明显时退化
    head_max = max(widths[:max(1, lo)]) if lo > 0 else 1
    if widths[best] > head_max * 0.85:
        return int(h * 0.44)
    return best


def split_layers(base):
    """切成头 / 身体两层，重叠 6px 避免接缝。"""
    neck = find_neck(base)
    w, h = base.size
    overlap = 6
    head = base.crop((0, 0, w, min(h, neck + overlap)))
    body = base.crop((0, max(0, neck - overlap), w, h))
    return head, body, neck, overlap


def rotate_about(img, angle, center):
    """绕任意点旋转（Pillow 的 corner 处理用 expand=False）。"""
    if not angle:
        return img
    return img.rotate(angle, resample=Image.BICUBIC, center=center)


def scale_keep_anchor(img, scale, anchor_bottom=True):
    if scale == 1.0:
        return img
    nw, nh = max(1, int(img.width * scale)), max(1, int(img.height * scale))
    return img.resize((nw, nh), Image.LANCZOS)


def compose(head, body, neck, overlap, head_dx=0, head_dy=0, head_angle=0.0,
            body_scale=1.0, body_dy=0, body_dx=0):
    """把两层合回一个 192×208 格子。

    body 以底边为锚缩放；head 绕脖子点旋转，再整体平移。
    """
    cell = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))

    # 身体
    b = scale_keep_anchor(body, body_scale)
    tmp = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    tmp.alpha_composite(b, ((CW - b.width) // 2 + body_dx, CH - b.height - 8 + body_dy))
    cell = tmp

    # 头：绕「脖子中心」旋转。脖子在 head 图里的 y = neck+overlap（=head.height）
    pivot = (head.width // 2, head.height)
    h = rotate_about(head, head_angle, pivot)

    # 头在 cell 中的原始落点 = 身体顶端对齐位置
    body_top = CH - b.height - 8      # 身体顶端 y
    head_y = int(body_top - head.height + overlap + head_dy)
    head_x = int((CW - h.width) // 2 + head_dx)

    # 旋转会改变尺寸，重新按 pivot 对齐
    dy = int((h.height - head.height) // 2)
    tmp2 = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    tmp2.alpha_composite(cell, (0, 0))
    tmp2.alpha_composite(h, (head_x, head_y - dy))
    return tmp2


# ─────────────────────────────────────────────────────────────────────
# 动作生成（整图变换 + 大幅幅度）
#
# 2026-10-20 第二次修正：分层（头/身体）方案因脖子检测不可靠而废弃 ——
# Q 版角色脖子几乎不可见，切分会把头切在脸上造成断层。
# 真正的问题其实是【幅度太小】：v2 用 1~3px 位移，桌宠只显示约 100px，
# 缩放后不到 1px，肉眼等于静止。现在按显示尺寸标定：
#   位移 8~14px / 旋转 2.5~4° / 缩放 3~6% —— 缩到 100px 后仍有 4~7px 变化，清晰可见。
# ─────────────────────────────────────────────────────────────────────
SCALE = 2.0   # 全局幅度倍数（相对 v2）


def _rotate_bottom(img, angle):
    """绕底边中点旋转 —— 视觉上像人前倾/鞠躬，不脱离地面。"""
    if not angle:
        return img
    return img.rotate(angle, resample=Image.BICUBIC, center=(img.width // 2, img.height))


def _place(base_img, scale_x=1.0, scale_y=1.0, dx=0, dy=0, angle=0.0, bright=1.0):
    img = base_img
    if angle:
        img = _rotate_bottom(img, angle)
    if scale_x != 1.0 or scale_y != 1.0:
        nw = max(1, int(img.width * scale_x))
        nh = max(1, int(img.height * scale_y))
        img = img.resize((nw, nh), Image.LANCZOS)
    if bright != 1.0:
        img = ImageEnhance.Brightness(img).enhance(bright)
    cell = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    cell.alpha_composite(img, ((CW - img.width) // 2 + int(dx),
                               CH - img.height - 8 + int(dy)))
    return cell


# 安静动作（idle 等，占 95% 时间）与交互动作（用户点击/悬停才触发）分开标定幅度。
# 2026-10-20 第三次修正（用户现场：「原地左摇右摆、忽大忽小哪里像个律师」）：
# 整图变换做不出职业动作，幅度大了就是抽风、小了就看不见 —— 所以：
#   · 安静动作 = 几乎静止（只留极轻呼吸，缩放 <1%、位移 <1px）；
#   · 交互动作 = 保留明显幅度（用户主动触发时要给反馈）。
# 职业感靠形象（袍子/领巾/徽章）而不是靠乱晃。
# 三档幅度（按桌宠实际显示约 100px 标定，192 格子里 1px ≈ 显示 0.5px）：
#   安静档 → 几乎静止（位移 ~1px，缩放 ~1.2%）
#   干活档 → 看得见但不夸张（点头 2.5°、下沉 5px）—— 书记员速记/落笔在这一档
#   反馈档 → 用户主动交互时的明显反应（上抬/下压 9~11px）
CALM_ACTIONS = {"still", "breath", "rest", "read", "nod", "tilt"}
WORK_ACTIONS = {"nod_fast", "bow"}          # 干活：速记、低头看材料
CALM_FACTOR = 0.35
WORK_FACTOR = 0.85
ACTIVE_FACTOR = 1.0


def frames_for(action, base, neck, overlap, head, body, n, amp=1.0):
    """按动作语义生成 n 帧。全部为整图变换，安静的几乎不动、交互的有明显反馈。"""
    head_mode, head_amp, body_mode, body_amp, freq = ACTIONS.get(action, ACTIONS["breath"])
    if action in CALM_ACTIONS:
        factor = CALM_FACTOR
    elif action in WORK_ACTIONS:
        factor = WORK_FACTOR
    else:
        factor = ACTIVE_FACTOR
    A = amp * SCALE * factor
    out = []
    for i in range(n):
        t = i / max(1, n)
        ph = t * freq
        s_ = math.sin(ph * 2 * math.pi)
        a_ = abs(s_)

        sx = sy = 1.0
        dx = dy = 0.0
        ang = 0.0
        br = 1.0

        # ── 静息类 ──
        if action == "still":
            sx = sy = 1 + 0.006 * a_ * s_
            dy = 0.6 * s_
        elif action == "breath":
            k = 0.028 * A * s_                      # 缩放约 ±2.8%
            sx = sy = 1 + k
            dy = 2.6 * A * s_
        elif action == "rest":
            sx = sy = 1 - 0.012 * A * a_
            dy = 3.0 * A * a_
            br = 0.93

        # ── 头部语义（整图绕底旋转=前倾）──
        elif action == "nod":                        # 点头：±3° 绕底
            ang = -2.8 * A * s_
        elif action == "nod_fast":
            # 2026-10-20 修：原来是 sin(ph*4π) 且 freq=3 → 有效频率 12，6 帧采样点
            # 全落在 sin 零点上，速记动作**完全不动**（Δ=0，静默失败）。
            # 现在频率走 freq=2.5（非整数倍），实现只写单周期，帧间一定有差异。
            ang = -2.6 * A * math.sin(ph * 2 * math.pi)
        elif action == "bow":                        # 俯身观察
            ang = -3.2 * A * (0.55 + 0.45 * s_)
            dy = 1.5 * A * a_
        elif action == "tilt":                       # 歪头思考：恒偏 + 微摆
            ang = -2.4 * A + 1.0 * A * s_
            sx = 1 + 0.008 * A * a_
        elif action == "rot" or action == "sway_head":   # 左右扫视
            ang = 3.2 * A * s_
        elif action == "shift" or action == "glance":    # 左右看
            dx = 7.0 * A * s_

        # ── 整体语义 ──
        elif action == "bounce":                     # 弹跳（颠勺）
            sy = 1 - 0.045 * A * a_
            sx = 1 + 0.025 * A * a_
            dy = -11.0 * A * a_
        elif action == "slam":                       # 下压（敲槌/拍案）
            sy = 1 - 0.055 * A * a_
            sx = 1 + 0.030 * A * a_
            dy = 8.0 * A * a_
        elif action == "lift":                       # 上抬定格（敬礼/举手）
            up = 1.0 if t < 0.4 else 0.82
            dy = -11.0 * A * up
            sx = sy = 1 + 0.018 * A
        elif action == "raise":                      # 举手/起身：上抬 + 倾斜
            dy = -6.0 * A * a_
            ang = -2.0 * A * s_
        elif action == "stride":                     # 奔走：水平位移 + 反向倾斜
            dx = 9.0 * A * s_
            dy = -3.5 * A * a_
            ang = -3.0 * A * s_
        elif action == "turn":                       # 转身（镜像 + 轻摆）
            if (i // max(1, n // 2)) % 2:
                base = base.transpose(Image.FLIP_LEFT_RIGHT)
            dx = 4.0 * A * s_
            ang = 2.4 * A * s_
        elif action == "scan":                       # 环视（大幅左右）
            dx = 11.0 * A * s_
            ang = -1.8 * A * s_
        elif action == "read":                       # 阅卷：小幅快节奏
            f = math.sin(ph * 4 * math.pi)
            sx = sy = 1 + 0.008 * A * f
            ang = -1.4 * A * f

        out.append(_place(base, sx, sy, dx, dy, ang, br))
    return out


# ─────────────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────────────
def build(src_path, out_dir, name, profile_name):
    prof = PROFILES.get(profile_name, PROFILES["generic"])
    speeds = SPEED.get(profile_name, SPEED["generic"])

    src = Image.open(src_path)
    bgmode = detect_bg(src)
    known = {v for v in PROFILES}
    if profile_name not in known:
        pass
    print(f"  背景色: {('品红幕' if bgmode=='magenta' else '绿幕')}")
    trimmed = trim_padding(src)
    cut = key_out_green(trimmed)
    cut = clean_alpha(cut)
    bbox = cut.getbbox()
    if bbox:
        cut = cut.crop(bbox)
    base = fit_cell(cut)

    os.makedirs(out_dir, exist_ok=True)
    sheet = Image.new("RGBA", (CW * COLS, CH * len(SLOTS)), (0, 0, 0, 0))
    rows, preview = [], None

    for r, slot in enumerate(SLOTS):
        action = prof.get(slot, "breath")
        n = FRAMES[slot]
        fr = frames_for(action, base, 0, 0, None, None, n)
        if preview is None:
            preview = fr[0]
        for c, f in enumerate(fr):
            sheet.alpha_composite(f, (c * CW, r * CH))
        spd = speeds.get(slot, speeds.get("default", 1.0))
        rows.append({"state": slot, "row": r, "frames": n, "speed": round(spd, 2)})
        print(f"  {slot:18s} -> {action:10s} {n}帧 speed={spd:.2f}")

    # 自检：每个状态必须有帧间差异，否则就是静默失败（2026-10-20 踩过 nod_fast Δ=0）
    dead = []
    for r, slot in enumerate(SLOTS):
        row_imgs = [sheet.crop((c * CW, r * CH, (c + 1) * CW, (r + 1) * CH)) for c in range(FRAMES[slot])]
        if len(row_imgs) < 2:
            continue
        same = all(list(row_imgs[0].getdata()) == list(im.getdata()) for im in row_imgs[1:])
        if same:
            dead.append(slot)
    if dead:
        print(f"  ⚠️ 警告：以下状态所有帧完全相同（动作没生效）: {', '.join(dead)}")
    else:
        print("  ✅ 自检通过：所有状态都有帧间变化")

    sheet.save(os.path.join(out_dir, "spritesheet.png"))
    preview.resize((CW * 2, CH * 2), Image.LANCZOS).save(os.path.join(out_dir, "preview.png"))
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"displayName": name, "cellWidth": CW, "cellHeight": CH,
                   "columns": COLS, "rows": rows}, f, ensure_ascii=False, indent=2)
    print(f"\n✅ {len(SLOTS)} 状态 / {sum(FRAMES.values())} 帧 | 档案={profile_name}")


if __name__ == "__main__":
    if len(sys.argv) < 5:
        print(__doc__)
        sys.exit(1)
    build(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
