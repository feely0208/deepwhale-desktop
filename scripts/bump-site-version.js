#!/usr/bin/env node
/**
 * 一条命令把**两个官网**的版本引用全部升到目标版本。
 *
 * 为什么需要：官网的版本号散落在 4 个文件里，而且两站机制不同 ——
 *   · Pages 站 `docs/index.html`          ：DESKTOP_VERSION / LAWYER_VER / SUITE_TAG / SUITE_VER 四个常量
 *   · 主站 `assets/site.js`               ：一个 `DESKTOP_VERSION` 常量 + 硬编码的律师端/套装路径
 *   · 主站 `download.html`                ：全是硬编码路径
 * 手工改必漏。实测线上就出过不一致：**主站首页(site.js)给的是 v1.0.15，
 * 而下载页(download.html)给的是 1.0.16** —— 从首页点下载的用户拿到的是旧版。
 * 也出过 Pages 把律师端写死在旧 tag `v1.0.8` 上，新版发出去页面还指向老包。
 *
 * 用法：
 *   node scripts/bump-site-version.js \
 *     --shell 1.0.17 --lawyer 0.1.1 --lawyer-tag v1.0.17 --suite 1.0.17 \
 *     [--main-dir "/Users/mac/DeepSeek Harness/site-migration/deepwhale.org.cn"] \
 *     [--dry-run]
 *
 * 改完会逐文件报告改了多少处，并在最后**断言没有旧版本号残留**。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PAGES = path.join(__dirname, '..', 'docs', 'index.html');
const DEFAULT_MAIN_DIR = '/Users/mac/DeepSeek Harness/site-migration/deepwhale.org.cn';

function parseArgs(argv) {
  const out = { 'dry-run': false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'dry-run') {
      out['dry-run'] = true;
      continue;
    }
    out[key] = argv[i + 1];
    i += 1;
  }
  return out;
}

/**
 * 对一个文件做全部替换。
 *
 * 两阶段：
 *   ① **先探测**该文件里各族产物的旧版本号（壳 / 律师端 / 套装）——
 *      因为页面上的"版本标签"（`<span class="dlx-chip ver">v1.0.15</span>`）只有版本号、
 *      没有产物名，无法凭空分辨它属于壳还是套装，必须按"该文件里那一族当前是什么版本"来定位。
 *   ② 再应用精确替换，并对每组报告命中数。
 */
