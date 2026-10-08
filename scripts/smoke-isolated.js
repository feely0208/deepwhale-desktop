#!/usr/bin/env node
/**
 * 隔离冒烟：不会碰你正在用的那个实例，也不会复用它的 DSH 服务。
 *
 * 为什么需要它（2026-10-08 实测踩坑）：
 *   直接跑 `DSH_DESKTOP_SMOKE=1 electron .` 会**复用**用户正在跑的服务 ——
 *   因为 dshPortAnswered() 探的是 `127.0.0.1:<settings.port>`，而新 userData 里没存过
 *   端口、落到默认 3095，正好是用户那个。复用时壳会跳过注入写盘（避免与运行中的 DSH
 *   抢配置），于是页面里缺东西，冒烟报出一串**假红**：
 *     页面 45 秒未稳定 / 侧栏进度条没被注入 / 进度条没隐藏 / 动效检查抛异常
 *   在 DSH 桌面端的 shell 里跑还有第二层坑：`ELECTRON_RUN_AS_NODE=1` 会让 Electron
 *   退化成普通 Node（require('electron') 拿不到 app，启动即崩），
 *   而 `DSH_WEB_URL/DSH_HOME/DSH_PROFILE*` 又会把子进程引回用户的 profile。
 *
 * 做法：三样都隔离 —— userData 目录、DSH_HOME、**端口**（预置进 settings.json）。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAMP = Date.now();
const USER_DATA = '/tmp/dw-smoke-ud-' + STAMP;
const DSH_HOME = '/tmp/dw-smoke-home-' + STAMP;
const PORT = 3199;   // 刻意避开默认的 3095（用户实例通常在那儿）

fs.mkdirSync(USER_DATA, { recursive: true });
fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify({ port: PORT }));

const env = Object.assign({}, process.env);
for (const k of ['ELECTRON_RUN_AS_NODE', 'DSH_WEB_URL', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_PROFILE_DIR']) delete env[k];
env.DSH_HOME = DSH_HOME;
env.DSH_PROFILE = 'deepwhale';
env.DSH_DESKTOP_SMOKE = '1';

console.log(`[smoke-isolated] userData=${USER_DATA}`);
console.log(`[smoke-isolated] DSH_HOME=${DSH_HOME}  端口=${PORT}（避开默认 3095）`);
const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'electron'),
  ['.', '--user-data-dir=' + USER_DATA], { cwd: ROOT, stdio: 'inherit', env });
child.on('exit', (code) => {
  console.log(`[smoke-isolated] 冒烟退出码 ${code}（0 = 全绿）`);
  process.exit(code === null ? 1 : code);
});
