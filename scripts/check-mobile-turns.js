#!/usr/bin/env node
/**
 * 守卫：助手回复必须能从投影缓存里取出来（手机端聊天页的核心数据源）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 背景（2026-10-18 用户真机实测）：手机端只能看到自己说的话 ✗。
 * 根因：DSH 的 deriveMessages() 只有输入侧（allRoles 里没有 assistant），
 * 助手回复在投影缓存的 record.rows.turnOutline.val.turns[] 里。
 *
 * ⚠️ 这条守卫**必须 import 插件的真实代码**（ESM）：
 *    第一版我只测了"等价逻辑"，结果真代码里写了 require()（ESM 里直接抛错、被
 *    catch 吞掉 → 永远返回空），真机复现才发现 —— 测等价逻辑 = 假绿。
 * 用法：node scripts/check-mobile-turns.js
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-turns-'));
  const sid = 'session-test-turns';
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  // 夹具：真实文件的结构（record.rows.turnOutline.val.turns）——取自用户机器上的真实文件
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({
    version: 1,
    record: {
      identity: { id: sid },
      rows: {
        turnOutline: {
          val: {
            turns: [
              { turn: 1, seq: 4, prompt: '第一个问题', response: '第一个回答' },
              { turn: 2, seq: 333, prompt: '第二个问题', response: '第二个回答' },
            ],
          },
        },
      },
    },
  }), 'utf8');

  const pluginUrl =
    'file://' + path.join(__dirname, '..', 'shell-plugins', 'dsh-shell-mobile', 'lib', 'index.js');
  const problems = [];
  let plugin = null;
  try {
    plugin = await import(pluginUrl);
  } catch (e) {
    problems.push(`导入插件失败：${e?.message ?? e}`);
  }

  if (plugin) {
    if (typeof plugin.apply !== 'function') problems.push('插件没有导出 apply（导出形状变了？）');
    if (typeof plugin.readProjectionTurns !== 'function') {
      problems.push('插件没有导出 readProjectionTurns（守卫测不到真代码）');
    } else {
      const turns = plugin.readProjectionTurns(sid, home);
      if (!Array.isArray(turns) || turns.length !== 2) {
        problems.push(`应读出 2 轮，实际 ${Array.isArray(turns) ? turns.length : '非数组'}`);
      } else {
        if (turns[0].prompt !== '第一个问题' || turns[0].response !== '第一个回答') {
          problems.push('第 1 轮 prompt/response 不对');
        }
        if (turns[1].turn !== 2) problems.push('第 2 轮 turn 编号不对');
      }
      // 不存在的 id 必须安全返回空数组（不能抛）
      if (plugin.readProjectionTurns('session-not-exist', home).length !== 0) {
        problems.push('不存在的会话应返回空数组');
      }
    }
  }

  if (problems.length) {
    console.error('❌ 助手回复提取守卫失败：\n');
    problems.forEach((x, i) => console.error(`   ${i + 1}. ${x}`));
    process.exitCode = 1;
  } else {
    console.log('✅ 助手回复提取正确（插件真实代码从投影缓存读出 2 轮 prompt+response）');
  }
})().catch((e) => {
  console.error('❌ 守卫自身异常：', e?.message ?? e);
  process.exitCode = 1;
});