function bumpFile(file, opts) {
  if (!fs.existsSync(file)) {
    return { file, skipped: '文件不存在' };
  }
  let text = fs.readFileSync(file, 'utf8');
  const { shell, lawyer, lawyerTag, suite, suitePlatforms, lawyerPlatforms } = opts;

  // ① 探测旧版本号
  const first = (re) => (text.match(re) ?? [])[0]?.match(/\d+\.\d+\.\d+/)?.[0];
  const oldShell = first(/DeepWhale-Desktop-(\d+\.\d+\.\d+)-/);
  const oldLawyer = first(/DeepWhale-Lawyer-(\d+\.\d+\.\d+)-/);
  const oldSuite = first(/DeepWhale-Suite-(\d+\.\d+\.\d+)-/);

  const rules = [
    { name: 'DESKTOP_VERSION', re: /DESKTOP_VERSION\s*=\s*'v[\d.]+'/g, to: `DESKTOP_VERSION='v${shell}'` },
    // 主站下载区是 **JS 渲染**的（assets/site.js 里的 DOWNLOADS 数据 + dlxCard() 拼 HTML），
    // 分组徽章取自数据里的 `ver:` 字段，**不是** download.html 里那份静态 HTML。
    // 这里原本只维护了 DESKTOP_VERSION，律师端的 ver 是硬编码 ——
    // 于是文件名被更新成 0.1.2、徽章却一直显示 0.1.0，
    // 页面上出现「徽章 0.1.0 / 说明文字 0.1.2」的自相矛盾（2026-09-27 实测踩到）。
    // 所以：律师端徽章必须走 LAWYER_VERSION 常量，并由这里一并维护。
    { name: 'LAWYER_VERSION', re: /LAWYER_VERSION\s*=\s*'v[\d.]+'/g, to: `LAWYER_VERSION='v${lawyer}'` },
    { name: '律师端产物名', re: /DeepWhale-Lawyer-\d+\.\d+\.\d+-/g, to: `DeepWhale-Lawyer-${lawyer}-` },
    { name: '律师端 tag', re: /\/v\d+\.\d+\.\d+\/DeepWhale-Lawyer-/g, to: `/${lawyerTag}/DeepWhale-Lawyer-` },
    { name: '套装产物名', re: /DeepWhale-Suite-\d+\.\d+\.\d+-/g, to: `DeepWhale-Suite-${suite}-` },
    { name: '套装 tag', re: /\/suite-v\d+\.\d+\.\d+\//g, to: `/suite-v${suite}/` },
    { name: '壳产物名', re: /DeepWhale-Desktop-\d+\.\d+\.\d+-/g, to: `DeepWhale-Desktop-${shell}-` },
    // Pages 站已改成「变量驱动」：律师端与套装的 tag/版本号各是一个常量，
    // 产物名由常量拼接而成，不再有字面量可匹配。少了这三条，Pages 会**静默
    // 跳过**（报「无需改动」却什么都没升），下一版就会带着旧版本号上线。
    { name: 'LAWYER_VER', re: /LAWYER_VER\s*=\s*'\d+\.\d+\.\d+'/g, to: `LAWYER_VER = '${lawyer}'` },
    // 套装的徽章常量。**必须独立于 DESKTOP_VERSION** ——
    // 借用桌面端常量的后果（2026-09-28 实测）：壳发 1.0.19 而套装的包还在传 CDN、
    // 链接只能留 1.0.18 时，套装徽章会跟着桌面端显示 1.0.19，
    // 用户在浏览器里看到的就是「v1.0.19 / 下到 1.0.18」。
    { name: 'SUITE_VERSION', re: /SUITE_VERSION\s*=\s*'v[\d.]+'/g, to: `SUITE_VERSION='v${suite}'` },
    { name: 'SUITE_TAG', re: /SUITE_TAG\s*=\s*'suite-v[\d.]+'/g, to: `SUITE_TAG = 'suite-v${suite}'` },
    { name: 'SUITE_VER', re: /SUITE_VER\s*=\s*'\d+\.\d+\.\d+'/g, to: `SUITE_VER = '${suite}'` },
  ];

  // 版本标签 / 平台数标签：**必须按"这一族原本的版本号"逐一锚定**。
  // 用 `class="cnt">v[\d.]+ · N 个平台` 这种通用模式会**误伤别的分组** ——
  // 下载页上除了壳/套装，还有律师端与移动端两组，通用模式会把它们的版本号一并改掉。
  const esc = (v) => v.replace(/\./g, '\\.');
  // ⚠️ 徽标替换必须**按分组限定**，不能全局匹配。
  //
  // 反例（2026-09-28 真实踩到）：壳与套装的当前版本恰好都是 1.0.18，
  // 而"壳版本徽标"的匹配模式是全局的 `class="dlx-chip ver">v1.0.18<` ——
  // 于是**套装那几张卡的徽标也被改成了 1.0.19**，而它们的下载链接仍是 1.0.18，
  // 页面上出现「徽章 1.0.19 / 链接 1.0.18」。部署自检当场报了出来。
  //
  // 所以：把页面按 `dlx-group` 切块，每个分组只应用**属于它自己**的那族规则。
  const families = [
    { key: '壳', title: '深鲸桌面', oldV: oldShell, newV: shell, platforms: null },
    { key: '律师端', title: '深鲸律师端', oldV: oldLawyer, newV: lawyer, platforms: lawyerPlatforms },
    { key: '套装', title: '深鲸套装', oldV: oldSuite, newV: suite, platforms: suitePlatforms },
  ];
  const applied = [];
  const groupHits = {};
  text = text.replace(
    /(<div class="dlx-group">)([\s\S]*?)(?=<div class="dlx-group">|<\/div><\/div>\s*$|$)/g,
    (whole, open, body) => {
      // 归属只看分组标题（`<h3>`）。**绝不能**用「正文里出现过某族名」来判断：
      // 套装组的标题就是「深鲸套装（桌面 + 律师端）」，正文里桌面端、律师端都提，
      // 那样判断会让壳族/律师端规则二次命中套装组，把刚修好的 bug 原样带回来。
      const title = (body.match(/<h3>([^<]*)<\/h3>/) ?? [])[1] ?? '';
      const fam = families.find((f) => f.oldV && title.includes(f.title));
      if (!fam) return whole; // 移动端等分组：不归任何一族，原样放行
      let out = body;
      let hits = 0;
      // 平台卡片上的版本徽标
      // 只有**真的改了字**才计入 hits —— 目标版本与旧版本相同时（比如套装这一版
      // 故意留在旧版，等 CDN 传完再切），替换是空操作，不能报成"改了 N 处"。
      out = out.replace(
        new RegExp(`(class="dlx-chip ver">)v${esc(fam.oldV)}(<)`, 'g'),
        (_m, a, b) => {
          if (fam.oldV !== fam.newV) hits += 1;
          return `${a}v${fam.newV}${b}`;
        },
      );
      // 分组标题里的「vX · N 个平台」（N 只在显式传了 platforms 时才改）
      out = out.replace(
        new RegExp(`(class="cnt">)v${esc(fam.oldV)}( · )(\\d+)( 个平台)`, 'g'),
        (_m, a, sep, n, tail) => {
          if (fam.oldV !== fam.newV || (fam.platforms && fam.platforms !== n)) hits += 1;
          return fam.platforms ? `${a}v${fam.newV}${sep}${fam.platforms}${tail}` : `${a}v${fam.newV}${sep}${n}${tail}`;
        },
      );
      if (hits > 0) groupHits[fam.key] = (groupHits[fam.key] || 0) + hits;
      return open + out;
    },
  );
  for (const fam of families) {
    const n = groupHits[fam.key];
    if (n) applied.push(`${fam.key}分组徽标/平台数×${n}`);
  }

  for (const rule of rules) {
    const hits = (text.match(rule.re) ?? []).length;
    if (hits === 0) continue;
    text = text.replace(rule.re, rule.to);
    applied.push(`${rule.name}×${hits}`);
  }
  // ── 自愈：卡片徽标必须等于链接文件名里的版本 ────────────────────────────
  //
  // 链接指向的是**真实存在的产物**（deploy.sh 会逐个 HEAD 校验 200），
  // 所以链接是唯一可信来源，徽标只是它的显示副本。两者一旦脱节，页面就在骗用户：
  // 显示 v1.0.19、点下去下到 1.0.18。
  //
  // 这是 2026-09-28 那个 bug 的**根因兜底**：壳族徽标替换是全局匹配，
  // 而套装的包当时还没传上 CDN（版本刻意留在旧版），于是套装卡片被一并升了号，
  // 页面上出现「徽章 1.0.19 / 链接 1.0.18」。上面按分组限定是"别改错"，
  // 这里以链接为准是"改了也兜得住" —— 两道都要有。
  //
  // 用 split 而不是正则切卡片：卡片内部 `<div class="dlx-top">` 里就嵌套着
  // `</div></div>`，懒惰匹配 `([\s\S]*?<\/div><\/div>)` 会在 dlx-meta/dlx-act
  // **之前**就收尾，链接根本取不到。
  const chunks = text.split(/(?=<div class="dlx-card)/);
  for (let i = 1; i < chunks.length; i += 1) {
    const href = chunks[i].match(/dl\.deepwhale\.org\.cn\/([^"']+)["']/);
    if (!href) continue;
    const fileVer = (href[1].match(/(\d+\.\d+\.\d+)/) ?? [])[1];
    if (!fileVer) continue;
    chunks[i] = chunks[i].replace(
      /(class="dlx-chip ver">)v([0-9][0-9.]*)(<)/,
      (m, a, shown, b) => {
        if (shown === fileVer) return m;
        applied.push(`徽标按链接纠正：${href[1].split('/').pop()} v${shown}→v${fileVer}`);
        return `${a}v${fileVer}${b}`;
      },
    );
  }
  text = chunks.join('');

  return { file, text, applied, old: { shell: oldShell, lawyer: oldLawyer, suite: oldSuite } };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const shell = args.shell;
  const lawyer = args.lawyer;
  const lawyerTag = args['lawyer-tag'] ?? `v${shell}`;
  const suite = args.suite ?? shell;
  /** 套装的平台数（新增 macOS Intel 后为 4；不传则不动页面上的"· N 个平台"）。 */
  const suitePlatforms = args['suite-platforms'];
  /** 律师端的平台数（新增 macOS Intel 后为 5；不传则不动）。 */
  const lawyerPlatforms = args['lawyer-platforms'];
  if (!shell || !lawyer) {
    throw new Error('需要 --shell 与 --lawyer（--suite / --lawyer-tag 可选）');
  }
  const dryRun = args['dry-run'] === true;
  const pages = args.pages ?? DEFAULT_PAGES;
  const mainDir = args['main-dir'] ?? DEFAULT_MAIN_DIR;

  const targets = [
    pages,
    path.join(mainDir, 'download.html'),
    path.join(mainDir, 'assets', 'site.js'),
  ];

  console.log(`目标版本：壳 ${shell} ｜ 律师端 ${lawyer}（tag ${lawyerTag}）｜ 套装 ${suite}`);
  if (dryRun) console.log('（dry-run：只报告，不写盘）');
  console.log('');

  let totalChanged = 0;
  const finalTexts = new Map();
  for (const file of targets) {
    const result = bumpFile(file, { shell, lawyer, lawyerTag, suite, suitePlatforms, lawyerPlatforms });
    const short = file.replace('/Users/mac/', '');
    if (result.skipped) {
      console.log(`  ⚠️ ${short} — ${result.skipped}`);
      continue;
    }
    finalTexts.set(file, result.text);
    if (result.applied.length === 0) {
      console.log(`  · ${short} — 无需改动`);
      continue;
    }
    totalChanged += result.applied.length;
    console.log(`  ✅ ${short} — ${result.applied.join('、')}`);
    if (!dryRun) fs.writeFileSync(file, result.text);
  }

  // 断言：改完不该再有旧版本号残留（只检查我们管的这几类，不误报 MOBILE_VERSION）
  // ⚠️ 必须检查**替换后的文本**：dry-run 时不写盘，若去读磁盘文件会把"将要被改掉的
  // 旧版本号"误报成残留。
  console.log('');
  let stale = 0;
  for (const [file, text] of finalTexts) {
    const bad = [
      ...new Set(
        (text.match(/DeepWhale-(Desktop|Lawyer|Suite)-\d+\.\d+\.\d+/g) ?? []).filter(
          (m) =>
            !m.startsWith(`DeepWhale-Desktop-${shell}`) &&
            !m.startsWith(`DeepWhale-Lawyer-${lawyer}`) &&
            !m.startsWith(`DeepWhale-Suite-${suite}`),
        ),
      ),
    ];
    if (bad.length > 0) {
      stale += bad.length;
      console.log(`  ❌ ${file.replace('/Users/mac/', '')} 仍有旧版本引用：${bad.join('、')}`);
    }
  }
  console.log(
    stale === 0
      ? '  ✅ 无旧版本号残留'
      : `  ⚠️ 共 ${stale} 处旧版本引用残留（可能是刻意保留的历史版本，请人工确认）`,
  );

  // ── 断言：主站下载数据里不得有硬编码的 ver 字面量 ──────────────────────
  //
  // 主站下载区由 assets/site.js 的 DOWNLOADS 数据渲染，徽章取自 `ver:` 字段。
  // 这个字段**必须写成常量**（DESKTOP_VERSION / MOBILE_VERSION / LAWYER_VERSION），
  // 常量由本脚本维护；写成字面量就没人维护 —— 文件名会随版本切换而更新、
  // 徽章却永远停在旧值，页面上出现「徽章 v0.1.0 / 链接 0.1.2」的自相矛盾。
  // 2026-09-27 实测踩到，所以在这里 fail-loud 卡住。
  const mainSiteJs = path.join(mainDir, 'assets', 'site.js');
  if (fs.existsSync(mainSiteJs)) {
    const jsText = fs.readFileSync(mainSiteJs, 'utf8');
    // 只查**下载分组**：它们形如 { titleZh:'…', …, ver:…, …, items:[…] }。
    // 不查应用列表（形如 { nameZh:'…', ver:'v1.1.0', links:[…] }）——
    // 那是各鸿蒙应用自己的版本号，与应用自身的发布节奏绑定，本来就该写死，
    // 跟着壳/律师端的发版周期走反而是错的。
    const groupVerLiterals = [];
    const groupRe = /titleZh:\s*'[^']+'[\s\S]{0,400}?ver:\s*'v\d+\.\d+\.\d+'/g;
    for (const hit of jsText.match(groupRe) ?? []) {
      groupVerLiterals.push(hit.match(/ver:\s*'v\d+\.\d+\.\d+'/)[0]);
    }
    const hardcoded = [...new Set(groupVerLiterals)];
    if (hardcoded.length > 0) {
      console.log('');
      console.log(`  ❌ assets/site.js 里有 ${hardcoded.length} 处**硬编码**的版本徽章：${hardcoded.join('、')}`);
      console.log('     徽章必须走常量（DESKTOP_VERSION / MOBILE_VERSION / LAWYER_VERSION），');
      console.log('     否则版本切换时文件名会更新、徽章却不会，页面自相矛盾。');
      process.exitCode = 1;
    } else {
      console.log('  ✅ 主站下载徽章全部走常量（无硬编码版本字面量）');
    }
  }

  console.log('');
  console.log('提醒：以下两项**不由本脚本处理**，发版前请人工确认：');
  console.log('  · 主站改完要跑 deploy.sh 部署，并按红线五做线上复查');
  console.log('  · 页面引用的产物必须**已经真实存在**（GitHub release 或官网 /downloads/），');
  console.log('    否则推上去就是 404 —— 上线前请对每个链接做一次 HEAD 检查');
  if (dryRun) console.log('\n（dry-run 结束，未写盘）');
  else console.log(`\n完成：共 ${totalChanged} 处规则命中`);
}

try {
  main();
} catch (error) {
  console.error('[bump] failed:', error.message);
  process.exit(1);
}
