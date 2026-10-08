/**
 * 错误码表 —— 稳定错误码是自动化测试与前端提示的基础，任何改动都要向后兼容。
 * 与 spec/v1/README.md 第 6 节保持同步。
 */

export const CODES = {
  E_SPEC_MISSING: { level: 'error', msg: '缺少 spec 字段' },
  E_SPEC_UNSUPPORTED: { level: 'error', msg: 'spec 版本不受支持（当前只支持 1）' },
  E_DOMAIN_UNKNOWN: { level: 'error', msg: '领域包注册表里没有该 domain' },
  E_DOMAIN_VERSION_MISMATCH: { level: 'error', msg: 'domainVersion 与已加载领域包版本不一致' },
  E_SCHEMA_INVALID: { level: 'error', msg: '结构不符合 JSON Schema' },
  E_FORBIDDEN_KEY: { level: 'error', msg: '出现可执行键或危险字符串（模板不能含代码）' },
  E_EXTERNAL_URL: { level: 'error', msg: '出现外链（模板素材只能是包内路径或用户槽位）' },
  E_RESOURCE_PATH_ESCAPE: { level: 'error', msg: '包内素材路径逃逸（不允许 .. 或绝对路径）' },
  E_CANVAS_LIMIT: { level: 'error', msg: '超出领域包预设的画布/帧率/帧数上限' },
  E_NODE_TYPE_UNKNOWN: { level: 'error', msg: '节点类型不在领域包白名单内' },
  E_ANIM_UNKNOWN: { level: 'error', msg: '动效不在领域包白名单内' },
  E_RESOURCE_TOO_LARGE: { level: 'error', msg: '素材声明体积合计超限' },
  E_VAR_UNDEFINED: { level: 'error', msg: '引用了未定义的变量' },
  E_TIMELINE_NODE_UNKNOWN: { level: 'error', msg: '时间轴引用了不存在的节点' },
  E_TIMELINE_RANGE: { level: 'error', msg: '时间轴的 from/to 不合法' },
  E_NODE_COUNT_LIMIT: { level: 'error', msg: '节点总数超限' },
  E_DEPTH_LIMIT: { level: 'error', msg: '节点嵌套深度超限' },
  E_FONT_NOT_WHITELISTED: { level: 'error', msg: '字体不在领域包白名单内（只允许字体 ID）' },
  E_BGM_NOT_IN_REGISTRY: { level: 'error', msg: '音频不在入库台账内' },
  W_AI_LABEL_REQUIRED: { level: 'warn', msg: '领域包要求 AI 标识，但模板未声明 meta.aiGenerated' },
};

export function makeIssue(code, path, msg, hint) {
  const base = CODES[code];
  if (!base) throw new Error(`未知错误码: ${code}`);
  return {
    level: base.level,
    code,
    path: path || '',
    msg: msg || base.msg,
    ...(hint ? { hint } : {}),
  };
}

/** 稳定排序：保证同一输入两次运行的报告逐字节一致（测试会校验这一点）。 */
export function sortIssues(issues) {
  return [...issues].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.msg < b.msg ? -1 : a.msg > b.msg ? 1 : 0;
  });
}
