/**
 * 领域包注册表：扫描 packs/ 目录，加载每个 domain.json 及其引用的 schema。
 * 契约 1：domain 用字符串 + 注册表 —— 加领域 = 加包，内核不动。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 解析 pack 目录里的相对路径引用（禁止逃出包目录）。 */
function resolveInPack(packDir, rel) {
  const abs = resolve(packDir, rel);
  if (!abs.startsWith(resolve(packDir) + '/')) {
    throw new Error(`领域包内路径逃逸: ${rel}`);
  }
  return abs;
}

export function loadPack(packDir) {
  const dir = resolve(packDir);
  const domainFile = join(dir, 'domain.json');
  if (!existsSync(domainFile)) throw new Error(`找不到领域包: ${domainFile}`);
  const domain = readJson(domainFile);

  const nodes = (domain.nodes || []).map((n) => ({
    ...n,
    propsSchemaPath: n.propsSchema ? resolveInPack(dir, n.propsSchema) : null,
  }));

  const animations = (domain.animations || []).map((a) => ({
    ...a,
    paramsSchemaPath: a.paramsSchema ? resolveInPack(dir, a.paramsSchema) : null,
  }));

  let bgmRegistry = null;
  if (domain.bgmRegistry) {
    const p = resolveInPack(dir, domain.bgmRegistry);
    if (existsSync(p)) bgmRegistry = readJson(p);
  }

  return { dir, domain, nodes, animations, bgmRegistry };
}

/** 扫描一个 packs 根目录下的所有领域包（每个子目录一个包）。 */
export function loadRegistry(packsRoot) {
  const root = resolve(packsRoot);
  const packs = new Map();
  if (!existsSync(root)) return packs;
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    if (!existsSync(join(dir, 'domain.json'))) continue;
    const pack = loadPack(dir);
    packs.set(pack.domain.domain, pack);
  }
  return packs;
}

/** 把 "2"、"1.0" 这类写法补全成 "2.0.0"、"1.0.0" */
function normalizeVersion(v) {
  const parts = String(v).trim().split('.').map((x) => Number(x));
  while (parts.length < 3) parts.push(0);
  return parts;
}

/**
 * 语义化范围极简判定：支持 ">=a[.b[.c]] <d[.e[.f]]" 这种两段式（够用且好懂）。
 * 不支持 ^、~、|| 等完整 semver 语法——故意的：规则简单才不容易出意外。
 */
export function satisfiesEngineRange(range, engineVersion) {
  const m = String(range)
    .trim()
    .match(/^>=\s*(\d+(?:\.\d+){0,2})\s+<\s*(\d+(?:\.\d+){0,2})$/);
  if (!m) return { ok: false, reason: `engineRange 格式不支持: ${range}（应为 ">=x.y.z <a.b.c"）` };
  const cmp = (a, b) => {
    const A = normalizeVersion(a);
    const B = normalizeVersion(b);
    return A[0] - B[0] || A[1] - B[1] || A[2] - B[2];
  };
  const [lo, hi] = [m[1], m[2]];
  if (cmp(engineVersion, lo) < 0) return { ok: false, reason: `需要引擎 >= ${lo}，当前 ${engineVersion}` };
  if (cmp(engineVersion, hi) >= 0) return { ok: false, reason: `需要引擎 < ${hi}，当前 ${engineVersion}` };
  return { ok: true };
}
