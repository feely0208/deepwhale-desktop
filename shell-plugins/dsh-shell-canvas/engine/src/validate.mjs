/**
 * 深鲸画布 · 校验器（spec v1）
 *
 * 职责：把「模板是数据」这句话变成机器可执行的检查。
 * 设计要点：
 *   1. 安全扫描（可执行键 / 外链）**先于**结构校验——安全问题的错误码不能被 schema 错误淹没；
 *   2. 结构校验用标准 JSON Schema（ajv 2020-12），规则校验用代码；
 *   3. 输出**稳定排序**，同一输入两次运行的报告逐字节一致（可作审计证据）。
 */

import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIssue, sortIssues } from './errors.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SPEC_DIR = resolve(HERE, '../spec/v1');
export const ENGINE_VERSION = '1.0.0';

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
const compiledCache = new Map();

function compile(path) {
  if (!compiledCache.has(path)) {
    compiledCache.set(path, ajv.compile(JSON.parse(readFileSync(path, 'utf8'))));
  }
  return compiledCache.get(path);
}

export const DOCUMENT_SCHEMA_PATH = resolve(SPEC_DIR, 'document.schema.json');

// ── 危险模式 ───────────────────────────────────────────────────────────────
const FORBIDDEN_KEY_RE = /^(script|eval|function|__proto__|constructor|prototype|on[a-z]+)$/i;
const DANGEROUS_STRING_RE = /(<script|<\/script|javascript:|eval\s*\(|Function\s*\()/i;
const EXTERNAL_URL_RE = /^(https?:)?\/\/|^(data|ftp|file|blob|ws|wss):/i;
const VAR_REF_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_-]*)/g;

// ── 工具 ──────────────────────────────────────────────────────────────────
function walk(value, path, visit) {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) walk(value[k], path ? `${path}.${k}` : k, visit);
  }
}

function joinPath(base, seg) {
  return base ? `${base}.${seg}` : seg;
}

function collectNodes(nodes, basePath, out, depth = 1) {
  (nodes || []).forEach((node, i) => {
    const p = `${basePath}[${i}]`;
    out.push({ node, path: p, depth });
    if (Array.isArray(node && node.children)) {
      collectNodes(node.children, joinPath(p, 'children'), out, depth + 1);
    }
  });
}

// ── 各层校验 ──────────────────────────────────────────────────────────────
function scanSecurity(doc, issues) {
  walk(doc, '', (value, path) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (FORBIDDEN_KEY_RE.test(key)) {
          issues.push(makeIssue('E_FORBIDDEN_KEY', joinPath(path, key),
            `字段名 "${key}" 属于可执行键，模板不允许出现（模板是数据，不是代码）`));
        }
      }
    }
    if (typeof value === 'string') {
      if (DANGEROUS_STRING_RE.test(value)) {
        issues.push(makeIssue('E_FORBIDDEN_KEY', path, '字符串里含可执行内容（如 <script / javascript: / eval( ）'));
      }
      if (EXTERNAL_URL_RE.test(value.trim())) {
        issues.push(makeIssue('E_EXTERNAL_URL', path,
          `不允许外链：${value.slice(0, 60)}（素材只能是包内路径或用户槽位）`));
      }
    }
  });
}

function checkMetaAndCanvas(doc, pack, packInfo, issues) {
  if (doc.spec === undefined) issues.push(makeIssue('E_SPEC_MISSING', 'spec'));
  else if (doc.spec !== 1) issues.push(makeIssue('E_SPEC_UNSUPPORTED', 'spec', `spec=${doc.spec}，只支持 1`));

  if (typeof doc.domain === 'string') {
    if (!pack) issues.push(makeIssue('E_DOMAIN_UNKNOWN', 'domain', `注册表里没有领域 "${doc.domain}"`));
    else if (doc.domainVersion && doc.domainVersion !== pack.domain.version) {
      issues.push(makeIssue('E_DOMAIN_VERSION_MISMATCH', 'domainVersion',
        `模板要求 ${doc.domainVersion}，已加载领域包是 ${pack.domain.version}`));
    }
  }

  if (pack && pack.domain.engineRange) {
    const r = pack.engineRangeCheck;
    if (r && !r.ok) {
      issues.push(makeIssue('E_DOMAIN_VERSION_MISMATCH', 'domain', `领域包与引擎不匹配：${r.reason}`));
    }
  }

  const c = doc.canvas;
  if (!c || typeof c !== 'object') return;
  const presets = pack?.domain?.canvas?.presets || [];
  const preset = presets.find((p) => p.name === c.preset) || presets[0] || {};
  const limits = {
    maxW: preset.maxW ?? preset.w,
    maxH: preset.maxH ?? preset.h,
    maxFps: preset.maxFps ?? preset.fps,
    maxFrames: preset.maxFrames,
  };
  if (limits.maxW && c.w > limits.maxW) issues.push(makeIssue('E_CANVAS_LIMIT', 'canvas.w', `宽度 ${c.w} 超过上限 ${limits.maxW}`));
  if (limits.maxH && c.h > limits.maxH) issues.push(makeIssue('E_CANVAS_LIMIT', 'canvas.h', `高度 ${c.h} 超过上限 ${limits.maxH}`));
  if (limits.maxFps && c.fps > limits.maxFps) issues.push(makeIssue('E_CANVAS_LIMIT', 'canvas.fps', `帧率 ${c.fps} 超过上限 ${limits.maxFps}`));
  if (limits.maxFrames && c.frames > limits.maxFrames) issues.push(makeIssue('E_CANVAS_LIMIT', 'canvas.frames', `帧数 ${c.frames} 超过上限 ${limits.maxFrames}`));
}

