/**
 * MCP 服务（stdio）—— 框架第 8 面：让任何 AI 助手能直接调深鲸画布。
 *
 * 为什么这一面对我们特别合适（2026-10-09 定的判断）：
 *   我们的底座是「输入 → 文档 → 逐帧 → 成片」的**确定性管线**。
 *   AI 助手最擅长的就是"调工具"，最不擅长的恰恰是"保证一批次的一致性"。
 *   —— 我们补的正是它缺的那块。
 *
 * 位置（顺序不能颠倒，用户原话：前面没人用，MCP 有啥用）：
 *   ① 框架可用 → ② 有人在用 → ③ 暴露 MCP 放大 → ④ 生态
 *   本文件是第 ③ 步的实现，**不改变前两步的前提**。
 *
 * 启动方式（MCP 客户端标准做法）：
 *   command: node
 *   args:    ["<canvas>/cli/canvas.mjs", "mcp"]
 *
 * 协议：JSON-RPC 2.0 over stdio，一行一个消息（MCP 标准）。
 * 暴露的工具（不贪多，够用）：
 *   canvas_producers  列出生产者（内容 → 分镜）
 *   canvas_produce    内容 → 分镜文档（返回 template/vars/assets/notes）
 *   canvas_render     分镜 → 成片（可选；重活，默认落在临时目录）
 *   canvas_batch      批量 + 台账（返回 manifest 摘要）
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROTOCOL_VERSION = '2024-11-05';

/** 工具定义（JSON Schema，MCP 客户端据此生成表单） */
const TOOLS = [
  {
    name: 'canvas_producers',
    description: '列出可用的「内容 → 分镜」生产者（如 文案→分镜、文档→分镜、文案+AI生图→分镜）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'canvas_produce',
    description: '把内容交给某个生产者，得到「分镜文档」（template / vars / assets）。不渲染、很快。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['producer'],
      properties: {
        producer: { type: 'string', description: '生产者 id，如 text.storyboard' },
        text: { type: 'string', description: '文案或文档正文' },
        file: { type: 'string', description: '文档路径（与 text 二选一）' },
        title: { type: 'string' },
        orientation: { type: 'string', enum: ['vertical', 'horizontal'] },
        provider: { type: 'string', description: 'ai.shots 用的生图 provider id' },
        count: { type: 'number' },
      },
    },
  },
  {
    name: 'canvas_render',
    description: '把「分镜文档」渲染成视频（横竖双版之一）。重活：几分钟级。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['doc'],
      properties: {
        doc: { type: 'object', description: 'canvas_produce 的返回（含 template/vars/assets）' },
        quality: { type: 'string', enum: ['preview', 'final'] },
        outDir: { type: 'string', description: '产物目录（缺省落临时目录）' },
      },
    },
  },
  {
    name: 'canvas_batch',
    description: '批量生产并返回台账摘要（成功数/失败数/台账文件）。适合"一次出 N 条、风格统一、可追溯"。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['producer', 'jobs'],
      properties: {
        producer: { type: 'string' },
        jobs: { type: 'array', items: { type: 'object' }, description: '每项 { id, input }' },
        quality: { type: 'string', enum: ['preview', 'final'] },
        outDir: { type: 'string' },
      },
    },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });

