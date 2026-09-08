const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
let XLSX = null;
try { XLSX = require('xlsx'); } catch (e) { XLSX = null; }

// —— 启动门槛标记：是否为"由深鲸桌面端(deepwhale-law://)启动"。macOS 协议启动通过 open-url 事件传递 URL。 —
let __launchedViaDsh = false;
app.on('open-url', (ev, url) => { ev.preventDefault(); if (/deepwhale-law/i.test(String(url) || '')) __launchedViaDsh = true; });

// 工作台内嵌于包内（打包后可自包含运行），用相对路径加载
const WORKBENCH = 'file://' + path.join(__dirname, 'workbench', 'index.html');
const DEEPSEEK_DEFAULT = 'https://api.deepseek.com/v1';

// A款「集团算力」：从当前 DSH_HOME 的 credentials 读 DEEPSEEK_API_KEY（订阅侧统一下发/校验）
function readDshKey() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : (process.env.HOME ? path.join(process.env.HOME, '.dsh-legal') : null);
  if (!home) return '';
  const f = path.join(home, '.credentials.yaml');
  try {
    const raw = fs.readFileSync(f, 'utf8');
    // 支持 refs 嵌套或顶层键：DEEPSEEK_API_KEY
    const re = /DEEPSEEK_API_KEY:\s*["']?([^"'\s#]+)/;
    const m = raw.match(re);
    return m ? m[1] : '';
  } catch { return ''; }
}

// 真实 LLM 桥：走 DeepSeek 官方 OpenAI-completions
// opts: { key, baseURL, model, messages:[{role,content}], temperature, maxTokens }
ipcMain.handle('llm:chat', async (_ev, opts) => {
  const o = opts || {};
  // A款一律自备算力：只使用用户自备的 key，绝不 fallback 到集团算力 key
  const key = o.key || '';
  if (!key) return { ok: false, msg: '未配置 API Key（请在「设置 → 算力与 Key」填入你自己的 DeepSeek API Key）' };
  const base = (o.baseURL || DEEPSEEK_DEFAULT).replace(/\/+$/, '');
  const model = o.model || 'deepseek-v4-flash';
  const body = {
    model,
    messages: o.messages || [],
    temperature: o.temperature != null ? o.temperature : 0.4,
    max_tokens: o.maxTokens != null ? o.maxTokens : 2000,
    stream: false,
  };
  try {
    const url = base + '/chat/completions';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    if (!resp.ok) {
      // 友好错误：识别鉴权失败(401/403/authentication_error)，不甩原始 JSON 堆栈
      let m = 'HTTP ' + resp.status;
      try {
        const j = JSON.parse(text);
        const em = (j && j.error && (j.error.message || j.error.code)) || '';
        if (!resp.ok && (resp.status === 401 || resp.status === 403 || /authentication|invalid.*key|api key/i.test(em || ''))) {
          return { ok: false, msg: 'API Key 无效或已过期，请在「设置 → 算力与 Key」重新填写你的 DeepSeek API Key' };
        }
        m += (em ? '：' + em : '');
      } catch (e2) { /* 非 JSON 响应，用原始文本 */ }
      return { ok: false, msg: m.slice(0, 160) };
    }
    let data; try { data = JSON.parse(text); } catch { return { ok: false, msg: '响应解析失败' }; }
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return { ok: true, content: content || '' };
  } catch (e) {
    return { ok: false, msg: '请求失败：' + (e && e.message || String(e)) };
  }
});

// 查询集团算力 key 是否已配置
ipcMain.handle('llm:keyinfo', async () => {
  const key = readDshKey();
  return { configured: !!key, source: key ? '集团算力(DEEPSEEK_API_KEY)' : '' };
});

// —— 短信配置读取（密钥不进代码，读 sms-config.json；.gitignore 已忽略）——
function readSmsConfig() {
  const f = path.join(__dirname, 'sms-config.json');
  try {
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    return c || {};
  } catch { return {}; }
}

// —— 生成6位验证码 ——
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }

