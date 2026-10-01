#!/usr/bin/env node
/**
 * 自建更新源（CDN feed）· 回归测试
 *
 * 两部分：
 *   A. 纯逻辑（离线）：回退配置的解析、feed 常量
 *   B. 发布守卫（联网）：CDN 上真的能取到三个 latest*.yml，且**版本号等于最新的 v* 标签**
 *
 * B 段为什么重要：更新源是自建的，最容易犯的错是"推了 tag、忘了补传 yml" ——
 * 那会让所有用户都收不到更新，而且**没有任何报错**（客户端只是每次都读到旧版本）。
 * 这条守卫就是为了让这种错在发版当时就暴露。
 *
 * 用法：npm run build && node scripts/test-update-feed.js [--offline]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const MOD = path.join(REPO, 'dist/main/update-feed.js');
const OFFLINE = process.argv.includes('--offline');

if (!fs.existsSync(MOD)) {
  console.error(`\n❌ 找不到 ${MOD}\n   先跑 npm run build，再执行本测试。\n`);
  process.exit(1);
}

const { CDN_FEED_URL, cdnFeedConfig, readPackagedUpdateConfig } = require(MOD);

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ✅ ${label}`);
  else {
    failures += 1;
    console.error(`  ❌ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

// ── A. 纯逻辑 ────────────────────────────────────────────────────────
console.log('\nA. 更新源配置（离线）');
check('CDN 地址是 https', CDN_FEED_URL.startsWith('https://'), CDN_FEED_URL);
check('CDN 地址不带尾斜杠（避免拼出 //latest.yml）', !CDN_FEED_URL.endsWith('/'), CDN_FEED_URL);
{
  const cfg = cdnFeedConfig();
  check('主源走 generic provider', cfg.provider === 'generic', JSON.stringify(cfg));
  check('主源 url 与常量一致', cfg.url === CDN_FEED_URL);
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-feed-'));
  try {
    // 真实形状（electron-builder 生成的就是这样）
    fs.writeFileSync(
      path.join(dir, 'app-update.yml'),
      ['owner: feely0208', 'repo: deepwhale-desktop', 'provider: github',
       'releaseType: draft', "updaterCacheDirName: 'deepwhale-desktop-updater'", ''].join('\n'),
    );
    const cfg = readPackagedUpdateConfig(dir);
    check('能读回退配置', cfg !== null);
    check('provider 正确', cfg?.provider === 'github', JSON.stringify(cfg));
    check('owner 正确', cfg?.owner === 'feely0208');
    check('带引号的值会被去掉引号', cfg?.updaterCacheDirName === 'deepwhale-desktop-updater', String(cfg?.updaterCacheDirName));

    // 缺 provider → 不能拿去 setFeedURL
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-feed2-'));
    try {
      fs.writeFileSync(path.join(dir2, 'app-update.yml'), 'owner: x\nrepo: y\n');
      check('缺少 provider 时返回 null（不给半成品配置）', readPackagedUpdateConfig(dir2) === null);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }

    check('文件不存在时返回 null', readPackagedUpdateConfig(path.join(dir, 'nope')) === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── B. 发布守卫 ──────────────────────────────────────────────────────
console.log('\nB. 发布守卫（联网：CDN 上真有清单、且版本等于最新 tag）');

async function liveGuard() {
if (OFFLINE) {
  console.log('  ⏭  跳过（--offline）');
} else {
  let latestTag = '';
  try {
    latestTag = execFileSync('git', ['tag', '--sort=-v:refname', '--list', 'v*'], {
      cwd: REPO,
      encoding: 'utf8',
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)[0] ?? '';
  } catch {
    latestTag = '';
  }
  console.log(`     最新 tag：${latestTag || '(取不到)'}`);

  const files = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];
  for (const f of files) {
    const url = `${CDN_FEED_URL}/${f}?noCache=probe${String(Date.now())}`;
    try {
      const res = await fetch(url, { method: 'GET' });
      const body = res.ok ? await res.text() : '';
      const version = /^version:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? '';
      check(`${f} 可访问`, res.ok, `HTTP ${String(res.status)}`);
      check(
        `${f} 的版本等于最新 tag`,
        latestTag !== '' && version === latestTag.replace(/^v/, ''),
        `清单里是 ${version || '(读不到)'}，tag 是 ${latestTag}`,
      );
    } catch (error) {
      check(`${f} 可访问`, false, error instanceof Error ? error.message : String(error));
    }
  }
}
}

// 顶层 await 与 require 不能共存（Node 会报 ERR_AMBIGUOUS_MODULE_SYNTAX），
// 所以这一整段包进 async 函数，用 .then 收尾。
liveGuard()
  .catch((error) => {
    console.error('\n❌ 发布守卫自身出错：', error);
    failures += 1;
  })
  .then(() => {
    if (failures > 0) {
      console.error(`\n❌ 更新源测试失败：${failures} 项\n`);
      process.exit(1);
    }
    console.log('\n✅ 通过：回退配置可解析，CDN 上的更新清单与最新 tag 一致\n');
  });
