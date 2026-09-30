#!/usr/bin/env node
/**
 * 声呐 · DeepSeek 动态探测
 *
 * 为什么要有（2026-09-30，用户的原话）：
 *   「deepseek 官方今天开源昇腾基础组件，我发现了官方的一切动态你都没有及时反馈过来给我，
 *     都是我发现反馈给你，这他娘的他不本末倒置了吗，怎么才能体现出让 deepseek 触手可及呢」
 *
 * 在此之前我们只监控了一个 npm 包版本号 —— 那**根本不叫监控官方动态**。
 * 昇腾那三个仓库（DeepEP-Ascend / DeepGEMM-Ascend / clangd-ascend）是在
 * GitHub 组织事件流里第一时间出现的，而我们从没看过那里。
 *
 * 设计要点：
 *   ① 抓的源要覆盖"官方会发布东西的地方"，不只是 npm
 *   ② **去重**：记住上次看到的事件 id，只报新的，不然每天都是同一批噪音
 *   ③ 每条带一句**判断**（对我们意味着什么）—— 用户自己刷公众号也能看到新闻，
 *      值钱的是判读。没有影响的明确标「仅知悉，无需动作」，不占他注意力
 *
 * 用法：
 *   node sonar.js            抓取 + 发信（cron 用）
 *   node sonar.js --dry      只打印，不发信（调试用）
 *   node sonar.js --force    忽略"没有新东西"，强制发一封（测试用）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = __dirname;
const STATE = path.join(DIR, 'sonar-state.json');
// 发信账号：优先用声呐专用的 sonar-mail.json（sales@），
// 找不到才回落到后端通用的 mail-config.json（license@）。
// 分开的原因：license@ 是**许可问题专用**信箱，还同时给律师授权/订单/反馈通知发信 ——
// 声呐天天发日报，不该占用它，改这里也不会影响那些邮件。
const MAIL_CFG = fs.existsSync(path.join(DIR, 'sonar-mail.json'))
  ? path.join(DIR, 'sonar-mail.json')
  : path.join(DIR, 'mail-config.json');
const TO = process.env.SONAR_TO || 'sonar@deepwhale.org';
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}

/** 带超时的 GET（JSON 或文本），失败返回 null —— 一个源挂了不能拖垮整封信。 */
function get(url, headers) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'GET',
      headers: Object.assign({ 'user-agent': 'deepwhale-sonar', accept: 'application/vnd.github+json' }, headers || {}),
      timeout: 25000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return resolve({ error: 'HTTP ' + res.statusCode });
        try { resolve({ json: JSON.parse(body) }); } catch (e) { resolve({ text: body }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: '超时' }); });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

/**
 * 判读规则 —— 这是这封信**真正值钱的部分**。
 * 命中就给出"要不要动"的结论；匹配不上就老实说"待判读"，不编。
 */
const RULES = [
  { re: /ascend|昇腾/i, say: '国产算力线。**对桌面端无直接技术影响**，但对信创/政企叙事是现成论据，可进官网与公众号素材' },
  { re: /@deepseek-ai\/dsh|deepseek-harness/i, say: '**运行时本体**。可能带来插件 API 变更 —— 要评估并跟进升级' },
  { re: /model|模型|v\d+\.\d+/i, say: '模型动态。可做宣传点；若进入 API 模型列表，考虑加进我们的模型选项' },
  { re: /harness/i, say: '与我们的产品直接相关，**要看**' },
  { re: /mcp/i, say: 'MCP 生态。和 0.2 里已支持的 MCP 一路，考虑做成我们的卖点' },
];

function judge(text) {
  for (const r of RULES) if (r.re.test(text)) return r.say;
  return '待判读（暂无明确影响）';
}

/** ① GitHub 组织公开事件 —— 新仓库、新 Release、新提交都从这里出来 */
async function fetchGithub(state) {
  const out = [];
  const r = await get('https://api.github.com/orgs/deepseek-ai/events?per_page=100');
  if (r.error) return { items: out, error: 'GitHub 事件流：' + r.error };
  const seen = new Set(state.github || []);
  const fresh = [];
  for (const ev of (r.json || [])) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    fresh.push(ev);
  }
  state.github = Array.from(seen).slice(-400);

  for (const ev of fresh.slice(0, 40)) {
    const repo = ev.repo && ev.repo.name ? ev.repo.name : '?';
    let what = '';
    if (ev.type === 'CreateEvent' && ev.payload && ev.payload.ref_type === 'repository') what = '🆕 新仓库：' + repo;
    else if (ev.type === 'ReleaseEvent') what = '🚀 新 Release：' + repo + ' ' + ((ev.payload && ev.payload.release && ev.payload.release.tag_name) || '');
    else if (ev.type === 'PublicEvent') what = '📣 转为公开：' + repo;
    else continue; // 普通 push 太吵，不报
    out.push({ kind: '仓库动态', text: what, url: 'https://github.com/' + repo, judge: judge(repo + ' ' + what) });
  }
  return { items: out };
}

