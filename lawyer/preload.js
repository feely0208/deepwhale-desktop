const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { readFileSync } = require('fs');
const path = require('path');

let machineCode, verifyLicense;
// 授权模块自包含：用包内 lib 的 machine.js(取本机机器码) + issuer-public.pem 做验签，
// 不再依赖外部 /Users/mac/legal-license 路径。打包后在不同电脑上运行时动态取本机机器码。
try {
  const { createPublicKey, verify } = require('crypto');
  machineCode = require('./lib/machine.js').machineCode;
  const pub = readFileSync(path.join(__dirname, 'lib', 'issuer-public.pem'), 'utf8');
  verifyLicense = (lic) => {
    try {
      const parts = String(lic || '').trim().split('.');
      if (parts.length !== 2) return { ok: false, msg: '授权码格式错误' };
      const payload = Buffer.from(parts[0], 'base64');
      const sig = Buffer.from(parts[1], 'base64');
      let p; try { p = createPublicKey(pub); } catch { return { ok: false, msg: '公钥无效' }; }
      let okSig = false; try { okSig = verify(null, payload, p, sig); } catch { /* ignore */ }
      if (!okSig) return { ok: false, msg: '签名校验失败（授权码无效）' };
      let o; try { o = JSON.parse(payload.toString()); } catch { return { ok: false, msg: '授权码载荷无效' }; }
      const cur = machineCode();
      if (o.m !== cur) return { ok: false, msg: '该授权码与当前设备不匹配' };
      const exp = new Date(o.e);
      if (isNaN(exp.getTime())) return { ok: false, msg: '到期时间无效' };
      if (exp.getTime() < Date.now()) return { ok: false, msg: '已过期', exp: o.e, remainingDays: 0 };
      return { ok: true, product: o.p, exp: o.e, remainingDays: Math.ceil((exp.getTime() - Date.now()) / 86400000) };
    } catch (e) { return { ok: false, msg: '校验异常：' + (e && e.message || String(e)) }; }
  };
} catch (e) {
  machineCode = () => 'UNAVAILABLE';
  verifyLicense = () => ({ ok: false, msg: '授权模块未就绪' });
}

// —— 真实授权桥（机器码 + 校验）——
contextBridge.exposeInMainWorld('__licenseGetMachine', () => machineCode());
contextBridge.exposeInMainWorld('__licenseVerify', (lic) => verifyLicense(lic));

// —— 真实算力桥（A款=集团算力订阅 / B款=自填 DeepSeek Key）——
// __llmChat({ key?, baseURL?, model?, messages:[{role,content}], temperature?, maxTokens? }) -> {ok, content?, msg?}
contextBridge.exposeInMainWorld('__llmChat', (opts) => ipcRenderer.invoke('llm:chat', opts));
// 查询集团算力 key 是否已配置（A款）
contextBridge.exposeInMainWorld('__getLLMKeyInfo', () => ipcRenderer.invoke('llm:keyinfo'));

// —— 真实短信桥（阿里云短信，经华为云服务器）——
contextBridge.exposeInMainWorld('__sendSms', (opts) => ipcRenderer.invoke('sms:send', opts));
contextBridge.exposeInMainWorld('__verifySms', (opts) => ipcRenderer.invoke('sms:verify', opts));
contextBridge.exposeInMainWorld('__smsStatus', () => ipcRenderer.invoke('sms:status'));

// —— 公益/法学生 免费申请 审核桥 ——
contextBridge.exposeInMainWorld('__freeSubmit', (app) => ipcRenderer.invoke('free:submit', app));
contextBridge.exposeInMainWorld('__freeList', () => ipcRenderer.invoke('free:list'));
contextBridge.exposeInMainWorld('__freeDecide', (o) => ipcRenderer.invoke('free:decide', o));
contextBridge.exposeInMainWorld('__freeCheck', (machine) => ipcRenderer.invoke('free:check', machine));
contextBridge.exposeInMainWorld('__adminOpen', () => ipcRenderer.invoke('admin:open'));

// —— 律师实名核验 桥 ——
contextBridge.exposeInMainWorld('__lawyerSubmit', (app) => ipcRenderer.invoke('lawyer:submit', app));
contextBridge.exposeInMainWorld('__lawyerList', () => ipcRenderer.invoke('lawyer:list'));
contextBridge.exposeInMainWorld('__lawyerDecide', (o) => ipcRenderer.invoke('lawyer:decide', o));
contextBridge.exposeInMainWorld('__lawyerCheck', (machine) => ipcRenderer.invoke('lawyer:check', machine));

// 打开外部链接（系统默认浏览器），供"打开官网核验"等用
contextBridge.exposeInMainWorld('__openExternal', (url) => ipcRenderer.invoke('shell:openExternal', url));
// 唤回深鲸桌面端（DeepWhale Desktop）窗口
contextBridge.exposeInMainWorld('__focusDSH', () => ipcRenderer.invoke('dsh:focus'));

// —— Excel/CSV 数据导入桥 ——
// __parseImportFile(file) -> {ok, sheets:[{name,rows}]}; file 为 <input type=file> 的 File 对象
contextBridge.exposeInMainWorld('__parseImportFile', async (file) => {
  let filePath = '';
  try { filePath = webUtils.getPathForFile(file); } catch (e) {}
  if (!filePath) {
    // 无路径（部分环境）：退化为读 File 的 arrayBuffer，转 Buffer 传给主进程（走 import:parseBuffer）
    const buf = Buffer.from(await file.arrayBuffer());
    return ipcRenderer.invoke('import:parseBuffer', buf, file.name);
  }
  return ipcRenderer.invoke('import:parse', filePath);
});

// —— 反馈/Bug 桥 ——
contextBridge.exposeInMainWorld('__feedbackSubmit', (rec) => ipcRenderer.invoke('feedback:submit', rec));
contextBridge.exposeInMainWorld('__feedbackList', () => ipcRenderer.invoke('feedback:list'));
contextBridge.exposeInMainWorld('__feedbackApprove', (o) => ipcRenderer.invoke('feedback:approve', o));
contextBridge.exposeInMainWorld('__feedbackListApproved', () => ipcRenderer.invoke('feedback:listApproved'));

// 标记环境：本版不再用模板生成（__callHarness 已移除），真算力由 __llmChat 提供
contextBridge.exposeInMainWorld('__HARNESS_EMBEDDED__', false);
