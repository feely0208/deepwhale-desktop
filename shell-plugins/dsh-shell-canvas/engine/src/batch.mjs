/**
 * 批量生产 + 台账（Batch & Manifest）—— 框架第 ⑧ 层，也是**收费点**。
 *
 * 为什么这一层值钱（用户追问过"凭什么收费"）：
 *   单条片子在这个时代谁都能做，**免费工具也能做**。
 *   但"1000 条内容各异、风格统一、可复现、可追溯、出错能重跑"是**工程**，
 *   token 烧不出来 —— 它靠的是跑通上百个边界。
 *   所以框架里"批量 + 确定性"是**唯一能理直气壮收费**的部分：
 *     · 批量：队列、进度、失败隔离、断点重跑
 *     · 确定性：同输入同输出、每条留文档与产物哈希
 *     · 台账：谁、什么时候、用什么参数、出了什么 —— 可审计、可回放
 *
 * 这一版刻意做得小（够用即停）：串行跑、失败不中断、逐条记台账。
 * 并发/队列/重试策略是后面按需加的事，不在这里提前复杂化。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * 跑一批任务。
 * @param {object} plan
 *   { producer, quality?, jobs: [{ id, input }], domain? }
 * @param {object} deps
 *   { runProducer, runRender, outDir, log? }
 * @returns {Promise<object>} 台账 manifest
 */
export async function runBatch(plan, deps) {
  const { runProducer, runRender, outDir, log = () => {} } = deps;
  if (!plan || typeof plan !== 'object') throw new Error('batch 需要一个 plan 对象');
  if (!plan.producer) throw new Error('batch 缺 producer');
  const jobs = Array.isArray(plan.jobs) ? plan.jobs : [];
  if (!jobs.length) throw new Error('batch 里没有 jobs');

  const root = resolve(outDir || 'out/batch');
  mkdirSync(root, { recursive: true });
  const startedAt = new Date().toISOString();
  const items = [];

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i] || {};
    const id = String(job.id || `job-${i + 1}`);
    const t0 = Date.now();
    const item = { id, index: i, ok: false };
    try {
      // ① 内容 → 分镜（生产者）
      const doc = await runProducer(plan.producer, job.input || {});
      item.doc = doc;
      item.docSha256 = sha256(JSON.stringify(doc));
      log(`[${i + 1}/${jobs.length}] ${id} · 生产者 ok（模板 ${doc.template}）`);

      // ② 渲染出片
      if (runRender) {
        const r = await runRender(doc, { id, outDir: join(root, id), quality: plan.quality || 'final', domain: plan.domain });
        item.out = (r && r.outFile) || null;
        item.outSha256 = r && r.outFile && existsSync(r.outFile)
          ? sha256(readFileSync(r.outFile))
          : null;
        log(`[${i + 1}/${jobs.length}] ${id} · 出片 ${item.out || '(未返回产物)'}`);
      }
      item.ok = true;
    } catch (e) {
      // 失败隔离：一条挂了不拖垮整批，但**必须记在台账里**（不许吞）
      item.error = e && e.message ? e.message : String(e);
      log(`[${i + 1}/${jobs.length}] ${id} · ❌ ${item.error}`);
    }
    item.ms = Date.now() - t0;
    items.push(item);
  }

  const okCount = items.filter((x) => x.ok).length;
  const manifest = {
    version: 1,
    producer: plan.producer,
    quality: plan.quality || 'final',
    startedAt,
    endedAt: new Date().toISOString(),
    total: items.length,
    ok: okCount,
    failed: items.length - okCount,
    items,
  };
  const manifestFile = join(root, 'manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  log(`台账：${manifestFile}（成功 ${okCount}/${items.length}）`);
  return { manifest, manifestFile };
}
