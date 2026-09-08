#!/usr/bin/env node
// 深鲸律师端 · 本地一键发码工具
// 用法：node license-tool.js   →  浏览器打开 http://127.0.0.1:8899
// 私钥(口令加密)只在本地；授权码本地生成 → 自动上传到华为云服务器后端。
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { URL } = require('url');

const CONFIG_PATH = path.join(__dirname, 'license-tool-config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const ADMIN_TOKEN = config.adminToken || '';
const SERVER = (config.serverBase || 'http://115.120.202.30:8080').replace(/\/$/, '');
const PRIV_PATH = path.join(__dirname, 'issuer', 'issuer-private.pem');
const DEFAULT_EXP = config.defaultExpiry || '2030-12-31';
const PRODUCT = config.product || 'legal-workbench';
const PORT = Number(config.port || 8899);

function issueLicense(machine, exp, product) {
  const priv = crypto.createPrivateKey({ key: fs.readFileSync(PRIV_PATH), passphrase: config.passphrase });
  const payload = Buffer.from(JSON.stringify({ p: product || PRODUCT, m: machine, e: exp || DEFAULT_EXP }));
  const sig = crypto.sign(null, payload, priv);
  return payload.toString('base64') + '.' + sig.toString('base64');
}

const HTML = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>深鲸律师端 · 一键发码</title>
<style>
body{font-family:-apple-system,'PingFang SC',sans-serif;background:#0b0f17;color:#e8edf5;margin:0;padding:28px;max-width:980px;margin:auto}
h1{font-size:20px;margin:0 0 6px}h2{font-size:15px;color:#9fb0c8;font-weight:500;margin:6px 0 14px}
.toolbar{display:flex;gap:10px;align-items:center;margin:14px 0}
.toolbar input{background:#151b26;border:1px solid #2a3446;color:#e8edf5;padding:8px 10px;border-radius:8px}
.toolbar .btn{background:#2b6cff;color:#fff;border:0;padding:9px 16px;border-radius:8px;cursor:pointer}
table{width:100%;border-collapse:collapse;background:#111722;border-radius:12px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;font-size:13px;border-bottom:1px solid #1e2836}
th{background:#161e2c;color:#9fb0c8;font-weight:500}
td.mono{font-family:Menlo,monospace;font-size:12px;color:#7fd0ff;word-break:break-all}
.issue{background:#2b6cff;color:#fff;border:0;padding:7px 12px;border-radius:7px;cursor:pointer}
.issue:hover{background:#3b7cff}
.done{color:#4fd9c9}.err{color:#ff8080}
.empty{color:#5b6b82;padding:20px;text-align:center}
pre{background:#0d1420;padding:12px;border-radius:8px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-all;margin-top:6px}
.note{color:#5b6b82;font-size:12px;margin-top:8px}
</style>
<h1>深鲸律师端 · 一键发码</h1>
<h2>在下方点「发码」：用本地私钥生成绑机器授权码，并自动上传到服务器（用户 App 即可自动领取）</h2>
<div class="toolbar">
  <input id="exp" placeholder="到期日 YYYY-MM-DD" value="${DEFAULT_EXP}">
  <button class="btn" onclick="reload()">刷新列表</button>
</div>
<div id="list" class="empty">加载中…</div>
<div id="out"></div>
<script>
async function reload(){
  const el=document.getElementById('list');
  try{
    const r=await fetch('/api/list'); const d=await r.json();
    if(!d.ok){el.innerHTML='<div class="err">'+ (d.msg||'拉取失败，请检查后端/Token') +'</div>';return;}
    const rows=(d.registrations||[]).map(function(p){
      return '<tr><td>'+p.phone+'</td><td class="mono">'+p.machine+'</td><td>'+((p.at)?new Date(p.at).toLocaleString():'')+'</td><td>'+(p.issued?'<span class="done">已发</span>':'<button class="issue" onclick="issue(\\''+p.phone+'\\',\\''+p.machine+'\\')">发码</button>')+'</td></tr>';
    }).join('');
    el.innerHTML='<table><tr><th>手机号</th><th>机器码</th><th>注册时间</th><th>状态</th></tr>'+rows+'</table>'+((rows?'':'<div class="empty">暂无注册用户</div>'));
  }catch(e){ el.innerHTML='<div class="err">连接后端失败：'+e+'</div>'; }
}
async function issue(phone,machine){
  const exp=document.getElementById('exp').value.trim();
  const out=document.getElementById('out');
  out.innerHTML='签发中…';
  try{
    const r=await fetch('/api/issue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:phone,machine:machine,exp:exp})});
    const d=await r.json();
    if(!d.ok){out.innerHTML='<div class="err">'+ (d.msg||'失败') +'</div>';return;}
    out.innerHTML='<div class="done">✅ 已为 '+phone+' 签发并上传授权码（到期 '+exp+'）</div><pre>'+d.license+'</pre>'+(d.manual?'<div class="note">（也可复制上面的授权码手动发给用户）</div>':'');
    reload();
  }catch(e){out.innerHTML='<div class="err">失败：'+e+'</div>';}
}
reload();
</script></html>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  if (u.pathname === '/api/list') {
    try {
      const r = await fetch(SERVER + '/api/admin/list', { headers: { 'X-Admin-Token': ADMIN_TOKEN } });
      const d = await r.json();
      return sendJson(200, d);
    } catch (e) { return sendJson(200, { ok: false, msg: '连接后端失败：' + String((e && e.message) || e) }); }
  }
  if (u.pathname === '/api/issue' && req.method === 'POST') {
    let b = ''; req.on('data', c => b += c); req.on('end', async () => {
      try {
        const o = JSON.parse(b || '{}');
        const phone = String(o.phone || '').trim();
        const machine = String(o.machine || '').trim();
        const exp = String(o.exp || '').trim() || DEFAULT_EXP;
        if (!machine) return sendJson(200, { ok: false, msg: '缺机器码' });
        const lic = issueLicense(machine, exp, PRODUCT);
        const pr = await fetch(SERVER + '/api/license/put', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
          body: JSON.stringify({ phone: phone, machine: machine, license: lic })
        });
        const pd = await pr.json();
        if (!pd.ok) return sendJson(200, { ok: false, msg: '上传失败：' + (pd.msg || '') });
        return sendJson(200, { ok: true, license: lic });
      } catch (e) { return sendJson(200, { ok: false, msg: '签发失败：' + String((e && e.message) || e) }); }
    }); return;
  }
  sendJson(404, { ok: false, msg: 'not found' });
});
server.listen(PORT, '127.0.0.1', function () {
  console.log('✅ 发码工具已启动：http://127.0.0.1:' + PORT + '   （Ctrl+C 停止）');
  console.log('   关闭本窗口不会影响服务器。');
});
