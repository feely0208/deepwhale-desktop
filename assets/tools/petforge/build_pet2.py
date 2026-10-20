#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""宠物工厂 v2：角色动作档案版

同造型不同动作没有意义 —— 所以每个角色用「动作档案(profile)」定义其同名槽位演什么。
壳的动作槽位（pet.js 实测）：
  idle / jumping / walking-l|r / jogging-l|r / fast-running-l|r / dash
  随机池：dash waving jumping flip ball swimming diving
  稀有池：standing look review sleeping

动作语义用「整体变换」表达（程序化，零美术成本）：
  breath 呼吸 | still 极静 | gavel 敲击 | step 踏步 | salute 敬礼
  raise 举手 | stride 奔走 | turn 转身 | sway 摇摆 | scan 环视
  bow 俯身 | read 阅卷 | rest 小憩
用法：python3 build_pet2.py <图> <输出目录> <显示名> <profile名>
"""
import sys, os, json, math
from PIL import Image, ImageEnhance

CW, CH = 192, 208
COLS = 8

# ── 动作档案：每个职业给同名槽位不同的语义与节奏 ──────────────────────────
PROFILES = {
    # 律师：活跃、走动多、举手陈述
    "lawyer": {
        "idle":              ("breath", 1.0, 0.90),
        "waving":            ("raise",  1.0, 0.85),   # 举手陈述
        "jumping":           ("raise",  1.4, 0.75),   # 起身发言
        "dash":              ("stride", 1.0, 0.70),   # 快步奔走
        "flip":              ("turn",   1.0, 1.00),
        "ball":              ("sway",   0.7, 1.10),   # 整理卷宗
        "swimming":          ("sway",   1.2, 0.95),   # 翻阅
        "diving":            ("bow",    1.0, 1.00),   # 弯腰查看
        "standing":          ("still",  0.5, 1.10),
        "look":              ("scan",   1.1, 1.00),   # 环视
        "review":            ("read",   1.0, 1.00),   # 阅卷
        "sleeping":          ("rest",   1.0, 1.50),
        "walking-left":      ("stride", 0.8, 1.00), "walking-right": ("stride", 0.8, 1.00),
        "jogging-left":      ("stride", 1.1, 0.80), "jogging-right": ("stride", 1.1, 0.80),
        "fast-running-left": ("stride", 1.4, 0.60), "fast-running-right": ("stride", 1.4, 0.60),
    },
    # 法官：庄重、慢、下压（敲槌感）、几乎不跑
    "judge": {
        "idle":              ("still",  0.6, 1.40),
        "waving":            ("raise",  0.5, 1.40),   # 宣读（幅度小）
        "jumping":           ("gavel",  1.0, 0.90),   # 敲法槌
        "dash":              ("stride", 0.5, 1.30),   # 稳重移动
        "flip":              ("turn",   0.6, 1.30),
        "ball":              ("gavel",  0.8, 1.00),
        "swimming":          ("read",   0.8, 1.20),
        "diving":            ("bow",    0.8, 1.20),   # 俯身审视
        "standing":          ("still",  0.3, 1.50),   # 端坐/站定
        "look":              ("scan",   0.7, 1.30),
        "review":            ("read",   1.0, 1.20),
        "sleeping":          ("rest",   1.0, 1.60),
        "walking-left":      ("stride", 0.5, 1.20), "walking-right": ("stride", 0.5, 1.20),
        "jogging-left":      ("stride", 0.6, 1.10), "jogging-right": ("stride", 0.6, 1.10),
        "fast-running-left": ("stride", 0.7, 0.95), "fast-running-right": ("stride", 0.7, 0.95),
    },
    # 检察官：严谨、翻材料、出示证据
    "prosecutor": {
        "idle":              ("breath", 0.8, 1.05),
        "waving":            ("raise",  0.9, 0.90),   # 出示证据
        "jumping":           ("step",   1.0, 0.85),   # 拍案
        "dash":              ("stride", 0.9, 0.80),
        "flip":              ("turn",   1.0, 1.00),
        "ball":              ("read",   1.1, 0.95),   # 翻材料
        "swimming":          ("read",   0.9, 1.00),
        "diving":            ("bow",    0.9, 1.00),
        "standing":          ("still",  0.5, 1.15),
        "look":              ("scan",   1.0, 1.00),
        "review":            ("read",   1.1, 0.95),
        "sleeping":          ("rest",   1.0, 1.50),
        "walking-left":      ("stride", 0.8, 1.00), "walking-right": ("stride", 0.8, 1.00),
        "jogging-left":      ("stride", 1.0, 0.85), "jogging-right": ("stride", 1.0, 0.85),
        "fast-running-left": ("stride", 1.2, 0.70), "fast-running-right": ("stride", 1.2, 0.70),
    },
    # 法警：刚硬、干脆、立正、敬礼、踏步
    "bailiff": {
        "idle":              ("still",  0.4, 1.20),   # 立正
        "waving":            ("salute", 1.0, 1.00),   # 敬礼
        "jumping":           ("step",   1.2, 0.70),   # 踏步（硬）
        "dash":              ("stride", 1.3, 0.60),   # 出警
        "flip":              ("turn",   1.0, 0.90),   # 巡逻转向
        "ball":              ("step",   0.9, 0.80),
        "swimming":          ("scan",   0.9, 0.90),   # 警戒环视
        "diving":            ("bow",    0.7, 1.10),
        "standing":          ("still",  0.2, 1.50),   # 最庄重
        "look":              ("scan",   1.2, 0.80),   # 警戒
        "review":            ("still",  0.4, 1.20),
        "sleeping":          ("rest",   1.0, 1.40),
        "walking-left":      ("stride", 1.0, 0.85), "walking-right": ("stride", 1.0, 0.85),
        "jogging-left":      ("stride", 1.2, 0.70), "jogging-right": ("stride", 1.2, 0.70),
        "fast-running-left": ("stride", 1.6, 0.55), "fast-running-right": ("stride", 1.6, 0.55),
    },
    # 法医：冷静、缓慢、俯身检查
    "forensic": {
        "idle":              ("breath", 0.7, 1.25),
        "waving":            ("raise",  0.7, 1.15),
        "jumping":           ("bow",    1.0, 1.00),   # 俯身取样
        "dash":              ("stride", 0.7, 1.10),
        "flip":              ("turn",   0.8, 1.10),
        "ball":              ("read",   1.2, 1.00),   # 检查样本
        "swimming":          ("read",   1.0, 1.05),
        "diving":            ("bow",    1.3, 0.95),   # 深俯身
        "standing":          ("still",  0.5, 1.30),
        "look":              ("scan",   0.9, 1.10),
        "review":            ("read",   1.2, 0.95),   # 记录
        "sleeping":          ("rest",   1.0, 1.60),
        "walking-left":      ("stride", 0.7, 1.10), "walking-right": ("stride", 0.7, 1.10),
        "jogging-left":      ("stride", 0.9, 0.95), "jogging-right": ("stride", 0.9, 0.95),
        "fast-running-left": ("stride", 1.1, 0.80), "fast-running-right": ("stride", 1.1, 0.80),
    },
    # 书记员：手快、速记、打字节奏
    "clerk": {
        "idle":              ("breath", 0.9, 0.95),
        "waving":            ("raise",  0.6, 1.00),
        "jumping":           ("step",   0.7, 0.65),   # 打字（快而碎）
        "dash":              ("stride", 1.0, 0.80),
        "flip":              ("turn",   1.0, 0.95),
        "ball":              ("read",   1.4, 0.75),   # 速记
        "swimming":          ("read",   1.2, 0.80),
        "diving":            ("bow",    1.0, 0.95),
        "standing":          ("still",  0.5, 1.10),
        "look":              ("scan",   1.0, 0.95),
        "review":            ("read",   1.4, 0.75),   # 速记
        "sleeping":          ("rest",   1.0, 1.45),
        "walking-left":      ("stride", 0.9, 0.95), "walking-right": ("stride", 0.9, 0.95),
        "jogging-left":      ("stride", 1.1, 0.80), "jogging-right": ("stride", 1.1, 0.80),
        "fast-running-left": ("stride", 1.3, 0.65), "fast-running-right": ("stride", 1.3, 0.65),
    },
    # 厨师：颠勺、翻炒、尝味
    "chef": {
        "idle":              ("breath", 1.1, 0.85),
        "waving":            ("raise",  1.3, 0.75),   # 挥勺
        "jumping":           ("step",   1.3, 0.60),   # 颠勺（快而弹）
        "dash":              ("stride", 1.1, 0.75),
        "flip":              ("turn",   1.0, 0.90),
        "ball":              ("sway",   1.4, 0.75),   # 翻炒
        "swimming":          ("sway",   1.2, 0.85),
        "diving":            ("bow",    1.2, 0.95),   # 低头看锅
        "standing":          ("still",  0.5, 1.10),
        "look":              ("scan",   1.0, 0.95),
        "review":            ("bow",    0.8, 1.10),   # 尝味
        "sleeping":          ("rest",   1.0, 1.50),
        "walking-left":      ("stride", 0.9, 0.95), "walking-right": ("stride", 0.9, 0.95),
        "jogging-left":      ("stride", 1.1, 0.80), "jogging-right": ("stride", 1.1, 0.80),
        "fast-running-left": ("stride", 1.3, 0.65), "fast-running-right": ("stride", 1.3, 0.65),
    },
}

# 每个槽位的帧数
FRAMES = {
    "idle": 6, "waving": 5, "jumping": 6, "dash": 6, "flip": 6, "ball": 6,
    "swimming": 6, "diving": 6, "standing": 4, "look": 6, "review": 6, "sleeping": 6,
    "walking-left": 6, "walking-right": 6, "jogging-left": 6, "jogging-right": 6,
    "fast-running-left": 6, "fast-running-right": 6,
}


def key_out_green(img):
    img = img.convert("RGBA"); px = img.load(); w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if g > r + 25 and g > b + 25 and g > 90:
                px[x, y] = (r, g, b, 0)
    return img


def trim_padding(img, max_pad=16):
    """裁掉四周「非绿底」的纯色留白（截图边距），否则抠图后会残留细线。

    只在整条边都不含绿底像素时，向内找第一条含绿色的行/列再裁；
    绿底图本身边缘就是绿色，因此不会被误裁。
    """
    im = img.convert("RGB")
    w, h = im.size
    px = im.load()

    def is_green(c):
        r, g, b = c[:3]
        return g > r + 25 and g > b + 25 and g > 90

    def row_has_green(y):
        return any(is_green(px[x, y]) for x in range(0, w, 9))

    def col_has_green(x):
        return any(is_green(px[x, y]) for y in range(0, h, 9))

    top = bot = left = right = 0
    while top < max_pad and not row_has_green(top):
        top += 1
    while bot < max_pad and not row_has_green(h - 1 - bot):
        bot += 1
    while left < max_pad and not col_has_green(left):
        left += 1
    while right < max_pad and not col_has_green(w - 1 - right):
        right += 1
    if top or bot or left or right:
        im = im.crop((left, top, w - right, h - bot))
    return im


def crop_to_alpha(img):
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def fit_into_cell(img, pad=8):
    mw, mh = CW - pad * 2, CH - pad * 2
    s = min(mw / img.width, mh / img.height)
    return img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))), Image.LANCZOS)


def place(base, scale=1.0, dx=0, dy=0, angle=0.0, bright=1.0):
    img = base
    if angle:
        img = img.rotate(angle, resample=Image.BICUBIC, expand=False)
    if scale != 1.0:
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS)
    if bright != 1.0:
        img = ImageEnhance.Brightness(img).enhance(bright)
    cell = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    cell.alpha_composite(img, ((CW - img.width) // 2 + dx, CH - img.height - 8 + dy))
    return cell


def frames_for(kind, amp, base, n):
    """按动作语义生成 n 帧。amp 放大/缩小幅度，全部为整体变换。"""
    out = []
    for i in range(n):
        t = i / max(1, n)
        w = math.sin(t * 2 * math.pi)                  # 平滑周期
        sq = 1.0 if math.sin(t * 2 * math.pi) >= 0 else -1.0   # 方波（硬动作）
        if kind == "breath":                            # 呼吸
            out.append(place(base, scale=1 + 0.013 * amp * w, dy=int(1.4 * amp * w)))
        elif kind == "rest":                            # 小憩：更慢更沉
            out.append(place(base, scale=1 + 0.008 * amp * w, dy=int(2.2 * amp * abs(w)), bright=0.94))
        elif kind == "still":                           # 极静：几乎不动
            out.append(place(base, scale=1 + 0.003 * amp * w, dy=int(0.4 * amp * w)))
        elif kind == "gavel":                           # 敲击：快下压 + 压扁
            hit = abs(math.sin(t * 2 * math.pi))
            out.append(place(base, scale=1 - 0.02 * amp * hit, dy=int(4 * amp * hit)))
        elif kind == "step":                            # 踏步：方波硬上下
            out.append(place(base, dy=int(3.5 * amp * sq), scale=1 - 0.01 * amp * abs(sq)))
        elif kind == "salute":                          # 敬礼：快速上抬后保持
            up = -9 if t < 0.35 else -8
            out.append(place(base, dy=int(up * amp), scale=1 + 0.01 * amp))
        elif kind == "raise":                           # 举手/起身：轻抬 + 前倾
            out.append(place(base, dy=int(-3.2 * amp * abs(w)), angle=-1.6 * amp * w))
        elif kind == "stride":                          # 奔走：位移 + 反向倾斜
            out.append(place(base, dx=int(6 * amp * w), dy=-int(2.4 * amp * abs(w)), angle=-2.8 * amp * w))
        elif kind == "turn":                            # 转身：镜像 + 摆动
            flip = base.transpose(Image.FLIP_LEFT_RIGHT) if (i // max(1, n // 2)) % 2 else base
            out.append(place(flip, dx=int(2.4 * amp * w), angle=2.0 * amp * w))
        elif kind == "sway":                            # 摇摆
            out.append(place(base, dx=int(2.8 * amp * w), angle=1.6 * amp * w))
        elif kind == "scan":                            # 环视：大幅左右
            out.append(place(base, dx=int(5.5 * amp * w), angle=-1.2 * amp * w))
        elif kind == "bow":                             # 俯身
            out.append(place(base, scale=1 - 0.018 * amp * abs(w), dy=int(2.6 * amp * abs(w)), angle=1.4 * amp * w))
        elif kind == "read":                            # 阅卷：小而快的左右
            f = math.sin(t * 4 * math.pi)
            out.append(place(base, dx=int(1.8 * amp * f), dy=int(1.0 * amp * f)))
        else:
            out.append(place(base, scale=1 + 0.01 * w))
    return out


def build(src_path, out_dir, display_name, profile_name):
    prof = PROFILES.get(profile_name)
    if prof is None:
        raise SystemExit(f"未知动作档案: {profile_name}（可选: {', '.join(PROFILES)}）")
    src = Image.open(src_path)
    trimmed = trim_padding(src)
    if trimmed.size != src.size:
        print(f"[裁边距] {src.size} → {trimmed.size}")
    cut = crop_to_alpha(key_out_green(trimmed))
    base = fit_into_cell(cut)
    print(f"[抠图] {src.size} → {cut.size} → 归一 {base.size} | 动作档案: {profile_name}")

    os.makedirs(out_dir, exist_ok=True)
    states = list(FRAMES.keys())
    sheet = Image.new("RGBA", (CW * COLS, CH * len(states)), (0, 0, 0, 0))
    rows, preview = [], None

    for r, state in enumerate(states):
        kind, amp, speed = prof.get(state, ("breath", 1.0, 1.0))
        n = FRAMES[state]
        fr = frames_for(kind, amp, base, n)
        if preview is None:
            preview = fr[0]
        for c, f in enumerate(fr):
            sheet.alpha_composite(f, (c * CW, r * CH))
        rows.append({"state": state, "row": r, "frames": n, "speed": round(speed, 2)})
        print(f"[生成] {state:18s} {kind:7s} {n} 帧 speed={speed:.2f}")

    manifest = {"displayName": display_name, "cellWidth": CW, "cellHeight": CH, "columns": COLS, "rows": rows}
    sheet.save(os.path.join(out_dir, "spritesheet.png"))
    preview.resize((CW * 2, CH * 2), Image.LANCZOS).save(os.path.join(out_dir, "preview.png"))
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"\n✅ {len(states)} 状态 / {sum(FRAMES.values())} 帧 | {sheet.size[0]}×{sheet.size[1]} → {out_dir}")


if __name__ == "__main__":
    if len(sys.argv) < 5:
        print(__doc__); sys.exit(1)
    build(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
