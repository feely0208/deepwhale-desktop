#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""petforge —— 一句话生成桌宠（宠物工厂 CLI）

用户只需描述想要的宠物，一条命令产出可直接安装的 pet pack：
    python3 petforge.py "一只穿警服的柴犬" --name 柴犬警察

流程：AI 出图(纯绿底) → 自动裁边距 → 色键抠图 → 归一化 → 18 状态程序化动画
      → spritesheet + manifest → 安装到壳的 pets 目录

支持任意 OpenAI 兼容图像接口（默认 Agnes）：
    --api-key / --base-url / --model / --size
环境变量：PETFORGE_API_KEY 或 AGNES_API_KEY

动作档案（--style）：lawyer judge prosecutor bailiff forensic clerk chef
                     generic（默认，通用）
"""
import argparse, base64, io, json, math, os, re, sys, urllib.request
from PIL import Image, ImageEnhance, ImageDraw

CW, CH, COLS = 192, 208, 8

# ── 动作类型 ────────────────────────────────────────────────────────────
def _place(base, scale=1.0, dx=0, dy=0, angle=0.0, bright=1.0):
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
    out = []
    for i in range(n):
        t = i / max(1, n)
        w = math.sin(t * 2 * math.pi)
        sq = 1.0 if math.sin(t * 2 * math.pi) >= 0 else -1.0
        if kind == "breath":
            out.append(_place(base, scale=1 + 0.013 * amp * w, dy=int(1.4 * amp * w)))
        elif kind == "rest":
            out.append(_place(base, scale=1 + 0.008 * amp * w, dy=int(2.2 * amp * abs(w)), bright=0.94))
        elif kind == "still":
            out.append(_place(base, scale=1 + 0.003 * amp * w, dy=int(0.4 * amp * w)))
        elif kind == "gavel":
            hit = abs(math.sin(t * 2 * math.pi))
            out.append(_place(base, scale=1 - 0.02 * amp * hit, dy=int(4 * amp * hit)))
        elif kind == "step":
            out.append(_place(base, dy=int(3.5 * amp * sq), scale=1 - 0.01 * amp * abs(sq)))
        elif kind == "salute":
            up = -9 if t < 0.35 else -8
            out.append(_place(base, dy=int(up * amp), scale=1 + 0.01 * amp))
        elif kind == "raise":
            out.append(_place(base, dy=int(-3.2 * amp * abs(w)), angle=-1.6 * amp * w))
        elif kind == "stride":
            out.append(_place(base, dx=int(6 * amp * w), dy=-int(2.4 * amp * abs(w)), angle=-2.8 * amp * w))
        elif kind == "turn":
            flip = base.transpose(Image.FLIP_LEFT_RIGHT) if (i // max(1, n // 2)) % 2 else base
            out.append(_place(flip, dx=int(2.4 * amp * w), angle=2.0 * amp * w))
        elif kind == "sway":
            out.append(_place(base, dx=int(2.8 * amp * w), angle=1.6 * amp * w))
        elif kind == "scan":
            out.append(_place(base, dx=int(5.5 * amp * w), angle=-1.2 * amp * w))
        elif kind == "bow":
            out.append(_place(base, scale=1 - 0.018 * amp * abs(w), dy=int(2.6 * amp * abs(w)), angle=1.4 * amp * w))
        elif kind == "read":
            f = math.sin(t * 4 * math.pi)
            out.append(_place(base, dx=int(1.8 * amp * f), dy=int(1.0 * amp * f)))
        else:
            out.append(_place(base, scale=1 + 0.01 * w))
    return out


# 槽位 → (动作类型, 幅度, 速度)；不同风格只改这三项
BASE_SLOTS = ["idle", "waving", "jumping", "dash", "flip", "ball", "swimming", "diving",
              "standing", "look", "review", "sleeping",
              "walking-left", "walking-right", "jogging-left", "jogging-right",
              "fast-running-left", "fast-running-right"]
FRAMES = {"idle": 6, "waving": 5, "jumping": 6, "dash": 6, "flip": 6, "ball": 6,
          "swimming": 6, "diving": 6, "standing": 4, "look": 6, "review": 6, "sleeping": 6,
          "walking-left": 6, "walking-right": 6, "jogging-left": 6, "jogging-right": 6,
          "fast-running-left": 6, "fast-running-right": 6}

STYLES = {
    "generic":    dict(default=("breath", 1.0, 1.0), jump="raise",  wave="raise",  move="stride"),
    "lawyer":     dict(default=("breath", 1.0, 0.9), jump="raise",  wave="raise",  move="stride"),
    "judge":      dict(default=("still", 0.6, 1.4),  jump="gavel",  wave="raise",  move="stride"),
    "prosecutor": dict(default=("breath", 0.8, 1.05), jump="step",  wave="raise",  move="stride"),
    "bailiff":    dict(default=("still", 0.4, 1.2),  jump="step",   wave="salute", move="stride"),
    "forensic":   dict(default=("breath", 0.7, 1.25), jump="bow",   wave="raise",  move="stride"),
    "clerk":      dict(default=("breath", 0.9, 0.95), jump="step",  wave="raise",  move="stride"),
    "chef":       dict(default=("breath", 1.1, 0.85), jump="step",  wave="raise",  move="stride"),
}




# ── 常见「图像生成」接口预设（用户自备 Key，本项目不提供算力）────────────────
# 说明：DeepSeek 系列模型（v4.1-flash 等）是文本/视觉理解模型，不生图，
#       所以这里给出国内可直接调用的图像生成接口，均为 OpenAI 兼容 /images/generations。
PROVIDER_PRESETS = {
    # 默认：Agnes（我们出图验证用的那家）
    "agnes": dict(base_url="https://api.agnes-ai.cn/v1", model="agnes-image-2.5-flash"),
    # 阿里云通义万相（DashScope 兼容模式）
    "dashscope": dict(base_url="https://dashscope.aliyuncs.com/compatible-mode/v1", model="wanx2.1-t2i-turbo"),
    # 火山引擎豆包 Seedream
    "doubao": dict(base_url="https://ark.cn-beijing.volces.com/api/v3", model="doubao-seedream-3-0-t2i-250415"),
    # 智谱 CogView
    "zhipu": dict(base_url="https://open.bigmodel.cn/api/paas/v4", model="cogview-3-flash"),
    # 硅基流动 SiliconFlow
    "siliconflow": dict(base_url="https://api.siliconflow.cn/v1", model="Kwai-Kolors/Kolors"),
    # OpenAI
    "openai": dict(base_url="https://api.openai.com/v1", model="gpt-image-1"),
}
CONFIG_PATH = os.path.expanduser("~/.petforge.json")


def load_config():
    """读取 ~/.petforge.json（可选）：{provider, api_key, base_url, model, size}"""
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def style_slots(style):
    st = STYLES.get(style, STYLES["generic"])
    slots = {}
    for s in BASE_SLOTS:
        if s == "jumping": slots[s] = (st["jump"], 1.1, 0.8)
        elif s == "waving": slots[s] = (st["wave"], 1.0, 0.9)
        elif "-" in s or s == "dash": slots[s] = (st["move"], 1.0, 0.8)
        elif s in ("standing", "sleeping"): slots[s] = (st["default"][0], st["default"][1] * 0.5, st["default"][2] * 1.4)
        elif s in ("review", "look", "ball", "swimming"): slots[s] = ("read" if style in ("clerk", "prosecutor") else "scan", 1.0, 1.0)
        elif s == "diving": slots[s] = ("bow", 1.0, 1.0)
        else: slots[s] = st["default"]
    return slots


# ── 图像处理 ────────────────────────────────────────────────────────────
def is_green(c):
    r, g, b = c[:3]
    return g > r + 25 and g > b + 25 and g > 90


def trim_padding(img, max_pad=16):
    im = img.convert("RGB"); w, h = im.size; px = im.load()
    def row_ok(y): return any(is_green(px[x, y]) for x in range(0, w, 9))
    def col_ok(x): return any(is_green(px[x, y]) for y in range(0, h, 9))
    t = b = l = r = 0
    while t < max_pad and not row_ok(t): t += 1
    while b < max_pad and not row_ok(h - 1 - b): b += 1
    while l < max_pad and not col_ok(l): l += 1
    while r < max_pad and not col_ok(w - 1 - r): r += 1
    return im.crop((l, t, w - r, h - b)) if (t or b or l or r) else im


def key_out_green(img):
    img = img.convert("RGBA"); px = img.load(); w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if g > r + 25 and g > b + 25 and g > 90:
                px[x, y] = (r, g, b, 0)
    return img


def fit_cell(img, pad=8):
    mw, mh = CW - pad * 2, CH - pad * 2
    s = min(mw / img.width, mh / img.height)
    return img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))), Image.LANCZOS)


# ── AI 出图 ─────────────────────────────────────────────────────────────
def generate_image(prompt, api_key, base_url, model, size, out_path):
    body = {"model": model, "prompt": prompt, "size": size, "n": 1}
    req = urllib.request.Request(base_url.rstrip("/") + "/images/generations",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key},
        method="POST")
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read().decode())
    item = (d.get("data") or [{}])[0]
    if item.get("b64_json"):
        raw = base64.b64decode(item["b64_json"])
    elif item.get("url"):
        with urllib.request.urlopen(item["url"], timeout=120) as r2:
            raw = r2.read()
    else:
        raise RuntimeError("接口未返回图片数据: " + json.dumps(d)[:200])
    im = Image.open(io.BytesIO(raw))
    im.load()                       # 防御截断
    im.convert("RGB").save(out_path)
    return out_path


# ── 主流程 ──────────────────────────────────────────────────────────────
def build(src_path, out_dir, name, style):
    src = Image.open(src_path)
    trimmed = trim_padding(src)
    cut = key_out_green(trimmed)
    bbox = cut.getbbox()
    if bbox:
        cut = cut.crop(bbox)
    base = fit_cell(cut)

    slots = style_slots(style)
    os.makedirs(out_dir, exist_ok=True)
    sheet = Image.new("RGBA", (CW * COLS, CH * len(BASE_SLOTS)), (0, 0, 0, 0))
    rows, preview = [], None
    for r, state in enumerate(BASE_SLOTS):
        kind, amp, speed = slots[state]
        n = FRAMES[state]
        fr = frames_for(kind, amp, base, n)
        if preview is None:
            preview = fr[0]
        for c, f in enumerate(fr):
            sheet.alpha_composite(f, (c * CW, r * CH))
        rows.append({"state": state, "row": r, "frames": n, "speed": round(speed, 2)})

    sheet.save(os.path.join(out_dir, "spritesheet.png"))
    preview.resize((CW * 2, CH * 2), Image.LANCZOS).save(os.path.join(out_dir, "preview.png"))
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"displayName": name, "cellWidth": CW, "cellHeight": CH,
                   "columns": COLS, "rows": rows}, f, ensure_ascii=False, indent=2)
    return len(BASE_SLOTS), sum(FRAMES.values())


def main():
    ap = argparse.ArgumentParser(description="一句话生成桌宠")
    ap.add_argument("description", help="宠物描述，如：一只穿警服的柴犬")
    ap.add_argument("--name", help="宠物名（默认取描述前 8 字）")
    ap.add_argument("--style", default="generic", choices=list(STYLES), help="动作风格")
    ap.add_argument("--pets-dir", default=os.path.expanduser("~/Library/Application Support/DeepWhale Desktop/pets"))
    ap.add_argument("--out", help="只输出到目录，不安装")
    ap.add_argument("--keep-source", action="store_true", help="保留 AI 原图")
    ap.add_argument("--no-bg-rule", action="store_true", help="不自动追加绿底要求")
    ap.add_argument("--provider", choices=list(PROVIDER_PRESETS), help="图像接口预设（也可用 --base-url/--model 自定义）")
    ap.add_argument("--api-key", help="图像生成 API Key（也可写进 ~/.petforge.json 或设 PETFORGE_API_KEY）")
    ap.add_argument("--base-url", help="OpenAI 兼容图像接口 base URL")
    ap.add_argument("--model", help="图像模型名")
    ap.add_argument("--size", default="1024x1024")
    a = ap.parse_args()

    cfg = load_config()
    provider = a.provider or cfg.get("provider") or "agnes"
    preset = PROVIDER_PRESETS.get(provider, PROVIDER_PRESETS["agnes"])
    a.base_url = a.base_url or cfg.get("base_url") or preset["base_url"]
    a.model = a.model or cfg.get("model") or preset["model"]
    a.api_key = a.api_key or os.environ.get("PETFORGE_API_KEY") or cfg.get("api_key")
    a.size = a.size or cfg.get("size") or "1024x1024"

    if not a.api_key:
        sys.exit(
            "缺少图像生成 API Key。\n"
            "  方式1: python3 petforge.py \"描述\" --provider dashscope --api-key sk-xxx\n"
            "  方式2: 写进 ~/.petforge.json  {\"provider\":\"dashscope\",\"api_key\":\"sk-xxx\"}\n"
            "  方式3: 设环境变量 PETFORGE_API_KEY\n"
            "可选 provider: " + ", ".join(PROVIDER_PRESETS) + "\n"
            "注意：DeepSeek 系列模型不生图，需要单独申请上述任一图像生成模型的 Key。"
        )

    name = a.name or a.description[:8]
    prompt = a.description
    if not a.no_bg_rule:
        prompt += "，卡通Q版风格，正面站立全身，纯绿色纯色背景，角色居中完整，线条干净简洁，无阴影无文字，适合做游戏精灵图"

    work = a.out or "/tmp/petforge"
    os.makedirs(work, exist_ok=True)
    src_path = os.path.join(work, "source.png")
    print(f"[1/3] AI 出图：{a.description}")
    generate_image(prompt, a.api_key, a.base_url, a.model, a.size, src_path)
    print(f"      → {src_path}")

    out_dir = a.out or os.path.join(work, name)
    print(f"[2/3] 生成动画（{a.style} 风格）")
    # 用 v3 分层/大幅动画引擎（2026-10-20：v2 幅度太小，桌宠上看不出动作）
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from build_pet3 import build as build_v3
        build_v3(src_path, out_dir, name, a.style)
        nstate, nframe = 18, 105
    except Exception as e:  # 回退到旧引擎
        print(f"      v3 引擎不可用（{e}），回退旧引擎")
        nstate, nframe = build(src_path, out_dir, name, a.style)
    print(f"      → {nstate} 状态 / {nframe} 帧")

    if a.out:
        print(f"[3/3] 已输出到 {out_dir}（未安装）")
    else:
        dest = os.path.join(a.pets_dir, name)
        if os.path.exists(dest):
            import shutil; shutil.rmtree(dest)
        import shutil; shutil.copytree(out_dir, dest)
        print(f"[3/3] ✅ 已安装到 {dest}")
    if not a.keep_source and not a.out:
        try: os.remove(src_path)
        except OSError: pass
    print(f"\n完成：重启/切换宠物即可在托盘「宠物」菜单看到「{name}」")


if __name__ == "__main__":
    main()
