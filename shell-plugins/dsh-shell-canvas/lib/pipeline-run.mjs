/**
 * 任务执行体 —— 真正调用深鲸画布引擎的地方。
 *
 * 两个入口共用本文件（同一份逻辑，只换渲染后端）：
 *   · `lib/worker.mjs`    普通 Node 子进程 → Chromium 后端（Playwright 驱动本机已有 Chromium）
 *   · `lib/osr-main.cjs`  Electron 主进程 → Electron OSR 后端（桌面端自带的 Chromium）
 *
 * ── 为什么不直接调 `produce()` ──────────────────────────────────────────
 * `src/pipeline.mjs` 的 `produce()` 是引擎的**一次性主入口**（S2 验收对象），
 * 但它没有对外暴露 `resume`，而 §4.2 要求"中途 kill 掉重跑能跳过已渲好的帧"。
 * S3 的约束是**不改内核**，所以这里由外壳把同一条链路按阶段拼出来：
 * 每一步都调引擎自己导出的函数（`synthVoiceTrack` / `buildCuesFromText` /
 * `renderTemplate` / `mixVoiceAndBgm` / `muxAudio`），外壳只负责"顺序 + 进度 + 取消 + 续渲"。
 * 分步顺序与 `produce()` 完全一致，见 `README.md` 的"与 produce() 的一致性"。
 *
 * ── 每步都保持引擎的既有约束（踩过的坑，别再踩）────────────────────────
 *   · ffmpeg concat 清单必须写**绝对路径**（引擎内部已处理，这里不碰）；
 *   · 预览档必须按设计尺寸建 DOM、只整体缩放（引擎 `renderFrames` 内部已处理）；
 *   · 渲染进程必须断网（两个适配器都装了 webRequest 过滤）。
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * 重建断点清单。
 *
 * ── 为什么需要这一步（§4.2 第 2 条的实测坑）──────────────────────────
 * 引擎的断点续渲靠 `<outDir>/frames/manifest.json`：`renderFrames({resume:true})`
 * 只认清单里记着的帧。而清单是**渲完（或优雅取消）时才落盘**的。
 * 于是"中途 `kill -9`"这种最真实的场景：几十张 PNG 明明躺在盘上，
 * 重跑却是「续用 0」—— 因为没有任何东西告诉引擎"这些帧是好的"。
 *
 * 外壳能做的正确的事，不是伪造指纹，而是**按盘上真实的字节重算**：
 * 帧文件本身就是唯一事实来源，重新哈希一遍与当初写清单时记录的值等价
 * （编码阶段读的也是这些文件，指纹只进报告）。
 *
 * 只在"清单缺失"或"清单是我们重建的且这次的计划变了"时才动手：
 * 引擎自己写的完整清单永远优先。
 */
