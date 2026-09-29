#!/usr/bin/env node
/**
 * 断言律师端的实名核验**没有被任何"开发者后门"旁路**。
 *
 * ── 为什么必须有（2026-09-29，用户在自己机器上踩到）──────────────────
 * `lawyer/workbench/js/workbench.js` 里曾经有一段「开发者特权」：
 * 姓名填 `feely` 或 `张冬宝`、证号是**任意** 17 位数字，就**直接登录进工作台，
 * 完全跳过运营后台核验**。注释当时写着"release 构建由开关关闭" ——
 * 但**仓库里根本没有那个开关**，构建流程不做任何替换，
 * 于是后门就这么进了正式包（已实测确认存在于 0.1.3 的成品包内）。
 *
 * 两个后果都很糟：
 *   ① 任何人在姓名栏填这两个名字 + 任意 17 位数字即可免核验使用；
 *   ② **正常测试路径被废掉** —— 点"提交审核"根本没走后台，运营侧收不到申请。
 *      用户实测：客户端"直接进了工作台"，而服务器上一条记录都没有。
 *
 * 这条守卫扫源码；发布流程在打包前调用它，命中即拒绝出包。
 *
 * 用法：node scripts/check-lawyer-verify-gate.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'lawyer', 'workbench', 'js', 'workbench.js');

/** 命中即失败的特征。注释里提到这些名字是允许的 —— 所以只查"代码形态"。 */
const FORBIDDEN = [
  { re: /\bfunction\s+isDevAuth\s*\(/, why: '开发者免核验后门函数 isDevAuth' },
  { re: /\bfunction\s+isDevAuthorizer\s*\(/, why: '开发者授权旁路函数 isDevAuthorizer' },
  { re: /\bisDevAuth\s*\(/, why: '仍在调用 isDevAuth' },
  { re: /\bisDevAuthorizer\s*\(/, why: '仍在调用 isDevAuthorizer' },
  { re: /开发者特权登录/, why: '「开发者特权登录」提示文案（旁路分支的产物）' },
  { re: /name\s*!==\s*["']feely["']\s*&&\s*name\s*!==\s*["']张冬宝["']/, why: '按姓名放行的判断' },
];

/** 必须存在的特征：核验必须真的提交到后台。 */
const REQUIRED = [
  { re: /__lawyerSubmit/, why: '提交到运营后台的入口 __lawyerSubmit' },
  { re: /startLawyerPoll\s*\(/, why: '核验结果轮询 startLawyerPoll' },
  { re: /function\s+verifyLawyerIdentity\s*\(/, why: '格式校验函数 verifyLawyerIdentity' },
];

if (!fs.existsSync(FILE)) {
  console.error(`\n❌ 找不到 ${FILE}\n`);
  process.exit(1);
}

const src = fs.readFileSync(FILE, 'utf8');
// ⚠️ **不要**去掉注释再查。第一版写了个「去注释」正则，结果它把代码里带 `//`
//    的行也截断了（URL、字符串里的 //），于是连 __lawyerSubmit 都"找不到"，
//    正常源码被误判成失败。而这些特征本来就是代码形态的
//    （`function isDevAuth(`、`开发者特权登录`），注释里正常提到名字不会命中。
const code = src;

const problems = [];
for (const { re, why } of FORBIDDEN) {
  if (re.test(code)) problems.push(`出现${why}`);
}
for (const { re, why } of REQUIRED) {
  if (!re.test(code)) problems.push(`缺少${why} —— 核验链路可能被改断了`);
}

console.log('== 律师端实名核验 · 后门检查 ==');
console.log(`  文件：lawyer/workbench/js/workbench.js（${src.length} 字节）`);

if (problems.length > 0) {
  console.error('\n❌ 未通过：');
  for (const p of problems) console.error('   ' + p);
  console.error(
    '\n   免核验的旁路会让「提交 → 后台审核 → 通过后进工作台」这条链路失效：' +
    '\n   用户点提交根本没走后台，运营侧收不到申请，而客户端直接放行。' +
    '\n   要方便测试请走运营后台正常审核 —— 那才是用户走的路。\n',
  );
  process.exit(1);
}

console.log('  ✅ 无免核验旁路，且提交流程完整（提交 + 轮询 + 格式校验都在）');