// —— 阿里云 RPC 签名（HMAC-SHA1），调用 dysmsapi.SendSms ——
// 参考阿里云官方 RPC 签名方法（percentEncode + HMAC-SHA1），无第三方依赖。
function aliyunPercentEncode(str) {
  return encodeURIComponent(str)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}
const crypto = require('crypto');

// 真实短信桥：阿里云短信 SendSms（RPC 签名）
ipcMain.handle('sms:send', async (_ev, opts) => {
  const cfg = readSmsConfig();
  const phone = (opts && opts.phone) || '';
  const code = (opts && opts.code) || genCode();
  if (!/^1\d{10}$/.test(phone)) return { ok: false, msg: '手机号格式不对' };
  if (!cfg.accessKeyId || !cfg.accessKeySecret) {
    return { ok: true, simulated: true, code: code, msg: '阿里云短信未配置（缺 accessKeyId/accessKeySecret），已用本地模拟码。' };
  }
  try {
    const param = {
      SignName: cfg.signName || '深鲸律师端',
      TemplateCode: cfg.templateCode || '',
      PhoneNumbers: phone,
      // 模板参数：code=验证码, time=有效分钟数（模板：验证码为${code}，${time}分钟内有效）
      TemplateParam: JSON.stringify({ code: code, time: String(cfg.smsMinutes || 5) }),
      RegionId: cfg.regionId || 'cn-hangzhou',
    };
    if (!param.TemplateCode) return { ok: false, msg: '请先在 sms-config.json 填写 TemplateCode（验证码模板CODE）' };

    // 公共请求参数
    const common = {
      AccessKeyId: cfg.accessKeyId,
      Action: 'SendSms',
      Format: 'JSON',
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: crypto.randomBytes(8).toString('hex'),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: '2017-05-25',
    };
    const all = Object.assign({}, common, param);

    // 1) 按 key 排序，percentEncode，拼 canonicalized query string
    const keys = Object.keys(all).sort();
    const canonical = keys.map(function (k) {
      return aliyunPercentEncode(k) + '=' + aliyunPercentEncode(String(all[k]));
    }).join('&');
    // 2) StringToSign = GET&%2F&<canonical>
    const stringToSign = 'GET&%2F&' + aliyunPercentEncode(canonical);
    // 3) HMAC-SHA1 signature = base64(hmacSha1(secret+'&', stringToSign))
    const signature = crypto.createHmac('sha1', cfg.accessKeySecret + '&').update(stringToSign, 'utf8').digest('base64');
    // 4) 加 Signature 进 query
    const url = 'https://' + (cfg.endpoint || 'dysmsapi.aliyuncs.com') + '/?' + canonical + '&Signature=' + aliyunPercentEncode(signature);

    const resp = await fetch(url, { method: 'GET' });
    const text = await resp.text();
    console.log('[sms] aliyun code=' + code + ' body=' + text.slice(0, 300));
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (data && data.Code === 'OK') return { ok: true, code: code, bizId: data.BizId };
    const msg = (data && data.Message) || text.slice(0, 180);
    return { ok: false, msg: '阿里云短信发送失败：' + msg };
  } catch (e) {
    return { ok: false, msg: '阿里云短信发送失败：' + (e && e.message || String(e)) };
  }
});

// 查询短信配置状态
ipcMain.handle('sms:status', async () => {
  const cfg = readSmsConfig();
  return { configured: !!(cfg.accessKeyId && cfg.accessKeySecret && cfg.templateCode), provider: cfg.provider };
});

// —— Excel/CSV 数据导入解析桥（列头映射用）——
// 读文件 → 用 xlsx 解析出所有 sheet，返回每个 sheet 的二维数组（含表头行）。
// 文件来自前端 <input type=file>，Electron 下 path 在 webUtils.getPathForFile 获取。
ipcMain.handle('import:parse', async (_ev, filePath) => {
  if (!filePath) return { ok: false, msg: '未传文件路径' };
  if (!XLSX) return { ok: false, msg: '未安装 xlsx(SheetJS) 解析库' };
  try {
    const buf = fs.readFileSync(filePath);
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    const sheets = [];
    wb.SheetNames.forEach(function (name) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      sheets.push({ name: name, rows: rows });
    });
    return { ok: true, sheets: sheets };
  } catch (e) {
    return { ok: false, msg: '解析失败：' + (e && e.message || String(e)) };
  }
});

