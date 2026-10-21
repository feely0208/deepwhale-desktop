# -*- coding: utf-8 -*-
"""绿幕版组装：AI 视频（有道具动作）+ 绿幕抠图（去绿，零红边）"""
import sys, os, json, glob
sys.path.insert(0,'/Users/mac/dsh-desktop/assets/tools/petforge')
import build_pet3 as B
from PIL import Image, ImageFilter
import numpy as np

CW,CH,COLS = 192,208,12
SLOTS = ['idle','waving','jumping','flip','ball','swimming','diving','standing','look','review','sleeping']

def key_green(img):
    a=np.asarray(img.convert('RGB')).astype(float)
    R,G,B=a[:,:,0],a[:,:,1],a[:,:,2]
    # 绿色占主导就判为背景（兼容纯绿和草绿）
    green = G - np.maximum(R,B)
    rel = G / (np.maximum(R,B) + 1)
    alpha = np.clip((30 - green)/25.0, 0, 1) * np.clip((1.45 - rel)/0.25, 0, 1)
    Gn = np.where(green > 8, np.minimum(G, np.maximum(R,B)+2), G)
    return Image.fromarray(np.dstack([R,Gn,B,alpha*255]).astype(np.uint8),'RGBA')

def pick_clean_frames(name):
    """只取背景为绿/黑的帧（跳过品红帧——AI 背景色会漂）"""
    files = sorted(glob.glob(f'/tmp/gv/{name}/*.png'))
    clean=[]
    for f in files:
        a=np.asarray(Image.open(f).convert('RGB')).astype(int)
        h,w,_=a.shape
        c=[a[3,3],a[3,w-4],a[h-4,3],a[h-4,w-4]]
        r,g,b = c[0]
        # 2026-10-21 放宽：AI 给的"绿幕"经常是草绿(116,230,42)，不是纯绿(0,255,0)
        is_green = g > 150 and g > r*1.4 and g > b*1.4
        is_dark  = (int(r)+int(g)+int(b))/3 < 45
        if is_green or is_dark: clean.append(f)
    return clean

def load_cells(name, n):
    files = pick_clean_frames(name)      # 只取背景干净的帧
    if not files: return []
    step = len(files)/n
    pick = [files[min(len(files)-1,int(i*step))] for i in range(n)]
    cells=[]
    for f in pick:
        c = key_green(Image.open(f))
        bb = c.getbbox()
        if bb: c = c.crop(bb)
        cells.append(c)
    return cells

