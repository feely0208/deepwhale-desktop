/* =========================================================================
   wb-data.js — 深鲸·律师端 数据层：.swj 专属数据包（内容加密）+ 分类别 + schemaVersion
   -------------------------------------------------------------------------
   - .swj = 深鲸·律师端专属数据包文件后缀；【内容】AES-256-GCM 加密（用户设口令）。
   - 只有深鲸·律师端能导入（识别专属 header + format + 口令解密）。
   - 我们本机不存、不上传数据；仅提供导出/导入能力。
   - 这套 collect()/get() 也是 C-1（AI agent 读工作台数据）的统一数据访问入口。
   ========================================================================= */
(function () {
  var FORMAT = 'deepwhale-legal-workbench';
  var VERSION = 1;
  var SCHEMA_VERSION = 1;
  var MAGIC = 'SWJ1'; // magic header 字节，标识深鲸·律师端数据包

  // 分类别：localStorage 键  类别
  var CATEGORY_MAP = [
    { cat: 'profile',   keys: ['legal-mode.profile', 'legal-mode.profileInfo', 'legal-mode.lawyer', 'legal-mode.team'] },
    { cat: 'clients',   keys: ['legal-mode.clients'] },
    { cat: 'contracts', keys: ['legal-mode.contracts'] },
    { cat: 'finance',   keys: ['legal-mode.fees'] },
    { cat: 'documents', keys: ['legal-mode.documents', 'legal-mode.docTemplates'] },
    { cat: 'evidence',  keys: ['legal-mode.evidence'] },
    { cat: 'approvals', keys: ['legal-mode.approvals'] },
    { cat: 'calendar',  keys: ['legal-mode.calendar'] },
    { cat: 'settings',  keys: ['legal-mode.theme'] },
    { cat: 'intl',      keys: ['legal-kb.intl.items', 'legal-kb.intl.meta', 'legal-kb.intl.cfg', 'intl-compliance.log', 'intl-docs.saved', 'intl-gba.coop', 'intl-arb.cases', 'intl-arb.nodes'] },
  ];

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  // —— 收集：把工作台数据按类别汇总（C-1 也用它做 agent 数据访问） ——
  function collect() {
    var categories = {};
    CATEGORY_MAP.forEach(function (row) {
      var out = {};
      row.keys.forEach(function (k) { var v = lsGet(k); if (v != null) out[k] = v; });
      categories[row.cat] = out;
    });
    // 全量兜底：把深鲸相关的所有自定义键也收集进 _all，避免将来新增模块漏备份
    var all = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        // 只收深鲸工作台命名空间的键（避免把别的应用/浏览器数据也打包进来）
        if (/^(legal-mode\.|intl-|legal-kb\.|legal-lic-|legal-expire-)/.test(k)) {
          var v = lsGet(k);
          if (v != null) all[k] = v;
        }
      }
    } catch (e) { /* ignore */ }
    categories['_all'] = all;
    return { format: FORMAT, version: VERSION, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), categories: categories };
  }

  // —— 口令  AES-GCM 密钥（PBKDF2） ——
  function deriveKey(passphrase, salt) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(String(passphrase)), 'PBKDF2', false, ['deriveKey'])
      .then(function (km) {
        return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: 120000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }

  // —— 导出：collect()  加密  .swj 文件字节 ——
  function exportSwj(passphrase) {
    return collect().then ? Promise.resolve(collect()) : Promise.resolve(collect());
  }
  function exportData(passphrase) {
    if (!passphrase) return Promise.reject(new Error('请设置导出口令'));
    var data = collect();
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(passphrase, salt).then(function (key) {
      var pt = new TextEncoder().encode(JSON.stringify(data));
      return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, pt).then(function (ct) {
        // 组装 .swj：magic + version/schema 明文头 + salt + iv + 密文
        var head = new TextEncoder().encode(MAGIC + '|' + VERSION + '|' + SCHEMA_VERSION);
        var parts = [head, salt, iv, new Uint8Array(ct)];
        var blob = new Blob(parts, { type: 'application/octet-stream' });
        return blob;
      });
    });
  }

  // —— 导入：解析 .swj  口令解密  校验 format/schema  恢复到 localStorage ——
  function importData(file, passphrase) {
    if (!passphrase) return Promise.reject(new Error('请输入导出时的口令'));
    return file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      // 固定前缀头：magic|version|schema
      var headLen = (MAGIC + '|' + VERSION + '|' + SCHEMA_VERSION).length;
      var headText = new TextDecoder().decode(bytes.subarray(0, headLen));
      if (headText !== (MAGIC + '|' + VERSION + '|' + SCHEMA_VERSION)) return Promise.reject(new Error('不是深鲸·律师端数据包(.swj)'));
      var off = headLen;
      var salt = bytes.subarray(off, off + 16); off += 16;
      var iv = bytes.subarray(off, off + 12); off += 12;
      var ct = bytes.subarray(off);
      return deriveKey(passphrase, salt).then(function (key) {
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct).then(function (pt) {
          var data = JSON.parse(new TextDecoder().decode(pt));
          if (data.format !== FORMAT) return Promise.reject(new Error('格式不符'));
          if (data.schemaVersion > SCHEMA_VERSION) return Promise.reject(new Error('数据包来自更新版本，请升级深鲸·律师端'));
          // 恢复（只写回存在的键；按类别还原）
          Object.keys(data.categories).forEach(function (cat) {
            var row = CATEGORY_MAP.find(function (r) { return r.cat === cat; });
            if (!row) return;
            row.keys.forEach(function (k) { if (data.categories[cat][k] != null) lsSet(k, data.categories[cat][k]); });
          });
          return { ok: true, count: Object.keys(data.categories).length };
        });
      });
    });
  }

  // —— 下载 .swj ——
  function download(filename, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || ('深鲸律师端-' + new Date().toISOString().slice(0, 10) + '.swj');
    a.click();
  }


  // —— 弹出"数据管理"（导出/导入 .swj，口令保护）——
  function openDataManager() {
    var m = document.createElement('div'); m.className = 'modal-overlay show';
    m.innerHTML = '<div class="modal glow" style="width:560px">' +
      '<div class="card-head"><h3> 数据管理（.swj 专属数据包 · 内容加密）</h3></div>' +
      '<div class="intl-note" style="margin-bottom:10px">导出为深鲸·律师端专属数据包（.swj），内容用你的口令 AES 加密；<b>只有深鲸·律师端能导入</b>。我们本机不存、不上传你的数据。</div>' +
      '<div class="doc-meta"><div class="mi"><b>导出口令</b><span><input id="dmPass" type="password" style="width:100%;padding:8px 11px;border-radius:9px;border:1px solid rgba(127,127,127,.25);background:rgba(127,127,127,.06);color:inherit" placeholder="设一个口令（导入时需同口令）"></span></div></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">' +
      '<button class="btn btn-primary glow" id="dmExport">导出全套 .swj</button>' +
      '<input id="dmFile" type="file" accept=".swj" style="display:none">' +
      '<button class="btn btn-ghost" id="dmImport">导入 .swj</button>' +
      '<button class="btn btn-ghost" data-close>关闭</button></div>' +
      '<div id="dmMsg" style="margin-top:12px;font-size:12px;opacity:.8"></div>' +
      '</div>';
    document.body.appendChild(m);
    var msg = function (t, ok) { var e = document.getElementById('dmMsg'); if (e) e.textContent = t; };
    m.addEventListener('click', function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute('data-close'))) { m.remove(); return; }
      if (e.target.id === 'dmExport') {
        var pass = document.getElementById('dmPass').value;
        if (!pass) { msg('请先设置导出口令'); return; }
        exportData(pass).then(function (blob) {
          download('', blob); msg('已导出 .swj（内容已用口令加密）', true);
        }).catch(function (err) { msg('导出失败：' + err.message); });
      }
      if (e.target.id === 'dmImport') { document.getElementById('dmFile').click(); }
    });
    var fin = document.getElementById('dmFile');
    if (fin) fin.addEventListener('change', function () {
      var f = fin.files[0]; if (!f) return;
      var pass = document.getElementById('dmPass').value;
      if (!pass) { msg('请输入当初导出时设置的口令'); return; }
      importData(f, pass).then(function (r) { msg('导入成功，共 ' + r.count + ' 类数据已还原'); }).catch(function (err) { msg('导入失败：' + err.message); });
    });
  }


  // —— DSH 数据桥：向父窗口（DSH）暴露工作台数据，供法律模式 agent 感知（C 收官） ——
  function startDataBridge() {
    try {
      window.addEventListener("message", function (ev) {
        var msg = ev.data;
        if (!msg || msg.type !== "deepwhale-legal:request") return;
        // 生产用 targetOrigin 校验 DSH 源；此处先 '*' 便于联调
        var payload = { type: "deepwhale-legal:data", data: collect() };
        (ev.source && ev.source.postMessage ? ev.source : window.parent).postMessage(payload, "*");
      });
    } catch (e) { /* ignore */ }
  }
  try { if (typeof window !== "undefined" && window.addEventListener) startDataBridge(); } catch (e) { /* ignore */ }

  window.WbData = {
    FORMAT: FORMAT, VERSION: VERSION, SCHEMA_VERSION: SCHEMA_VERSION,
    collect: collect, exportData: exportData, importData: importData, download: download, openDataManager: openDataManager, startDataBridge: startDataBridge
  };
})();