/**
 * ①b 组织下**最近新建的仓库** —— 比事件流可靠。
 * 实测教训：昇腾那三个仓库（DeepEP-Ascend 等）用事件流**没抓到**，
 * 而事件流只回最近 100 条、还会漏。所以直接按创建时间倒序查仓库列表。
 */
async function fetchRepos(state) {
  const out = [];
  const r = await get('https://api.github.com/orgs/deepseek-ai/repos?sort=created&direction=desc&per_page=30');
  if (r.error) return { items: out, error: 'GitHub 仓库列表：' + r.error };
  const seen = new Set(state.repos || []);
  const firstRun = (state.repos || []).length === 0;
  for (const repo of (r.json || [])) {
    const name = repo.full_name || repo.name || '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    // 首次运行不要"整批当基线闷掉" —— 那样今天的昇腾那三个仓库就漏了。
    // 改成：首次只报**最近 7 天**建的，历史的记进基线不刷屏。
    if (firstRun) {
      const days = (Date.now() - new Date(repo.created_at || 0).getTime()) / 86400000;
      if (!(days <= 7)) continue;
    }
    out.push({
      kind: '新仓库',
      text: name,
      desc: String(repo.description || '').slice(0, 160),
      url: repo.html_url || ('https://github.com/' + name),
      judge: judge(name + ' ' + (repo.description || '')),
    });
  }
  state.repos = Array.from(seen).slice(-300);
  return { items: out };
}

/** ② npm 上的 dsh 版本（原有能力，保留） */
async function fetchNpm(state) {
  const out = [];
  const r = await get('https://registry.npmmirror.com/@deepseek-ai/dsh');
  if (r.error) return { items: out, error: 'npm：' + r.error };
  const latest = r.json && r.json['dist-tags'] && r.json['dist-tags'].latest;
  if (latest && latest !== state.npmLatest) {
    state.npmLatest = latest;
    out.push({ kind: '运行时版本', text: '@deepseek-ai/dsh ' + latest, url: 'https://www.npmjs.com/package/@deepseek-ai/dsh', judge: judge('@deepseek-ai/dsh ' + latest) });
  }
  return { items: out };
}

/** ③ HuggingFace 模型 */
async function fetchHf(state) {
  const out = [];
  const r = await get('https://huggingface.co/api/models?author=deepseek-ai&sort=createdAt&direction=-1&limit=20');
  if (r.error) return { items: out, error: 'HuggingFace：' + r.error };
  const seen = new Set(state.hf || []);
  for (const m of (r.json || [])) {
    const id = m.modelId || m.id || '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if ((state.hf || []).length === 0) continue; // 首次运行只记基线，不刷屏
    out.push({ kind: '新模型', text: id, url: 'https://huggingface.co/' + id, judge: judge(id) });
  }
  state.hf = Array.from(seen).slice(-300);
  return { items: out };
}

