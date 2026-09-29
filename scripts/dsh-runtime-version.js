#!/usr/bin/env node
/**
 * 随包 DSH 运行时版本 —— 全仓唯一出处。
 *
 * 为什么要有这个文件（2026-09-29）：
 *   在这之前，`0.1.7-rc.2` 这个串同时躺在至少三个地方：
 *     · .github/workflows/release.yml 的 `npm install "@deepseek-ai/dsh@0.1.7-rc.2"`
 *     · src/main/store.ts 的默认命令 `npx @deepseek-ai/dsh@0.1.7-rc.2 web …`
 *     · scripts/check-upstream-dsh.py 用来比对上游的「我们钉住的版本」
 *   结果是每次升级都要手抄三遍，抄漏一处就会出现「CI 装的是一版、开发机兜底命令是另一版」
 *   这种极难查的分裂。现在版本只写在 `dsh-runtime.version`（一行），其余全部从这里读。
 *
 * 用法：
 *   node scripts/dsh-runtime-version.js              打印版本号
 *   node scripts/dsh-runtime-version.js --generate   生成 src/main/dsh-version.generated.ts（构建前跑）
 *   node scripts/dsh-runtime-version.js --check      校验 dsh-runtime/ 里实际装的是不是这个版本
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'dsh-runtime.version');
const GENERATED = path.join(ROOT, 'src', 'main', 'dsh-version.generated.ts');
const INSTALLED = path.join(
  ROOT,
  'dsh-runtime',
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'package.json',
);

/** 读 `dsh-runtime.version`，顺带挡住格式错误（多行/带引号/带 v 前缀最容易被手滑写进去）。 */
function readVersion() {
  if (!fs.existsSync(VERSION_FILE)) {
    throw new Error(`找不到 ${VERSION_FILE}`);
  }
  const raw = fs.readFileSync(VERSION_FILE, 'utf8');
  const version = raw.trim();
  if (!version) throw new Error('dsh-runtime.version 是空的');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(
      `dsh-runtime.version 里的 ${JSON.stringify(version)} 不像一个版本号（要形如 0.2.0-rc.2，不要带 v 前缀）`,
    );
  }
  return version;
}

function generate() {
  const version = readVersion();
  const body = `/**
 * 本文件由 scripts/dsh-runtime-version.js 生成，请勿手改。
 * 唯一出处：仓库根目录的 dsh-runtime.version
 */
export const DSH_RUNTIME_VERSION = '${version}';
`;
  fs.mkdirSync(path.dirname(GENERATED), { recursive: true });
  const previous = fs.existsSync(GENERATED) ? fs.readFileSync(GENERATED, 'utf8') : null;
  if (previous === body) return version;
  fs.writeFileSync(GENERATED, body, 'utf8');
  return version;
}

function check() {
  const wanted = readVersion();
  if (!fs.existsSync(INSTALLED)) {
    console.error(
      `✗ dsh-runtime/ 里没有装 @deepseek-ai/dsh（缺 ${INSTALLED}）—— 先跑 npm install "@deepseek-ai/dsh@${wanted}" --prefix dsh-runtime`,
    );
    process.exit(1);
  }
  const actual = JSON.parse(fs.readFileSync(INSTALLED, 'utf8')).version;
  if (actual !== wanted) {
    console.error(
      `✗ 随包运行时版本对不上：dsh-runtime.version 写的是 ${wanted}，dsh-runtime/ 里实际装的是 ${actual}`,
    );
    process.exit(1);
  }
  console.log(`✓ 随包 DSH 运行时版本一致：${actual}`);
}

const mode = process.argv[2];
if (mode === '--generate') {
  console.log(generate());
} else if (mode === '--check') {
  check();
} else if (mode === undefined || mode === '--print') {
  console.log(readVersion());
} else {
  console.error(`未知参数 ${mode}（可用：--print / --generate / --check）`);
  process.exit(2);
}
