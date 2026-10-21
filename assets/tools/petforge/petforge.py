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
import argparse, base64, io, json, math, os, re, subprocess, sys, time, urllib.request
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
# ─────────────────────────────────────────────────────────────────────
# AI 视频生成（真动作）—— 2026-10-21 加
#
# 背景：原来只有"程序化变换"（整图平移缩放），做不出"手抬起来写字"这类动作，
# 用户会明显感觉到机械。这里接入 OpenAI Videos 兼容接口，用**用户自己的视频模型**
# 生成真动作，再切帧组装。
#
# 关键：`first_frame` 支持 **base64 data URI**（2026-10-21 实测），
# 所以用户不需要自备图床，整条链路纯本地完成。
# ─────────────────────────────────────────────────────────────────────
VIDEO_PRESETS = {
    # Agnes Video 2.5（OpenAI Videos 兼容；keyframe 模式用首帧锁角色）
    "agnes": dict(base_url="https://api.agnes-ai.cn/v1", model="agnes-video-2.5-flash",
                  query_path="/agnesapi", mode="keyframe"),
}


def _b64_image(path, max_side=768, quality=90):
    """把图片压成 JPEG 再 base64（视频接口对体积敏感）"""
    im = Image.open(path).convert("RGB")
    if max(im.size) > max_side:
        im.thumbnail((max_side, max_side), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=quality)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def generate_video(prompt, image_path, api_key, preset, seconds="5", size="720P",
                   aspect_ratio="1:1", timeout=1800, poll_sec=4):
    """创建视频任务并轮询直到完成，返回视频 URL。失败抛异常。"""
    base = preset["base_url"].rstrip("/")
    body = {
        "model": preset["model"],
        "mode": preset.get("mode", "keyframe"),
        "first_frame": _b64_image(image_path),
        "prompt": prompt,
        "seconds": str(seconds),
        "size": size,
        "aspect_ratio": aspect_ratio,
    }
    data = json.dumps(body).encode()
    headers = {"Content-Type": "application/json", "Authorization": "Bearer " + api_key}

    # ① 创建（队列满时退避重试）
    vid = None
    for attempt in range(40):
        try:
            req = urllib.request.Request(base + "/videos", data=data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=120) as r:
                d = json.loads(r.read().decode())
            vid = d.get("video_id") or d.get("id") or d.get("task_id")
            if vid:
                print(f"      视频任务已创建: {vid}")
                break
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:160]
            if e.code == 503:          # 队列满
                print(f"      视频队列满，{20}s 后重试（{attempt+1}/40）")
            elif e.code == 429:        # 限流
                print(f"      触发限流，{30}s 后重试（{attempt+1}/40）")
                time.sleep(10)
            else:
                raise RuntimeError(f"视频接口返回 {e.code}: {msg}")
        except Exception as e:
            print(f"      网络异常（{e}），重试（{attempt+1}/40）")
        time.sleep(20)
    if not vid:
        raise RuntimeError("视频队列一直满，创建任务超时")

    # ② 轮询
    q = f"{base}{preset.get('query_path', '/agnesapi')}?video_id={vid}&model_name={preset['model']}"
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        time.sleep(poll_sec)
        try:
            req = urllib.request.Request(q, headers={"Authorization": "Bearer " + api_key})
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.loads(r.read().decode())
        except Exception:
            continue
        st, pr = j.get("status", ""), j.get("progress", 0)
        if st + str(pr) != last:
            print(f"      {st} {pr}%")
            last = st + str(pr)
        if st == "completed":
            url = j.get("url")
            if not url:
                raise RuntimeError("视频完成但没有返回 url")
            return url
        if st == "failed":
            raise RuntimeError("视频生成失败: " + json.dumps(j.get("error"), ensure_ascii=False)[:200])
    raise RuntimeError(f"视频轮询超时（{timeout}s）")


def download_video(url, out_path, timeout=300):
    with urllib.request.urlopen(url, timeout=timeout) as r, open(out_path, "wb") as f:
        f.write(r.read())
    return out_path


def extract_video_frames(mp4_path, out_dir, fps=4):
    """用 ffmpeg 抽帧。没有 ffmpeg 就报错（这是视频模式的硬依赖）。"""
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):
        try: os.remove(os.path.join(out_dir, f))
        except OSError: pass
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", mp4_path, "-vf", f"fps={fps}",
                        os.path.join(out_dir, "f%03d.png")],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("抽帧失败（需要 ffmpeg）: " + (r.stderr or "")[:200])
    return sorted(os.path.join(out_dir, f) for f in os.listdir(out_dir) if f.endswith(".png"))