function checkNodes(doc, pack, issues) {
  const flat = [];
  collectNodes(doc.nodes, 'nodes', flat);

  if (pack) {
    const maxNodes = pack.domain.constraints?.maxNodes;
    const maxDepth = pack.domain.constraints?.maxDepth;
    if (maxNodes && flat.length > maxNodes) {
      issues.push(makeIssue('E_NODE_COUNT_LIMIT', 'nodes', `节点总数 ${flat.length} 超过上限 ${maxNodes}`));
    }
    const deepest = flat.reduce((m, n) => Math.max(m, n.depth), 0);
    if (maxDepth && deepest > maxDepth) {
      issues.push(makeIssue('E_DEPTH_LIMIT', 'nodes', `嵌套深度 ${deepest} 超过上限 ${maxDepth}`));
    }
  }

  const byType = new Map((pack?.nodes || []).map((n) => [n.type, n]));
  const declaredVars = new Set((doc.vars || []).map((v) => v.key));
  const fontIds = new Set((pack?.domain?.fonts || []).map((f) => f.id));
  const bgmIds = new Set((pack?.bgmRegistry?.tracks || []).map((t) => t.id));

  for (const { node, path } of flat) {
    if (!pack) break;
    const def = byType.get(node.type);
    if (!def) {
      issues.push(makeIssue('E_NODE_TYPE_UNKNOWN', joinPath(path, 'type'),
        `节点类型 "${node.type}" 不在领域包白名单内（允许：${[...byType.keys()].join(', ')}）`));
      continue;
    }
    if (def.propsSchemaPath) {
      const validateProps = compile(def.propsSchemaPath);
      if (!validateProps(node.props)) {
        for (const e of validateProps.errors || []) {
          issues.push(makeIssue('E_SCHEMA_INVALID', `${path}.props${e.instancePath}`,
            `${node.type}: ${e.message}`));
        }
      }
    }
    // 字体：只能是白名单里的字体 ID
    const font = node.props && (node.props.font || node.props.fontId);
    if (typeof font === 'string' && !fontIds.has(font)) {
      issues.push(makeIssue('E_FONT_NOT_WHITELISTED', `${path}.props.font`,
        `字体 "${font}" 不在领域包字体白名单内（只允许字体 ID：${[...fontIds].join(', ')}）`));
    }
    // 字幕：srtVar 必须指向一个已声明的变量（字幕内容由变量注入，不写死在模板里）
    if (node.type === 'subtitle' && node.props && typeof node.props.srtVar === 'string') {
      if (!declaredVars.has(node.props.srtVar)) {
        issues.push(makeIssue('E_VAR_UNDEFINED', `${path}.props.srtVar`,
          `字幕引用了未声明的变量 "${node.props.srtVar}"（字幕要从变量注入）`));
      }
    }
    // 音频：必须已在入库台账
    const bgm = node.props && (node.props.bgmId || node.props.audioId);
    if (typeof bgm === 'string' && pack.bgmRegistry && !bgmIds.has(bgm)) {
      issues.push(makeIssue('E_BGM_NOT_IN_REGISTRY', `${path}.props.bgmId`,
        `音频 "${bgm}" 不在 BGM 入库台账内（需先经 bgm-license-audit 入库）`));
    }
  }
  return flat;
}

