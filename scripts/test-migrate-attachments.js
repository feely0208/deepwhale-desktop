#!/usr/bin/env node
/**
 * 旧 home 迁移 · attachments 丢失回归测试（离线，不启动 Electron）
 *
 * ── 为什么要这个测试 ────────────────────────────────────────────────
 * 2026-09-30 的真实事故：新旧两套 home 之间搬会话，图片全丢，会话里引用图片时
 * 报 TRANSPORT（"DeepSeek Messages transport failed"）—— 看起来像网络故障，
 * 实际是附件一个都没搬过来（真实数据里丢了 44 个对象）。
 *
 * 根因：迁移循环按**目录**粒度判断「目标已存在就跳过」，而 DSH 首次启动会
 * 先建一个空的 `attachments/`，于是整个目录被跳过。
 *
 * 这个测试**不启动 Electron、不开窗口**：`legal-mode.js` 只依赖 fs/path
 * （已核实编译产物里没有 require('electron')，与 test-inject-race.js 同一套做法），
 * 可以直接在纯 Node 下对着临时 home 调用。
 *
 * 用法：npm run build && node scripts/test-migrate-attachments.js
 *      （或 package.json 里的 npm run test:migrate）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const LEGAL_MODE_JS = path.join(REPO, 'dist/main/legal-mode.js');

// 编译产物缺失时必须直接失败，不能静默"跑绿" —— 否则测试什么都没验证到。
if (!fs.existsSync(LEGAL_MODE_JS)) {
  console.error(`\n❌ 找不到 ${LEGAL_MODE_JS}\n   先跑 npm run build 生成 dist/，再执行本测试。\n`);
  process.exit(1);
}

const { migrateLegacyHomeOnce } = require(LEGAL_MODE_JS);

let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 旧 home 里的附件对象（含一个多层子目录，验证递归） */
const LEGACY_ONLY = ['v1/bb/bbbb.bin', 'v1/cc/nested/cccc.bin'];
/** 新旧都有、且内容不同：必须保留目标侧已有的那份，不能被覆盖 */
const CONFLICT = 'v1/aa/aaaa.bin';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-migrate-'));
try {
  const legacy = path.join(root, 'legacy-home');
  const fresh = path.join(root, 'fresh-home');

  // ── 旧 home：附件 + 一个会话 + 凭据/设置 ──────────────────────────
  for (const rel of [...LEGACY_ONLY, CONFLICT]) {
    const p = path.join(legacy, 'attachments', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `legacy:${rel}`);
  }
  // 会话：DSH 按 workspace 分目录存放，hasSessions 判定的是「子目录里有东西」
  fs.mkdirSync(path.join(legacy, 'sessions', 'ws-1'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'sessions', 'ws-1', 'session.jsonl'), '{}\n');
  fs.mkdirSync(path.join(legacy, 'llm-deepseek'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'llm-deepseek', 'model.bin'), 'legacy-model');
  fs.writeFileSync(path.join(legacy, 'settings.yaml'), 'theme: dark\n');

  // ── 新 home：精确复刻线上出事的场景 ──────────────────────────────
  //    DSH 已经先建好了**空的** attachments/ 与 llm-deepseek/，
  //    并且 attachments 里已有一个同名文件（内容不同）。
  fs.mkdirSync(path.join(fresh, 'attachments'), { recursive: true });
  fs.mkdirSync(path.join(fresh, 'llm-deepseek'), { recursive: true });
  fs.mkdirSync(path.join(fresh, 'sessions'), { recursive: true });
  const conflictPath = path.join(fresh, 'attachments', CONFLICT);
  fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
  fs.writeFileSync(conflictPath, 'fresh:already-here');

  // ── 跑迁移 ──────────────────────────────────────────────────────
  const migrated = migrateLegacyHomeOnce(fresh, [legacy]);
  check('迁移被真正执行（返回 true）', migrated === true, `返回值 ${String(migrated)}`);

  // ① 回归本体：空 attachments/ 已存在，附件仍必须补齐
  for (const rel of LEGACY_ONLY) {
    const p = path.join(fresh, 'attachments', rel);
    const got = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    check(`空目录下仍补齐附件 ${rel}`, got === `legacy:${rel}`, `实际内容 ${JSON.stringify(got)}`);
  }

  // ② 同名已有文件不被覆盖
  const conflictGot = fs.readFileSync(conflictPath, 'utf8');
  check('目标已有的同名附件不被覆盖', conflictGot === 'fresh:already-here', `实际内容 ${JSON.stringify(conflictGot)}`);

  // ③ 会话（走 mergeSessionsDir）与空 llm-deepseek/ 同理
  check('会话补齐到已存在的空 sessions/ 下', fs.existsSync(path.join(fresh, 'sessions', 'ws-1', 'session.jsonl')));
  check('文件补进已存在的空 llm-deepseek/', fs.existsSync(path.join(fresh, 'llm-deepseek', 'model.bin')));
  check('settings.yaml 补齐', fs.existsSync(path.join(fresh, 'settings.yaml')));

  // ④ 幂等：迁移标记生效，第二次调用直接跳过
  const again = migrateLegacyHomeOnce(fresh, [legacy]);
  check('第二次调用直接跳过（标记文件生效）', again === false, `返回值 ${String(again)}`);
  check('第二次调用没有产生重复文件', fs.readdirSync(path.join(fresh, 'attachments', 'v1', 'bb')).length === 1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n❌ 迁移回归测试失败：${failures} 项\n`);
  process.exit(1);
}
console.log('\n✅ 迁移回归测试通过：attachments 不再因「空目录已存在」而整体跳过\n');
