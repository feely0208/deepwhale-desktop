/**
 * 素材/配音 提供者（Provider）—— 框架第 ④⑤ 层。
 *
 * 为什么要有这一层（2026-10-09 定）：
 *   生图/生视频/配音在这个时代是**别人的能力**，而且是用户在各自渠道买的。
 *   框架的正确做法不是"我们内置一个模型"，而是 **把接口开出来，让用户接自己的**：
 *     谁的便宜用谁的、想换随时换、key 是用户自己的。
 *   我们只负责编排、合成、批量、确定性 —— 这才是不会被 token 冲掉的部分。
 *
 * 配置（用户自己的文件，**key 存在用户自己机器上**）：
 *   $DSH_HOME/canvas-providers.json
 *   {
 *     "providers": [
 *       { "id": "my-image", "kind": "image", "adapter": "http",
 *         "url": "https://api.example.com/v1/images",
 *         "key": "sk-...", "promptField": "prompt",
 *         "resultType": "url" },            // url | base64 | binary
 *       { "id": "local-sd", "kind": "image", "adapter": "command",
 *         "command": "python3 ~/sd.py --prompt {prompt} --out {out}" },
 *       { "id": "my-voice", "kind": "voice", "adapter": "command",
 *         "command": "my-tts --text {prompt} --out {out}" }
 *     ]
 *   }
 *
 * 安全与边界：
 *   · 配置来自用户自己的文件 → 命令/密钥都是用户自己的选择，我们不做额外执行；
 *   · **绝不把 key 写进日志或产物**；
 *   · 产物路径统一落在 outDir 内，不允许 adapter 写到任意位置；
 *   · 失败的 provider 只影响它自己那一步，且**错误必须冒出来**（不许静默降级）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';

const KIND = new Set(['image', 'video', 'voice', 'text']);

/* ── 适配器：http ─────────────────────────────────────────────────── */
async function httpGenerate(p, { prompt, outDir, index = 0, extra = {} }) {
  if (!p.url) throw new Error(`provider ${p.id} 缺 url`);
  const body = { [p.promptField || 'prompt']: prompt, ...(p.extra || {}), ...extra };
  const headers = { 'content-type': 'application/json' };
  if (p.key) headers[p.authHeader || 'authorization'] = (p.authPrefix === undefined ? 'Bearer ' : p.authPrefix) + p.key;

  const res = await fetch(p.url, { method: p.method || 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`provider ${p.id} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const type = String(res.headers.get('content-type') || '');
  const out = join(outDir, `${p.id}-${Date.now()}-${index}${String(p.outExt || '').startsWith('.') ? p.outExt : '.png'}`);

  if (p.resultType === 'binary' || type.startsWith('image/') || type.startsWith('video/')) {
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(out, buf);
    return out;
  }
  const json = await res.json();
  // 结果路径可配置：默认按 OpenAI 风格的 data[0].url 兜底
  const pick = p.resultPath || 'data.0.url';
  let val = json;
  for (const k of pick.split('.')) val = val == null ? undefined : val[Array.isArray(val) ? Number(k) : k];
  if (typeof val !== 'string' || !val) {
    throw new Error(`provider ${p.id} 返回里找不到结果（resultPath=${pick}）：${JSON.stringify(json).slice(0, 200)}`);
  }
  if (val.startsWith('http')) {
    const r2 = await fetch(val);
    if (!r2.ok) throw new Error(`provider ${p.id} 结果下载失败 HTTP ${r2.status}`);
    writeFileSync(out, Buffer.from(await r2.arrayBuffer()));
  } else {
    writeFileSync(out, Buffer.from(val.replace(/^data:[^,]+,/, ''), 'base64'));   // base64 / data URI
  }
  return out;
}

/* ── 适配器：command ───────────────────────────────────────────────
 * 最通用的一条：用户写什么命令都行（本地模型、自家脚本、云厂商 CLI）。
 * 约定：命令里 `{prompt}` 换成提示词、`{out}` 换成**必须写入**的产物路径。
 */
function commandGenerate(p, { prompt, outDir, index = 0 }) {
  if (!p.command) throw new Error(`provider ${p.id} 缺 command`);
  const ext = String(p.outExt || '').startsWith('.') ? p.outExt : '.png';   // extname('.jpg') 是空串，别用
  const out = join(outDir, `${p.id}-${Date.now()}-${index}${ext}`);
  const cmd = String(p.command).split('{prompt}').join(prompt).split('{out}').join(out);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(new Error(`provider ${p.id} 起不来：${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`provider ${p.id} 退出码 ${code}：${String(err).slice(-300)}`));
      if (!existsSync(out)) return reject(new Error(`provider ${p.id} 说成功但没写出产物：${out}`));
      resolvePromise(out);
    });
  });
}