// 无真实路径时的兜底：直接解析 Buffer
ipcMain.handle('import:parseBuffer', async (_ev, buf, name) => {
  if (!buf) return { ok: false, msg: '空文件' };
  try {
    const wb = XLSX.read(Buffer.from(buf), { type: 'buffer', cellDates: true });
    const sheets = [];
    wb.SheetNames.forEach(function (n) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' });
      sheets.push({ name: n, rows: rows });
    });
    return { ok: true, sheets: sheets };
  } catch (e) {
    return { ok: false, msg: '解析失败：' + (e && e.message || String(e)) };
  }
});

// —— 公益律师/法学生 免费申请 审核存储（本地 JSON，运营后台读取/审核）——
const FREE_STORE = process.env.HOME ? path.join(process.env.HOME, '.deepwhale-legal', 'free-applications.json') : null;
function readFreeStore() {
  try { return JSON.parse(fs.readFileSync(FREE_STORE, 'utf8')); } catch { return { applications: [] }; }
}
function writeFreeStore(d) {
  try { fs.mkdirSync(path.dirname(FREE_STORE), { recursive: true }); fs.writeFileSync(FREE_STORE, JSON.stringify(d, null, 2)); return true; } catch { return false; }
}
// 用户端提交免费申请（写入待审核）
ipcMain.handle('free:submit', async (_ev, app) => {
  if (!app) return { ok: false, msg: '空申请' };
  const d = readFreeStore();
  d.applications.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), status: 'pending', app, at: Date.now() });
  return { ok: writeFreeStore(d) };
});
// 运营后台读取申请列表
ipcMain.handle('free:list', async () => {
  const d = readFreeStore();
  return d.applications || [];
});
// 运营后台审核决定: id, decide='approve'|'reject', reason
ipcMain.handle('free:decide', async (_ev, o) => {
  const d = readFreeStore();
  const it = (d.applications || []).find(x => x.id === o.id);
  if (!it) return { ok: false, msg: '申请不存在' };
  it.status = o.decide === 'approve' ? 'approved' : 'rejected';
  it.reason = o.reason || '';
  it.decidedAt = Date.now();
  return { ok: writeFreeStore(d) };
});
// 用户端：按机器码查自己的免费申请审核状态（运营审批后，用户端据此自动生效）
ipcMain.handle('free:check', async (_ev, machine) => {
  const d = readFreeStore();
  const it = (d.applications || []).filter(x => x.app && x.app.machine === machine).slice().reverse()[0];
  return it ? { found: true, status: it.status, reason: it.reason, name: it.app.name } : { found: false };
});