function recoverFrameManifest(frameDir, planSig, emit, orientation) {
  if (!frameDir || !existsSync(frameDir)) return 0;
  const manifestPath = join(frameDir, 'manifest.json');
  let existing = null;
  if (existsSync(manifestPath)) {
    try { existing = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { existing = null; }
    // 引擎写的（没有 recoveredBy 标记）→ 原样尊重，不碰。
    if (existing && !existing.recoveredBy) return 0;
    // 是我们上次重建的，但这次的渲染计划变了（画质/帧数不同）→ 作废重建。
    if (existing && existing.recoveredBy && existing.planSig === planSig) return 0;
  }

  const pngs = readdirSync(frameDir)
    .filter((f) => /^frame-\d{6}\.png$/.test(f))
    .sort();
  if (!pngs.length) return 0;

  const frames = pngs.map((file, i) => {
    const full = join(frameDir, file);
    const buf = readFileSync(full);
    return {
      outIndex: i,
      srcFrame: null, // 引擎恢复时用计划里的 srcFrame，不读这里
      file,
      sha256: createHash('sha256').update(buf).digest('hex'),
      bytes: statSync(full).size,
      resumed: true,
    };
  });
  writeFileSync(manifestPath, JSON.stringify({
    partial: true,
    recoveredBy: 'dsh-shell-canvas',
    recoveredAt: new Date().toISOString(),
    planSig,
    frameCount: frames.length,
    frames,
  }, null, 2) + '\n');
  emit({ t: 'log', msg: `${orientation === 'vertical' ? '竖版' : '横版'}：发现 ${frames.length} 张没有清单的残留帧（上次被强杀），已按盘上字节重建断点清单` });
  return frames.length;
}

/** 计划签名：画质 + 输出尺寸 + 输出帧数 —— 变了就不能续用旧帧。 */
function planSignature(plan) {
  return `${plan.quality.scale}x${plan.quality.step}@${plan.width}x${plan.height}/${plan.indices.length}`;
}

/** 按需 import 引擎模块（绝对路径；引擎目录带空格，必须用 pathToFileURL）。 */
async function imp(root, rel) {
  return import(pathToFileURL(join(root, rel)).href);
}

/**
 * 跑一个任务。
 *
 * @param {object} spec 任务规格（见 lib/jobs.mjs 的 buildSpec）
 * @param {object} host
 * @param {(e: object) => void} host.emit        向宿主吐一行 JSON 事件
 * @param {(o: {width:number,height:number}) => object} host.makeAdapter 造一个渲染适配器
 * @param {AbortSignal} host.signal              取消信号
 */
/**
 * 右下角水印（2026-10-10 用户定的形态）
 *
 * 用户原话：「水印就写一个深鲸画布 + 你说的右下角青色大肥鱼就好，
 *            不用写试用版三个字，得罪人而且体验感差」
 *   → 只放「深鲸画布」四个字 + 我们的青色鲸鱼，右下角。
 *   → **不写"试用版"**：写着等于当面提醒用户没付钱，体验很糟。
 *
 * 商业模型（用户拍板）：免费版**不限条数**、带这个水印；
 *   ¥199/年 去水印 + 批量 + 台账。水印是唯一的门槛。
 *   所以：未授权 → 加水印；已授权 → 不加水印（spec.watermark === false 时跳过）。
 */
export function injectWatermark(doc, enabled = true) {
  if (!enabled) return doc;                                 // 已授权：不加水印
  if (!doc || !Array.isArray(doc.nodes)) return doc;
  if (doc.nodes.some((n) => n && String(n.id || '').startsWith('__wm_'))) return doc;   // 别重复加
  const W = doc.canvas?.w || 1080;
  const H = doc.canvas?.h || 1920;
  const S = Math.round(Math.min(W, H) * 0.062);          // 鲸鱼尺寸（随画幅缩放）
  const pad = Math.round(Math.min(W, H) * 0.045);
  const size = Math.round(Math.min(W, H) * 0.030);       // 字号
  // 中央**斜铺**大字（用户定的形态：鲸在右下，字铺中间）
  //   两处讲究：
  //   ① 这个节点**不进 timeline** —— setFrame 只重写 timeline 里节点的 transform，
  //      不进就保得住静态旋转 ✓
  //   ② 不透明度压到 0.11：既要"一眼看到是我们出的"，又不能毁掉画面 ✓
  // 斜度提成常量：两行文字与偏移量都由它算，改一个数就全对
  const ANGLE = -50;   // 用户选定 C 方案：更斜、更淡、鲸更大
  const big = Math.round(Math.min(W, H) * 0.165);        // C 方案：竖版约 178px
  const textW = Math.round(big * 4.15);                  // 「深鲸画布」四字的估算宽度
  doc.nodes.push({
    id: '__wm_center', type: 'text',
    props: {
      text: '深鲸画布', font: 'source-han-sans', size: big, weight: 700,
      color: '#8FDCE8', align: 'center', opacity: 0.075, maxLines: 1, letterSpacing: 8,
    },
    transform: { x: Math.round((W - textW) / 2), y: Math.round((H - big) / 2), rotate: ANGLE },
  });

  // 英文一行（用户建议：「把深鲸画布下面再增加一行英文的更好，
  //   有心人会用图像处理软件处理掉中文的，简单的多」）
  //   中英两层 + 右下角的鱼 = 三处元素，想抹掉的工作量明显上去 ✓
  //   （诚实说：任何水印都挡不住铁了心的人；这里要的是"抬高门槛 + 品牌看得清"）
  const enSize = Math.round(big * 0.40);                  // C 方案：竖版约 71px
  const enW = Math.round(enSize * 5.6);                   // "DeepWhale" 九个字母的估算宽度
  // ⚠️ 对齐的算法（上一版就是这里错的）：两个节点各自绕【自己的中心】旋转，
  //    所以要用"沿旋转后方向"的偏移来排第二行，而不是屏幕上的竖直偏移。
  //    -28° 时"向下"的方向向量 = (-sin(-28°), cos(-28°)) ≈ (0.469, 0.883)
  const gap = Math.round(big * 0.95);                     // 两行中心距（沿倾斜方向）
  const rad = (ANGLE * Math.PI) / 180;
  const dx = Math.round(-Math.sin(rad) * gap);
  const dy = Math.round(Math.cos(rad) * gap);
  doc.nodes.push({
    id: '__wm_center_en', type: 'text',
    props: {
      text: 'DeepWhale', font: 'source-han-sans', size: enSize, weight: 600,
      color: '#8FDCE8', align: 'center', opacity: 0.075, maxLines: 1, letterSpacing: 20,
    },
    transform: {
      x: Math.round((W - enW) / 2 + dx),
      y: Math.round((H - enSize) / 2 + dy),
      rotate: ANGLE,
    },
  });

  // 右下角：**只留大肥鱼**（用户："右下角的深鲸画布四个字还在，没去掉"）
  //   中央已经有斜铺的大字了，右下再写一遍是重复；鲸鱼本身就是品牌标识 ✓
  const SW = Math.round(Math.min(W, H) * 0.130);         // C 方案：竖版约 140px
  doc.nodes.push({
    id: '__wm_whale', type: 'image',
    props: { src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAACJCAYAAACrbDPTAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAQAElEQVR42u19B4AU1f3/983M9uudO+DoHaQLIigaUFFQscYSTazRaIwmaCyJ3URjiT2W2OtPQbELotKUIr0e7Xpve9unvf8rM7tz617hRHPwv9Fh9mZ3Z2fe+7zPt77vQ9Cz9Wz/w03qaYKerQeAPVsPAA/rDSEAjHt6sweA/wvsIYTJlpmdnZnXKz9v+5bN23u6tQeAv9hGwUeB9/biT9+ePvGo6Weedc6Zixe+t7ina3sA+IttZ5xz7hnHTTzquABA4B//fuIfPQDsAeAvur34zFMvTptx/LQ5p58+55xTTz6np1t7APiLbgrZLjl3/iUOp9MRCgZDPd3aA8BffNPJ1gO+HgD2bD1bDwB7th4A9mw9Ww8Ae7YeAPZsPduRCUDRZrdpiqz0dGEPAH/xbe6fb/vr6Tf/7eZnL7vgd+sXv7+wpxt7APiLbam5eXkTTz97fnKmPXXqeRdd8MPHiz7Auq73dGUPAH/+DSHw1lRX//vs2WeOn3fu6Uuff+qp+Pd70rJ6AHhodDy7HSSbDSKBQOwkBVf2aNTYa2b5/vIDT9347cYHGr5fsWnN91+/43S50KY338Qulwt0UYSI39/Tuz0A7Po26YYb4IR5c+H+Y6fzE717Qx93LgydeQw0nzIXnPuLzxs2Y+wtkeFjN27G7vduGJmtrchIR3NOPhl/l5UFX7/xJmwgBIl7pHMPAA9qIwwGQ4fA/rfeFUNbdqcfc8kl9aslG8CAQnRsc198fG8Z37tlOww58aR9IRm+qygp/1Y/dqi2LT8D5ZZV4L8/8RzY5Igz84Tp4ZTCQvAeONAjmnsA2EnsEZxc+/7b8OKI8fDbneUXD5095dKa0prbDmxcvWq024Ubvlg66YNSxzFHhaTPGh56dv1zUHNuugfqHxt8A9z74B24YQ6eeMNbi3/nSYHe6z744r1VTY+8PnXBAv27Bx+kmdM0ebWnx3sA2I6N4UwF58Z+0Purp6DPrQ+cFFDhuL2bi+ZVz5+/6sz3P55x3CP/elELwyCnE06777TzLsnoO7x89HVnQX72aLhh5N2zi48f/KwSDPZv9Gkw4qSTjrn8yVfX71/5yY777r0Xbrv99sPG0Irquz0A/KXuQgLa7MGQF/77+Dx01q/PwIsefeDF486+xlGx5Yd3hs0+FUZPPfHqlMbIoOpgBPyS7VeXPfbMiU9edv5r6tp+cM3m16b+8ZEHXxjRLPcpD8jg0xC01PkyB06YkNP4yWs7koePODx6Q5TAcdp1mTY1mO9f/9UuqNmrdOuBYg6Sn6Di/M8BmJ+TA8NPPQW+IvcvfPY5XHTuXEiaNAmS1n6/1Ltq79KqzxeCM6dXbk6as3+yHIFSVQVNw+BJTR7UVFUK6z/5OummF16509MU6VPuD8FuvwypTgf0ykneve+thfuuvPI+OG7m4MNCBNNBmGaXTsdp/c5S7I6rIgDl3fZmSVv2mjGDvaxavvxwZkAM/VMKwENaPygJ0CJr+NvPljuuvOhs7Zv9K9VfP/NveOXGmyWnCGJ1SIGt3ggUJDkhSxRTXXYnXHT/Y/NysDprZ1MANjZHQBAFyMpK9a3674v3bDqws2zR04uN9joMRBq5RzmMp4rJrlmpQyZObKzZX67K3TfHdvJ99/XVdZz30XEz1h62AMR2e9JRl135d6k2BK+//eod9uPnDL3x9NMe8Tb5lF4Nvkdfu+beL06Z/7DS6A8qpb4I+HQMTbIGOsYh8ZxzBAeofzjgD6MdLRFw2ETwZOfIS5595jaxcu8bf/r3w9D4nyfh2qsXgp1Y10ok0t3dMoKOUb4SCtncOQMuRO6UJSCHAt31ZsOh0Iywps8nL+cftgB0ZOTkZo4uvC6vARzgSXl++NRpl+Yi7QRE9KHCk+dPP0aWLti2/q0PjxLuqQuqfpAIw0UIUzR7fQ03/O76IUSyTtpW7wNEzjuTk7SiRW/euO6p259yJL+cu2vSNYrW8HFj/5NPgksefhiem3c6VO7b123RN3D8hLRGm5iuKCr4QZ1jn3nJ79Qvn38CB5q6z03a7cxV5iLqkOqyjffrwtDDzwixKK3lJSUV//fusn8dc9IJ6ZefcWZlqt212Y9EuToUsVc3R9z9Tpz99OBfTS9WAt69gmgDQmNMWVJ1xZYiSBfVYEGKYMAOpxOFaisfULauX/bM7obnJEWZ5bXNrdj9zcW/f/SCuXve+sudhfU1dSV04HZT9Q+78galC4LdjUEgIzPJjRxZtzpPulpGWz5/Ra3aF5YDLcaHiT4L+Bftp+iWnExGukOf9JvLBjjHjTnJ9/3Gw9AKpg911VUAH34IfREOD9zyzR0v//sR4aRP3taevuqq10dPObpl2uXXXOKta5mnKuF8AYn/JwtYxVhlzU71OYfTfZWq49Qqrx8Ehx0pmvpNflry9qMffmRhY4N/WB+PBKLN1s8fDJw74PjZ71+y6M0XHh059uKaHZt3dkftj/6jyVgEJyAskW4RaCvhPCEz/37PnD8MU/aufSOtrmLHFbYRwftWP/jLAI6+7t0b4PEnEDz6CIYVKyDTF9Znzb/UvXfGcX8MyvoIORzacni6Yajl9PjjqO7aa3FFOIhbHrtde+TK38J1hf1F51GT90WC4X/mOaT99Yr6R1FXB+s6olPfWCPRdtFUpTCg6hAgFrFDAi3XaWuUbMl3by9tHFzjDUBySgqMzHdi0qsbk0A9kFap345luaI7K4Ahry+spmBiSXGG0zUFExxm+FqarxfzBs+y9zvqi03OXt+m5d5URFqj7jhPU+Onb7+CZVUDQRCgS0lBgwcDfPQRgj/+EcMXX8TOT5wIsGABwDW/B+nN17C6exfc8dxzsLdgwEDXuLE3CDZ8lS8QBl0hP35YAnAnIaKbbsK+++9Hi8vKACZNwX/+2yO5U3Oz3xCczmk+f4Bmm1ZmCFjzqliiDjGNII/KKoUcfYoGfgJA0kMEmJoo69IZpY3NwtaGAETsLsVZUrkM79j60ifvLP6g5LTZemj+tM/DVWXd2ghu2L25Sc8d3Ywd5JEUBYnEqNJ1DRBBF0bSSL8ij/wKlV7sHjhyF9b0vWvD/lLPRX/fl2KH0nGFo/ZsffMhomRs0zS/rwPFm/yAplECALj+OrDPnoXTPcmgFBYS4461JyiNTRC86144emy+cNO9Ryc/XXZF/119h5xQb5POrgv5pkZ8KrkvBLrT6UIeTzIOBHzdH4CiSETv1QA7tgN88w0ABd6dd+KsB/8BkawMCD/5+tkZI+acKDUHYX8g7KzXUEoaucP6iAZBwnQ6gZ9IGJA2ElXkiE3L/HsaGfn7Gv3CLtIoSb36lver3PO3L6445aVVZSUwY9SNUFL/DJz08IPo84uuwNsD3TdLpsVb4ffoejXCiAEEkw5GVBxT1qdPTXpcADE7osjZ5NR0WbTrYnJWM5aEmg3NDfuTLrppTWGo9ouGd57bGCopUuRw8MfildgQ8KtZAmz4Qc998J+gTJlhHzL16Nyjr/hDltcuZGuKko6USHJNRMYNkZBDSk7Jexw5+ssF2ohdYWW4rOouIn3IeECgYh3ZR48ZlvW3vz9Zd/OCS7o/AGkjpKeSXxWip5IiKvT/fq8T//4Gue/ECZW1TRp4/Qre5ZOB9ANqErjVK5LOECn/IaYegUzeDGikYzQdvMEQHJBFECXHD5ULLv19g1NaN+y8353YL8XVa8u2lW/Du5L68LE3ktY/0L0d0ggRyasVCRp1M5GnVBn7ARAmxKKIGCCJHCA9T8ApICQJgo6EDF2EDM0mDG+RI7MkZ9b5mb+77V1pz/rn9r7ySBVh0pg+d8vdCF5OA/juVj1n0MiUo/758PG+/IHTI6AN/7KlpY8oCR5JEp2khZNVm8OtS3bJrxKmQ7JOflXQaMtRkSsiQs0AciQCNiKnBFWVu7cIpo2IqW2H4Oy0YUmpv5+HvlDu9pV++ym4e+XnzPnXna8gCSoXX3HNzef8+Y5/u7NzrymUXLaqZi+opAFGJDugkgDVS55dIhxACaKK/G0jYGqJKFCnSUQUJJfvu+/aK/y/Pm3j3JRBVw6YOunB0RngQe+ODDVo37xvc7lRyetbcHd2SFP1wqEG15DuriONlk30V8C0awkAkc0GVDekH6PPjwTyHIiwoojYgMbkb1WT7cSMGdGg4dtSB48bMfKaW2/Z/sQ9B3Rq41CxsfQznGbvByNvvneKb/Tkv1Rl5hwX8Nan61SBpCaPQnaV65GkmcnPMYGMICILbHAQzJOjSC+nRcKgBsMgeWTQZVnv3gC88lLyECF8+oBZvcdfcfHfnang3r5kxN0EgLtTFn7ZK1QTOVm12cPnHHfRA+/eessNJ//1ttfIQ88t7D/oitpAMF8mw29Qkh22t0RAoWKXimLSZhphvyq/DEHJpY8IFd9dO/2hjeOVtWDzR3ZW7inZpQ0vHB4MJ4dsyRUguTzdPxBCdK+WtYvWO2dctpF0zWwCLjpgKAAYEyI7AaEosJ3qX8BYUWA+UMrsiKgiWAkT8hRsLTI+F+UPEYbMvfTKXY3Lm2ic2bliPUxaeNOv6wvG/sPr8/XVG5oIuCVuhAsUYAIruEj/pj+LGdgRIxAme0h7098iLAiRFj8/H45gIRhu7t4AXEb002AAer0wcrTkgstVH8azb3ngk33Ll+0u2ClXOmY7Xmv8fnPFv/96QeXM034Htx899AfyrR9mX3/Tovl3/eux4prG40MEaL2IuVscUtnopLpgU1hlUZHMrNQvPnv09bcySJt8+e2/wDl9zopRGYWnVhfmDawtCqwvee3NqKuj229+b5NYvucTnD9kJqIp4RQOhJU0wjYCAajgdhA2lAzWQwYTYj4smfVMiUvXsagjn+iYr4wcs9b5/McPUfVl0PMvnlKaPvihYGNzga6ENWyjaAYqyglDMuWEfJuTHhWxIBghTPK7FIh0EBCTGyI+P2FABRAZ1HbVtlOyuX+o6bYApFKjqJw8hQyrX3p0fcaot+5KSkXuHZ++sbyhZDd8+9SldaF3+l2y7+tPcUtlBXz45gNw9B33HOWQ7f0rSpUPFt51x3ln3nHPmweq60+USEe4SKOESaPYSGM1k0awpWaEm7/94DVPv5P9e568AIEgY9fQMUjdU9RQka807HjtATicNqwQw6F8x0Kp94BzVWyfRnRcLEjU8tJAC+nkoINIJKPgdoEgcTZkkKH/EHGMETXMiIJIY452myCNGn9+0rRZ73pS3Jreb/RdgaBcoAYCqmCXJKxS8GpcPxQw9yhQZmV6Mte3ERXx5Bz9FS0kgxwIUBcYBw/pD2X3nq+8nyz+tPsyIH0Q+I693PTOD3W1RcX3uZPdqGzjOlml8z22bIPGRXfj7NpiaKisQKk5eXjseRcXpqYUTvlswYIlKs6s/fi+W2846db73y+vrhviII1DhAyNBYOPtF2KW9xR/cN3H185vB4WDc3Ga1dth6YHbsJqQR6kBCcQjUXEWNMOqzMTcgAAEABJREFUGwDSO/U27SpPKu37OOozYaxsc3iwphKrkyuAlIE0LQg6GXyi2w7I4wTkdPA0QvKPwMSzwMIl5MEhpCiDHEPHjXXlZ6YHJfs4rZGF9UTaJozd6C5R8OkMwMBJkXksENW3FfK5cIQALwSqTPQ9inT6ObsD3DqqhX17FjVsXu/vakrWLyCCW99U72MnqhN//3u8dMHNUPTxxwD19VB63vnsSD/s3V8M78457lM0eMiXjV8tiYw5+VQYNn3qtpVPPfzo5OtuenJ3SZUoEaU8IqsYO92ouWjz8n2hOt8jX25Hzau+if6Yr6Ka7J8cflmd48cDnDEPxHsfXujI7T9KtxfcrmGi62k6cwUwFzUxxggoARNDAAgwpNRkkDKSuXeBikqRGSXEbCCiOxBwpw4edKEtJyOp2dsi6sRqRZKE2DVEDkBEd7tIRDxnUMaC5HMaBV1LgIl/nVrk9PrU609UABv5fVtz49ul//zbN2waRSjUTRkwblv7xJOY7LETigJySUmrz+QOGazC3Xepjdu3wt6meiTNnYsLnnnh5WBF+WWS0zMRE6s/oulIC0d0NTP3a89dN4N+3wNIOVz0vPa2DRvY7gVQk0o3PiwNSs3QJeeVRBDbEE2E5NoY0/8w/TNEDDMKKkpK+ZlcDANmkRGm/sghSXa6Tgv5wwRTAYI9qtgRttP495Gdilgi2n3Eqo2oQP0tuqaATlgPh2WmCzIhRg0OFVEGxgIZ+A6PuBqWfPKwNmUyhtJSBHv34sMCgB27whDsWroUgOw8SzqEUUmJsLfPiLC+s+SHUZPGTmz2RYioon4CrW5w+dq1W3/7NUC/kaQB3oMjaEP+Hau8jrD6N/uoE4OqaLtaQ2Iyi4xQoqKOUW4JsxQzpd5LRLIDbHkZLHpC0Wcatd6w6gKFGDGEuXSk88wH5uQm3yXsJtc1gUaYTldV6m8ELHErG3Hrl49qTN2PRDMkCqkDu0rUlZ/cXVy2rhRsHugq+LolAK1+OuYC8Hphy9x5ep8HX4TmgkHNAX8Q7HY7JiIEqb6mA+uWf1kHvz4O4OEFONZaR8TGbIvI/jWNDjvclTH6xHJvRP+DrOHBmIpQQk0CMYG5zSEyERmprAcpiYAwNYm5qJguSMNl9Go0kKLpwBuJnJaIGecLQvhAJQMfs6IJIMFu+BypGEdGNIZypk595Bg5HM4S7ftv/up9/ZEvoOAKgIrnf9JDdu/KCBSMohMUTQZ7Va1DkBzuZlluzHYIGXQk64pc7ttQgcfPcyMitDCXFUfUZB4GwpZdawL5gv8JKW/stiZnweURZJ9NTONMAgvEE2wFZnxoRBxHSmtBGuEBUZJ4yhYDEE/goFEjdoo6tgn4QntLQSVHRMDI3H/0WmFMg+2ECQWqU2L2VZGHrlyOpB9g8+p7mt594kMYNxZgz+Kf3ODdvzTH0CkAUy+GcHCzFNHCntqIvCfdgYbJGqSKSKpAjgAOCtuNhjgiZ5Kxh9q1YzuGHduXpY2Zvcme1edkIXvgVbKOphEIilhXiLAgfEjoUG72g6vFD/a8TKbPUZ1QpQaHkSkjiASYxLgI7a8A1UvAR8FI2Y1JHi5siSimSiQGYu0JDgcSRaHWromfwI71/2l457k1UDANQe0+AH/NT27w7g/A7ADACSoEFwYdcjiSRVTjrUQMtMiB4KwIRhV6BGGPrxeC/z821Lzly0bRmfRm2rFz1kq5I66WNdvlsiak6ljneiEBmtoSBGd+NhGzIqjUiQzc5cL0OhrFOFBB9L4WEGlWjMoSvzCxS+gnyAc0YhTTpAcdbDapDpTg1ynpuW/rW7/6tvLD5xsBUojYpa6c6kMy2rsfAFkQkjrEyIiVHAjS/g4pC/fhvPnzRyNVGSXZ7E8LCFWGZGVWVkqqc+TMf6HVs8kwv3gdgvMvwrBnN5vmSYb9kcqGxPr34+aVi/ZK6Wtvz555UVULcvw1qOqZ3H0sIC2kcCvYQYyOkBoVDHSUqnWNIJfVEl3PyZzaBG00dCdQ1wwFJw7KLTbJfsBhd650auLHqQNHfr//n2c3aw1/Jt+m01t30B3DIVK4uxsAEYy6FeAsMhjvvI+0FpEp63Mgafhr0HvitVNCCs5W924v3lJTquPhk2Up1GLfeaKARW+LNriuDKqHPAK+U5cDHDsRoGgPcns8yDl1GvbNPgM8yengc2tY273DanIfjhPAefZ0WEFaVXG4Ycmzj6UfewnIWtLdmk1yA00cJ8aCnVgusmDo0UbaGiaDMlJVB5joL6KNJh8omNKmoKOIhPF2JNpWa6pvVbK/amtg97n7GvfdHK51bQfFR1PYHiJ7qE3/7uEDwFadTn9+PjmxlJxoZE+V1vwWyK+5AA8dB1JqkkN+QHB7vjzZjSt2l6qa683m3ZvV5s1r0ID8AV84sVJ7hl2ZUP7hx+F31nwf9rhdAU8ttKCvvgqOPuNUjNQIjqxeCxtmXw/Ds/qhTdPsKPTCowBON0BJCdGpdhzmQBRRqM6pwfeLnnHN+M3YsGS/KBKSwea2g+CSQPWHOE/R0B0Rx7ovAJo3xFw3mhwh3IeQ0520y67h5xS39g1p433+nVtb/LtXkW89zVpG8ZlI+3kmRv3yAKQd3ed4BBOIFfXpUwQkI7BzYoGgClvtkt2TnX3M7EGR5NR+qmTvTUZxnr5mV24kNyl969rNDl1XHUQsH++ccapz5/crIshmG73O4Vhgm352ZNi83wVp8rTNJtS40jPqZy9+b/97G9aXlrmLa/o7xKI82FfjuPg/amjGcQCZmUSFqYJ+5/1FwK5aKHn5lcO1hBYG90Akp9cEbbV7nxVyx5woIVuv1N45WNE0pCkKS9NnY4um7AcixMLVqbsF0+RCN6DPcWXdnfK+b9aH07Am79hErGDFlNb4l3Ap/NIZ0UTEDsewezd2i8cItrlXp4q2yiHQZ+wMVRg+FmyOgTUCyhcxZBBTzBOIkCFKK2NpKitbgex2pkwHadjH6eAhI6I9K0oIDjREWIYM9RhIXh9sO/q4kGfGrLo8h70lxS5tzchK3zxlyik7lIrS/YUQrvh+zffNJTuW65LWD9LGrYQB1xwQd9z5Fz1cUX0YUaFG/v8Wa8V28HkzfhCEgvVZYwfOTS7Mg/qgjyUo6LLK8UT0PcqIpIEwzVVIVfR3A+sX3RSsKC7X5KaEYv6X2H4ZAIpJCAbPxmhYGpZ6jfY4xlYNlLDzRJSWf6pmt49SEWQjghxqilGvqaZoLFTEsjGM7AwQNRYcZ4mRGs3FpNnCzMUFGhYZGFUaQFd5MB5FIi7VJvb1kQ9JNmnUgcam01MLBja7CwdXlNrs23uNmbljRMi3NXvP3o0vPXlDfcPT5IKDL4ZjfuNEqx+8HycXFCB/aWlMMHdXMU1IDaaOQ0LaIDlNimzNnzx0ro96VkgbIpY4qhLxKwEOhUH3B3WBZsjY7V83r3n95nDxjnKe8fq/234mABoMPqA/AiUVhBmXYVFX0jweeZrN5ThLTRp0kqLr+TQBk2WqUD+UTlmO+vVpMJN78GlwHWFjDqxuWMYi4rFQbAQpjURMMNL1qQVNxQ7CGnufdAMxiEWQFdkdDIfcoijmS5I00S3ZZG96VnXDCX23Tp85Y9PM1F6rPv3Hgm17/u/DSlt2Fi6cPx83bt0qRFwu3LB/f/fVFwcMQHDhRXjIhv3CwHlnZFalp4G/ooolJGi0EoTGvQFqiw/jUESwg71Ga9r/z3CwuRj6zxKh5EuNjPgjDYCkgzKHI8jvje29JrlsGfWniV50kSqmnqBpOIkCT2MAUjHL8xYNoOlUhgIPltMJIZg755k3X9cNN6mRoStANA+O5a7pxpQKxCMDfOI2Z0MuqVXGBjr5W5UEpEg2h18JF9b5fIWizTa7KgLVfW+5Z/fxTY3Ltr34xKqjZHXTBrvNVzltGuQ/+6yAXn4ZKh59WAeaRdydQDhmDE7ethX6nzDzrMjA/mc2lJSxECbVdmSiA7IsLdKeujegkzGJtGD9x/Lnb3wDE2cgKPpB/1+C7+cBYEYqQP5RhPlywKEKUxx25591n+MkWUBJDEShMGaZuzS/jbAdMubAMmDReQkskM5lK80ExiKPudPYJ+jWjud0R8kSsQljHLfkDxaE5+8bISiOXC7C2W/pNKmSkK9KEzwAZNEekiN9vS3evm6PZ3redbdWZWQnrxz61ZJlffftWbLq1+dXoCQPTLnjRbTW0wT6FZd1D/Q9/jgkv/cenHzBhcf4R0/+e3FZTU4oGADBLoFOjAld0Xlys65izRcQhHAkjJtqlshArJGmPQJ46//nxtehA6DDTq7mRJAxBXtQMNU58ahrI0j6I1HJsjU6s0oQmH+KJetSgGlGAiRm6eBGloYhQxl76TzxiM4QAz7vwfRngW4E1ZmdRt/TKXsCn/YEXDyzeTYcfdi4MtEDgOX2MqBSny3FPZtYDJomA7UaI+Gg0+/39i+ptvdPGzz69LzRE3aeOGHK6isH5r/y+D8f3Oa5+1YtuPhDQKtWgvri8wD1zf+bnrv9DkjZsAEuvvX28aW9Bj1cXFY7wtvcTGMYdOIQqNQCpvJFpNavjPVAWHBiXOGSbDsDhUOojxXoXJMjA4A2D4JBQzHkpmAbHjxZyEm9NwzCLCruaG6ZkYGBuEg1wMXAYgxAg7EwA6OZr2EUC2X4YOEibpAAVxHZjBl6ZQJG3YigIDZ/gfwmE+nkvKBxwIKRG0fVQoHqhxS0JhnqPOODF11gu6pEsCJHUMgfSKl12I5OT82e/EjEcX7/O+7+9E/lRW+uWb9lk+2eBxtXXnkfhIe7ITsjHcqq6345Zz257ZQXn4N5/311UmmvgY/sr2uc0tTSwvUTOvCoxRvhZUwo62thYqnIKhnP2hZUX7oPIIXIaEe3IPFDA0CpH3a2YISzMy9E2en3yGDrh2nypMaYiDONmY1hJEoilhTJ5l8xQAiiOV+XgEYXuHjVjYiPYJTkEPhOmRPRSe7GDDFGeGJr+4ddSzUm04iYW8YmsgXDgNFRDPj0pYgYa7DJh/Q8QSVR5HFdXS1q9Db3KnY5Lktz5p4z4IIrv0ldWfx/ZwbdS7Ze93AN7NkBZWsXAtQ18ooDP6OO6LF78DEXXCY65s+aXZ3T787SyrrJLX4/Y30uHchjh2QigmU2INnQpWBUiboRai6q3LwkAL3HkgYv1Y8AANrIPgsE23aXNOjEW7WkXjcpYd2FbAoGSeJyT9W5YUvFH0uX4mIQcRTyGV2UuBSdZ2wwV4wxMwsZCS5saiAw1mTgE3jaOUsRp64XOkPMJrHMDsFuA2SX2C4YgMWG3sfwqQvsOiw4b07oYRaMwPVMhktkzM1BBtGSd+QIeMnub/Gn1LY0z8tJTZ5ZmI3XFvzmNwubinYvPfu680qXJLvC3k2bAa6++mcLIp3xwvNZ6VNPunhrfc31ZZX1/fwBvylf+MAjVi9NsaL6MzPKyCjGEZUYepIiCOJ+lFQAOEDs6CMAABAASURBVEwkVn1ltzCmfiIAR4GYvCfdMXrGgxF7xuWayuevEjOTWhB8miBlHk1kgOPqFuJijxoYzA2DzaB4zPtp+v8EY44DvY4hH83JN0yQ0ymEAp8Ty0QwBZQkMiVccNpBYCEpBwgOA5Smh1U3fomxBgc2d/WgaCYwNgYG/03EWZYJORVCQR3KQuHk+ibHiemelunphembVHv+R8cmuZYL8/pvqx4xqnnzn/+i23bvgIDX+5Na2F1QAFpTM0y77TZP79lnTA45nZeuq6k8vbqxKTUUDPHZcMBdTzQBQfGHGAOyZ6X3Tot5UgC6k6uRFtgNqURUDB0MsGxVt7DkuwpA9nz21Mpe9jHzHg9KSWdTpmPikBkG1JGMuYikWKSTXyjgqO5HARfNT8NRoFFjgPmZTVlqAA4bYONMhQ1RHHvf9PqY16YiUCPKtRYIA/IKrLYKAyMxktgsMreT/G3jYGVWN7B5r1HAY86EHNT8SbEZzMcGGQt8Ik8oGISgP2iv9Tonpzjtk9M87t0ehL7v4yhYMfDJd39wCd7SZQtuagyHgzAmPQnWfPkltChahw07cvhQwFm9IOBwwNGvvZWZXN04phmhueWByNz6psZBjT4/yOEwc0+xZ+CxNjZ5SG0OGAMMMzUF+0KY6H9IcDjLpe0le6B5PEDlym4TeuwqADFKLehvG3Pak2HRM4dO/6N5kQR0yPThReeZagLLwqCzsCgwdRzzzyHuLzFqTXAdmjmRRTajgfkABWOWlsl8JisyYCCIOaqj3WdIFsR1TkzLW0QUchtBUAjoKBhFAkIp2QWChyjiRGSzTiQDhGFfpO5JY84E8DmxjIF5whzNPebiG7iIpmJOCYWAoAxagqGhDpt9qNutnJYkiGXpLsfGyU+8soHoF0Vze2ftS3rs8co9pfuUnLQULUWP4Anp6eTyLlhe0QyKLQghRbclpacnHfOrkzIihYMLSkLyyNqiiinlqj7Np6r9WiJhMUTDkJpRmQrzRAP2vHRyV5Mf2Kw3qk7QQUXuU2smIpoMSLvTcaBx/2Yvdt4CsOsDfLgDEFD20KtDUuocXQtzVtJ0rroza4MbEUA6njqA2QgVjNCaySyYW8K8bAnXCwEZjQkcwLRzdcw1RmaeKNSrr7B8P5FWB0DM6DWcrYavz1QfIY7BdF76QldDoAcjoBOmoCJa9LgApbjYa8YblJ0BomKfGUSm09swTBgAEYpaPIJR8Iiykkw62x8KZjaKYmaN3THWWd/062Snq/o/dc21WaecUzHCbStLS/KUuTW5MsXtCCOiG+RWe0Fy6hlhDWeCZOuzpiVYGKisHeaPqNkBVfUEgwHSlCprSyQYLiWqxuiGRKD2npeALyTzdtf4PdIUfc3ro4NGFSCyWXDoIX38RgE+g8OeAQk7oSzmy9MNGSiYahXmolDWovoTdxIbopa1meHjY0FdXvcm6nbhM6oZkZrf1QhzYtK4makeKMhIgjIy0ptI44qEzRgN8JIU3NuCjMgI1k30xUS1UXaCXZ8whtpCmNFHRFaTA6QUN4hpHiKiHbxTmTuIFQCiz2rEoTnXcn3U1CNJR5tMznaNgVhWZIgQQPp05GyyBfpJgtCv3O4F0e4Au92lOVxO9RvBh7GiIcrSRPUQiHQQVVUTKIjDBHS0+hSf4aaz30cG2HRjLi97PPr7LUHQ/BHjlrhuTT8jUmMkFBawbqtPz7VvCNk0rLZs71bZ4103QhDm0lSPdQQYbgDe2ZyaaNUmnlhgWLSMTUQOOhyLgnBLlIs0HJ0gzV00FHzThuXDjfOnw5D8LNhaWgsPfLACtlLmICJUN+7BkOImwXJxSsc/+wnM5z7EpL3hgsF85r8sg0CALRLRLBGQ04oDdGKOrnEHJh00uinkTXY0AMB0XkP8M3BGVQLuCFfJYKReORziflACKhHTKlOGHitSfVTjJTKY4MfcP05bkBZh0s371HE0wZR9lzIfARnLctHMSeZk7MsqeIiESCcordBI4yvh2uKNZaUq/Y1Vy/UjA4AmvWDcmmWiSDA6QYs5mqPuFTpKMYoyFhjJBlgUjEnQhoVKK2ARY2JEnwx4/Kq5MH5wX25798tn7HTNc59Ai6ZHjRZssILpM2QEy9gWTBMGsKkx6jFdkRb4YR1MWEtrUkGniZwEgFKqm4hnN8+lM/LqOL6E6HeNiWdG7AbFnsdAOjaBaNwBdQ1JAlcfsBHfpowlGM8gGGKANyv3EBi+yZjRSt8jejW1eFmOH9YhOieLMiJ5b2RuOiiBZr1Yx2KS07FVX1NcrfaeAVD/PisGcPgDkFoItPOJksssYAEZ8zkEXvLLJnLvsGk8iILpxzCYUuDKMjLEt8DByiWd4XKhuiQRRyMLskibafD0ouXQu1cGzB4/FI4fNQByiTHR1BIilxY5w5qFdQwXihkEYb9hUgr8uEBlNLFG4AOAGU1NPqLAEz0xyQm2jGQQCBCRIdlppo2OcOxZjOfCyDKnGczQImdJCizd+LhmgAVbcj5NiLKMARPAsTcMSWGMaaJ+UNbDYcW0xwx0IqIrKtA3yQ3T+2TDwk3biWR3yE67c4VsL2+Bndt4Xx0RDEgsMdHXDOefNhnGDS8EWrC6ttEL9c0+qCegqPeFIUin//mJHhRm4W9DWtM0K9EoLyYarg/jPK3BqZtxNip6CCJdTli+qxzW/fMtKK/zgYuA+9Zzp8O0Mf1BpR1gRj3MvhcseqRRtoxfmzvCMbL4GU0XhsUwYm4YAyiUoWgae4R0tkAY0ZaeDCjJYalIhXl+hArRbDBsSgKD8JFBXZrhWDequ0S1FlOaRu/DsLDBMu3HNLJociktCqkHQ0wXFAxxrxsxbxtpV8UXgpMnjYBMEesV3jAx+p11oUBoXdg2ByD0X0MkHQkAJB3Tu68AD9xwFvTJz+GBb4gORwiSRmr0BqCstgn2VzXCvupmKK1sgLKyeihr8EFlYwv4/AHSqJT2RDaDi+02I+rBoiKYRTlq6DwGqow5nQzMDy36Dt5fswuqgrKpevGO13mvmjFjMMSWYDAiNlwqTBgaeiM27Qls+BfNnjfFumFwaEGia5FBJjgcTE8UqQuHMj3T0cAwFFAiJSUWqQBDRTatc0Nk4lj8MKpLQtQg07nfNKRw8NG6fOwbAvCUDB45opngAWKMDE1Pgd+MHwyPL/xK9wsOIUW0LZH3fLELco4GCPYDqNlypDCggmn9YU3nbgtaCkI3fGN0c7pc0NvtJiIzG6YeFftaLWHIsppmKK9pgrKKathSVAHrdldASUUdEad+lnqP3YZ/jq9Iw0FDs3pphSaHDRoJ8zXuqeIZOIIR0RNijmmkGzpg1O0TGxjYpDdkzbjmQGCrQBgA1gUUC99hU1nFLLNYjYSJeLaBSKMsZAdyT5iFBrnvUDfBZB0cVmyjmGMbmw6eqPvIiMBQY4WWRqMl0SIyK8uGzUQNeq9YM1hUZ9qNLuvM53fdmccDhMN4xfYSQZLEiNZc9WW4wueH5qe5C6ubbV0HoCQKtc2E5Yio7cf/NEjD9M5z/15sUHMFPSctme0ThvYh58ZAgDBaXTNRT/aWwecrt8KqzfthV5UXAgGF1oJgjMgTC4yEU8OnyKrHG5nQONrhptMYomLODNNF9U/BYikLZpTDYjxRXU033Rymw5v7EdkXRUOFVSgoCBu1BJhKQWv06Q6JVS+lNVZYYUfR+G0wjByLhogMCox6c3SefasRSxWRgcYkA/X9GXX8zIHNfZqG7DZdReS+gvVeOGlkf7hw0jC46+UP9fLaFjEpPWMN9oVWQCa5h4KJCLZ/h48YAAqE3eiqWVv2lBMdsH8UZBCNEMT+NhVxHoa1uG1orJMwXb+8LLbPmjoGGpq88NGqHfDOV1tgxbZiiHiJmHXZo6EzPtxRzNK1WuGIx3N5PRRewpaXFzOc3hZ/o1kKhbuGzPOGERJNlEBGDqKppmLucdFNMWnkG8oaAyMvYytyANp4kgTTdwUjnmyyrmmw0hswjDnmAFeNv41nYkMLmRWqsMGOJgvyz9J2CdY1w2AyqP9x/iyi2jTDhz/sRjQkiVp8HwY34nJwDEZQvrBbTrbqMgAlm4hl0QFffL8LzjvpaEJWdoPtcCvgxTI5EFghiVtZoTpT2EXS2LlZGXD56cfC3Olj4INvN8ALi1bD+q3FgGkZCY+bNLrKHdqiELNCsRYVtRyUArNUmQ9RQDGr3RR1xlejKitzARkvjNAKNt8QLPeMY75LynDcQY2j2OcZ3QSINM09YljygAzGjR1NlwkHE2dB/ijGzZkGUtRl1aq1zBIuTOcONfohnby6ff7xMLZfHlz39Lt6caNfsNukjXLJpo9199cAgycCrAQ4ogAIKpFBaW5Y/UMRlBNDY3Cf3INMLUKt8oxEiGV1UD0tJyMFriL6zIyxg+HpN7+Alz/4DtgCQKluA0xgLFtgspwQ1Qf5ihZGkqmAomFAzpCGSERCjKVNABmT7swcajNzhmdNmyxkfEfDhkpgOKSjHkZkWUzQko2NIbrMWDSObFlxnAPR4DpVjy1GbrGEcdR9A6w+dNgfhCTChDefOQN+M3M8rNm9Hxav2kgHoOy0C4sCezfuhcClxPB4BnfXWX1dBiBWwhtdHmdTTXlD+uertsLg83Ojz4i6GOyJVvY0Mqfpf8P7F8AjN18MY4cVwj0vfAkljcQiTnFxEDJSM4PBBnsZCasckEYCgW6co6IQI6MAvG58z0iQtQQwEE+KiZ5jOmA00mFxsiOeS6gjFAUm/6zh9haisGnF/rGq4tj0HcfwYXzfGq2NgZC7kij7honu6SJvUPBdd+oxLFz5/GertNL6gOjwpGyLFH33lh5s1OniPFaV54gBYJLQ9C6AfHqTqp363odfw/mnHA3Zqck/6WasnSwYihddhssm2eCys06EPsSi/vMjC2FraT25AZeRZm9J6zdz+ECIhvSYuBUEw/UiMnZkSalGLW4zLg2WNH+sG8sfCLHsGgYMbEnNihnWMWeyoWOy1AoE0WSBqG8vGpHBP0rBiv6OHjNKUCvcYHPJLoi0hMBDLO6bT58ONxLwuZ12+HDlD/Dh8k0I2dyyTQ69HKrevxdjOmn4c+jOW5cB2FRZ6nWllL9nc+XMXLtul/uDpevhirNmGlnEMcboarJhVDSbVik5OfuYMfAUsTavu/9N2HygDhARx9icExzV7rn7BAuG5YiNJQeYq8bIymZLE3CKw6bsN05hE4vMt2QVkVH/eMzgoj5AbEmkiIa7DWGNuJtEiLphcMwtE80kNUS0aSABMq6Jow52rh7QdlBB9fogJz0Zbj5rBlz1q0kMfFWNXnj6g6+1+jq/6EnPXIlLdr2v1RXD4bD9pIxorWLbQlQ4+YqwrB/z9v8tgTnHjYWCrHSL9/WnbyyMZUm8nD5+KDx001lw9d9fgf11LQSESXyuSdSBi6KWMLeCqShWDSsaoqzG9T0+MSqabc2iIOZaG0bozAzMmgJOI0iLAAAQAElEQVRTs4BH06NZQLqp/QlGNk4rp4uhL1ojHDH5bjUvjCsZoURsGiiIzWnGzS0wpCADbr9wNlxA2lo0snBe/mylvmxHhYicrjq9ueFBvXx7JRwmW9cBOAyQXFnckhwZ9jzOyB379ept7g8+Xw3XXnRqK/b7qVg0/Yr8yIO21F1z97Xz4Lr73oAmmjjgdvL5xMhMEDSoiL4WweAkPTqNk8+C42tjICPbhelxBmtik/WQYEm6Nk1V3ZJ2w/2DOopl43DGtRhaJikDtngArGueY4uVi6yVSrnNRBO8QkEQIjIcO7wv3HHRLJhFBqG5fb5uKzz58XegIhsRy8qzoe8WLdUDdQCHScHsrgOw5H6AyLsQVFZ8IA2Zcy52Jp/y5DsrYOax42BEv3wmNgUBxRy6hwSEZjYyggtPPw6qGrxwy78/YstGCbQYo6bHxLDZg1FFKjYpPSpnjQwc025FGo4uSQBRMWjql5bYmnFtXbf4PLGRXqNbbdaYhY2ic0xiYTiz+rwZC0cW65v+q9DCQuTZMonRdf4JY+GaedNgRGFedEDur6yFu99colV6ZdHtcH0S2dfypJ4kahCAw6beXNcBGLqdq+Qh3Cw1bHpIGHLWhF17a3MefuVzeOLmC4lu4jCsO9TKk38omFBnepUA118yB6obA/Dwy0vJOSdbbIWu7MMtABRz01jCbdhwUoMZmdD1qFjmuBVi0RJLiMS0fqP4RjGXDI46pVEs/NbK3RQDX7z5wecyG5UfTIwTENNBRfXfownr/f6UyXDmtNHgcdpYyJPmD3oDIbjzhUX6d9tKRVdmzg5UXXm3Vv5hLdxzG8AfrsNHvgiOhuABgnXVy129yl6yZ+fd/Op7y2HSqP5wNTNIzCDFoQQhMPBRENpFCe64eh4E/QF45u3lgN0eEJwGE+p8DY0o45nTAnSI1ssz3TAsK0dCxhwVnmCKdRQDqbEiZYz8cMzPF/URGo7l2EwAC+BQvL8pGse1imbmeopE2HzmPrkZhPXGw29/NQGG981m7yvkuej6goqqwv2vfqC9sWS9KLpSWsSG8n+Efnh7LfY3UfAdVgU3D8XEdIQjPk2o3PCYY8DMyT7JOfPBf78Nwwtz4LiJI6PAs84q+2kgNLUogXVYapIH7rnhXFAVFZ5/dxUBnwuQx86nBWCzngyKTkRHdoEvaUVDZnYbm0dM18Zg8VyR+xHN+SWsVBzNDQzLxnwLYNM+oylUjNn0mCMboJV7Jpo/ilpbybHEBCOUR+O9dL4L0fNSU9xw0tSRcClhveOPGgQuu8Tj6joHH90ef28JfuLtrwVdFyHbrzyRtHH5WwfCTRBF3mFU7fVQABBDbo4Q1MLVqGznfWLBqGEHSst63Xb/C/DiY3+BoX3zo3NWEfqpDhqL6DLjuaSxM9NS4IEFF0Jysguefn0ZhBsJWNJTWJZXFIjm9AHJxuZ+gN3OMmyQTTCqLKCYlcoYDzH90I65tUsrDajNQZahTRmTFk3i8+r1aKKBGVnRTZY0BxyKGR9mwgMyZtfhEGE8YmSkJTtgyoSBcOGcqXDK0SMhM9ltGNp87rJogO/Vz1bCP177EoVkkYDT+XLTgbKHvOHtakyzPLy2Q1Oao6aWNNMM0mdbvxqQoT6wJ33Aw6vW77X9+a7n8XMPXo96ZaaDsdbeITFKWgORJ2RmpibDfX86Hwb2zYPHiE64p7gWsIenS0Xz7ihYvAHQbSKI2Q7DEDFirVosRQubBY2MlYUoM4rJHhCT3GzxProsFmUsbCbTWtjPLMdl1fl4ZjaKai4stYqmxRPx3TsrFY47fgycMW0kCztSHx9PMlUN4wgxlYNu7337A77txU+hvklGosvzLi7ffpta9rk3QXj9/zMAsmG9nDRBNvQPbnhayxvQpxin3fjxF2vFP2e9Do/f9ltiySVFQfjj2FTX3TXIBCEBktPhgGsuOAlGDS2EJ99cCp8v2wS+qjogFhFz1fA0KcJeLSGAJMI8KR5elcGQqXxtXF4giYlWEIzsG52Bhrp0JDpzjljcalUjYcMI/3z87Dsz1Ic5A5vzjkHmYjwjNQXGDM6HKWMHwSlTR8C4IfmQTGf4AX8OHg7k+qtg+Pre+vI7uPXZxVBOwGf3pCzWSrfeHN7zRSUc5tshAiAXXtSl9uXu3lpv+fu7XJkTMyJ9+1/25nsrweVywqM3XwzJ5KgZ4thMaTfLbLQOukMi1b1DkWy6fmZMGAYjBuTDIqJLvfvhcti4dR800HVykQ2w08nmq2hNQRDommgSL26EzHxGrEfTpliaFsvUMUJzCq9hIzrsQGgdoLyeTYek+qNgZFmb/kad6nS0QKSqsIysdI8TBvXLg4lHDYTjJ42EycMLoSAzOWqYmaLW9D0y45yAkCb8/nfRMrjrhU+hoj6McgoLP7PV7ftLRdEnxXAEbIe4QGUdBrcblasDA4P0igVyZr69EnIvfvGNr0EnDPCvBRdARkqyAUIz+tAahNAlAMb8caZTN4vogFecPZMp9N9v2g0r1hXBht0VsL+iCRqbAyDXNvMoS3Yq1wWN5apY/Nas2hD19Rki3Igx0+KPFFX2/AyQKxvZ0ge6mSJFLPMkwmbpxJjole6BgeQzw/tlkwHRC0YO6g39C3II/sWoc5sDD3Ed2bSmjYEUDEfg8Xc+xw/950PU2BIBR3b+IkfN/gVV37+yF46Q7dBXSA2UYPAkob0l7sacxm+vS+o/VfFlpP/2pTeWovqGRvyvmy9GQ/r1jsU7jTgrShQL7kLYLpaRzV/3JR1O91NmToLq+mYoKqkh+mE1vPT+ctiyuwp0YoyIBCjYrNYgGHUGDQuXh5ONknDIktJPGI5Z0ITFsogVPTw3g6WQ9c3NJCDLgr7ZKVBIzvXNSyeDzt06hGmu20Z+SxRicWLdmFpA9+pGLzz08sf46Tc/R2EZafbU9DeUkq23lR34ohyOoO3nqRFdu50WiRZqxSHepL3f/knKnRzRszOv/mjxalRXXoMf+Nvl6PhJo9hHVV1nMc3o1ELUdSs5mvRqhsBM65TsyUQHTCYGymCyw/SjIDc9Ca6+601oqWtmCj/VBxEyHNSIr0qOzJR60TAezJAcQjwErGigEb2uoDAL7r10Dozulw8Ohw3cDtuPBkY05IaEaAzX+j6rZGCc31hUCg+8/Cl+74u1ZCygADjx86iq6AFcsqwWjrDtZ1ymoYFWxhb8kN/SP7zpJsegY7x7tNwbv99Uav/tjY/pdy64WLhk7nFEBRNApd59I239UG1mDh8yOhjj2Pxbmp1y1kmT4cvvtsHLbywDHdF5GCqrb01TY7HCCyQxJzXSo3FhM/PFzFmkky1F0Qa7Kuth1b4ymDFmkIWJowaxoduhaD0ZbCafMhHPHdEUfNTB/OE3G+D+lz8nemsJAqdUNgGNe2zWNu3ZfwT+FIQjcPt51wmp26FDXgBV2nNDwuIX/+oYPK1E6zvo78V1LXm//9sreNvuMvjTpXNQflZGNBIgmGEx+IlJDHHftoJb01SwEwPkqrNnwJKl66CiIQBY4pPnEQMhzzkw9VReN5ATIZ+8jqIOZKddgkAYwVOffA/jCAOePG4oDxWCEK2eFS3bYRheZsoa1/U46+0pq4bn3voCXli0EprJ9VBGzkqhqeaB3Tvv/7RWhiN2+/kXqqkuwZHqZAR5vTGUfv6sRzh5j9B7zP2hppbJ/3pyEXy/bge+5Q9no5On8fQis87LoQJiK/CZ9f1YapYGU8YNhysu/BXc/dTHjPkkWQUxGAIxLRUkAixacUGkjmpBjNWtMTQFep90qQmahWPPTIVKorM9tvhbGNk3F/pkphkx29baLbKE7ASDEf2hMHzw9Xp4/MWPYN3a7QDudL+Unvy2Xl/ykFb0WZFfbgY/wBG3EvcvB0C2bcNAy7lEAAd3LvkqAzWe70wZcac3K/e8ld8VOS7c8SD+7fknwjWXzEWDe+fF3BLUCSscutSuaGF9ungNvb6A4aLzZsH6ogpYvb0Sknulg81GrNuUJLATK1okRoYoxKqmmnJVZ3OIif6n0dqPKuiECdOSXLC1ohleXbEFrj/1GLALPJFWtOi02PDr8URuDKu27YWn/rtY/+iLNUIoGCHg8+xx5eY+FNm88G295YAPEs/hOqw2sWC0kcVrsS9FCWs1RQBh3y+4VtwGM9KVgpq36weQ882rk4eduiKUl7PA6w0MfuylZfDVxhJ87a9novknTITs9FQulnFsfm9nwNfKl4h5PX4zWMEKqNJqVWRXMA29KuDKSIeLLjkFwu8uhzDR5+weO593QS1cp53HflvVrI6VnOO6ppmniMHvC8I3eythRFEZTBtSyKo5sDAzjQASpZKCWSaGy9a9ZfDfD5bD4o9XQ2V5rQAet5dYSYvOunzu4x/dv2AjAR/AYcp6yOGB9PFzkKZE6ABFKHuQUY7C8ihI1HHvkTi4/n0cBWBKRkYr8dfS2PiTb8bpSQIbq0Aag4euajgpMx/9+q//CA2b1vuF1xe++s22Fak3epsD523dUpZx3c5X4a3Fq/CV5x6PTjyGWqsxIOpmRg2KGRfR4txRz1os7Et3WrdBNYCn6Py1Qmu1MBHKK1ONHTEQTprRDJ8s2QAhRWUAVQmzsSnARFekoTteVYgnHlARTifii6JEp6cS1hTAQT6XnpwEqhyBr7aXQH52BvRKS4Ig+UFabUQOBaGYGCufrtgEX36zEfYUVdGVjJTUwoLV/QYMefaMc0/4bNSUgd5jxhWIQX8QpebkYb5oT4cgbPU+q1BBHo5NcCeqQ/nunfDsdZeBzeFISKVsbZRQ5+0bhzspamDpRJdOzi6AcWdfjZRwmE6qZ8sECe50UVUURGsdanLYyuKsa9jUl7w0fff2JKZ6w3V3P4B+99dbIOiLsH51Jzvghfvuh68XvYddHk+XwCdHwnDHc6+gwqHDSKcopjLEJu0ScSaEgyFRITf32E13Ve45df/t7763ZNnO4oarKisap63bUuzavecNmDpxPZx5yhQ4ZuwQKMhJZw5cTTfFc2unoQk6bILVYDzzNX+PTxZyUjeKSKsUckZzSA44a+oI2LVxJ3z93V5w5WaA5JDARv10BuPRutJsJXbMy6VpKnXBqIT1VDZwJYkC0U6MGwE2NRHbn7DnOTOOIpatDvtKq2HbrgOwe181VDe0QHpWJp41ZNCe/KzkJTMmDV00cMSgOnJr+bqu5/adMJkmFqg0Cx+b+fk/XjoVJwAf+yy5Bqb/Y+OoDxuizz3lFJ2eZ2f5EZM2xCJpz7K9e+CJW67Hdoej9QQo44AtriKJDLIr73yEVtynIUNEduoaEDBBOgE9oTWdHzVVIJdH5m8Cr4hEd/psuic5Bb9w319wuLkGpJHjJ8I9d9yCqvyy4HIYWnNEgT/ffivc8vdbcTsPnCggbFb3Y8dQGJOb0URwiJRpqXPMzo4Y7Cg1yQEoya6pqmPyyEHijAlDajduLX5mw9a9O7ft6RRMKAAAEABJREFUPDCrrtY3qLpFlV79ZB2s21EOE0cVwuhBvaEgNxM8LgdjdVWLTdxpdYOG8KIHyQirCYb7hR+jkGUp+rSN8rPS4I+XnEoYexmU1/nBmZEcW3uD6wB0eTECXDEWqjNm7dFdJoCMEPFKj35/CJas3UmkiBe8VfVQXFLNOtftdmuDCnL3jhrdf+uYkf23FPTKrCfPMIyAeTD1KhLyYME+o6PMTksEQhzHKsbD8Ax+8khkR4zIsSQpRA8gpI+NnRI8ZvV+qRAomDBWO27FOo0hlzUn2yBuR2wnoAoHAwJ5LfId6FGir2luOX3fuAadmK3SmhFU8AAvSmM+h+50OvGZ55wHezavA2n31k3wwGNP4bOvvZaWUmMuKbbLmhVMbdkB5mfMXTSAJhlgo7vD2J3Gbr7m7yFkIxSJIAQoZ0Afbc7AvjvHTa2v219cM3zn7tJJzY0tfUqbg47KlTuJ0l4MfQuyYHC/XizakJGaxMFoKVRuZuGz1UBYACNWY9oUyawahlHWzEwKpRObCvrkwUVnHQf/eedrKK5uAmeay6xPFJvYjnguoTmzjcZr2RrFhB1tNEZMPpaW6oEwEeGr9lRCsLIaIKhUpWZlbB4woPd302dOWFdQkOUXbVJyaUsohQDcbAt6dFva/GDtLSPDn0puTnVko0Sn0SM5oZB/ZfKOQv6WyXkZs6MeIR+IkE+R81jh36Gfx/QawK+FCaNpFIACeZMATRfYOY2wICdV+isqvRa9LvksPSqYX8taOM+8Rz118ESckVcAkkJ0ntXr1uGjFVoYVLEymRQFY+y1YDkKce+ZwLNZ2E6ynDc/byrXdNKqbNoHbA8pOukQLCUll2UPc2/y9M37YPumnYP37CydVl3tHb27pCZ/9Ya9dMlbyEhPgiF9c/DwQX1gQN8cRBmMpjI5bZJRRYVVoAa6UJiqcsNDw7q5gkF0MroJVArGoCYzEM47bSq8+8kaaGgJgy3VZRhAKBoF4QYN1yOpTknj3FQf0nSezWKzUd2QiO8kD6QN6hcZ1jd32egJI5a6komx4XToJRHVjkOKn1ym0dIGDkubSZY2swIyUcSyleShEofoXiLRx0TCrPS1RF47yGs3/1tFVFcjrzF5j/AgUSTIrtFd0xRyVMjfikZesP9VjVxSo6+xcYr+Q/+j34uQP8IaPfJdZtelS2Woxu9rWoydjeKEos0BtZu+gur9RSD1GTUGrnjuZVRV34wMcaPHfUGIA1I865m7+V3ZoNxgJ0SHdfTGgK1qPGbgcOARU8eV9h05eMX2ddsHle0rn9JU3zymxRse6K3wpRdX+8RvtpRCFhGXfXNSoU9eBuTlpkMWAWIqYce0FA+rWUOTOakFSmvPUOOBLgtmLB3HrGHdYh1Tl0ohAfX553vg63VFUNfo4+uMWEoA68Yac8yQoSAk36HRHFrFn+p89G+ZWNh0uVTyRcf++qZhOV7f5oL01EgoLKdbnlmztJe5m7pSxNIPidoRxZ1nHa0RHqLKv6qogsoBJ5D7kozXEjkvMWAoqp2cs9H3yWtqMGAGHmqEqSp9X2eGGIeiTP4mgFPD5MiARo4UqPScqirE2KDXUVU3eU2ArWLymxS8ZKfrc0RVhFifpw8HwbMRpPqSYvjuvXdh3JwzQAmH4gFlBZXWBvCEuJGa6Bgvjh2WEW9P8J3oEllUFXcRJjl61lRt0gnqysba5q31tU19Gmub+tVVNQz0Nft6K2E5aU9Fk6OotJ7F9l3E8k5KdhFRSICY5oEM8jrF48JujwO5iLJts/NlHqg1y/IDBT4ZnLtpDHYje68+2aSRXHxZMLPMmjF1kn2ejnS6MCAFH2ln3nkaC6kpvCMZEANhdcIPG3ZT5f21vN655eS8A0WLSbNB7Uyg7kAbhge0YYzwRBqeTMNroRM9zBwj5LXMRCyGADlBYMIMEaRxm4RpgFpUZmNuSOuYyVWNkiA98CMhTV0g5yWCLzt5jVSdDkCKU93EnM7+IOynaTqySL5YNXe6eiqb4WC3gzs13agw0GqUiZa9PXCJcaLaFieG48VKvChHbYx0yxwgzDqXir/M3MxgVq+scjksr/O3+FNbmloy6qvq8hvqmnv7Gv19Iv5QTkTVU0J+2dkYanKK9S2CkzCY0+VATgJMp8PGXEM2eiTnJRsHo0iTVQVkqd3Mw27uZLelwmlscodZgxDjWKyZgZEYIgphPgpABkKyy5QhVRhftLM4kzzmxzm9soswZ7iIhfFwG3t7+jfEiWer+mSuJyWYcz2jtq2hRVAthXqIyF8RZjAAVoxlelSjzqaOzLpf5kwTXsJBZ4Fwwtgoxtw6xq0msYpGQ1qlKYo+q7FUqpSelw+jfzUL+RuZCEZx3nctztgQEwDO+jr+MzrEGlpIAE6r3ogSNGrrhuasQ5U7RAGTnpUOaVlpwYL++cWKrNaQfaccCqcGfcHscCiSochKChmwyeRpPcROcYlItAuSIImiKEk2myjwXChkLL2ALb5lnS7bIQiCRquMSnYpTMDlCPpDmaqGhehcNxOPxkqcVPcD5s1w8bgH1fipOKKMQChDluXc+rrmk91J7pSklOQ6apUa0sUUw6rFAo4flIlYMB6grS3iuB3FpJi1v4gVF2Vh6uhUo/eBooNDs6gIqnG/1hVi7K3uBJm/ic3nUC0qg2DBFUhU51Ho0p5cxohxRka8eLXKcvPBrGCzLppqtYTbs4YdCX6nQ6WbugUIGAWenCIKDqcoOlwOEVI9tozcTBq1DWJex5YcdScBg5N8x2G4EATqYTGSA8yCBmy0s4ocFIxIoEeijCJyFFjevsvtbPR5A7nUhSaY74n0KGD2t4B08j1+JOCNniPfJzqkQj4foU4u8ncvcg8ZRkdG4jo3kftFbweAuB3wWa+nxQFctYDJHAiqRQ9NdB9mXzvaUAGsbGf9DdxK/Fr6VUpgSbXFcG0xoJTA+rVbXAsm0FyWY/wuHKTFZ71f6pcSTM+L9f4QYklVVM9jU3/JN8JGpgyyVNOMOQURNn3ZRm59a/Zxup0BstdYi463Ejk/9oVal1dAlnZKsnSKaum0REfcDgsmAgCOA4GWAHTW13QAhC1eiXggqgnux8rOWtyzqBZAax050KU2HMlWq1eKA5vN4nax7o4ETGcFmdvYPXGAdLYhcqGdJGmU4L7bEknWM2ZyvdGYuLWYwj8Se3oi5d9wZglt+EKFOJdTvFFnvZ6YoA8SeQpwZ8JwbTiosYUN43faDiHLHokDYrxlriUAtmIBnFVtS/RMqDPZMDiuYSWLvmZP8DoR27X32pnACj4oZ2sbYgjaeS+RTqS1pSt1QvQlYuJETvn2AIkSJBy09TuHLE83AajDxh40QBi2ADESJ6LlOIBCnGhtSx9ty7BqBUDcBrskavS2xK8U1/AoAUN1ZO11pVGhjQfW29k7A8C27q+rAGxLt46/VkeDrhOJZx2+J8TpdbY2GN9sx/h7xe2EBHEn2jUhA7Z10a6yU0cKqmiMqPZ0G9QO4OKPicCjJTjGAxG3oeO0FQdPqItaBqf1tRh3vi2/KWrDAENdAFcinTn+PP4JA16Pa99Eu94B++G2GDAexTgBivU2mCYeXG05V62ftXUgSnEnmK8zoxAnYD6tDYUat+MCSdS5Qhsg7Az7CXHt1J4R1hnGSwQ4IcFrc5cT6IVaG3qfGqf3Ke18V+8ECKMA7DjLorV1pll8Q4n0GmhHGY4fKbZOZNx0xK7Qjjsi0TPgBEBsa2AlYuNEcdj2drGT0SPUhu73UwCYiAWtgFTidLtIAh1QjtMH1S4Cr10ruDPOTCu7qR2AryMRbAVxZ8JOB2P1tfUMWhtMeLBGSDyTtKUDxru20EGI4Y7AhzoQwe1FSqy7ksC4SATI+Ji10gkwau3pf+2J4ESgES1H1dKAajsAxG2wkJXSbR34uDoCovWh9M5EBDoAX1esYNQJ1hPbMUCETup/nQXkwQJQiQOf3IbVG++eURNEb7QE0ge3lYjSEQPiBJkxWieBBwm+n8gXpRwCALZlhOhdsIQTGSFdAWBnXDHCQQDwp4hhoZ37jo+GmOCKWI4dga89MZwopHjQDJgoRas9H1VbHnkpgTIrdTLW2RkjRE/w+10B4M9hhCQ6/3MZIfEgFBLorGABoJoAgHICZmxL/MaDT+tAD8SJrOCOdCmtEy4DaON7ehwAReMBbJb4cVdB2BkjpLMumPYAmMgQOdRWcHvJGJ31+R2sEaJZwJRIx5MTiGnr59U2RHG7FjASbCy7vCMAJhK/KMGITWRwaAnYz7xJ04GtJADgoTJC2rKCcSd1QL0DP2hHRkg8AA/GCIFOAhAdhB8QteGKSaQSqQmApiRgQbWdMF3bLEjLzjUcIMLdT0DAE5LiG9r8IrJ4wa05XfEPaH5fsnjX43U/KUGCg2j5zk/V/6AN3yTuohGit8PKB6MDok64YTrjijkYQ6QjA8QKwvZ0cyVB1kz8e4lixe3pfxiJNrrIEWAlZKZjhcFSXM/amYmAp8cFnBMxjxRnPYsW902ivatGSEcA7GocuDsaIQfDhgdjBbeXqqUkeN2W+G3Pwa+30tFpLp0ocR2wqmgXvLHgerj82Zcg2OxNpMO1BbxE7hYr+BKlcAltnDsURoh+EDHJg7WCDyYUdzCumPhsmbb06q5awZ0xQvQEDJYIiFobOl+i77XLgD+ygumMLvRjHQ7FAVDrwNWSKEm1PSVcjGv8g42E4A70wI7CcL+0FdxVI+RQh+Lidfi2AgRqAvHcmfNaB2FbogNKdLe6YZBlsmLCjmzL2rVmVVjTrUXo/ASmzgCwI3Y8GCOkPSbEHXnuE3S0EJcl1JVQHGrDFdNVFwy0o/PFgzC+XdQ2AgZtMWRbxoeW2ACRmAGi1++PAVCgRbbFNn1qVia0draYwOAQ4pzV7U1mih/1P9UIOZRWcLThbA7nj+8HsZoqgq5pP7cR0tVQXLzYhQTXj58QpncQ99faAZ0VuIkGdPRIdT/cUg1YDsYA2FxdRfZ6bHM66cRmSCCG2+powcKcehv6UFtKtgCJc8u6aoR0BoAJmZDO1He43bpkt0dLyYAxq2jPmlXYmDEY3ejqSQXDRqKMgjxEtBc++wyBEPb7KSi7YoR05Ir5OUNxOIG/tK0pAu0xXXvqDBO7FHxa5XZQ9622hOJIy2376gtY/9FCOPHyK7G/0Rsf0QBoP6HUai0LnXjgRA1zsEZIIhbstBHCAOfx6DaHjU7/JUfQN322VCve9AOWHA72fTpBSVVkePdvCxLewMR5Z8HImbOQHA6xZyGMiKZf9DshLTdTIGOYTrcTQj6/2A4gE0mCQxGKS3RsLxTXUfg13q+rdxJ4/IgQRnY31ur3Y+ytxur+7+JCcUZJpK9ffAaPmHECpPUqIOJFTgTAtnTD9pypQgejEzoAYGdAiOPuNdqACKFWACTgIucEzeGx4aX/+Y+2denn2O5yEzHrwFuWfgbemmrozEbpbv3i925hzUAAAANdSURBVOne6h52fLNUS8nOpdUVkCpH0Ll3/RNl9x8oaqoiaDLZNVVEFvbDfEae0A5IDlUoriMGhHZAiKErUxkEESObiLGvEau7lmG9qZyI3QAkjAXTBi3duglqi/dDSnYOtjtdQEe/IY71BKNF74QD9WBXXjhoK5iITKNiwY98dnQapR5qacG0VgX5EGE5J37qN2frlUW7COhcULO3CJRI5EfAwp1Ybi3hZ6gkWfZlK6OoeON6cCQlaSGvF51x610w6YxzhEgwwNsLY8GVnCoIEluGM9aWtPSHqhFGlVF08bmDD8V11giBTmQVtQVEs7yYzlhOlHS2alqE+pRFHCn6FsuVu/n8rXBLmzcvWRv04fkn4V5DhsPvnnwBsvsNwOm98ujCQUiNyCgSCpoT13EHgGuvwbArOSV+rbiDjYKw36cVcw9s3IDDfh82QNiKoYk+i5+/+hJcVbQTKFDpbdHikQcNrM5uCb5bX1YSffel6y6HV2+8RjMma5N7keGyp19C+UOGCdb6idQllp5fgPKHDqH65UEDkNV54WVBkPEa0Vo1oRafoJBzbbhi2tOrf+yaIiqMINmwKNp0LOpY8TbgSH0VJroxbljxFi+sqWudarYfzYqjHXbf7Gl40ulnw8gTZkPQ24z7HTUeHXXyiYQxOpxj0FZCKqtMSYuNLHvhaVqlHsd9tDP1B1t91kZA9d49t0GgqeNKrqr8vy8zz8qLxA2AF6/5baJpjFB41Dg44bJrgbDlwc6Io0UheaVSXimVFZKkFVAHH3MCyh48HEWCQUHlJUMQK0xEC7MTo0qgBTdbvLSWmNnKVA8GyeVh5cWwpPIyY6KqIwfCjUUbsb+qGIPkAH/Zbuw/sKVL7SK1peOs+/A9urPOTsvthcfMnkMAGO7yIkasXgMZ0mvef/sQd+2RVUCetn3J5o3w0vWXQxcerM3Pb/70A8gdMoL1IVvTjpeSY3V3KGjpIB177hXIlZEDcjgCWNDI+TBsfvsJTAwsbH6OVjKiPjvv/m2gBLw/uR+kjkQRbZDmmipY/tqL0D17+shavQD/DEv+0j6s2rWN7e2pO/X7iLricPEVOw3A+WvKOzn4u3bf0v+iQXq27glqf131Lz74pZ7u6dn+l1sPAHu2HgD2bP//bv8PXbgRJGliyjYAAAAASUVORK5CYII=', fit: 'contain', width: SW, height: SW },
    transform: { x: W - pad - SW, y: H - pad - SW },
  });
  return doc;
}

export async function runJob(spec, { emit, makeAdapter, signal }) {
  const root = resolve(spec.engineRoot);
  // 引擎里有若干相对路径（TTS 的 modelDir、packs 目录等）按 cwd 解析，先切过去。
  // 注意：必须在 import 之前切，`findChromium` 之类会读相对路径。
  process.chdir(root);

  const { loadRegistry, satisfiesEngineRange } = await imp(root, 'src/registry.mjs');
  const { validateDocument, ENGINE_VERSION } = await imp(root, 'src/validate.mjs');
  const { renderTemplate } = await imp(root, 'src/render/index.mjs');
  const { findFfmpeg } = await imp(root, 'src/paths.mjs');

  const packs = loadRegistry(join(root, 'packs'));
  const pack = packs.get(spec.pack || 'video');
  if (!pack) throw new Error(`领域包不存在: ${spec.pack || 'video'}`);
  pack.engineRangeCheck = satisfiesEngineRange(pack.domain.engineRange, ENGINE_VERSION);

  // ── 闸门：校验不通过，绝不进入渲染（S0 校验器在 S1 就被消费，这里同理）──
  const gate = [];
  for (const [orientation, doc] of Object.entries(spec.pair || {})) {
    injectWatermark(doc, spec.watermark !== false);
    const v = validateDocument(doc, pack);
    gate.push({ orientation, ok: v.ok, errors: v.errors, warnings: v.warnings, issues: v.issues });
  }
  const blocked = gate.filter((g) => !g.ok);
  if (blocked.length) {
    const err = new Error(`模板校验未通过（${blocked.map((b) => `${b.orientation} ${b.errors} 个 error`).join('，')}），已拒绝渲染`);
    err.validation = { ok: false, template: gate };
    throw err;
  }
  emit({ t: 'gate', value: { engineVersion: ENGINE_VERSION, pack: `${pack.domain.domain}@${pack.domain.version}`, templates: gate } });

  const ctx = { root, pack, renderTemplate, findFfmpeg, makeAdapter, emit, signal, spec };

  if (spec.kind === 'preview') return runPreview(ctx);
  if (spec.kind === 'final') return runFinal(ctx);
  if (spec.kind === 'posters') return runPosters(ctx);
  throw new Error(`未知任务类型: ${spec.kind}`);
}

/** 统一的进度上报：把引擎的 onProgress 翻译成宿主能画进度条的形状。 */
function progressReporter(emit, orientation, total) {
  let last = 0;
  return (p) => {
    const now = Date.now();
    if (now - last < 250 && p.done !== p.total) return;
    last = now;
    emit({
      t: 'progress',
      orientation,
      done: p.done,
      total,
      msPerFrame: p.msPerFrame,
      etaMs: p.etaMs,
      pct: total ? Math.min(1, p.done / total) : 0,
    });
  };
}

function renderPlan(root, doc, quality, framesOverride) {
  // 只为拿尺寸（适配器要按最终像素尺寸建窗口/视口）
  return import(pathToFileURL(join(root, 'src/render/job.mjs')).href).then((m) =>
    m.planFrames({ doc, pack: null, quality, framesOverride }),
  );
}

/** 逐版渲染（预览与终版共用）。返回每个方向的结果。 */
async function renderBothVersions(ctx, { outDir, quality, framesOverrideByOrientation, vars, subtitle, keepFrames, resume }) {
  const results = [];
  for (const [orientation, doc] of Object.entries(ctx.spec.pair)) {
    injectWatermark(doc, ctx.spec.watermark !== false);
    if (ctx.signal?.aborted) throw cancelled();
    const framesOverride = framesOverrideByOrientation[orientation] ?? null;
    const plan = await renderPlan(ctx.root, doc, quality, framesOverride);
    // 强杀遗留的帧：先把断点清单按盘上字节重建出来，否则引擎只会说"续用 0"。
    if (resume) recoverFrameManifest(join(outDir, orientation, 'frames'), planSignature(plan), ctx.emit, orientation);
    const adapter = ctx.makeAdapter({ width: plan.width, height: plan.height, quality });
    const t0 = Date.now();
    ctx.emit({ t: 'step', name: `渲染${orientation === 'vertical' ? '竖版' : '横版'} ${plan.width}×${plan.height}`, elapsedMs: 0 });
    const r = await ctx.renderTemplate({
      doc,
      pack: ctx.pack,
      outDir: join(outDir, orientation),
      quality,
      framesOverride,
      vars: { ...vars, subtitle },
      userSlots: ctx.spec.assets || {},
      keepFrames,
      resume: !!resume,
      adapter,
      signal: ctx.signal,
      onProgress: progressReporter(ctx.emit, orientation, plan.indices.length),
    });
    const resumed = r.resumedFrames || 0;
    ctx.emit({
      t: 'log',
      msg: `${orientation === 'vertical' ? '竖版' : '横版'}：${r.frameCount} 帧（新渲 ${r.renderedFrames}、续用 ${resumed}）` +
        `，${(r.renderMs / 1000).toFixed(1)}s，${r.msPerFrame.toFixed(0)} ms/帧` +
        (r.warnings?.length ? `，告警 ${r.warnings.length} 条` : ''),
    });
    results.push({ orientation, ...r, wallMs: Date.now() - t0 });
  }
  return results;
}

// ── 预览：低分辨率 / 低帧率，先让用户看到效果 ──────────────────────────
async function runPreview(ctx) {
  const { spec, emit } = ctx;
  const outDir = spec.outDir;
  mkdirSync(outDir, { recursive: true });

  const { buildCuesFromText, cuesToSrtText } = await imp(ctx.root, 'src/text/segment.mjs');
  const fps = firstDoc(spec).canvas.fps || 30;
  // 预览不做配音（TTS 是整条链路里最慢的一步），字幕按字数估时长即可 ——
  // 预览要看的是**版式与动效**，不是最终听感。
  const cues = buildCuesFromText(spec.script || '', { fps, maxCharsPerLine: 15, maxLines: 2 });
  const srt = cuesToSrtText(cues);

  const seconds = spec.previewSeconds || 4;
  const framesOverrideByOrientation = {};
  for (const [orientation, doc] of Object.entries(spec.pair)) {
    injectWatermark(doc, spec.watermark !== false);
    framesOverrideByOrientation[orientation] = Math.max(2, Math.round(seconds * (doc.canvas.fps || 30)));
  }

  emit({ t: 'log', msg: `预览：${seconds}s，${spec.pair.vertical?.canvas.w || 0}×${spec.pair.vertical?.canvas.h || 0} 半分辨率、隔帧` });
  const renders = await renderBothVersions(ctx, {
    outDir,
    quality: 'preview',
    framesOverrideByOrientation,
    vars: spec.vars || {},
    subtitle: srt,
    keepFrames: true,
    resume: !!spec.resume,
  });

  if (!spec.keepFramesAfterDone) pruneFrames(outDir, emit);

  return {
    ok: true,
    kind: 'preview',
    outDir,
    quality: 'preview',
    subtitle: { cues: cues.length, file: null },
    renders: renders.map(summarizeRender),
    finals: renders.map((r) => ({ orientation: r.orientation, file: r.outFile, bytes: null })),
    totalMs: renders.reduce((a, r) => a + r.wallMs, 0),
  };
}

// ── 终版：配音 + 字幕 + 横竖双版 + 混音合流（与 produce() 同序）──────────
async function runFinal(ctx) {
  const { spec, emit } = ctx;
  const outDir = spec.outDir;
  mkdirSync(outDir, { recursive: true });
  const audioDir = join(outDir, 'audio');
  mkdirSync(audioDir, { recursive: true });

  const { splitSentences, buildCuesFromText, cuesToSrtText } = await imp(ctx.root, 'src/text/segment.mjs');
  const { createTtsBackend, audioDurationMs } = await imp(ctx.root, 'src/audio/tts.mjs');
  const { synthVoiceTrack } = await imp(ctx.root, 'src/pipeline.mjs');
  const { mixVoiceAndBgm, muxAudio, resolveBgm } = await imp(ctx.root, 'src/audio/mix.mjs');
  const { probe } = await imp(ctx.root, 'src/encode.mjs');
  const { run } = await imp(ctx.root, 'src/encode.mjs');

  const ffmpeg = ctx.findFfmpeg();
  const fps = firstDoc(spec).canvas.fps || 30;
  const script = spec.script || '';
  const sentences = splitSentences(script);
  emit({ t: 'log', msg: `拆句：${sentences.length} 句` });

  // ① 配音（可复用：续渲重跑时脚本没变就不重新合成 —— TTS 是最慢的一步）
  const voiceWav = join(audioDir, 'voice.wav');
  const cacheFile = join(outDir, '.voice-cache.json');
  const scriptSha = sha256(script);
  let voice = null;
  if (existsSync(voiceWav) && existsSync(cacheFile)) {
    try {
      const c = JSON.parse(await (await import('node:fs/promises')).readFile(cacheFile, 'utf8'));
      if (c.scriptSha === scriptSha && Array.isArray(c.durationsMs)) {
        const totalMs = await audioDurationMs(voiceWav);
        if (totalMs) {
          voice = { voiceWav, durationsMs: c.durationsMs, gapMs: c.gapMs || 0, totalMs, sentenceCount: sentences.length, provided: !!c.provided, backend: c.backend, voiceName: c.voiceName, reused: true };
          emit({ t: 'log', msg: `配音：续用已有音轨（${(totalMs / 1000).toFixed(1)} 秒）` });
        }
      }
    } catch { /* 缓存坏了就重做 */ }
  }

  if (!voice) {
    if (spec.voiceoverFile) {
      // 【用户自带配音】给了这个就完全跳过我们的 TTS
      const src = resolve(spec.voiceoverFile);
      if (!existsSync(src)) throw new Error(`配音文件不存在：${src}`);
      await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-ar', '44100', '-ac', '1', voiceWav]);
      const totalMs = (await audioDurationMs(voiceWav)) || 0;
      if (!totalMs) throw new Error('配音文件读不出时长，请检查格式');
      const totalChars = sentences.reduce((n, s) => n + s.length, 0) || 1;
      voice = {
        voiceWav, totalMs, gapMs: 0, provided: true, backend: 'user-provided', voiceName: '用户自带配音',
        durationsMs: sentences.map((s) => Math.max(500, (s.length / totalChars) * totalMs)),
      };
      emit({ t: 'log', msg: `配音：使用你自带的文件（${(totalMs / 1000).toFixed(1)} 秒）` });
    } else {
      // 兜底音色：中英切段混读（华言 + lessac）。**不做音色选择 UI**（立项决策 6）：
      // 用户要么用这个兜底，要么给 voiceoverFile，要么走 external 接口。
      const ttsOpts = spec.tts || defaultTts(ctx.root);
      const tts = createTtsBackend(ttsOpts);
      let done = 0;
      const wrapped = {
        synthesize: async (args) => {
          if (ctx.signal?.aborted) throw cancelled();
          const r = await tts.synthesize(args);
          done++;
          emit({ t: 'progress', phase: 'tts', done, total: sentences.length, pct: sentences.length ? done / sentences.length : 0, text: `配音 ${done}/${sentences.length} 句` });
          return r;
        },
      };
      emit({ t: 'step', name: `配音（${tts.voice || tts.id}）`, elapsedMs: 0 });
      voice = await synthVoiceTrack({ sentences, tts: wrapped, workDir: audioDir, ffmpeg });
      voice.backend = tts.id;
      voice.voiceName = tts.voice || tts.id;
      emit({ t: 'log', msg: `配音完成：${(voice.totalMs / 1000).toFixed(1)} 秒（${voice.voiceName}）` });
    }
    writeFileSync(cacheFile, JSON.stringify({
      scriptSha, durationsMs: voice.durationsMs, gapMs: voice.gapMs,
      provided: !!voice.provided, backend: voice.backend, voiceName: voice.voiceName,
    }, null, 2) + '\n');
  }

  // ② 字幕：用真实配音时长对齐
  const cues = buildCuesFromText(script, {
    fps, maxCharsPerLine: 15, maxLines: 2, gapMs: voice.gapMs, durationsMs: voice.durationsMs,
  });
  const srt = cuesToSrtText(cues);
  const srtFile = join(outDir, 'subtitle.srt');
  writeFileSync(srtFile, srt);
  const framesPadding = spec.framesPadding ?? 90;
  const totalFrames = Math.ceil(((voice.totalMs + 500 + (framesPadding / fps) * 1000) / 1000) * fps);
  emit({ t: 'log', msg: `字幕：${cues.length} 条；成片 ${totalFrames} 帧（${(totalFrames / fps).toFixed(1)} 秒）` });

  // ③ 横竖双版（断点续渲在这里生效）
  const framesOverrideByOrientation = {};
  for (const [orientation, doc] of Object.entries(spec.pair)) {
    injectWatermark(doc, spec.watermark !== false);
    framesOverrideByOrientation[orientation] = Math.min(totalFrames, Math.round(doc.canvas.maxFramesHint || totalFrames));
  }
  const renders = await renderBothVersions(ctx, {
    outDir,
    quality: spec.quality || 'final',
    framesOverrideByOrientation,
    vars: spec.vars || {},
    subtitle: srt,
    keepFrames: true, // 保帧：这是"断点续渲"唯一的依据（manifest.json + PNG）
    resume: true,
  });

  // ④ BGM + 闪避混音 + 合流
  if (ctx.signal?.aborted) throw cancelled();
  let bgm = null;
  if (spec.bgmFile) {
    // 用户自己的背景音乐（2026-10-09 加）。
    // ⚠️ 这里**故意绕过** BGM 入库台账 —— 台账是给"我们提供的曲子"用的（版权审核过）；
    //    用户自己的曲子，版权责任在用户，我们只做混音。
    //    **必须记一条日志**，不许静默绕过合规设计。
    bgm = { id: 'user', file: spec.bgmFile, source: 'user' };
    emit({ t: 'log', msg: '背景音乐：用户提供的文件（版权责任由使用者承担）' });
  } else if (spec.bgmId) {
    bgm = resolveBgm(ctx.pack, spec.bgmId);
  }
  const mixed = await mixVoiceAndBgm({
    voiceWav: voice.voiceWav,
    bgmFile: bgm ? bgm.file : null,
    outFile: join(audioDir, 'mixed.m4a'),
    duck: !!bgm,
  });
  emit({ t: 'log', msg: `混音：${bgm ? `BGM（${bgm.id}）+ 闪避` : '仅人声'}` });

  const finals = [];
  for (const o of renders) {
    if (ctx.signal?.aborted) throw cancelled();
    const out = join(outDir, `${o.outFile.split('/').pop().replace('.mp4', '')}-配音版.mp4`);
    await muxAudio({ videoFile: o.outFile, audioFile: mixed.outFile, outFile: out });
    const info = await probe(out, ffmpeg).catch(() => null);
    finals.push({
      orientation: o.orientation,
      file: out,
      bytes: Number(info?.format?.size || 0),
      durationSec: Number(Number(info?.format?.duration || 0).toFixed(2)),
    });
  }
  emit({ t: 'step', name: '合流完成', elapsedMs: 0 });
  if (!spec.keepFramesAfterDone) pruneFrames(outDir, emit);

  return {
    ok: true,
    kind: 'final',
    outDir,
    quality: spec.quality || 'final',
    voice: { backend: voice.backend, voice: voice.voiceName, totalMs: voice.totalMs, reused: !!voice.reused },
    subtitle: { cues: cues.length, file: srtFile },
    renders: renders.map(summarizeRender),
    finals,
    totalMs: renders.reduce((a, r) => a + r.wallMs, 0),
  };
}

/**
 * 海报占位文案。
 *
 * 海报只给人看个版式，所以必填变量得给**示例值**而不是空着
 * （`applyVars` 对必填变量缺值会直接抛错 —— 第一次跑就是这么失败的）。
 * `subtitle` 给一条**样例字幕**而不是空串：空字幕会让模板里的字幕层落到引擎的
 * "字幕占位：subtitle 为空"占位文案上，海报缩略图里就是一行红字，很丑。
 */
const POSTER_SUBTITLE = '1\n00:00:00,000 --> 00:00:20,000\n字幕示例：这里显示这一句旁白\n';

const POSTER_PLACEHOLDERS = {
  title: '标题示例',
  kicker: '小标题',
  subtitle: POSTER_SUBTITLE,
  step1: '第一步',
  step2: '第二步',
  step3: '第三步',
  points: '要点一\n要点二',
};

function posterVars(doc, given = {}) {
  const out = { subtitle: POSTER_SUBTITLE, ...given };
  for (const v of doc.vars || []) {
    if (out[v.key] !== undefined && String(out[v.key]).length) continue;
    out[v.key] = v.default !== undefined ? v.default : (POSTER_PLACEHOLDERS[v.key] ?? (v.label || v.key));
  }
  return out;
}

/**
 * 海报取第几帧。
 *
 * ⚠️ **不能取第 0 帧**（第一次就是那么干的，出来的是一张近乎空白的深色图）：
 * 三个模板的入场动画都是从 0 帧起跑的（`slide-up` 0→45、`bar` 20→50、
 * 03-steps 的第三行要到 135→160 才落位），第 0 帧的画面是"所有层都还没进场"。
 * 180 帧（6 秒）之后三套模板的元素都已 hold 在终态。
 */
const POSTER_FRAME = 180;

/** 生成模板预览图：渲到"元素都已落位"的那一帧，只留那一张当海报。 */
async function runPosters(ctx) {
  const { spec, emit } = ctx;
  const outDir = spec.outDir;
  mkdirSync(outDir, { recursive: true });
  const targetFrame = Number(spec.posterFrame ?? POSTER_FRAME);
  const made = [];
  for (const item of spec.posters || []) {
    if (ctx.signal?.aborted) throw cancelled();
    const doc = item.doc;
    const plan = await renderPlan(ctx.root, doc, 'preview', targetFrame + 1);
    const adapter = ctx.makeAdapter({ width: plan.width, height: plan.height, quality: 'preview' });
    const r = await ctx.renderTemplate({
      doc, pack: ctx.pack, outDir: join(outDir, item.id), quality: 'preview',
      framesOverride: targetFrame + 1, vars: posterVars(doc, item.vars), userSlots: {},
      keepFrames: true, resume: false, adapter, signal: ctx.signal,
    });
    // 挑"目标帧"那一张，其余帧与那段预览视频都删掉 —— 海报目录里只留一张图，
    // 并且用宿主约定的固定文件名（`<id>/frames/frame-000000.png`）。
    const pick = r.frames.filter((f) => f.srcFrame <= targetFrame).pop() || r.frames[r.frames.length - 1];
    for (const f of r.frames) {
      if (f.file !== pick.file) { try { rmSync(join(r.frameDir, f.file), { force: true }); } catch { /* ignore */ } }
    }
    const canonical = join(r.frameDir, 'frame-000000.png');
    if (join(r.frameDir, pick.file) !== canonical) renameSync(join(r.frameDir, pick.file), canonical);
    try { rmSync(join(r.frameDir, 'manifest.json'), { force: true }); } catch { /* ignore */ }
    try { rmSync(r.outFile, { force: true }); } catch { /* ignore */ }
    made.push({ id: item.id, file: canonical, frame: pick.srcFrame });
    emit({ t: 'progress', phase: 'posters', done: made.length, total: spec.posters.length, pct: made.length / spec.posters.length, text: `预览图 ${made.length}/${spec.posters.length}（第 ${pick.srcFrame} 帧）` });
  }
  emit({ t: 'log', msg: `模板预览图：${made.length} 张（取第 ${targetFrame} 帧附近，此时元素已落位）` });
  return { ok: true, kind: 'posters', outDir, posters: made };
}

function summarizeRender(r) {
  return {
    orientation: r.orientation,
    file: r.outFile,
    width: r.width,
    height: r.height,
    fps: r.fps,
    frames: r.frameCount,
    rendered: r.renderedFrames,
    resumed: r.resumedFrames || 0,
    msPerFrame: Number((r.msPerFrame || 0).toFixed(2)),
    renderMs: r.renderMs,
    adapter: r.adapter,
    warnings: r.warnings || [],
    sha256: r.videoSha256,
  };
}

function firstDoc(spec) {
  return spec.pair.vertical || spec.pair.horizontal || Object.values(spec.pair)[0];
}

/** 兜底 TTS：中英切段混读（华言 + lessac）；模型不在就退回系统音色。 */
export function defaultTts(root) {
  const zh = join(root, 'models/vits-piper-zh_CN-huayan-medium');
  const en = join(root, 'models/vits-piper-en_US-lessac-medium');
  if (existsSync(zh) && existsSync(en)) {
    return { backend: 'code-switch', zh: { backend: 'local', modelDir: zh }, en: { backend: 'local', modelDir: en } };
  }
  if (existsSync(zh)) return { backend: 'local', modelDir: zh };
  return { backend: 'system' };
}

function cancelled() {
  const e = new Error('任务已取消');
  e.cancelled = true;
  return e;
}

/**
 * 成片合成之后清掉逐帧 PNG。
 *
 * 为什么要管这件事：`renderTemplate` 在 `keepFrames:true` 时会把每一帧 PNG 留在
 * `<outDir>/<orientation>/frames/`，而**引擎从来不清它们**（`produce()` 用的
 * `.frames-tmp` 也一样留着）。一条 12 秒的片子就是 700+ 张 1080×1920 的 PNG。
 * 实测：跑十几轮之后 `out/app` 累积到 **2.7 GB**。
 *
 * 保帧的唯一理由是**断点续渲**，而那只对"没跑完的任务"有意义：
 *   · 中途被杀 / 崩了 → 帧留着，重跑 `resume` 能跳过（这时**不会**走到这里）；
 *   · 正常跑完 → 成片已经在手，帧就是纯占地方。
 * 所以清理点放在"成功之后"，语义刚好。
 * 想要留着帧的人可以把 `spec.keepFramesAfterDone` 打开。
 */
function pruneFrames(outDir, emit) {
  let count = 0;
  let bytes = 0;
  for (const orientation of ['vertical', 'horizontal']) {
    for (const sub of ['frames', '.frames-tmp']) {
      const dir = join(outDir, orientation, sub);
      if (!existsSync(dir)) continue;
      try {
        for (const f of readdirSync(dir)) {
          try { bytes += statSync(join(dir, f)).size; count++; } catch { /* ignore */ }
        }
        rmSync(dir, { recursive: true, force: true });
      } catch { /* 清不掉不算失败，成片已经好了 */ }
    }
  }
  if (count) emit({ t: 'log', msg: `清理逐帧 PNG：${count} 张（释放约 ${(bytes / 1048576).toFixed(0)} MB）—— 成片已合成，帧不再需要` });
}
