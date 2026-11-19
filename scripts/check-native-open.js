#!/usr/bin/env node
/**
 * 守卫：原生「在文件管理器中显示 / 打开方式」必须真的被打开（2026-11-19）
 *
 * 背景：Windows 用户点「显示文件位置」→「无法显示文件位置，请重试」。
 * Web 部署默认 `nativeOpen=false`，DSH 的 `canOpenWorkspacePath()` 就返回 false → 界面直接报错。
 * 壳靠往 `<home>/cordis.patch.yml` 写一行 `nativeOpen: true` 打开它；这条守卫保证：
 *   ① 写入幂等（重复调用不追加重复行）
 *   ② 行内容含 nativeOpen: true
 *   ③ 已有用户 patch 时是**追加**，不覆盖别的内容
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureNativeOpen } = require('../dist/main/native-open.js');

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log('  ✅ ' + msg); else { console.log('  ❌ ' + msg); failed += 1; } };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'native-open-'));
const patch = path.join(home, 'cordis.patch.yml');

// ① 空目录：写入
const r1 = ensureNativeOpen(home);
ok(r1.changed === true, '首次写入返回 changed=true');
const t1 = fs.readFileSync(patch, 'utf-8');
ok(/nativeOpen:\s*true/.test(t1), '文件里有 nativeOpen: true');

// ② 幂等
const r2 = ensureNativeOpen(home);
ok(r2.changed === false, '第二次调用不重复写入');
const t2 = fs.readFileSync(patch, 'utf-8');
ok(t2 === t1, '文件内容不变');

// ③ 不覆盖别人的内容
const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'native-open2-'));
const patch2 = path.join(home2, 'cordis.patch.yml');
fs.writeFileSync(patch2, '# 用户自己的 patch\n- id: other\n  name: other-plugin\n', 'utf-8');
ensureNativeOpen(home2);
const t3 = fs.readFileSync(patch2, 'utf-8');
ok(t3.includes('用户自己的 patch') && t3.includes('other-plugin'), '保留用户原有内容');
ok(/nativeOpen:\s*true/.test(t3), '并在其后追加 nativeOpen 行');

console.log(failed === 0 ? '\n✅ 原生打开守卫通过（写入幂等 · 不覆盖用户内容）' : `\n❌ 原生打开守卫失败：${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
