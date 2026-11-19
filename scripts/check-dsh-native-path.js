#!/usr/bin/env node
/** 守卫：随包 DSH 的 explorer 目标必须是文件系统路径，不能是 file:// URL（Windows /select 只认路径）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh-native-command', 'lib', 'index.js');
if (!fs.existsSync(FILE)) {
  console.log('⚠️ 跳过：未安装随包运行时（打包流水线里会先装再打补丁）');
  process.exit(0);
}
const src = fs.readFileSync(FILE, 'utf-8');
const bad = /function explorerTarget\(windowsPath\)[\s\S]{0,200}?pathToFileURL/.test(src);
if (bad) {
  console.error('❌ explorerTarget 仍返回 file:// URL —— Windows「显示文件位置」会失败');
  process.exit(1);
}
console.log('✅ explorerTarget 已改为传文件系统路径');
