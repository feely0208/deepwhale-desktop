#!/usr/bin/env node
/**
 * 能力一致性断言：**"CDN 支持多段 range" 与 "客户端开了差分下载" 不能同时为假/为真错配**
 * （2026-10-15 Windows 用户实测「80% 以后越来越慢、卡到 95%」后新加）
 *
 * ── 事故 ──────────────────────────────────────────────────────────
 *   1.0.57 起我们在 CDN 上补了 `*.blockmap`（P1-3 的"修复"）。于是 electron-updater 开始走
 *   **差分下载**，而差分下载依赖**多段 range**（一次请求最多 1000 段）。我们的华为 CDN：
 *     · 多段 range → 返回 **200 + 整个文件**（而不是 206 multipart/byteranges）；
 *     · 但响应头带 `Accept-Ranges: bytes` → electron-updater 认为"支持"，继续按 multipart 解析
 *       → 永远凑不齐分片 → **越下越慢**（用户看到的就是这个）。
 *   · 以前没这毛病，是因为**以前 CDN 上没有 blockmap**（403）→ 差分前缀直接失败 → 退回全量下载。
 *
 * ── 本断言做什么 ──────────────────────────────────────────────────
 *   ① 真去请求一次 CDN 的多段 range，判定它是否真的支持（206 + multipart/byteranges）；
 *   ② 读我们的 update-manager.ts，看 `autoUpdater.disableDifferentialDownload` 设成了什么；
 *   ③ 要求两者**一致**：
 *        CDN 不支持多段 range  → 客户端必须 disableDifferentialDownload = true
 *        CDN 支持多段 range    → 才允许把 disableDifferentialDownload 放开（false）
 *   不一致就红，并给出改哪一边。
 *
 * 用法：
 *   node scripts/check-updater-differential.js            # 用默认探测 URL
 *   node scripts/check-updater-differential.js <URL>      # 指定一个存在的安装包 URL
 *   OFFLINE=1 node scripts/check-updater-differential.js  # 只做静态检查（不联网，输出会说明）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = path.join(__dirname, '..');
const DEFAULT_URL = 'https://dl.deepwhale.org.cn/DeepWhale-Desktop-1.0.57-x64-Setup.exe';
const target = process.argv[2] || DEFAULT_URL;
const offline = process.env.OFFLINE === '1';

/** 请求一次"多段 range"，返回 {supported, status, acceptRanges, contentType, note} */
function probeMultiRange(url) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-99,1000000-1000099,2000000-2000099' },
      timeout: 30000,
    }, (res) => {
      const status = res.statusCode;
      const acceptRanges = res.headers['accept-ranges'] || '';
      const contentType = res.headers['content-type'] || '';
      // 多段 range 受支持的判据：206 + multipart/byteranges
      const supported = status === 206 && /multipart\/byteranges/i.test(contentType);
      res.destroy();
      resolve({
        supported, status, acceptRanges, contentType,
        note: supported
          ? '206 + multipart/byteranges ✓'
          : `状态 ${status}（期望 206）、Content-Type=${contentType || '无'}、Accept-Ranges=${acceptRanges || '无'}`,
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ supported: null, note: '探测超时' }); });
    req.on('error', (e) => resolve({ supported: null, note: '探测失败：' + e.message }));
    req.end();
  });
}

const src = fs.readFileSync(path.join(REPO, 'src', 'main', 'update-manager.ts'), 'utf-8');
const disabled = /autoUpdater\.disableDifferentialDownload\s*=\s*true/.test(src);
const enabledExplicitly = /autoUpdater\.disableDifferentialDownload\s*=\s*false/.test(src);

(async () => {
  console.log('== 更新分发能力一致性检查 ==');
  console.log(`   探测 URL: ${target}`);
  const probe = offline
    ? { supported: null, note: 'OFFLINE=1：跳过联网探测' }
    : await probeMultiRange(target);
  console.log(`   CDN 多段 range: ${probe.supported === null ? '未知（' + probe.note + '）' : (probe.supported ? '支持' : '不支持')} — ${probe.note}`);
  console.log(`   客户端差分下载: ${disabled ? '已关闭（disableDifferentialDownload = true）' : enabledExplicitly ? '显式开启' : '默认开启（未设置）'}`);

  const problems = [];
  if (probe.supported === false && !disabled) {
    problems.push(
      'CDN **不支持**多段 range，但客户端仍开着差分下载\n' +
        '       → 差分下载会发出多段请求、拿到整包却按 multipart 解析，结果"越下越慢"（2026-10-15 事故）。\n' +
        '       → 修法：src/main/update-manager.ts 里设 autoUpdater.disableDifferentialDownload = true；\n' +
        '         或者让 CDN 真正支持多段 range（返回 206 + multipart/byteranges），再放开这个开关。',
    );
  }
  if (probe.supported === true && disabled) {
    problems.push(
      'CDN **已支持**多段 range，但客户端把差分下载关着\n' +
        '       → 白丢差分更新的流量优势（用户要多下几十~上百 MB）。可以放开 disableDifferentialDownload。',
    );
  }
  if (probe.supported === null) {
    // 探不出来时必须说清楚，不能当成"通过"（假绿）
    console.log('   ⚠️ 本次没探到 CDN 能力（离线/超时/网络问题）—— 只做了静态部分，未验证一致性。');
  }

  if (problems.length) {
    console.error('\n❌ 更新分发能力不一致：\n');
    problems.forEach((p, i) => console.error(`   ${i + 1}. ${p}`));
    process.exitCode = 1;
  } else if (probe.supported !== null) {
    console.log('✅ 一致：CDN 能力与客户端差分开关匹配');
  }
})();
