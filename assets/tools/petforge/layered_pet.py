# -*- coding: utf-8 -*-
"""分层动画宠物生成器（2026-10-21）

为什么这样做：
- AI 视频：背景控制不住（要求黑还给品红），边缘被染色 → 一圈红边，所有后处理都去不干净
- 整图变换：动作是"整体晃"，看不出写字/挥手
- **分层**：把角色切成 头/身体/手/尾巴，每层独立做变换 → 动作自然，且原始图无污染、零红边

大肥鱼就是这样做的（矢量分层），我们用位图分层达到接近的效果。
"""
import sys, os, json
import numpy as np
from PIL import Image

CW, CH, COLS = 192, 208, 12
SLOTS = ['idle','waving','jumping','flip','ball','swimming','diving','standing','look','review','sleeping']

def load_clean(path):
    """抠图（品红）+ 裁 bbox，返回干净的 RGBA"""
    im = Image.open(path)
    a = np.asarray(im.convert('RGB')).astype(float)
    R,G,B = a[:,:,0],a[:,:,1],a[:,:,2]
    alpha = np.where((np.minimum(R,B)-G) > 42, 0, 255).astype(np.uint8)
    out = Image.fromarray(np.dstack([a, alpha]).astype(np.uint8), 'RGBA')
    bb = out.getbbox()
    return out.crop(bb)

class Rig:
    """把角色切成可独立驱动的层"""
    def __init__(self, base):
        self.img = base
        self.W, self.H = base.size
        self.neck = int(self.H * 0.42)          # 脖子位置（40% 处最窄）
        # 头部：0 ~ neck+6%（带过渡带）
        self.head = self.img.crop((0, 0, self.W, int(self.H*0.48)))
        # 身体：neck-6% ~ 底部
        self.body = self.img.crop((0, self.neck, self.W, self.H))
        self.body_y = self.neck

    def frame(self, head_angle=0.0, head_dx=0, head_dy=0,
              body_scale=1.0, body_dy=0, whole_angle=0.0, whole_dx=0, whole_dy=0):
        canvas = Image.new('RGBA', (self.W, self.H), (0,0,0,0))
        # ① 身体（可缩放/位移）
        b = self.body
        if body_scale != 1.0:
            nw = max(1,int(b.width*body_scale)); nh = max(1,int(b.height*body_scale))
            b = b.resize((nw,nh), Image.LANCZOS)
            bx = (self.W - nw)//2
        else:
            bx = 0
        canvas.alpha_composite(b, (bx, self.body_y + int(body_dy)))
        # ② 头部（绕脖子旋转）
        h = self.head
        if head_angle != 0:
            pivot = (self.W/2, self.neck)
            h = h.rotate(head_angle, resample=Image.BICUBIC, center=pivot)
        canvas.alpha_composite(h, (int(head_dx), int(head_dy)))
        # ③ 整图变换（跳跃/翻转用）
        if whole_angle != 0:
            canvas = canvas.rotate(whole_angle, resample=Image.BICUBIC)
        if whole_dx or whole_dy:
            tmp = Image.new('RGBA', (self.W, self.H), (0,0,0,0))
            tmp.alpha_composite(canvas, (int(whole_dx), int(whole_dy)))
            canvas = tmp
        return canvas