def _bg_colour(im):
    """取四角多数色当背景色（比固定绿幕/品红幕更通用，用户模型可能生成任何底色）"""
    im = im.convert("RGB")
    w, h = im.size
    pts = [im.getpixel(p) for p in [(2,2),(w-3,2),(2,h-3),(w-3,h-3),(w//2,2)]]
    return max(set(pts), key=pts.count)


def key_any_bg(im, tol=52):
    """按背景色抠图：与四角背景色接近的像素变透明。"""
    bg = _bg_colour(im)
    im = im.convert("RGBA"); px = im.load(); w, h = im.size
    br, bgc, bb = bg
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if abs(r-br) + abs(g-bgc) + abs(b-bb) < tol:
                px[x, y] = (r, g, b, 0)
    return im


def clean_bg_residue(im, hard=60):
    """硬阈值 + 中值滤波，去背景压缩噪点"""
    from PIL import ImageFilter
    a = im.split()[-1]
    a = a.point(lambda v: 0 if v < hard else v)
    a = a.filter(ImageFilter.MedianFilter(3))
    im.putalpha(a)
    return im


def build_from_video(frame_paths, out_dir, name, style, cols=12):
    """把视频帧组装成 spritesheet：1 段视频拆成 idle/review/diving/look 等状态，
    其余状态用程序化补（--motion video 的默认策略）。"""
    CW, CH = 192, 208
    cuts, bbs = [], []
    for f in frame_paths:
        c = clean_bg_residue(key_any_bg(Image.open(f)))
        bb = c.getbbox()
        if not bb:
            continue
        cuts.append(c); bbs.append(bb)
    if not cuts:
        raise RuntimeError("视频帧全透明（抠图失败），可能是背景与角色太接近")
    maxw = max(b[2]-b[0] for b in bbs)
    maxh = max(b[3]-b[1] for b in bbs)
    scale = min((CW-8)/maxw, (CH-8)/maxh)
    cells = []
    for c, bb in zip(cuts, bbs):
        c = c.crop(bb)
        c = c.resize((max(1,int(c.width*scale)), max(1,int(c.height*scale))), Image.LANCZOS)
        cell = Image.new("RGBA", (CW, CH), (0,0,0,0))
        cell.alpha_composite(c, ((CW-c.width)//2, CH-c.height-8))
        cells.append(cell)

    n = len(cells)
    # 分段：开头→idle，中段→review，靠后→diving，末尾→look
    seg = {
        "idle":   cells[:max(4, n//5)],
        "review": cells[max(0,n//5):max(1,int(n*0.7))],
        "diving": cells[int(n*0.7):int(n*0.9)],
        "look":   cells[int(n*0.9):],
    }
    SEG_SPEED = {"idle": 1.1, "review": 2.8, "diving": 2.2, "look": 1.4}

    src = Image.open(frame_paths[0])
    prof = STYLES.get(style, STYLES["generic"])
    out_states = ["idle","waving","jumping","dash","flip","ball","swimming","diving",
                  "standing","look","review","sleeping",
                  "walking-left","walking-right","jogging-left","jogging-right",
                  "fast-running-left","fast-running-right"]
    from PIL import ImageChops
    sheet = Image.new("RGBA", (CW*cols, CH*len(out_states)), (0,0,0,0))
    rows, report = [], []
    for r, st in enumerate(out_states):
        if st in seg and seg[st]:
            frames = seg[st][:cols]
            src_label, spd = "AI视频", SEG_SPEED[st]
        else:
            fr_n = {"idle":6,"waving":5,"jumping":6,"dash":6,"flip":6,"ball":6,"swimming":6,
                    "diving":6,"standing":4,"look":6,"review":6,"sleeping":6,
                    "walking-left":6,"walking-right":6,"jogging-left":6,"jogging-right":6,
                    "fast-running-left":6,"fast-running-right":6}[st]
            kind = {"waving":"raise","jumping":"bounce","dash":"stride","flip":"turn",
                    "ball":"read","swimming":"read","standing":"still","sleeping":"rest",
                    "walking-left":"stride","walking-right":"stride",
                    "jogging-left":"stride","jogging-right":"stride",
                    "fast-running-left":"stride","fast-running-right":"stride"}.get(st, "breath")
            frames = frames_for(kind, 1.0, cells[0], fr_n)
            src_label, spd = kind, 1.0
        for c, f in enumerate(frames):
            if c < cols:
                sheet.alpha_composite(f, (c*CW, r*CH))
        diffs = []
        for i in range(1, len(frames)):
            d = ImageChops.difference(frames[i-1].convert("RGB"), frames[i].convert("RGB"))
            diffs.append(sum(1 for p in d.getdata() if sum(p) > 20))
        rows.append({"state": st, "row": r, "frames": len(frames), "speed": round(spd, 2)})
        report.append((st, src_label, len(frames), min(diffs) if diffs else 0))

    os.makedirs(out_dir, exist_ok=True)
    sheet.save(os.path.join(out_dir, "spritesheet.png"))
    json.dump({"displayName": name, "cellWidth": CW, "cellHeight": CH, "columns": cols, "rows": rows},
              open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    pv = Image.new("RGBA", (CW, CH), (0,0,0,0))
    pv.alpha_composite(seg["idle"][0] if seg["idle"] else cells[0])
    pv.resize((CW*2, CH*2), Image.LANCZOS).save(os.path.join(out_dir, "preview.png"))
    return report


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
    ap.add_argument("--motion", default="procedural", choices=["procedural", "video"],
                    help="动作生成方式：procedural=程序化变换（快，机械）；video=AI 视频生成真动作（慢，需要视频模型）")
    ap.add_argument("--video-provider", default="agnes", choices=list(VIDEO_PRESETS),
                    help="视频模型接口预设")
    ap.add_argument("--video-model", help="视频模型名（默认用预设里的）")
    ap.add_argument("--video-seconds", default="5", help="视频时长 4~12 秒")
    ap.add_argument("--video-prompt", help="自定义动作描述（默认用通用小幅动作）")
    ap.add_argument("--video-size", default="720P", choices=["720P", "1080P", "1K", "2K"])
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
    if a.motion == "video":
        # ── AI 视频真动作 ──
        preset = dict(VIDEO_PRESETS[a.video_provider])
        if a.video_model:
            preset["model"] = a.video_model
        vprompt = a.video_prompt or (
            "卡通角色站在纯色背景前，固定镜头，做自然的小幅动作：轻微呼吸起伏、偶尔转头，"
            "身体几乎不移动，角色外观、服装、颜色完全保持一致，背景纯色保持不变，不要镜头运动"
        )
        print(f"[2/4] AI 视频生成（{preset['model']}，{a.video_seconds}s）")
        print(f"      动作描述：{vprompt[:60]}...")
        try:
            vurl = generate_video(vprompt, src_path, a.api_key, preset,
                                  seconds=a.video_seconds, size=a.video_size)
            mp4 = os.path.join(work, "motion.mp4")
            download_video(vurl, mp4)
            print(f"[3/4] 抽帧 + 组装")
            frames = extract_video_frames(mp4, os.path.join(work, "frames"), fps=4)
            print(f"      抽到 {len(frames)} 帧")
            report = build_from_video(frames, out_dir, name, a.style)
            nstate, nframe = len(report), sum(r[2] for r in report)
            for st, src_l, nf, mind in report:
                flag = "" if mind > 0 else "  ⚠️ 静止"
                print(f"      {st:<16} {src_l:<10} {nf:>2}帧{flag}")
        except Exception as e:
            print(f"\n⚠️ 视频模式失败：{e}")
            print("   回退到程序化模式（动作会比较机械，但至少能用）\n")
            a.motion = "procedural"
    if a.motion == "procedural":
        print(f"[2/3] 生成动画（{a.style} 风格，程序化）")
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            from build_pet3 import build as build_v3
            build_v3(src_path, out_dir, name, a.style)
            nstate, nframe = 18, 105
        except Exception as e:
            print(f"      v3 引擎不可用（{e}），回退旧引擎")
            nstate, nframe = build(src_path, out_dir, name, a.style)
    print(f"      → {nstate} 状态 / {nframe} 帧")

    if a.out:
        print(f"[4/4] 已输出到 {out_dir}（未安装）")
    else:
        dest = os.path.join(a.pets_dir, name)
        if os.path.exists(dest):
            import shutil; shutil.rmtree(dest)
        import shutil; shutil.copytree(out_dir, dest)
        print(f"[4/4] ✅ 已安装到 {dest}")
    if not a.keep_source and not a.out:
        try: os.remove(src_path)
        except OSError: pass
    print(f"\n完成：重启/切换宠物即可在托盘「宠物」菜单看到「{name}」")


if __name__ == "__main__":
    main()
