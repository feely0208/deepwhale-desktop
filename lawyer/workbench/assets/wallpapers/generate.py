#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate sample wallpapers for the legal-mode workbench framework.

Outputs (in this directory):
  aurora.jpg         dark blue/teal aurora      (suits dark theme)
  sunset.jpg         warm orange/purple         (suits light theme)
  mist.jpg           soft light teal            (light/elegant)
  nebula.jpg         deep purple/blue nebula    (dark/immersive)
  aurora.gif         animated gradient GIF      (dynamic wall)
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 1600, 900


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vertical_gradient(top, bottom):
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        d.line([(0, y), (W, y)], fill=lerp(top, bottom, y / H))
    return img


def blob(img, cx, cy, r, color, alpha=120):
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (alpha,))
    glow = glow.filter(ImageFilter.GaussianBlur(60))
    img.alpha_composite(glow)


def aurora():
    img = vertical_gradient((8, 20, 45), (12, 60, 90)).convert("RGBA")
    d = ImageDraw.Draw(img)
    blob(img, W * 0.25, H * 0.30, 420, (0, 200, 220))
    blob(img, W * 0.70, H * 0.60, 380, (40, 120, 240))
    blob(img, W * 0.55, H * 0.20, 320, (120, 90, 230))
    return img.convert("RGB")


def sunset():
    img = vertical_gradient((255, 190, 120), (150, 60, 130)).convert("RGBA")
    d = ImageDraw.Draw(img)
    blob(img, W * 0.5, H * 0.55, 400, (255, 140, 80))
    blob(img, W * 0.22, H * 0.25, 320, (255, 210, 150))
    blob(img, W * 0.8, H * 0.7, 360, (200, 80, 160))
    return img.convert("RGB")


def mist():
    img = vertical_gradient((238, 245, 250), (200, 224, 232)).convert("RGBA")
    d = ImageDraw.Draw(img)
    blob(img, W * 0.2, H * 0.2, 400, (255, 255, 255))
    blob(img, W * 0.8, H * 0.75, 420, (160, 214, 224))
    return img.convert("RGB")


def nebula():
    img = vertical_gradient((12, 8, 34), (40, 16, 70)).convert("RGBA")
    d = ImageDraw.Draw(img)
    blob(img, W * 0.3, H * 0.4, 460, (120, 60, 220))
    blob(img, W * 0.72, H * 0.3, 360, (30, 90, 220))
    blob(img, W * 0.6, H * 0.78, 380, (200, 60, 160))
    return img.convert("RGB")


def animated_gif(frames=40, out="aurora.gif"):
    imgs = []
    for f in range(frames):
        t = f / frames
        img = vertical_gradient((8, 20, 45), (ind := int(20 + 40 * t), int(60 + 30 * t), int(90 + 40 * t)))
        rimg = img.convert("RGBA")
        import math as m
        blob(rimg, W * (0.25 + 0.45 * (0.5 + 0.5 * m.sin(2 * m.pi * t))), H * 0.35, 420, (0, 200, 220))
        blob(rimg, W * (0.7 - 0.3 * (0.5 + 0.5 * m.sin(2 * m.pi * t + 1))), H * 0.65, 380, (60, 120, 240))
        imgs.append(rimg.convert("RGB"))
    imgs[0].save(out, save_all=True, append_images=imgs[1:], duration=40, loop=0)
    print("wrote", out, os.path.getsize(out), "bytes")


def main():
    specs = [("aurora.jpg", aurora), ("sunset.jpg", sunset), ("mist.jpg", mist), ("nebula.jpg", nebula)]
    for name, fn in specs:
        img = fn()
        img.save(os.path.join(HERE, name), quality=90)
        print("wrote", name, img.size)
    animated_gif(out=os.path.join(HERE, "aurora.gif"))


if __name__ == "__main__":
    main()