def fit(canvas, rig):
    """缩放 + 底部对齐到格子"""
    W,H = rig.W, rig.H
    sc = min((CW-6)/W, (CH-6)/H)
    nw, nh = max(1,int(W*sc)), max(1,int(H*sc))
    c = canvas.resize((nw,nh), Image.LANCZOS)
    cell = Image.new('RGBA',(CW,CH),(0,0,0,0))
    cell.alpha_composite(c, ((CW-nw)//2, CH-nh-3))
    return cell

def build(out_dir, src_path, name='鼠书记员'):
    base = load_clean(src_path)
    rig = Rig(base)
    print(f'角色 {rig.W}x{rig.H} | 脖子 y={rig.neck}')

    import math
    def frames_for(slot):
        """每个状态的动作设计（全部由分层驱动）"""
        if slot == 'idle':
            return [rig.frame(body_scale=1+0.012*math.sin(i/6*2*math.pi)) for i in range(6)], 2.6
        if slot == 'review':   # 写字：持续点头
            return [rig.frame(head_angle=-7+4*math.sin(i/8*2*math.pi)) for i in range(8)], 2.0
        if slot == 'look':     # 左右张望 + 抬头
            return [rig.frame(head_angle=3*math.sin(i/8*2*math.pi), head_dx=4*math.sin(i/8*2*math.pi)) for i in range(8)], 2.0
        if slot == 'sleeping': # 打盹：头慢慢低下
            return [rig.frame(head_angle=-min(i,i and (7-i)) * 0 + (-3 - i*2.2)) for i in range(5)] + \
                   [rig.frame(head_angle=-13) for _ in range(1)], 2.4
        if slot == 'waving':   # 挥手：头轻微摆动 + 身体侧倾
            return [rig.frame(head_angle=2*math.sin(i/6*2*math.pi), whole_angle=2.2*math.sin(i/6*2*math.pi)) for i in range(6)], 1.8
        if slot == 'jumping':  # 跳：整体上下 + 缩放
            return [rig.frame(body_scale=0.96, whole_dy=8), rig.frame(body_scale=1.04, whole_dy=-2),
                    rig.frame(body_scale=1.0, whole_dy=0)], 1.4
        if slot == 'flip':     # 翻转：整体旋转
            return [rig.frame(whole_angle=a) for a in [0,-12,-28,-45,-28,-12]], 1.5
        if slot == 'ball':     # 翻卷宗：头前倾 + 身体起伏
            return [rig.frame(head_angle=-6*math.sin(i/6*2*math.pi), body_scale=1+0.02*math.sin(i/6*2*math.pi)) for i in range(6)], 2.0
        if slot == 'swimming': # 摆动
            return [rig.frame(whole_angle=2.5*math.sin(i/6*2*math.pi)) for i in range(6)], 1.6
        if slot == 'diving':   # 俯身：头低 + 身体前倾
            return [rig.frame(head_angle=-4-i*3, whole_angle=-2) for i in range(4)] + [rig.frame(head_angle=-16)], 2.2
        if slot == 'standing':
            return [rig.frame()], 1.0
        return [rig.frame()], 1.5

    sheet = Image.new('RGBA', (CW*COLS, CH*len(SLOTS)), (0,0,0,0))
    rows = []
    for r, slot in enumerate(SLOTS):
        frames, speed = frames_for(slot)
        for c, f in enumerate(frames):
            if c < COLS:
                sheet.alpha_composite(fit(f, rig), (c*CW, r*CH))
        rows.append({"state": slot, "row": r, "frames": len(frames), "speed": round(speed,2)})

    os.makedirs(out_dir, exist_ok=True)
    # 自检
    EXP = (CW*COLS, CH*len(SLOTS))
    assert sheet.size == EXP, f'尺寸错: {sheet.size} != {EXP}'
    # 清除任何残余紫色（保险）
    arr = np.asarray(sheet).copy()
    R_,G_,B_ = arr[:,:,0].astype(int), arr[:,:,1].astype(int), arr[:,:,2].astype(int)
    mag = (G_ < 70) & ((R_-G_) > 25) & ((B_-G_) > 5) & (arr[:,:,3] < 220)
    arr[:,:,3][mag] = 0
    sheet = Image.fromarray(arr, 'RGBA')
    sheet.save(os.path.join(out_dir,'spritesheet.png'))
    json.dump({"displayName": name, "cellWidth": CW, "cellHeight": CH,
               "columns": COLS, "rows": rows},
              open(os.path.join(out_dir,'manifest.json'),'w',encoding='utf-8'),
              ensure_ascii=False, indent=2)
    pv = Image.new('RGBA',(CW,CH),(0,0,0,0))
    pv.alpha_composite(fit(rig.frame(), rig))
    pv.resize((CW*2,CH*2), Image.LANCZOS).save(os.path.join(out_dir,'preview.png'))
    print(f'✅ {sheet.size} | {len(SLOTS)} 状态 | {sum(r["frames"] for r in rows)} 帧')
    for r in rows: print(f'   {r["state"]:<10} {r["frames"]}帧 speed={r["speed"]}')
    return out_dir

if __name__ == '__main__':
    build('/tmp/rat-layered', '/Users/mac/宠物工厂-test/rat-clerk-v2.png')
