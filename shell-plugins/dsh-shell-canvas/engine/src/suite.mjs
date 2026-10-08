/**
 * 测试套件：把 manifest 里的用例跑一遍，比对「期望 vs 实际」。
 * 被测对象是一个"只应拒绝非法输入"的校验器，所以：
 *   - 合法用例必须通过（证明没有误杀）
 *   - 每个非法用例必须命中期望的错误码（证明拦得住）
 *   - 每个用例跑两遍，报告必须逐字节一致（确定性，可作审计证据）
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, satisfiesEngineRange } from './registry.mjs';
import { validateDocument, ENGINE_VERSION } from './validate.mjs';
import { CASES, GENERATORS, REQUIRED_BAD_CODES } from '../tests/manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PACKS_ROOT = resolve(ROOT, 'packs');
const CASES_DIR = resolve(ROOT, 'tests/cases');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function runSuite() {
  const packs = loadRegistry(PACKS_ROOT);
  const pack = packs.get('video');
  if (!pack) throw new Error('没有加载到 video 领域包');

  // 领域包与引擎版本匹配（契约 5）
  pack.engineRangeCheck = satisfiesEngineRange(pack.domain.engineRange, ENGINE_VERSION);

  const results = [];
  for (const c of CASES) {
    let doc;
    let sourceText;
    if (c.generated) {
      doc = GENERATORS[c.generated]();
      sourceText = JSON.stringify(doc);
    } else {
      const file = resolve(CASES_DIR, c.file);
      sourceText = readFileSync(file, 'utf8');
      doc = JSON.parse(sourceText);
    }

    const first = validateDocument(doc, pack);
    const second = validateDocument(doc, pack);
    const deterministic = JSON.stringify(first) === JSON.stringify(second);

    const found = first.issues.map((i) => i.code);
    const missing = c.codes.filter((code) => !found.includes(code));
    const gotOk = first.ok;

    const pass =
      deterministic &&
      (c.expect === 'ok' ? gotOk && missing.length === 0 : !gotOk && missing.length === 0);

    results.push({
      name: c.name,
      expect: c.expect,
      expectedCodes: c.codes,
      why: c.why,
      ok: gotOk,
      errors: first.errors,
      warnings: first.warnings,
      foundCodes: [...new Set(found)].sort(),
      missingCodes: missing,
      deterministic,
      pass,
      issues: first.issues,
      sourceSha256: sha256(sourceText),
    });
  }

  // 覆盖度自检：8 个必测错误码必须各被至少一个用例命中
  const hit = new Set(results.filter((r) => r.expect === 'error').flatMap((r) => r.foundCodes));
  const uncovered = REQUIRED_BAD_CODES.filter((code) => !hit.has(code));

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    okCases: results.filter((r) => r.expect === 'ok').length,
    badCases: results.filter((r) => r.expect === 'error').length,
    allDeterministic: results.every((r) => r.deterministic),
    requiredCodesCovered: uncovered.length === 0,
    uncoveredRequiredCodes: uncovered,
    engineVersion: ENGINE_VERSION,
    packVersion: pack.domain.version,
  };
  summary.verdict = summary.failed === 0 && summary.requiredCodesCovered ? 'PASS' : 'FAIL';

  return { results, summary, pack };
}
