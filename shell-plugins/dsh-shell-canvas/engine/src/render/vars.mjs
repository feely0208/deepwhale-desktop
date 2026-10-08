/**
 * 变量注入：把 {{key}} 换成实际值（用户填 或 模型填）。
 * 纯函数、无随机——保证同参数渲染结果一致。
 */

const REF_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*\}\}/g;

function renderValue(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).join('\n');
  if (value === null || value === undefined) return '';
  return String(value);
}

export function applyVars(doc, vars = {}) {
  const defs = new Map((doc.vars || []).map((v) => [v.key, v]));
  const resolved = {};
  for (const [key, def] of defs) {
    const given = vars[key];
    if (given !== undefined) resolved[key] = given;
    else if (def.default !== undefined) resolved[key] = def.default;
    else if (def.required) throw new Error(`缺少必填变量: ${key}`);
    else resolved[key] = '';
  }
  // 允许传入模板未声明但实际用到的变量（仍会由校验器兜底）
  for (const [k, v] of Object.entries(vars)) if (!(k in resolved)) resolved[k] = v;

  const subst = (s) => s.replace(REF_RE, (_, key) => renderValue(resolved[key] ?? ''));

  const clone = structuredClone(doc);
  const visit = (nodes) => {
    for (const n of nodes || []) {
      if (n.props && typeof n.props.text === 'string') n.props.text = subst(n.props.text);
      if (n.children) visit(n.children);
    }
  };
  visit(clone.nodes);
  Object.assign(clone, { __vars: resolved });
  return clone;
}