const registry = new Map();

/** 注册一个提供者。 */
export function registerProvider(p) {
  if (!p || !p.id) throw new Error('provider 需要 id');
  if (!KIND.has(p.kind)) throw new Error(`provider ${p.id} kind 必须是 ${[...KIND].join('/')}`);
  const adapter = p.adapter || 'command';
  if (adapter !== 'http' && adapter !== 'command') throw new Error(`provider ${p.id} 不支持的 adapter：${adapter}`);
  registry.set(p.id, { ...p, adapter });
  return registry.get(p.id);
}

export function listProviders() {
  // ⚠️ 绝不外泄 key：列表里只给出"有没有配 key"
  return [...registry.values()].map((p) => ({
    id: p.id, kind: p.kind, adapter: p.adapter, title: p.title || p.id,
    hasKey: !!p.key, url: p.url ? String(p.url).replace(/\/\/[^/]*@/, '//') : undefined,
  }));
}

export function getProvider(id) {
  return registry.get(id) || null;
}

/** 按 id 或 kind 找（方便 producer 说"给我一个生图的"）。 */
export function firstProvider(kindOrId) {
  if (registry.has(kindOrId)) return registry.get(kindOrId);
  for (const p of registry.values()) if (p.kind === kindOrId) return p;
  return null;
}

/** 调一个 provider 生成一个素材。 */
export async function generateWith(idOrKind, { prompt, outDir, index = 0, extra } = {}) {
  const p = firstProvider(idOrKind);
  if (!p) throw new Error(`没有可用的 provider：${idOrKind}（已配置：${[...registry.keys()].join(', ') || '无'}）`);
  if (!outDir) throw new Error('generate 需要 outDir');
  mkdirSync(outDir, { recursive: true });
  if (p.adapter === 'http') return httpGenerate(p, { prompt, outDir, index, extra });
  return commandGenerate(p, { prompt, outDir, index });
}

/** 从用户配置读 provider。路径默认 $DSH_HOME/canvas-providers.json。 */
export function loadProvidersFromConfig(configPath) {
  const file = configPath || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'canvas-providers.json') : null);
  if (!file || !existsSync(file)) return { loaded: 0, file: file || null, reason: '没有配置文件（正常：没接自己的接口时就是这样）' };
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`provider 配置不是合法 JSON：${file} —— ${e.message}`);
  }
  const list = Array.isArray(json.providers) ? json.providers : [];
  let loaded = 0;
  for (const p of list) {
    try { registerProvider(p); loaded++; } catch (e) { console.error(`[provider] ${p && p.id} 配置有误：${e.message}`); }
  }
  return { loaded, file, total: list.length };
}

/** 给 producer 用的访问器：ctx.provider('image') → { generate } */
export function providerAccessor(defaultOutDir) {
  return (kindOrId) => {
    const p = firstProvider(kindOrId);
    if (!p) return null;
    return {
      id: p.id,
      kind: p.kind,
      adapter: p.adapter,
      title: p.title || p.id,
      generate: (opts = {}) => generateWith(p.id, { outDir: defaultOutDir, ...opts }),
    };
  };
}

export const __testing = { httpGenerate, commandGenerate };
