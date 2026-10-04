#!/usr/bin/env node
/**
 * 安装器配置守卫（2026-10-04）
 *
 * 为什么需要它：Windows 自动更新把用户安装搞没的那次事故，
 * 病根（oneClick:false + allowToChangeInstallationDirectory:true）**在待办里记了但没人拦**，
 * 结果自愈逻辑（依赖应用能启动）在下一次更严重的事故里完全失效。
 * 这个脚本把"不能再这样配"变成 CI 里会红的断言 —— 靠人记，靠不住。
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const file = path.join(__dirname, '..', 'electron-builder.yml');
const conf = yaml.load(fs.readFileSync(file, 'utf-8'));

/** appId 一旦定下就不能再改：NSIS 用它拼注册表键记安装目录，改了 = 丢掉老用户的安装目录记忆 */
const FROZEN_APP_ID = 'com.deepwhale.desktop';

const problems = [];

if (conf.appId !== FROZEN_APP_ID) {
  problems.push(
    `appId 被改动：当前 ${conf.appId}，冻结值 ${FROZEN_APP_ID}\n` +
      '  → NSIS 用 appId 拼注册表键记录安装目录，改动会让老用户丢失安装位置、更新后目录漂移',
  );
}

const nsis = conf.nsis || {};
if (nsis.oneClick !== true) {
  problems.push(
    `nsis.oneClick = ${nsis.oneClick}（应为 true）\n` +
      '  → 非一键安装（带向导）与 electron-updater 的静默自动更新不兼容，' +
      '会把旧安装挪到 %TEMP%\\...\\old-install，%TEMP% 被清理后旧版本文件一并消失',
  );
}
if (nsis.allowToChangeInstallationDirectory === true) {
  problems.push(
    'nsis.allowToChangeInstallationDirectory = true\n' +
      '  → 允许改安装目录会让自动更新后的路径漂移，必须为 false（固定默认目录）',
  );
}
if (nsis.perMachine === true) {
  problems.push('nsis.perMachine = true → 每机器安装会引入权限/路径分支，Windows 自动更新场景下请保持 false');
}
if (nsis.deleteAppDataOnUninstall === true) {
  problems.push('nsis.deleteAppDataOnUninstall = true → 卸载会删用户数据（会话/密钥），必须为 false');
}

if (problems.length) {
  console.error('❌ 安装器配置不合规：\n');
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}\n`));
  process.exitCode = 1;
} else {
  console.log('✅ 安装器配置合规：appId 未变 · oneClick=true · 固定目录 · 不删用户数据');
}
