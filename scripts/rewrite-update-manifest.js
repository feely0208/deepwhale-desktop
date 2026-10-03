#!/usr/bin/env node
/* 重建 electron-updater 更新清单：让 sha512 / size 与**实际产物**一致。
 *
 * 为什么需要它（2026-10-03 实测）：
 *   律师端 macOS 构建在 `electron-builder` 之后还要用 `ditto` 把 zip 重新打一遍
 *   （往 zip 根目录塞「首次使用请双击我.command」）。zip 的字节数因此变了，
 *   但 electron-builder 生成的 `lawyer-latest-mac.yml` 仍是重打**之前**的哈希：
 *       清单写 144,407,164 / 139,359,377，实际 144,866,154 / 139,721,173
 *   → 用户自动更新能发现新版本、能下完，最后**校验失败**（报错还很难懂）。
 *   这个脚本按实际文件重算，重打完 zip 之后调用一次即可。
 *
 * mac 清单还多一件事：CI 的 arm64 / x64 是**两个 job**，各生成一份 latest-mac.yml，
 * 上传到同一个 Release 时后传的覆盖先传的 → 清单里只剩一个架构，
 * **Apple 芯片的用户会被推 x64 包**。`--ensure-both-arch` 会把目录里实际存在的
 * 另一个架构的 zip 补进清单（配合 --dir，publish 阶段两个 zip 都在手上）。
 *
 * 用法：
 *   node scripts/rewrite-update-manifest.js --manifest lawyer/dist/lawyer-latest-mac.yml --dir lawyer/dist
 *   node scripts/rewrite-update-manifest.js --manifest dist-assets/latest-mac.yml --dir dist-assets --ensure-both-arch
 *   （--dir 缺省取 manifest 所在目录；引用的文件找不到直接非 0 退出）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i].replace(/^--/, '');
    if (argv[i].startsWith('--')) {
      out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.manifest) {
  console.error('用法：node scripts/rewrite-update-manifest.js --manifest <yml> [--dir <产物目录>]');
  process.exit(2);
}
const manifestPath = path.resolve(args.manifest);
const dir = path.resolve(args.dir ?? path.dirname(manifestPath));
if (!fs.existsSync(manifestPath)) {
  console.error(`❌ 找不到清单：${manifestPath}`);
  process.exit(2);
}

let original = fs.readFileSync(manifestPath, 'utf-8');
const sha512 = (file) =>
  crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

// --ensure-both-arch：mac 清单里把目录中实际存在的另一架构 zip 补上
if (args['ensure-both-arch']) {
  const zips = fs.readdirSync(dir).filter((f) => /-(arm64|x64)\.zip$/.test(f));
  const inManifest = new Set([...original.matchAll(/- url: (\S+)/g)].map((m) => m[1]));
  const missingArch = zips.filter((f) => !inManifest.has(f));
  if (missingArch.length === 0) {
    console.log('  · 清单已包含目录里的全部架构 zip');
  } else {
    const entries = missingArch
      .map((f) => {
        const size = fs.statSync(path.join(dir, f)).size;
        const sha = sha512(path.join(dir, f));
        console.log(`  · 补入缺失架构：${f}  ${(size / 1048576).toFixed(1)}MB`);
        return `  - url: ${f}\n    sha512: ${sha}\n    size: ${size}`;
      })
      .join('\n');
    // 只在内存里改，等重算全部通过后再一次性落盘 —— 否则中途失败会留下半更新的清单
    // 注意：`(?:.*\n)*?` 消费完一行后位置在**行首**，所以 lookahead 不能写成 `(?=\n…)`
    //（那要求当前位置还是个换行符，永远匹配不上）。改成行首直接看顶层键。
    original = original.replace(/(\nfiles:\n(?:[^\n]*\n)*?)(?=[a-z]+:)/, (m0) => `${m0.trimEnd()}\n${entries}\n`);
    console.log('  · 已补入缺失架构（待重算后落盘）');
  }
}

let changed = 0;
let missing = 0;
// 逐个 files[] 条目：url / sha512 / size 三行一组
const updated = original.replace(
  /- url: (\S+)\n(\s+)sha512: \S+\n(\s+)size: \d+/g,
  (_m, url, ind1, ind2) => {
    const file = path.join(dir, url);
    if (!fs.existsSync(file)) {
      console.error(`  ❌ 清单引用的文件不存在：${file}`);
      missing += 1;
      return `- url: ${url}\n${ind1}sha512: MISSING\n${ind2}size: 0`;
    }
    const size = fs.statSync(file).size;
    const sha = sha512(file);
    changed += 1;
    console.log(`  · ${url}  ${(size / 1048576).toFixed(1)}MB`);
    return `- url: ${url}\n${ind1}sha512: ${sha}\n${ind2}size: ${size}`;
  },
);

// 顶层 path / sha512 是"主文件"，指向某个 files[] 条目，一并更新
const pathMatch = updated.match(/^path: (\S+)$/m);
let finalText = updated;
if (pathMatch) {
  const main = pathMatch[1];
  const mainFile = path.join(dir, main);
  if (fs.existsSync(mainFile)) {
    const sha = sha512(mainFile);
    finalText = updated.replace(/^sha512: \S+$/m, `sha512: ${sha}`);
  }
}

if (missing > 0) {
  console.error(`\n❌ 有 ${missing} 个清单引用的文件缺失，清单未写入`);
  process.exit(1);
}
if (changed === 0) {
  console.log('清单里没有可更新的条目（格式变了？）');
  process.exit(1);
}

fs.writeFileSync(manifestPath, finalText, 'utf-8');
console.log(`✅ 已按实际产物重写 ${path.basename(manifestPath)}（${changed} 个文件条目）`);