// —— 律师实名核验 审核存储（用户提交律师信息 → 后台人工核验 → 通过才可登录）——
const RESTORE_STORE = process.env.HOME ? path.join(process.env.HOME, '.deepwhale-legal', 'lawyer-applications.json') : null;
function readResStore() {
  try { return JSON.parse(fs.readFileSync(RESTORE_STORE, 'utf8')); } catch { return { applications: [] }; }
}
function writeResStore(d) {
  try { fs.mkdirSync(path.dirname(RESTORE_STORE), { recursive: true }); fs.writeFileSync(RESTORE_STORE, JSON.stringify(d, null, 2)); return true; } catch { return false; }
}
// 用户提交律师实名（写入待核验）
ipcMain.handle('lawyer:submit', async (_ev, app) => {
  if (!app) return { ok: false, msg: '空申请' };
  const d = readResStore();
  // 去重：同机器同时最多一个待核验/已通过
  const existing = (d.applications || []).findIndex(x => x.app && x.app.machine === app.machine && (x.status === 'pending' || x.status === 'approved'));
  if (existing >= 0) { const old = d.applications[existing]; old.app = app; old.at = Date.now(); return { ok: writeResStore(d) }; }
  d.applications.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), status: 'pending', app, at: Date.now() });
  return { ok: writeResStore(d) };
});
// 运营后台读取律师实名申请
ipcMain.handle('lawyer:list', async () => {
  const d = readResStore();
  return d.applications || [];
});
// 运营后台核验决定: id, decide='approve'|'reject', reason
ipcMain.handle('lawyer:decide', async (_ev, o) => {
  const d = readResStore();
  const it = (d.applications || []).find(x => x.id === o.id);
  if (!it) return { ok: false, msg: '申请不存在' };
  it.status = o.decide === 'approve' ? 'approved' : 'rejected';
  it.reason = o.reason || '';
  it.decidedAt = Date.now();
  return { ok: writeResStore(d) };
});
// 用户端：按机器码查自己的律师实名核验状态（通过后 user 端自动建档进工作台）
ipcMain.handle('lawyer:check', async (_ev, machine) => {
  const d = readResStore();
  const it = (d.applications || []).filter(x => x.app && x.app.machine === machine).slice().reverse()[0];
  return it ? { found: true, status: it.status, reason: it.reason, name: it.app.name } : { found: false };
});

// 运营后台：新开窗口加载 admin.html（本地审核页）
ipcMain.handle('admin:open', async () => {
  const { BrowserWindow: BW } = require('electron');
  const w = new BW({ width: 1100, height: 820, title: '深鲸·律师端 · 运营后台', backgroundColor: '#0d1424', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  w.loadFile(path.join(__dirname, 'admin.html'));
  return { ok: true };
});
// 用系统默认浏览器打开外部链接
ipcMain.handle('shell:openExternal', async (_ev, url) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) {
    try { require('electron').shell.openExternal(url); return { ok: true }; } catch (e) { return { ok: false, msg: String(e) }; }
  }
  return { ok: false, msg: '非法链接' };
});

// —— 唤回深鲸桌面端（DeepWhale Desktop）窗口到前台（macOS osascript；Win/Linux 预留）——
ipcMain.handle('dsh:focus', async () => {
  try {
    if (process.platform === 'darwin') {
      // 把 DeepWhale Desktop 应用带到前台并还原窗口
      const { execFile } = require('child_process');
      await new Promise((resolve, reject) => {
        execFile('osascript', ['-e', 'tell application "DeepWhale Desktop" to activate'], { timeout: 8000 },
          (err, so, se) => err ? reject(new Error(se || err.message)) : resolve());
      });
      return { ok: true };
    }
    // Win/Linux 占位：后续用对应系统命令
    return { ok: false, msg: '当前平台暂不支持唤回，请手动切换窗口' };
  } catch (e) {
    return { ok: false, msg: '唤回失败：' + (e && e.message || String(e)) };
  }
});

// —— 反馈/Bug 存储（运营后台读取/采纳/加试用时长）——
const FB_STORE = process.env.HOME ? path.join(process.env.HOME, '.deepwhale-legal', 'feedback.json') : null;
function readFb() { try { return JSON.parse(fs.readFileSync(FB_STORE, 'utf8')); } catch { return { items: [] }; } }
function writeFb(d) { try { fs.mkdirSync(path.dirname(FB_STORE), { recursive: true }); fs.writeFileSync(FB_STORE, JSON.stringify(d, null, 2)); return true; } catch { return false; } }

