#!/usr/bin/env node
/**
 * 把安装包上传到华为云 OBS —— 替代原来「scp 到 ECS」的同步方式。
 *
 * 为什么需要：实测 GitHub 美国 runner → 国内 ECS 走 scp 只有 0.19–1.0 MB/s，
 * 1.96 GB 要 93 分钟（单连接、跨国际链路、丢包重传）。OBS 的**分片并发上传**
 * 把一个大文件拆成多个分片并行发，能显著绕开单连接的瓶颈。
 *
 * 用法：
 *   OBS_AK=xxx OBS_SK=xxx OBS_BUCKET=deepwhale-downloads \
 *   OBS_ENDPOINT=obs.cn-north-4.myhuaweicloud.com \
 *   node scripts/sync-to-obs.js --dir dist-assets [--dry-run] [--concurrency 8]
 *
 * 配置也可走同一个文件（CI 里用 GitHub Secrets 注入环境变量即可）。
 * 🔴 AK/SK 只从环境变量读，绝不写进仓库、绝不打印。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── 默认过滤：与官网 nginx 的约定保持一致 ─────────────────────────────
// 桌面端 .zip 官网不提供（那是 electron-updater 在 macOS 上走 GitHub 用的），
// 实测占同步总量的 29%。blockmap / latest*.yml 同理不需要落到官网。
const DEFAULT_EXCLUDE = [
  /\.blockmap$/,
  /(^|\/)latest.*\.yml$/,
  /(^|\/)DeepWhale-Desktop-.*\.zip$/,
];

function parseArgs(argv) {
  const out = { dir: null, 'key-prefix': '', 'dry-run': false, concurrency: 1, verify: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'dry-run' || k === 'verify') { out[k] = true; continue; }
    out[k] = argv[i + 1]; i += 1;
  }
  return out;
}

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

/** 确保 OBS Node SDK 可用；没有就按需装（不写进 package.json，避免长期依赖）。 */
function ensureSdk() {
  try {
    return require('esdk-obs-nodejs');
  } catch {
    console.log('[obs] 未找到 esdk-obs-nodejs，按需安装…');
    // --no-package-lock：CI 里跑时不要动仓库的锁文件
    execFileSync(
      'npm',
      ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', 'esdk-obs-nodejs'],
      { stdio: 'inherit' },
    );
    return require('esdk-obs-nodejs');
  }
}

function collect(dir, excludes) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (excludes.some((re) => re.test(rel))) continue;
      out.push({ full, rel, size: fs.statSync(full).size });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) throw new Error('需要 --dir <目录>');

  const files = collect(path.resolve(args.dir), DEFAULT_EXCLUDE);
  const totalMB = files.reduce((s, f) => s + f.size, 0) / 1048576;

  console.log(`[obs] 待上传 ${files.length} 个文件，合计 ${totalMB.toFixed(1)} MB`);
  for (const f of files) console.log(`  ${(f.size / 1048576).toFixed(1)} MB  ${f.rel}`);

  if (args['dry-run']) {
    console.log('\n[obs] dry-run：未上传。设好 OBS_AK/OBS_SK/OBS_BUCKET/OBS_ENDPOINT 后去掉 --dry-run 即可。');
    return;
  }

  const ObsClient = ensureSdk();
  const obs = new ObsClient({
    access_key_id: need('OBS_AK'),
    secret_access_key: need('OBS_SK'),
    server: `https://${need('OBS_ENDPOINT')}`,
    // ⚠️ 必须显式设超时：SDK 默认**没有超时**，跨国链路一旦僵死就会永久挂着
    // （实测一个 277MB 文件卡了 22 分钟不动，而同一批其它文件 8–12 MB/s）。
    // 有超时才能失败并重传，而不是无限期地等。
    timeout: 90,
  });

  const bucket = need('OBS_BUCKET');
  const prefix = args['key-prefix'].replace(/^\/+|\/+$/g, '');
  // ⚠️ 默认串行（1）。实测并发 4 时反而几乎传不动：
  //   · 串行（迁移 3.3GB）：14.5 分钟，多数文件 8–12 MB/s
  //   · 并发 4（1.0.18 同步）：一小时一个新文件都没上去
  // 原因是每个大文件本身就在分片并发，再叠 4 个文件 = 几十条 TCP 连接
  // 挤同一条丢包严重的国际链路，互相抢带宽并引发大量重传。
  // 想调高请先小样本实测，别直接改。
  const concurrency = Math.max(1, Number(args.concurrency) || 1);
  let failed = 0;

  // 并发上传多个文件。
  // 为什么需要：实测串行上传 3.3 GB 用时 14.5 分钟，但逐文件速率差异极大 ——
  // 多数文件 8–12 MB/s，却有 3 个只有 0.56–1.8 MB/s，这三个单独就占了总时长的
  // 58%。串行时一个慢文件会挡住后面所有文件；并发能让别的文件在它卡着时继续走，
  // 既快又不会被单个坏连接拖死。
  const queue = [...files];
  const runOne = async () => {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      const key = prefix ? `${prefix}/${f.rel}` : f.rel;
      const MAX_TRIES = 3;
      let ok = false;
      for (let attempt = 1; attempt <= MAX_TRIES && !ok; attempt += 1) {
        const t0 = Date.now();
        try {
          const res = await obs.putObject({ Bucket: bucket, Key: key, SourceFile: f.full });
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          const mbps = (f.size / 1048576 / Math.max(Number(secs), 0.1)).toFixed(2);
          if (res.CommonMsg.Status < 300) {
            console.log(`  ✅ ${key}  ${secs}s  ${mbps} MB/s${attempt > 1 ? `（第 ${attempt} 次尝试）` : ''}`);
            ok = true;
          } else {
            console.error(`  ⚠️ ${key}  第 ${attempt}/${MAX_TRIES} 次 HTTP ${res.CommonMsg.Status} ${res.CommonMsg.Message}`);
          }
        } catch (error) {
          console.error(`  ⚠️ ${key}  第 ${attempt}/${MAX_TRIES} 次失败：${error.message}`);
        }
        if (!ok && attempt < MAX_TRIES) {
          const wait = attempt * 5000;
          console.log(`     等 ${wait / 1000}s 后重传…`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      if (!ok) {
        failed += 1;
        console.error(`  ❌ ${key}  重传 ${MAX_TRIES} 次仍失败`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => runOne()));

  obs.close();
  if (failed) throw new Error(`${failed} 个文件上传失败`);
  console.log(`\n[obs] 完成：${files.length} 个文件已上传到 obs://${bucket}/${prefix || ''}`);
}

main().catch((e) => {
  console.error('[obs] failed:', e.message);
  process.exit(1);
});