function checkTimeline(doc, pack, issues) {
  const anims = new Map((pack?.animations || []).map((a) => [a.name, a]));
  const nodeIds = new Set();
  walk(doc.nodes, 'nodes', (v, p) => {
    // 节点 id 是一段字符串值，路径形如 "nodes[0].id" / "nodes[0].children[1].id"
    if (typeof v === 'string' && p.endsWith('.id')) nodeIds.add(v);
  });

  (doc.timeline || []).forEach((item, i) => {
    const p = `timeline[${i}]`;
    if (!pack) return;
    if (item.anim) {
      const def = anims.get(item.anim.name);
      if (!def) {
        issues.push(makeIssue('E_ANIM_UNKNOWN', `${p}.anim.name`,
          `动效 "${item.anim.name}" 不在领域包白名单内（允许：${[...anims.keys()].join(', ')}）`));
      } else if (def.paramsSchemaPath) {
        const v = compile(def.paramsSchemaPath);
        if (!v(item.anim.params ?? {})) {
          for (const e of v.errors || []) {
            issues.push(makeIssue('E_SCHEMA_INVALID', `${p}.anim.params${e.instancePath}`, `${item.anim.name}: ${e.message}`));
          }
        }
      }
    }
    if (item.nodeId && !nodeIds.has(item.nodeId)) {
      issues.push(makeIssue('E_TIMELINE_NODE_UNKNOWN', `${p}.nodeId`, `时间轴引用了不存在的节点 "${item.nodeId}"`));
    }
    if (item.from !== undefined && item.to !== undefined && item.to <= item.from) {
      issues.push(makeIssue('E_TIMELINE_RANGE', `${p}.to`, `to(=${item.to}) 必须大于 from(=${item.from})`));
    }
  });
}

function checkResources(doc, pack, issues) {
  let total = 0;
  const slots = new Set();
  (doc.resources || []).forEach((r, i) => {
    const p = `resources[${i}]`;
    if (r.kind === 'user') {
      if (r.slot) slots.add(r.slot);
      return;
    }
    if (r.kind === 'pack') {
      if (typeof r.path !== 'string') {
        issues.push(makeIssue('E_SCHEMA_INVALID', `${p}.path`, '包内素材必须给 path'));
      } else {
        if (isAbsolute(r.path) || r.path.split('/').includes('..')) {
          issues.push(makeIssue('E_RESOURCE_PATH_ESCAPE', `${p}.path`, `路径不允许绝对路径或 .. ：${r.path}`));
        }
        if (!r.path.startsWith('assets/')) {
          issues.push(makeIssue('E_RESOURCE_PATH_ESCAPE', `${p}.path`, `包内素材必须位于 assets/ 下：${r.path}`));
        }
      }
    }
    total += Number.isFinite(r.bytes) ? r.bytes : 0;
  });
  const maxMB = pack?.domain?.constraints?.maxResourceMB;
  if (maxMB && total > maxMB * 1024 * 1024) {
    issues.push(makeIssue('E_RESOURCE_TOO_LARGE', 'resources',
      `素材声明体积合计 ${(total / 1024 / 1024).toFixed(1)}MB 超过上限 ${maxMB}MB`));
  }
  return slots;
}

function checkVars(doc, issues) {
  const defined = new Set((doc.vars || []).map((v) => v.key));
  walk(doc.nodes, 'nodes', (value, path) => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(VAR_REF_RE)) {
        if (!defined.has(m[1])) {
          issues.push(makeIssue('E_VAR_UNDEFINED', path, `引用了未定义的变量 "${m[1]}"`));
        }
      }
    }
  });
  (doc.timeline || []).forEach((item, i) => {
    if (!item.vars) return;
    const base = String(item.vars).replace(/\[.*$/, '').replace(/\..*$/, '');
    if (!defined.has(base)) {
      issues.push(makeIssue('E_VAR_UNDEFINED', `timeline[${i}].vars`, `引用了未定义的变量 "${base}"`));
    }
  });
}

function checkAiLabel(doc, pack, issues) {
  if (pack?.domain?.constraints?.requireAiLabel && doc.meta && doc.meta.aiGenerated === undefined) {
    issues.push(makeIssue('W_AI_LABEL_REQUIRED', 'meta.aiGenerated',
      '领域包要求声明是否含 AI 生成内容（按国家规定需标识）'));
  }
}

// ── 对外入口 ──────────────────────────────────────────────────────────────
export function validateDocument(doc, pack) {
  const issues = [];

  // 1. 安全优先
  scanSecurity(doc, issues);
  // 2. 结构（JSON Schema）
  const validateDoc = compile(DOCUMENT_SCHEMA_PATH);
  if (!validateDoc(doc)) {
    for (const e of validateDoc.errors || []) {
      issues.push(makeIssue('E_SCHEMA_INVALID', `#${e.instancePath || ''}`, e.message));
    }
  }
  // 3. 规则
  checkMetaAndCanvas(doc, pack, pack, issues);
  checkNodes(doc, pack, issues);
  checkTimeline(doc, pack, issues);
  checkResources(doc, pack, issues);
  checkVars(doc, issues);
  checkAiLabel(doc, pack, issues);

  const sorted = sortIssues(issues);
  return {
    ok: sorted.every((i) => i.level !== 'error'),
    issues: sorted,
    errors: sorted.filter((i) => i.level === 'error').length,
    warnings: sorted.filter((i) => i.level === 'warn').length,
  };
}
