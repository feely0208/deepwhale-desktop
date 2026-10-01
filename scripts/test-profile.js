#!/usr/bin/env node
/**
 * 自有 profile · 离线回归测试
 *
 * 背景：壳原来让 DSH 启动自带 profile `web`，我们的三套注入（法律模式 / office /
 * 随包插件）写进 `profiles/web/` —— 那是 DSH 自己的目录，它会在设置导入、版本升级时
 * reconcile 重写（2026-09-27 实测到「注入的三行被整段覆盖」）。现在改成从自带模板
 * 派生一个自有 profile（`deepwhale`）。
 *
 * 这个改动有两个**特别容易搞错、且错了很难发现**的点，所以必须钉住：
 *   1. `--from-default-profile` **只能在首启传一次**，profile 已存在时再传会让 DSH 直接抛错；
 *   2. 兜底命令里的裸 profile 名若不改写，DSH 会启动到自带 `web`，
 *      而注入全在 `profiles/deepwhale/` —— **插件会静默失效**（不报错，只是没有）。
 *
 * 用法：npm run build && node scripts/test-profile.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const MOD = path.join(REPO, 'dist/main/profile.js');

if (!fs.existsSync(MOD)) {
  console.error(`\n❌ 找不到 ${MOD}\n   先跑 npm run build，再执行本测试。\n`);
  process.exit(1);
}

const {
  PROFILE_NAME,
  PROFILE_TEMPLATE,
  SHIPPED_PROFILE_NAMES,
  profileDirOf,
  profileNeedsInit,
  applyProfileToCommandArgs,
} = require(MOD);

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ✅ ${label}`);
  else {
    failures += 1;
    console.error(`  ❌ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

// ── A. 常量本身 ──────────────────────────────────────────────────────
console.log('\nA. profile 名（两个硬约束来自 DSH 源码）');
check(
  `名字不是 DSH 自带模板名（否则 DSH 会拒绝作为自定义 profile）`,
  !SHIPPED_PROFILE_NAMES.includes(PROFILE_NAME),
  `PROFILE_NAME=${PROFILE_NAME}`,
);
check(
  '名字不是保留名 desktop（那个被官方 Electron 宿主占用，CLI 会拒绝）',
  PROFILE_NAME.toLowerCase() !== 'desktop',
  `PROFILE_NAME=${PROFILE_NAME}`,
);
check('派生模板是自带 profile', SHIPPED_PROFILE_NAMES.includes(PROFILE_TEMPLATE), PROFILE_TEMPLATE);

// ── B. profileNeedsInit ──────────────────────────────────────────────
console.log('\nB. 首启判断（决定要不要带 --from-default-profile）');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-profile-'));
try {
  const home = path.join(tmp, 'dsh-home');
  check('home 还不存在 → 需要初始化', profileNeedsInit(home) === true);
  check('目录不存在 → 需要初始化', profileNeedsInit(home) === true);

  fs.mkdirSync(profileDirOf(home), { recursive: true });
  check('目录建了但还没有 package.json → 仍需要初始化', profileNeedsInit(home) === true);

  fs.writeFileSync(path.join(profileDirOf(home), 'package.json'), '{}\n');
  check('package.json 存在 → 不需要初始化', profileNeedsInit(home) === false);

  check('home 为空（拿不到 DSH_HOME）→ 保守地不初始化', profileNeedsInit(undefined) === false);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── C. 兜底命令的改写 ────────────────────────────────────────────────
console.log('\nC. 兜底命令改写（不改写 = 插件静默失效）');
{
  const home = path.join(os.tmpdir(), `dw-nope-${String(Date.now())}`); // 不存在 → 需要初始化
  const r1 = applyProfileToCommandArgs(['web', '--port', '3095', '--no-open'], home);
  check('裸 `web` → 换成 --profile 我们的', r1.args.includes(PROFILE_NAME) && r1.ok === true, r1.args.join(' '));
  check('裸 `web` 被移除（否则又启动回自带 profile）', !r1.args.includes('web') || r1.args[r1.args.indexOf('web') - 1] === '--from-default-profile', r1.args.join(' '));
  check('首启带上 --from-default-profile', r1.args.includes('--from-default-profile'));
  check('其余参数保持顺序', r1.args.slice(-3).join(' ') === '--port 3095 --no-open', r1.args.join(' '));

  const done = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-profile2-'));
  try {
    fs.mkdirSync(profileDirOf(done), { recursive: true });
    fs.writeFileSync(path.join(profileDirOf(done), 'package.json'), '{}\n');
    const r2 = applyProfileToCommandArgs(['web', '--port', '3095'], done);
    check('profile 已存在时不带 --from-default-profile', !r2.args.includes('--from-default-profile'), r2.args.join(' '));

    const r3 = applyProfileToCommandArgs(['--profile', PROFILE_NAME, '--port', '3095'], done);
    check('命令里已写 --profile 我们的 → ok', r3.ok === true && r3.args.includes(PROFILE_NAME), r3.args.join(' '));

    const r4 = applyProfileToCommandArgs(['--profile', 'tui', '--port', '3095'], done);
    check('命令里显式指定了别的 profile → 尊重用户、但 ok=false（调用方要告警）', r4.ok === false && r4.args.includes('tui'), r4.args.join(' '));

    const r5 = applyProfileToCommandArgs(['--port', '3095', '--no-open'], done);
    check('命令里根本没有 profile 位置 → ok=false', r5.ok === false, r5.args.join(' '));
  } finally {
    fs.rmSync(done, { recursive: true, force: true });
  }
}

// ── D. 静态守卫：源码里不许再有硬编码 profiles/web ───────────────────
console.log('\nD. 静态守卫：不许再有写死的 `profiles/web`');
{
  const files = fs.readdirSync(path.join(REPO, 'src/main')).filter((f) => f.endsWith('.ts'));
  const bad = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(REPO, 'src/main', f), 'utf8');
    // 允许注释里提到 `profiles/web`（说明历史），只禁代码里的拼接
    for (const line of text.split('\n')) {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      if (/'profiles',\s*'web'/.test(line)) bad.push(`${f}: ${line.trim()}`);
    }
  }
  check('src/main 下没有写死的 profiles/web', bad.length === 0, bad.join(' | '));
}

if (failures > 0) {
  console.error(`\n❌ 自有 profile 回归测试失败：${failures} 项\n`);
  process.exit(1);
}
console.log('\n✅ 通过：自有 profile 的选择与首启初始化都符合 DSH 的约束\n');