// —— 用 Agent Mail(agently-cli) 发反馈邮件到 service@deepwhale.org ——
// 运行时探测 agently-cli（打包后不同机器路径可能不同），找不到则发邮件降级跳过
const AGENTLY_CLI = (function () {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('which', ['agently-cli'], { encoding: 'utf8', timeout: 3000 });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim();
  } catch (e) { /* ignore */ }
  return '/Users/mac/.npm-global/bin/agently-cli'; // 本机兜底
})();
const FEEDBACK_TO = 'service@deepwhale.org';
function runAgently(args) {
  return new Promise((resolve, reject) => {
    execFile(AGENTLY_CLI, args, { timeout: 45000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message || '').slice(0, 300)));
      resolve(String(stdout || ''));
    });
  });
}
async function sendFeedbackEmail(rec) {
  try {
    const subject = '[深鲸律师端反馈] ' + (rec.type === 'bug' ? 'Bug问题' : rec.type === 'advice' ? '改进建议' : '使用疑问') + ' - ' + (rec.name || '用户');
    const reply = rec.email ? ('（可回复用户邮箱：' + rec.email + '）') : '';
    const body = [
      '类型：' + (rec.type === 'bug' ? 'Bug 问题' : rec.type === 'advice' ? '改进建议' : '使用疑问'),
      '描述：' + (rec.desc || ''),
      '手机号：' + (rec.phone || '未填写'),
      reply,
      '时间：' + new Date((rec.at || Date.now())).toLocaleString('zh-CN'),
    ].filter(Boolean).join('\n');
    // 1) 发起发送，取确认 token
    const first = JSON.parse(await runAgently(['message', '+send', '--to', FEEDBACK_TO, '--subject', subject, '--body', body]));
    if (!first || !first.ok) return { ok: false, msg: (first && first.data && first.data.message) || '发送被拒' };
    if (first.data && first.data.confirmation_required && first.data.confirmation_token) {
      // 2) 带确认 token 正式发送
      const second = JSON.parse(await runAgently(['message', '+send', '--to', FEEDBACK_TO, '--subject', subject, '--body', body, '--confirmation-token', first.data.confirmation_token]));
      if (!second || !second.ok) return { ok: false, msg: (second && second.data && second.data.message) || '确认后发送失败' };
      return { ok: true, queued: !!(second.data && second.data.queued) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: '邮件发送失败：' + (e && e.message || String(e)) };
  }
}
ipcMain.handle('feedback:submit', async (_ev, rec) => {
  if (!rec) return { ok: false, msg: '空反馈' };
  const d = readFb();
  d.items.push({ id: rec.id, type: rec.type, desc: rec.desc, phone: rec.phone, email: rec.email || '', name: rec.name || '', status: rec.status || 'pending', machine: rec.machine || '', approvedDays: 0, at: rec.at || Date.now() });
  writeFb(d);
  // 发送邮件到 service@deepwhale.org（异步，不阻塞反馈存储）
  const mail = await sendFeedbackEmail(rec);
  return { ok: true, emailed: mail.ok, mailMsg: mail.msg || '' };
});
ipcMain.handle('feedback:list', async () => { return readFb().items || []; });
// 运营确认采纳：approve 反馈并给奖励天数
ipcMain.handle('feedback:approve', async (_ev, o) => {
  const d = readFb();
  const it = (d.items || []).find(x => x.id === o.id);
  if (!it) return { ok: false, msg: '反馈不存在' };
  it.status = 'approved';
  it.approvedDays = parseInt(o.days, 10) || 7;
  it.approvedAt = Date.now();
  return { ok: writeFb(d) };
});
// 用户端：查询被采纳(approved且approvedDays>0)的反馈（用于轮询延长试用）
ipcMain.handle('feedback:listApproved', async () => {
  return (readFb().items || []).filter(x => x.status === 'approved' && x.approvedDays && x.approvedDays > 0).map(x => ({ id: x.id, approvedDays: x.approvedDays }));
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1460,
    height: 950,
    minWidth: 1100,
    minHeight: 720,
    title: '深鲸律师端 · 律师工作台',
    backgroundColor: '#0d1424',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadURL(WORKBENCH);
}

// 独立运营后台窗口（仅打开 admin.html，不进入律师工作台；审核/核验用）
function createAdminWindow() {
  const win = new BrowserWindow({
    width: 1120, height: 860, title: '深鲸·律师端 · 运营后台（审核核验）', backgroundColor: '#0d1424',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  // 允许外部链接（如「打开官网核验」→ credit.acla.org.cn）用系统默认浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      require('electron').shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  // 同窗口内点击外部链接也交给系统浏览器
  win.webContents.on('will-navigate', (e, url) => {
    if (/^https?:/i.test(url) && !url.includes('file://')) {
      e.preventDefault();
      require('electron').shell.openExternal(url);
    }
  });
  win.loadFile(path.join(__dirname, 'admin.html'));
}

// —— 运营后台 HTTP API（局域网设备提交免费申请/律师核验/反馈并轮询结果；仅 admin 模式启动）——
function startAdminApiServer() {
  const http = require('http');
  const port = Number(process.env.DSH_ADMIN_PORT || 7777);
  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const u = new URL(req.url, 'http://localhost');
    console.log('[admin-api] ' + req.method + ' ' + u.pathname + ' from ' + req.socket.remoteAddress);
    const send = (code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors)); res.end(JSON.stringify(obj)); };
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      let o = {};
      try { o = body ? JSON.parse(body) : {}; } catch { return send(400, { ok: false, msg: 'JSON 解析失败' }); }
      if (req.method === 'GET' && u.pathname === '/api/ping') return send(200, { ok: true, service: 'deepwhale-legal-admin', at: Date.now() });
      if (req.method === 'POST' && u.pathname === '/api/free-apply') {
        if (!o.name || !o.machine) return send(400, { ok: false, msg: '缺少姓名/机器码' });
        const app = { name: o.name, no: o.no || '', org: o.org || '', firm: o.firm || '', phone: o.phone || '', machine: o.machine, file: { name: o.fileName || '', data: o.fileBase64 || '' } };
        const d = readFreeStore();
        const ex = (d.applications || []).findIndex((x) => x.app && x.app.machine === o.machine && x.status === 'pending');
        if (ex >= 0) { d.applications[ex].app = app; d.applications[ex].at = Date.now(); }
        else d.applications.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), status: 'pending', app, at: Date.now() });
        return send(200, { ok: writeFreeStore(d) });
      }
      if (req.method === 'GET' && u.pathname === '/api/free-check') {
        const machine = u.searchParams.get('machine') || '';
        const d = readFreeStore();
        const it = (d.applications || []).filter((x) => x.app && x.app.machine === machine).slice().reverse()[0];
        return send(200, it ? { found: true, status: it.status, reason: it.reason || '', app: it.app } : { found: false });
      }
      if (req.method === 'POST' && u.pathname === '/api/lawyer-verify') {
        if (!o.name || !o.machine) return send(400, { ok: false, msg: '缺少姓名/机器码' });
        const d = readResStore();
        const ex = (d.applications || []).findIndex((x) => x.app && x.app.machine === o.machine && (x.status === 'pending' || x.status === 'approved'));
        if (ex >= 0) { d.applications[ex].app = o; d.applications[ex].at = Date.now(); }
        else d.applications.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), status: 'pending', app: o, at: Date.now() });
        return send(200, { ok: writeResStore(d) });
      }
      if (req.method === 'GET' && u.pathname === '/api/lawyer-check') {
        const machine = u.searchParams.get('machine') || '';
        const d = readResStore();
        const it = (d.applications || []).filter((x) => x.app && x.app.machine === machine).slice().reverse()[0];
        return send(200, it ? { found: true, status: it.status, reason: it.reason || '', name: it.app.name } : { found: false });
      }
      if (req.method === 'POST' && u.pathname === '/api/feedback') {
        if (!o.desc) return send(400, { ok: false, msg: '缺少描述' });
        const d = readFb();
        d.items = d.items || [];
        const rec = { id: o.id || Date.now().toString(36), type: o.type || 'advice', desc: o.desc, phone: o.phone || '', email: o.email || '', name: o.name || '', status: 'pending', machine: o.machine || '', approvedDays: 0, at: Date.now() };
        d.items.push(rec);
        const okW = writeFb(d);
        // 同步发邮件（异步，不阻塞响应）
        sendFeedbackEmail(rec).catch(() => {});
        return send(200, { ok: okW, emailed: true });
      }
