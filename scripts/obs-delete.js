#!/usr/bin/env node
/**
 * 删除 OBS 桶里的对象（官网 CDN 的内容）。
 *
 * 为什么需要：发版发错了要能**擦干净**。1.0.20 那次决定作废重发 1.0.21，
 * 但同步是逐个文件落地的 —— 已有的那个 deb 留在桶里，就成了
 * 「官网没有、CDN 上有」的幽灵文件：用户拿旧链接还能下到作废的版本，
 * 而任何人对着官网都查不出它为什么在那儿。
 *
 * 用法：
 *   OBS_AK=xxx OBS_SK=xxx OBS_BUCKET=deepwhale-downloads \
 *   OBS_ENDPOINT=obs.cn-north-4.myhuaweicloud.com \
 *   node scripts/obs-delete.js DeepWhale-Desktop-1.0.20-amd64.deb [...]
 *
 *   --dry-run   只列出将删什么，不真删
 *
 * 认证与 sync-to-obs.js 一致（同一组 Secrets），确保"能传的就能删"。
 */
'use strict';

const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const out = { keys: [], 'dry-run': false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') {
      out['dry-run'] = true;
      continue;
    }
    if (a.startsWith('--')) {
      out[a.replace(/^--/, '')] = argv[i + 1];
      i += 1;
      continue;
    }
    out.keys.push(a);
  }
  return out;
}

/** 与 sync-to-obs.js 同款：缺依赖时就地装，避免 CI 里再维护一份依赖清单。 */
function ensureSdk() {
  try {
    // eslint-disable-next-line global-require
    return require('esdk-obs-nodejs');
  } catch {
    console.log('[obs] 未找到 esdk-obs-nodejs，按需安装…');
    execFileSync('npm', ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund',
      'esdk-obs-nodejs'], { stdio: 'inherit' });
    // eslint-disable-next-line global-require
    return require('esdk-obs-nodejs');
  }
}

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[obs] 缺少环境变量 ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.keys.length === 0) {
    console.error('用法: node scripts/obs-delete.js <对象名> [...] [--dry-run]');
    process.exit(1);
  }

  console.log(`[obs] 待删除 ${args.keys.length} 个对象：`);
  for (const k of args.keys) console.log(`  ${k}`);
  if (args['dry-run']) {
    console.log('\n[obs] dry-run：未删除。');
    return;
  }

  const ObsClient = ensureSdk();
  const obs = new ObsClient({
    access_key_id: need('OBS_AK'),
    secret_access_key: need('OBS_SK'),
    server: `https://${need('OBS_ENDPOINT')}`,
    timeout: 90,
  });
  const bucket = need('OBS_BUCKET');

  let failed = 0;
  for (const key of args.keys) {
    // eslint-disable-next-line no-await-in-loop
    const res = await new Promise((resolve) => {
      obs.deleteObject({ Bucket: bucket, Key: key }, (err, result) => resolve({ err, result }));
    });
    const status = res.result?.CommonMsg?.Status;
    // 删不存在的对象，OBS 也返回 204 —— 这正是我们要的幂等语义
    if (res.err || (status && status >= 300)) {
      failed += 1;
      console.error(`  ❌ ${key} → ${res.err ? res.err.message : `HTTP ${status}`}`);
    } else {
      console.log(`  ✅ ${key} 已删除（HTTP ${status ?? 204}）`);
    }
  }

  if (failed > 0) {
    console.error(`\n[obs] ${failed} 个对象删除失败`);
    process.exit(1);
  }
  console.log(`\n[obs] 完成：${args.keys.length} 个对象已从 obs://${bucket} 删除`);
}

main().catch((error) => {
  console.error('[obs] failed:', error);
  process.exit(1);
});