/** 工具实现。ctx 由调用方（CLI）注入，避免这里直接依赖 CLI 的参数解析。 */
async function callTool(name, args, ctx) {
  const { runProducer, loadBuiltins, assertAssetAllowed } = await import('../producers/index.mjs');
  const { providerAccessor, loadProvidersFromConfig } = await import('../providers/index.mjs');
  await loadBuiltins();
  try { loadProvidersFromConfig(); } catch (e) { /* 没配置是正常情况 */ }

  const allowRoots = ctx.allowRoots || [];
  const assetDir = ctx.assetDir || '/tmp/canvas-assets';
  const producerCtx = {
    allowRoots,
    assertAsset: (f) => assertAssetAllowed(f, allowRoots),
    readText: (f) => readFileSync(resolve(f), 'utf8'),
    provider: providerAccessor(assetDir),
    assetDir,
    outDir: ctx.outDir || '/tmp/canvas-out',
  };

  if (name === 'canvas_producers') {
    const { listProducers } = await import('../producers/index.mjs');
    return text(listProducers().map((p) => `· ${p.id} —— ${p.title}（${p.describe}）`).join('\n'));
  }

  if (name === 'canvas_produce') {
    const doc = await runProducer(args.producer, args, producerCtx);
    return text(doc);
  }

  if (name === 'canvas_render') {
    const { renderTemplate } = await import('../render/index.mjs');
    const { loadRegistry, satisfiesEngineRange } = await import('../registry.mjs');
    const { ENGINE_VERSION } = await import('../validate.mjs');
    const doc = args.doc || {};
    const d = JSON.parse(readFileSync(resolve(ctx.templatesRoot || 'templates', `${doc.template}.json`), 'utf8'));
    const packs = loadRegistry(ctx.packsRoot);
    const pack = packs.get(d.domain) || null;
    if (pack) pack.engineRangeCheck = satisfiesEngineRange(pack.domain.engineRange, ENGINE_VERSION);
    const userSlots = {};
    for (const [k, v] of Object.entries(doc.assets || {})) userSlots[k] = Array.isArray(v) ? v[0] : v;
    const outDir = args.outDir || ctx.outDir || '/tmp/canvas-out';
    const r = await renderTemplate({
      doc: d, pack, outDir,
      quality: args.quality || 'preview',
      vars: doc.vars || {}, userSlots, resume: false,
    });
    return text({ outFile: r && r.outFile, width: r && r.width, height: r && r.height, frames: r && r.frameCount });
  }

  if (name === 'canvas_batch') {
    const { runBatch } = await import('../batch.mjs');
    const res = await runBatch(
      { producer: args.producer, quality: args.quality || 'preview', jobs: args.jobs || [] },
      {
        outDir: args.outDir || ctx.outDir || '/tmp/canvas-batch',
        runProducer: (id, input) => runProducer(id, input, producerCtx),
        log: (m) => console.error('[batch] ' + m),   // ⚠️ 日志走 stderr —— stdout 是 JSON-RPC 通道，写脏就废了
      },
    );
    const m = res.manifest;
    return text({ ok: m.ok, total: m.total, failed: m.failed, manifestFile: res.manifestFile,
      items: m.items.map((x) => ({ id: x.id, ok: x.ok, out: x.out, error: x.error })) });
  }

  throw new Error(`未知工具：${name}`);
}

/** 跑 stdio 服务。 */
export function serveStdio(ctx = {}) {
  const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

  const handle = async (msg) => {
    const { id, method, params } = msg;
    try {
      if (method === 'initialize') {
        return out({ jsonrpc: '2.0', id, result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: 'deepwhale-canvas', version: '0.1.0' },
          capabilities: { tools: {} },
        } });
      }
      if (method === 'notifications/initialized' || method === 'initialized') return;   // 通知：不回
      if (method === 'tools/list') {
        return out({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      }
      if (method === 'tools/call') {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        if (!TOOLS.some((t) => t.name === name)) throw new Error(`没有这个工具：${name}`);
        const result = await callTool(name, args, ctx);
        return out({ jsonrpc: '2.0', id, result });
      }
      if (method === 'ping') return out({ jsonrpc: '2.0', id, result: {} });
      return out({ jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法：${method}` } });
    } catch (e) {
      // 工具错误按 MCP 约定放 result.isError，协议错误才用 error
      if (method === 'tools/call') {
        return out({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] } });
      }
      return out({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
    }
  };

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }   // 非 JSON 行直接忽略（有的客户端会插日志）
      void handle(msg);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  // stdout 只走 JSON-RPC；任何意外都要看得见但不污染通道
  process.on('uncaughtException', (e) => console.error('[mcp] 未捕获异常：' + e.message));
}

export { TOOLS, callTool };