function buildMail(items, errors) {
  const lines = [];
  lines.push('声呐日报 · ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
  lines.push('');
  if (items.length === 0) {
    lines.push('今天官方没有值得动作的动态。');
  } else {
    lines.push('新动态 ' + items.length + ' 条：');
    lines.push('');
    items.forEach((it, i) => {
      lines.push((i + 1) + '. [' + it.kind + '] ' + it.text);
      if (it.url) lines.push('   ' + it.url);
      lines.push('   → ' + it.judge);
      lines.push('');
    });
  }
  if (errors && errors.length) {
    lines.push('―― 抓取异常（不影响其它源）――');
    errors.forEach((e) => lines.push('  · ' + e));
  }
  lines.push('――');
  lines.push('（这封信由「声呐」自动发出。判断由规则表给出，只负责提示"要不要动"；');
  lines.push('  具体怎么做，我们在会话里展开。）');
  return lines.join('\n');
}

const KIND_COLOR = { '新仓库': '#12a08e', '仓库动态': '#12a08e', '运行时版本': '#b8860b', '新模型': '#3b6fd4' };

/**
 * HTML 排版 —— 为什么要做：
 *   用户原话「有点乱，就是链接和文案，可以适当排版下让阅读体验感更好吗，
 *             也可以用表格或者 ui 界面类的，而且里面的链接不是一点即可跳转的」
 * 所以：卡片式（一条一块）、类型做成彩色标签、标题是**可点链接**、
 *      判读单独一块带左侧色条；全部用 table + 内联样式（邮件客户端兼容性最好）。
 */
function buildHtml(items, errors) {
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const rows = items.map((it) => {
    const color = KIND_COLOR[it.kind] || '#5b6b7f';
    return `
    <tr><td style="padding:0 0 14px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="border:1px solid #e3e8ef;border-radius:12px;background:#ffffff">
        <tr><td style="padding:16px 18px">
          <div style="margin:0 0 10px 0">
            <span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;
                         color:#fff;background:${color}">${esc(it.kind)}</span>
          </div>
          <div style="font-size:15px;font-weight:700;line-height:1.6;margin:0 0 6px 0">
            ${it.url ? `<a href="${esc(it.url)}" style="color:#0b4f9e;text-decoration:none">${esc(it.text)}</a>` : esc(it.text)}
          </div>
          ${it.desc ? `<div style="font-size:13px;color:#6b7b8f;line-height:1.7;margin:0 0 10px 0">${esc(it.desc)}</div>` : ''}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="border-left:3px solid ${color};padding:2px 0 2px 11px">
              <div style="font-size:13px;color:#3b4b5e;line-height:1.8">
                <b style="color:${color}">要不要动：</b>${esc(it.judge)}
              </div>
            </td></tr>
          </table>
          ${it.url ? `<div style="margin:10px 0 0 0"><a href="${esc(it.url)}" style="font-size:12.5px;color:#0b4f9e">${esc(it.url)}</a></div>` : ''}
        </td></tr>
      </table>
    </td></tr>`;
  }).join('');

  const errBlock = (errors && errors.length) ? `
    <tr><td style="padding:6px 0 0 0">
      <div style="font-size:12.5px;color:#9aa7b6;line-height:1.9">
        抓取异常（不影响其它源）：${errors.map(esc).join('；')}
      </div>
    </td></tr>` : '';

  const empty = items.length === 0 ? `
    <tr><td style="padding:26px 0;text-align:center;color:#6b7b8f;font-size:14px">
      今天官方没有值得动作的动态。
    </td></tr>` : '';

  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f9">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:26px 12px">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%">
        <tr><td style="padding:0 0 4px 0">
          <div style="font-size:19px;font-weight:800;color:#0d2137;letter-spacing:.5px">🐋 声呐日报</div>
        </td></tr>
        <tr><td style="padding:0 0 18px 0">
          <div style="font-size:13px;color:#6b7b8f">
            ${esc(new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}
            ｜ DeepSeek 官方动态，每条附一句「要不要动」
          </div>
        </td></tr>
        ${rows}${empty}${errBlock}
        <tr><td style="padding:18px 0 0 0;border-top:1px solid #e3e8ef">
          <div style="font-size:12px;color:#9aa7b6;line-height:1.9">
            这封信由「声呐」自动发出。判断由规则表给出，只负责提示"要不要动"；具体怎么做，我们在会话里展开。
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function send(subject, text, html) {
  const cfg = readJson(MAIL_CFG, null);
  if (!cfg) { console.error('读不到 mail-config.json'); process.exit(1); }
  const nm = require('nodemailer');
  const t = nm.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass } });
  return t.sendMail({ from: '"' + (cfg.fromName || '深鲸') + '" <' + cfg.user + '>', to: TO, subject: subject, text: text, html: html });
}

(async () => {
  const state = readJson(STATE, {});
  const results = await Promise.all([fetchRepos(state), fetchGithub(state), fetchNpm(state), fetchHf(state)]);
  const items = [];
  const errors = [];
  for (const r of results) {
    (r.items || []).forEach((it) => items.push(it));
    if (r.error) errors.push(r.error);
  }

  const text = buildMail(items, errors);
  const subject = items.length
    ? '【深鲸·声呐】' + items.length + ' 条新动态'
    : '【深鲸·声呐】今日无新动态';

  if (DRY) { console.log(text); console.log('\n[--dry] 未发信，状态未落盘'); return; }
  if (items.length === 0 && !FORCE) {
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
    console.log('无新动态，不发信'); return;
  }
  const r = await send(subject, text, buildHtml(items, errors));
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log('已发送 →', TO, '|', r.accepted, '|', (r.response || '').slice(0, 80));
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
