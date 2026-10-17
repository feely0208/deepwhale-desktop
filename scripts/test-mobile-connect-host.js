#!/usr/bin/env node
/**
 * 守卫：**「手机连接」写进 cordis.patch.yml 的 webserver 配置，永远不能出现通配地址**
 * （以及老用户遗留的 0.0.0.0 必须能被自动改写掉）。
 *
 * ── 为什么必须有这条（2026-10-17 发布级事故）──────────────────────────
 *   1.0.58 把随包运行时升到 DSH 0.2.1-rc.1，新版 `dsh-host-webserver`
 *   **拒绝 `host: 0.0.0.0`**：
 *     `host "0.0.0.0" is an unspecified (wildcard) address, which is not supported`
 *   而旧壳的 `bindingBlock()` 恰好写死了 0.0.0.0 → webserver 插件校验失败 →
 *   webServer 起不来 → web-runtime / shell-canvas / shell-mobile 等 8 个插件全在等它
 *   → DSH 进程 exit 1 → 壳弹「无法连接到 DSH 服务」。
 *   **所有 lanAccess=true 的升级用户升级即砖**，且点「重试」无效（每次启动都重写）。
 *
 *   当时的守卫全部是绿的 —— 因为它们都没覆盖「升级用户的旧配置」这条路径。
 *   本守卫就是补上那一条：既断言**新写入**不带通配地址，也断言**遗留配置能被迁移**。
 *
 * 判据（全部跑真实代码，不是读源码字符串）：
 *   ① bindingBlock() 生成的文本里没有 `host: 0.0.0.0`
 *   ② 老配置里的 `0.0.0.0` 被 sanitizeWebserverHost() 改写为 127.0.0.1
 *   ③ 其它配置块一行不动（不误伤 feedback / 别人的 insert）
 *   ④ 已经是 127.0.0.1 的文件不被重写（幂等）
 *
 * 用法：node scripts/test-mobile-connect-host.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const mod = require(path.join(REPO, 'dist', 'main', 'mobile-connect.js'));

const problems = [];
function check(ok, msg) {
  if (!ok) problems.push(msg);
  console.log(`  ${ok ? '✅' : '❌'} ${msg}`);
}

// ① bindingBlock 不能带通配地址
const block = mod.bindingBlock(3095, ['192.168.1.23']);
check(!/host:\s*0\.0\.0\.0/.test(block), 'bindingBlock() 不产出 host: 0.0.0.0');
check(/host:\s*127\.0\.0\.1/.test(block), 'bindingBlock() 产出 host: 127.0.0.1');

// ② 老配置能被迁移
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-host-'));
const file = path.join(dir, 'cordis.patch.yml');
const legacy = `# 头部注释
- insert:
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        port: 3095
        host: 0.0.0.0
        trustedHosts:
          - 192.168.1.23:3095

# ── 意见反馈 ──
- insert:
    - id: feedback
      config:
        url: https://deepwhale.org.cn/feedback.html
`;
fs.writeFileSync(file, legacy);
const changed = mod.sanitizeWebserverHost(dir);
const after = fs.readFileSync(file, 'utf8');
check(changed === true, '老配置被识别并改写（返回 true）');
check(!/host:\s*0\.0\.0\.0/.test(after), '改写后不再有 host: 0.0.0.0');
check(/host:\s*127\.0\.0\.1/.test(after), '改写后是 host: 127.0.0.1');
check(after.includes('id: feedback') && after.includes('deepwhale.org.cn/feedback.html'), '意见反馈那一块一行没动');
check(after.includes('trustedHosts:') && after.includes('192.168.1.23:3095'), 'trustedHosts 保留');

// ④ 幂等：已是 127.0.0.1 就不再写盘
const before2 = fs.readFileSync(file, 'utf8');
const changed2 = mod.sanitizeWebserverHost(dir);
check(changed2 === false && fs.readFileSync(file, 'utf8') === before2, '幂等：已修好的文件不重写');

// ⑤ 没有该文件时不抛
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-empty-'));
check(mod.sanitizeWebserverHost(emptyDir) === false, '没有 cordis.patch.yml 时不抛错');

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(emptyDir, { recursive: true, force: true });

if (problems.length) {
  console.error(`\n❌ 手机连接 webserver 配置守卫失败（${problems.length} 项）：`);
  problems.forEach((p, i) => console.error(`   ${i + 1}. ${p}`));
  process.exitCode = 1;
} else {
  console.log('\n✅ 通过：webserver 配置永不写通配地址，且老用户遗留能被自动迁移');
}