def place_multiframe(cells, W, H, scale_to=1.0):
    """统一缩放（按中位数 bbox），底部对齐"""
    if not cells: return []
    hs = [c.height for c in cells]
    mh = int(np.median(hs))
    out=[]
    for c in cells:
        sc = (H-6)/mh * scale_to
        c2 = c.resize((max(1,int(c.width*sc)), max(1,int(c.height*sc))), Image.LANCZOS)
        cell = Image.new('RGBA',(W,H),(0,0,0,0))
        cell.alpha_composite(c2, ((W-c2.width)//2, H-c2.height-3))
        out.append(cell)
    return out

# 2026-10-21：全部 10 个动作都用绿幕视频（分层动画用户嫌假）
VIDEO = {
    'review':('review',12,2.4), 'ball':('ball',12,2.6), 'look':('look',12,2.4),
    'flip':('flip',12,2.0), 'waving':('waving',12,2.2), 'swimming':('swimming',12,2.2),
    'diving':('diving',12,2.4), 'jumping':('jumping',12,2.0),
    'idle':('idle',12,3.0), 'sleeping':('sleeping',12,2.8),
}

# 分层动画（给没有视频的状态）
sys.path.insert(0,'/tmp')
from layered_pet import load_clean, Rig, fit

def build(out_dir):
    base = load_clean('/Users/mac/宠物工厂-test/rat-clerk-v2.png')
    rig = Rig(base)
    import math
    sheet = Image.new('RGBA',(CW*COLS,CH*len(SLOTS)),(0,0,0,0))
    rows=[]
    for r,slot in enumerate(SLOTS):
        if slot in VIDEO:
            name,n,spd = VIDEO[slot]
            cells = load_cells(name, min(n, COLS))
            frames = place_multiframe(cells, CW, CH)[:COLS]   # 硬限制：不能超过列数
        else:
            # 分层动画
            if slot=='idle':
                frames=[fit(rig.frame(body_scale=1+0.02*math.sin(i/6*2*math.pi)),rig) for i in range(6)]; spd=2.6
            elif slot=='standing':
                # 用 idle 视频的第一帧（保持风格一致）
                sc_ = load_cells('idle', 1)
                frames = place_multiframe(sc_, CW, CH) if sc_ else [fit(rig.frame(),rig)]
                spd=1.0
            elif slot=='sleeping':
                frames=[fit(rig.frame(head_angle=-5-i*5),rig) for i in range(5)]+[fit(rig.frame(head_angle=-28),rig)]; spd=2.4
            elif slot=='diving':
                frames=[fit(rig.frame(head_angle=-8-i*6),rig) for i in range(4)]+[fit(rig.frame(head_angle=-30),rig)]; spd=2.2
            elif slot=='flip':
                # 真翻跟头：整图旋转一整圈（-360°），每帧 60°
                frames=[fit(rig.frame(whole_angle=a),rig,0.72) for a in [0,-60,-120,-180,-240,-300]]; spd=1.0
            elif slot=='swimming':
                # 2026-10-21：左右摇摆被用户嫌"贼难看" → 改成轻微上下浮动
                frames=[fit(rig.frame(whole_dy=round(2.5*math.sin(i/6*2*math.pi))),rig) for i in range(6)]; spd=1.8
            elif slot=='jumping':
                frames=[fit(rig.frame(body_scale=0.93, whole_dy=14),rig),fit(rig.frame(body_scale=1.06, whole_dy=-4),rig),fit(rig.frame(),rig)]; spd=1.4
            else:
                frames=[fit(rig.frame(),rig)]; spd=1.5
        assert len(frames) <= COLS, f'{slot} 帧数 {len(frames)} 超过列数 {COLS}'
        for c,f in enumerate(frames):
            sheet.alpha_composite(f,(c*CW,r*CH))
        rows.append({"state":slot,"row":r,"frames":len(frames),"speed":round(spd,2)})
    os.makedirs(out_dir,exist_ok=True)
    EXP=(CW*COLS,CH*len(SLOTS)); assert sheet.size==EXP, f'{sheet.size}!={EXP}'
    # 最终保险：清残留绿/红
    arr=np.asarray(sheet).copy()
    R_,G_,B_,A_=arr[:,:,0].astype(int),arr[:,:,1].astype(int),arr[:,:,2].astype(int),arr[:,:,3]
    # 品红特征：R 明显高于 G 且 B 也高于 G（粉色耳朵 B-G 很小，不会误伤）
    magenta = ((R_-G_)>55) & ((B_-G_)>25)
    bad = magenta | ((A_<220)&((G_-np.maximum(R_,B_))>20))
    arr[:,:,3][bad]=0
    sheet=Image.fromarray(arr,'RGBA')
    sheet.save(f'{out_dir}/spritesheet.png')
    json.dump({"displayName":"鼠书记员","cellWidth":CW,"cellHeight":CH,"columns":COLS,"rows":rows},
              open(f'{out_dir}/manifest.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
    pv=Image.new('RGBA',(CW,CH),(0,0,0,0)); pv.alpha_composite(frames[0])
    pv.resize((CW*2,CH*2),Image.LANCZOS).save(f'{out_dir}/preview.png')
    print(f'✅ {sheet.size} | {len(SLOTS)} 状态')
    for x in rows: print(f'  {x["state"]:<10} {x["frames"]}帧 speed={x["speed"]}')

if __name__=='__main__':
    build('/tmp/rat-green')
