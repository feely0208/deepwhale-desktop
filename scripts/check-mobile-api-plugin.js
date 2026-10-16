#!/usr/bin/env node
/**
 * 守卫：手机端接口层插件（shell-mobile）必须"三处俱全"
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独立一条：
 *   本仓库踩过两次同类坑 —— 「插件写了、但没进随包清单/构建脚本」→ 用户装到的包里
 *   根本没有它（1.0.56 的视频预览就是这么丢的）。手机端接口层是整条链路的第二段
 *   （第一段是网关），丢一段整条就断了，所以拿断言钉住：
 *     ① 插件源码存在，且声明了 `name` / `inject` / `apply`；
 *     ② **只监听回环地址**（安全闸）—— 断言 isLoopback 检查存在；
 *     ③ 路由前缀存在且注册用 `ctx.webServer.register`；
 *     ④ 随包清单（src/main/bundled-plugins.ts）里有它；
 *     ⑤ 构建脚本（scripts/build-bundled-plugins.js）里有拷贝段 —— ④⑤ 必须同进同出。
 *
 * 用法：node scripts/check-mobile-api-plugin.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const PLUGIN = path.join(REPO, 'shell-plugins', 'dsh-shell-mobile', 'lib', 'index.js');
const PKG = path.join(REPO, 'shell-plugins', 'dsh-shell-mobile', 'package.json');
const LIST = path.join(REPO, 'src', 'main', 'bundled-plugins.ts');
const BUILD = path.join(REPO, 'scripts', 'build-bundled-plugins.js');

const problems = [];
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '');
const src = read(PLUGIN);
const pkg = read(PKG);

if (src === '') problems.push('缺少 shell-plugins/dsh-shell-mobile/lib/index.js');
if (!/export const name = 'shell-mobile'/.test(src)) problems.push('插件没声明 name = shell-mobile');
if (!/export const inject = \[/.test(src)) problems.push('插件没声明 inject（拿不到 DSH 服务）');
if (!/export function apply\(/.test(src)) problems.push('插件没导出 apply(ctx)');
if (!/ctx\.webServer\.register\(/.test(src)) problems.push('插件没有用 ctx.webServer.register 注册路由');
if (!/isLoopback|127\.0\.0\.1/.test(src)) problems.push('插件缺少"只允许回环地址"的安全检查');
if (!/const ROUTE = '\/mobile\/api'/.test(src)) problems.push('插件没定义 /mobile/api 路由前缀');
if (!/"name": "@deepwhale-cn\/dsh-shell-mobile"/.test(pkg)) problems.push('package.json 的 name 不对（bundle patch 要靠它解析）');

const list = read(LIST);
if (!/dsh-shell-mobile/.test(list)) {
  problems.push('随包清单 src/main/bundled-plugins.ts 里没有它 → 用户装到的包里没有这个插件');
}
const build = read(BUILD);
// ⚠️ 必须匹配**真正的拷贝调用**（`fs.cpSync(…, 'dsh-shell-mobile')`）——
//    第一版只查 "dsh-shell-mobile" 这个字符串，结果注释里也有它 → 摘掉拷贝行仍然全绿（假绿，实测）。
if (!/fs\.cpSync\([^)]*'dsh-shell-mobile'[^)]*\)/.test(build)) {
  problems.push('构建脚本里没有**真正的拷贝调用** fs.cpSync(..., \'dsh-shell-mobile\') → 声明了但载荷里没有');
}

if (problems.length) {
  console.error('❌ 手机端接口层插件守卫失败：\n');
  problems.forEach((p, i) => console.error(`   ${i + 1}. ${p}`));
  process.exitCode = 1;
} else {
  console.log('✅ 手机端接口层插件齐备（源码 + 回环闸 + 路由 + 随包清单 + 构建拷贝）');
}
