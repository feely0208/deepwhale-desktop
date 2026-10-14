#!/usr/bin/env node
/**
 * 离线守卫：故障日志要"能当证据用"（2026-10-14 用户日志复盘后加）
 *
 * 那份 Windows 用户送来的 fault.log 暴露了三件事：
 *   ① **带着用户的凭据**：`dsh web: http://127.0.0.1:3095/?token=…` 与 `prefill_token=…`
 *      直接落在要给开发者看的日志里 —— 用户发日志 = 发本机凭据。
 *   ② **没有版本/平台/安装目录**：日志跨了 18 天、还跨了一次安装目录变更
 *      （Program Files (x86) → AppData\Local），只能靠堆栈反推是哪个版本。
 *   ③ **噪音淹没信号**：5 条 unhandledRejection 全是 ERR_ABORTED（导航被抢占），
 *      那是正常的，却被当成"故障"记下来。
 *
 * 本脚本断言这三件事都修好了（纯函数，不需要 Electron 运行时）。
 */
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist', 'main', 'crash-guard.js');
if (!fs.existsSync(dist)) {
  console.error('❌ 找不到编译产物 dist/main/crash-guard.js —— 请先 npm run build');
  process.exit(1);
}
const { redactSecrets, formatEntry, isBenignNavigationAbort, appendCrashLog } = require(dist);

const problems = [];
const check = (name, ok, detail) => {
  if (!ok) problems.push(`${name}${detail ? `（${detail}）` : ''}`);
};

// ── ① 凭据打码（用用户日志里真实出现过的那种行）──
const rawDetail = [
  "Error: ERR_ABORTED (-3) loading 'http://127.0.0.1:3095/?token=-XmqdIzlY6fM2NwqSYxm_oUZ4AnWE9m1bYw_cInkceE'",
  'dsh web: http://127.0.0.1:3095/?token=lzhWxG3uN7xuLuZKGNffPMKh7JJjjqPlwNr9Gh6OBJA (LAN: http://192.168.1.24:3095/?token=lzhWxG3uN7xuLuZKGNffPMKh7JJjjqPlwNr9Gh6OBJA)',
  "contactFormUrl: 'https://deepwhale.org.cn/feedback.html?prefill_token=7c947fd39d9619522abca25d15a296b44cc96896c1ea6d20037e95fff2183056'",
].join('\n');
const redacted = redactSecrets(rawDetail);
check('原始样本里确实有 token（否则这测试没意义）', /token=lzhWxG3u/.test(rawDetail));
check('长 token 已被打码', !/token=lzhWxG3uN7xuLuZKGNffPMKh7JJjjqPlwNr9Gh6OBJA/.test(redacted));
check('短 token 已被打码', !/token=-XmqdIzlY6fM2NwqSYxm/.test(redacted));
check('prefill_token 已被打码', !/prefill_token=7c947fd3/.test(redacted));
check('打码后仍保留 token= 这个线索（便于看懂上下文）', /token=<已打码>/.test(redacted));
check('非凭据内容不受影响（URL 主机与端口还在）', /127\.0\.0\.1:3095/.test(redacted));

// ── ② 每条日志都带运行环境事实 ──
const entry = formatEntry({
  kind: 'dsh-start-failed',
  summary: 'DSH 服务启动失败',
  detail: rawDetail,
  at: '2026-10-14T11:04:08.566Z',
});
check('带版本行', /版本：\S+/.test(entry), entry.split('\n')[4]);
check('带平台行', /平台：\S+\s+\S+/.test(entry));
check('带安装目录行', /安装目录：/.test(entry));
check('写入日志的详情也已打码', !/token=lzhWxG3u/.test(entry));
check('保留了时间/类别/概要', /时间：2026-10-14T11:04:08\.566Z/.test(entry) && /类别：dsh-start-failed/.test(entry));

// ── ③ 导航中止不算故障（用户日志里那 5 条的形状）──
const aborts = [
  new Error("(-3) loading 'http://127.0.0.1:3095/'"),
  new Error("ERR_ABORTED (-3) loading 'http://127.0.0.1:3095/?token=abc'"),
];
aborts.forEach((e, i) => check(`导航中止 #${i + 1} 被判为正常`, isBenignNavigationAbort(e) === true, e.message));
check('普通错误不会被误判成导航中止', isBenignNavigationAbort(new Error('等待 DSH Web UI 就绪超时')) === false);
check('空值/非 Error 不炸', isBenignNavigationAbort(undefined) === false && isBenignNavigationAbort('boom') === false);
check(
  'YAMLException 这类真故障仍应记账',
  isBenignNavigationAbort(new Error('YAMLException: null byte is not allowed in input (1:1)')) === false,
);

// ── ④ 写日志本身不能抛（非 Electron 环境下也要安全）──
let threw = false;
try {
  appendCrashLog({ kind: 'x', summary: 'y', detail: 'z', at: '2026-01-01T00:00:00.000Z' });
} catch {
  threw = true;
}
check('appendCrashLog 在拿不到 logs 目录时也不抛', !threw);

if (problems.length) {
  console.error('❌ 故障日志守卫失败：');
  problems.forEach((p) => console.error('  · ' + p));
  process.exitCode = 1;
} else {
  console.log('✅ 故障日志守卫通过（凭据打码 · 每条带版本/平台/安装目录 · 导航中止不记账）');
}