const SMS_CODES = {};
async function doSendSms(phone) {
  const cfg = readSmsConfig();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  if (!cfg.endpoint) {
    return { ok: true, simulated: true, code, msg: '短信接口未配置，已用本地模拟' };
  }
  try {
    const signName = cfg.signName || '深鲸律师端';
    const content = '【' + signName + '】您的验证码为' + code + '，5分钟内有效。如非本人操作请忽略。';
    const q = new URLSearchParams({ content, mobile: phone }).toString();
    const url2 = cfg.endpoint + (cfg.endpoint.includes('?') ? '&' : '?') + q;
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.appCode) { headers['X-Apig-AppCode'] = cfg.appCode; headers['Authorization'] = 'APPCODE ' + cfg.appCode; }
    const resp = await fetch(url2, { method: (cfg.method || 'POST').toUpperCase(), headers });
    const text = await resp.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    const ok = data && data.ReturnStatus && /success/i.test(String(data.ReturnStatus));
    if (!ok) return { ok: false, msg: (data && data.Message) || text.slice(0, 120) };
    return { ok: true, simulated: false, code, msg: '发送成功' };
  } catch (e) {
    return { ok: false, msg: String(e && e.message || e) };
  }
}

      if (req.method === 'POST' && u.pathname === '/api/send-sms') {
        const phone = o.phone || '';
        if (!/^1\d{10}$/.test(phone)) return send(400, { ok: false, msg: '手机号格式不对' });
        const r = await doSendSms(phone);
        if (r.ok) SMS_CODES[phone] = { code: r.code, exp: Date.now() + 5 * 60000 };
        return send(200, { ok: r.ok, simulated: !!r.simulated, msg: r.msg || '', code: r.simulated ? r.code : '' });
        return send(200, { ok: r.ok, simulated: !!r.simulated, msg: r.msg || '' });
      }
      if (req.method === 'POST' && u.pathname === '/api/verify-sms') {
        const phone = o.phone || '';
        const rec = SMS_CODES[phone];
        if (!rec || Date.now() > rec.exp) return send(200, { ok: false, msg: '验证码无效或已过期' });
        if (String(o.code) !== rec.code) return send(200, { ok: false, msg: '验证码不正确' });
        delete SMS_CODES[phone];
        return send(200, { ok: true });
      }
      if (req.method === 'GET' && u.pathname === '/api/feedback-poll') {
        const machine = u.searchParams.get('machine') || '';
        const processed = (u.searchParams.get('processed') || '').split(',').filter(Boolean);
        const items = (readFb().items || []).filter((x) => x.machine === machine && x.status === 'approved' && Number(x.approvedDays) > 0 && processed.indexOf(String(x.id)) < 0)
          .map((x) => ({ id: String(x.id), approvedDays: Number(x.approvedDays) || 0 }));
        return send(200, { ok: true, items });
      }
      send(404, { ok: false, msg: 'not found' });
    });
  });
  server.on('error', (e) => console.log('[admin-api] 启动失败：' + e.message));
  server.listen(port, '0.0.0.0', () => console.log('[admin-api] 运营后台 API 已监听 0.0.0.0:' + port));
}

app.whenReady().then(() => {
  if (process.env.DSH_ADMIN === '1') { startAdminApiServer(); createAdminWindow(); return; }
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { if (process.env.DSH_ADMIN === '1') createAdminWindow(); else createWindow(); } });

// 判断是否为"由深鲸桌面端(deepwhale-law://start)启动"。深鲸桌面端通过协议启动本应用时：
//  - macOS 触发 app.on('open-url')，设置 __launchedViaDsh
//  - 也兼容 argv 含 deepwhale-law、或 DSH_LAUNCHED=1 环境变量标记
function launchedByDsh() {
  if (__launchedViaDsh) return true;
  if (process.env.DSH_LAUNCHED === '1') return true;
  const args = (process.argv || []).join(' ');
  return /deepwhale-law/i.test(args);
}
