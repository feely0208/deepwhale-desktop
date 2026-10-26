#!/usr/bin/env node
/**
 * client-manifest-items.py 的否定测试（2026-10-26）。
 *
 * 为什么要有：这条解析逻辑曾经写错（只取第一段 combo URL），把产品判成红 41 次、
 * 连续 16 天每天两封失败邮件，而真正的原因是"清单被切成多段"。判据必须能被否定：
 * 人造两份 HTML —— 法律模式在**第二段**（正确实现该说 YES）和**根本没有**（该说 NO）。
 *
 * 跑法：node scripts/test-client-manifest-items.js
 */
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = path.join(__dirname, 'client-manifest-items.py');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-items-test-'));

function run(html) {
  const file = path.join(tmp, `page-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(file, html);
  try {
    const out = execFileSync('python3', [PY, file], { encoding: 'utf8' });
    return { code: 0, out: out.trim() };
  } catch (error) {
    return { code: error.status ?? 1, out: String(error.stdout ?? '').trim() };
  }
}

// 一份客户端清单被切成两段：第一段里**没有**法律模式（正是线上真实形状）
const seg1 = 'plugins/??@deepseek-ai/dsh-client-ui-chat/client.js&rev=aaa,@deepseek-ai/dsh-client-ui-theme/client.js&rev=aaa"';
const seg2 = 'plugins/??@deepseek-ai/dsh-client-ui-legal-mode/client.js&rev=aaa,@deepseek-ai/dsh-client-ui-sidebar/client.js&rev=aaa"';
const multi = `<html><body><script src="/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=bbb"></script>
<script src="${seg1}"></script>
<script src="${seg2}"></script></body></html>`;

const cases = [
  {
    name: '多段清单：法律模式在第二段 → 必须 YES（旧实现只读第一段会误报 NO）',
    html: multi,
    want: (r) => {
      assert.strictEqual(r.code, 0, '应正常解析');
      // dsh-client-modules + 第一段 2 个 + 第二段 2 个 = 5
      assert.match(r.out, /^COUNT=5$/m, `去重后应为 5 个包，实际：${r.out}`);
      assert.match(r.out, /^LEGAL=YES$/m, `应判 YES，实际：${r.out}`);
    },
  },
  {
    name: '清单里确实没有法律模式 → 必须 NO（不能一律放行）',
    html: `<script src="${seg1}"></script>`,
    want: (r) => {
      assert.strictEqual(r.code, 0);
      assert.match(r.out, /^LEGAL=NO$/m, `应判 NO，实际：${r.out}`);
    },
  },
  {
    name: '页面里没有清单（鉴权页/空页）→ NO_MANIFEST 且非 0 退出',
    html: '<html><body>dsh web authentication required</body></html>',
    want: (r) => {
      assert.notStrictEqual(r.code, 0, '没有清单时不能返回成功');
      assert.strictEqual(r.out, 'NO_MANIFEST');
    },
  },
  {
    name: '同一段里重复的包只算一次（去重）',
    html: `<script src="${seg1}"></script><script src="${seg1}"></script>`,
    want: (r) => assert.match(r.out, /^COUNT=2$/m, `重复段应去重为 2，实际：${r.out}`),
  },
];

let failed = 0;
for (const c of cases) {
  try {
    c.want(run(c.html));
    console.log(`  ✅ ${c.name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ❌ ${c.name}\n     ${error.message}`);
  }
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // 清理失败不影响结论
}

if (failed > 0) {
  console.error(`\n❌ ${failed}/${cases.length} 个用例失败`);
  process.exit(1);
}
console.log(`\n✅ 全部通过（${cases.length} 个用例）`);
