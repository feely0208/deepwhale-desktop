#!/usr/bin/env node
/**
 * 离线守卫：更新必须"能被用户停下"（2026-10-14 用户实测回归）
 *
 * 事故（Win 1.0.54 → 1.0.55，用户口述）：
 *   打开就自动拉新版，弹窗里点了「取消」→ 窗口关了，主界面进度条**继续走**，下载没停。
 * 根因（代码事实）：Win/Linux 走 `autoUpdater.autoDownload = true` —— 下载由 electron-updater
 *   自己在后台做，**第三方没有取消接口**；`downloadToken` 那个字段只声明、从未接线，
 *   弹窗的 ✕ 与「稍后」都只 `closeUpdatePopup()`。用户原话：「很多人是不想更新的」。
 *
 * ⚠️ 这道守卫是**静态检查**（读源码文本）。它保证不了 electron-updater 的运行时行为 ——
 *    真实下载/取消只能在装好的应用里验（见清单里的"更新流程专项"）。
 *    它能保证的是：**这套接线不会被谁在下次重构里悄悄拆掉**（那正是这次事故的形状）。
 *
 * 接线必须同时具备：
 *   ① 自动下载关掉（autoDownload = false）—— 否则取消接口根本不存在
 *   ② 下载走带令牌的 downloadUpdate(token)，并且有 token.cancel() 的路径
 *   ③ 用户取消不能被打成"更新失败"（error 事件要认 cancelRequested）
 *   ④ 弹窗 HTML 有三个动作按钮：现在更新 / 停止更新 / 这个版本不再提醒
 *   ⑤ 渲染层会发 download / stop / skip 三个动作
 *   ⑥ 主进程侧处理这三个动作，并接到 UpdateManager 的对应方法
 *   ⑦ "这个版本不再提醒"是**持久化**的（重启后仍然不打扰）
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf-8');

const problems = [];
const need = (src, re, label, file) => {
  if (!re.test(src)) problems.push(`${file} 里找不到：${label}`);
};

const mgr = read('src/main/update-manager.ts');
const index = read('src/main/index.ts');
const popupTs = read('src/main/update-popup.ts');
const popupHtml = read('src/update-popup/update-popup.html');
const popupJs = read('src/update-popup/update-popup.js');

// ①
need(mgr, /autoUpdater\.autoDownload\s*=\s*false/, 'autoUpdater.autoDownload = false（关掉后台自动下载）', 'update-manager.ts');
// ②
need(mgr, /downloadUpdate\s*\(\s*this\.downloadToken\s*\)/, 'downloadUpdate(this.downloadToken)（带令牌下载）', 'update-manager.ts');
need(mgr, /token\?\.cancel\(\)|downloadToken\.cancel\(\)/, 'token.cancel()（真正中断下载）', 'update-manager.ts');
// ③
need(mgr, /cancelRequested/, 'cancelRequested（把"用户取消"与"真失败"分开）', 'update-manager.ts');
// ④
for (const id of ['btn-update', 'btn-stop', 'btn-skip']) {
  need(popupHtml, new RegExp(`id="${id}"`), `按钮 ${id}`, 'update-popup.html');
}
// ⑤
for (const act of ["send('download')", "send('stop')", "send('skip')"]) {
  need(popupJs, new RegExp(act.replace(/[()']/g, (c) => '\\' + c)), `渲染层发送 ${act}`, 'update-popup.js');
}
// ⑥
for (const act of ['download', 'stop', 'skip']) {
  need(popupTs, new RegExp(`action === '${act}'`), `主进程处理动作 ${act}`, 'update-popup.ts');
}
for (const hook of ['onDownloadNow', 'onStopDownload', 'onSkipVersion']) {
  need(popupTs, new RegExp(`${hook}\\?`), `弹窗動作接口声明 ${hook}`, 'update-popup.ts');
  need(index, new RegExp(`${hook}:`), `index.ts 接线 ${hook}`, 'index.ts');
}
// ⑥b 三个动作必须真的调到 UpdateManager 的方法
need(index, /updates\?\.downloadNow\(\)/, 'index.ts 调 updates.downloadNow()', 'index.ts');
need(index, /updates\?\.stopDownload\(\)/, 'index.ts 调 updates.stopDownload()', 'index.ts');
need(index, /updates\?\.skipVersion\(\)/, 'index.ts 调 updates.skipVersion()', 'index.ts');
// ⑦
need(mgr, /persistSkippedVersion/, '"不再提醒"落盘', 'update-manager.ts');
need(mgr, /loadSkippedVersion/, '启动时读回跳过记录', 'update-manager.ts');
// 发现新版本要弹窗（否则用户根本看不到"现在更新"按钮）
need(index, /onUpdateAvailable:/, 'index.ts 接线 onUpdateAvailable（发现新版就弹窗）', 'index.ts');

if (problems.length) {
  console.error('❌ 更新取消接线守卫失败：\n');
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}\n`));
  console.error('  提示：这套接线是 2026-10-14「点取消却继续下载」事故的修复，缺一不可；');
  console.error('        真实下载/取消行为只能在装好的应用里验（见待更新清单 §3 更新流程专项）。');
  process.exitCode = 1;
} else {
  console.log('✅ 更新取消接线守卫通过（关自动下载 · 令牌下载可取消 · 取消不算失败 · 三个动作按钮与接线齐全 · 跳过会落盘）');
}
