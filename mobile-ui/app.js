/* JS_ERROR_BAR：真机调试 —— 页面里任何未捕获的 JS 错误都**常驻显示**在顶部。
 *
 * 为什么需要：用户报"所有按钮都没用" ✗ —— 这几乎一定是 JS 在绑定事件前就抛错了。
 * 以前只能靠 a) 我抓手机日志（需要 WiFi/USB 连通）b) 猜。现在错误直接显示在屏幕上，
 * 用户拍一眼就知道哪一行炸了。
 */
(function () {
  function bar(text) {
    try {
      var el = document.getElementById('dsh-js-error');
      if (!el) {
        el = document.createElement('div');
        el.id = 'dsh-js-error';
        el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;padding:8px 12px;' +
          'background:#7f1d1d;color:#fff;font:12px/1.5 -apple-system,system-ui,sans-serif;' +
          'white-space:pre-wrap;word-break:break-all;max-height:45vh;overflow:auto';
        (document.body || document.documentElement).appendChild(el);
      }
      el.textContent += (el.textContent ? '\n' : '') + String(text).slice(0, 400);
    } catch (e) { /* 连错误条都建不出来就只能认了 */ }
  }
  window.addEventListener('error', function (ev) {
    bar('JS 错误：' + (ev.message || '') + '\n@' + String(ev.filename || '').split('/').pop() + ':' + ev.lineno);
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    bar('未捕获 Promise：' + String((r && (r.message || r)) || ''));
  });
  window.__dshErrorBar = bar;
})();

/**
 * 深鲸 Mobile · 数据层（手机端 1.2.0）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 分工（方案 B，见 docs/mobile-rpc-protocol.md）
 *   读（会话列表 / 聊天全文 / 附件 / 审批 / 任务）→ **我们自己的** `/mobile/api/*`
 *                                                  （由 dsh-shell-mobile 插件提供）
 *   写（建会话 / 发消息 / 传文件 / 切模型）      → DSH 基础 RPC `/api/*`
 *                                                  （官方客户端走的就是这套）
 * 两条都**同源**：手机访问的地址就是我们网关后面的 DSH，插件的 /mobile/ 直接发这个界面。
 *
 * 为什么附件走官方 RPC 而不是自定义接口（2026-10-19）：
 *   · 图片：`session/prompt` 的 content 里直接带 `{type:'image', mediaType, data(base64)}`，
 *     宿主会做准入/规范化/落盘（与桌面端同一条路）——我们不用碰 DSH 的附件事务；
 *   · 文件：`POST /api/session/uploadFileBinary?sessionId=&name=` 传原始字节拿 receiptId，
 *     再在 prompt 里引用 `{type:'file', receiptId}`（与桌面端同一条路）。
 *   代价：图片要先在手机上压缩（长边 1600 / JPEG 0.82）——不然 12MP 原图 base64 后
 *   5~8MB，走中继隧道会等到天荒地老。
 *
 * 环境区分（重要）：
 *   · 通过网关/DSH 打开（http(s)）→ 走真接口；
 *   · 以 file:// 打开（排版断言脚本就是这么跑的）→ 用内置假数据，**不联网**，
 *     这样"排版断言"和"功能联调"互不干扰。
 */
(function () {
  'use strict';

  var VERSION = '1.2.0';

  // ── 连接配置（独立安装的 App 用）：网关地址 + 会话令牌，存在本机 ──────────
  var STORE_KEY = 'dshMobile.conn';
  function loadConn() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }
  function saveConn(c) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(c));
    } catch (e) {}
  }
  function clearConn() {
    try {
      localStorage.removeItem(STORE_KEY);
    } catch (e) {}
  }
  var conn = loadConn();
  /**
   * 是否"同源即已连上"：**不能只看协议**（独立 App 的本地页面也是 http，会误判成已连接 —— 实测踩到）。
   * 判据：探测一次同源的 /mobile/api/health，通了才算。
   */
  var SAME_ORIGIN = false;   // 由 boot() 里的探测决定
  var ONLINE = false;

  /** 当前所有请求的基地址（独立 App 时是网关地址；同源打开时空串） */
  function base() {
    if (conn && conn.origin) return conn.origin;
    return '';
  }
  function authQuery() {
    // 同源（origin 为空）也要带令牌：网关要求显式令牌，不是所有部署都会下发 cookie
    if (conn && conn.token) return (base().indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(conn.token);
    return '';
  }
  function enc(v) {
    return encodeURIComponent(String(v == null ? '' : v));
  }

  /**
   * 配对：把扫码得到的 origin + 一次性配对码换成会话令牌。
   * 配对码一次性、5 分钟有效（网关侧实现，见 src/main/mobile-gateway.ts）。
   */
  function connect(origin, code) {
    var o = String(origin || '').replace(/\/+$/, '');
    if (!o) return Promise.resolve({ ok: false, reason: 'missing-origin' });
    return fetch(o + '/__pair?code=' + encodeURIComponent(String(code || '').trim().toUpperCase()))
      .then(function (r) { return r.json().catch(function () { return { ok: false, reason: 'bad-json' }; }); })
      .then(function (j) {
        if (!j || !j.ok) return { ok: false, reason: (j && j.reason) || 'pair-failed' };
        conn = { origin: o, token: j.token };
        saveConn(conn);
        ONLINE = true;
        return { ok: true };
      })
      .catch(function (e) { return { ok: false, reason: 'network: ' + e.message }; });
  }

  /** 解析扫码得到的深链：dshmobile://pair?origin=…&code=… */
  function parsePairLink(link) {
    try {
      var s = String(link || '');
      var q = s.indexOf('?');
      if (q < 0) return null;
      var params = new URLSearchParams(s.slice(q + 1));
      var origin = params.get('origin');
      var code = params.get('code');
      if (!origin || !code) return null;
      return { origin: origin, code: code };
    } catch (e) {
      return null;
    }
  }

  // API_FAIL_TOAST：真机调试用 —— 接口失败时把「路径 + 状态码」显示出来，
  // 否则手机上只能看到空列表，完全不知道是 401/502/网络错（局域网能过、公网不行时尤其难查）。
  function jfetch(path, opts) {
    var url = base() + path + authQuery();
    // 跨域（独立 App）时必须带凭据：DSH 的鉴权是 cookie，omit 会让网关拿到 403（实测）
    return fetch(url, Object.assign({ credentials: base() ? 'include' : 'same-origin' }, opts || {})).then(function (r) {
      return r.json().catch(function () {
        if (typeof toast === 'function') toast('接口 ' + r.status + '：' + String(path).slice(0, 46));
        return { ok: false, reason: 'bad-json', status: r.status };
      });
    });
  }

  /** DSH 基础 RPC：POST /api/<ns>/<method>，body 见协议文档 */
  function rpcArgs(nsMethod, args) {
    var rid = 'mobile-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    return jfetch('/api/' + nsMethod, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: rid,
        method: nsMethod,
        payload: { args: args || {} },
      }),
    }).then(function (res) {
      var r = res && res.result;
      if (r && r.ok) return { ok: true, value: r.value };
      return { ok: false, error: (r && r.error) || res };
    });
  }
  function rpc(nsMethod, args) {
    return rpcArgs(nsMethod, { request: args || {} });
  }
  function rpcNoArg(nsMethod) {
    return rpcArgs(nsMethod, {});
  }

  var api = {
    online: ONLINE,
    health: function () {
      return jfetch('/mobile/api/health');
    },
    list: function () {
      return jfetch('/mobile/api/sessions');
    },
    session: function (id) {
      return jfetch('/mobile/api/session?id=' + enc(id));
    },
    chat: function (id) {
      return jfetch('/mobile/api/chat?id=' + enc(id));
    },
    trajectory: function (id) {
      return jfetch('/mobile/api/trajectory?id=' + enc(id));
    },
    trace: function (id) {
      return jfetch('/mobile/api/trace?id=' + enc(id));
    },
    approvals: function (sid) {
      return jfetch('/mobile/api/approvals?sid=' + enc(sid));
    },
    answerApproval: function (id, outcome) {
      return jfetch('/mobile/api/approval/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id, outcome: outcome }),
      });
    },
    attachmentUrl: function (sid, part) {
      return base() + '/mobile/api/attachment?sid=' + enc(sid) + '&id=' + enc(part.attachmentId) + authQuery();
    },
    create: function () {
      return rpc('session/create', {});
    },
    prompt: function (sessionId, content, mode) {
      var requestId = 'mobile-p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      return rpc('session/prompt', {
        requestId: requestId,
        sessionId: sessionId,
        mode: mode || 'queue',
        content: content,
        clientTimeZone: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return undefined; } })(),
      });
    },
    /** 传原始字节（文件）→ {receiptId, file}；用 XHR 是为了拿上传进度（大文件要走中继隧道） */
    uploadFile: function (sessionId, file, onProgress) {
      return new Promise(function (resolve) {
        try {
          var url = base() + '/api/session/uploadFileBinary?sessionId=' + enc(sessionId) +
            '&name=' + enc(file.name || 'file') + authQuery();
          var xhr = new XMLHttpRequest();
          xhr.open('POST', url, true);
          xhr.setRequestHeader('content-type', 'application/octet-stream');
          if (xhr.upload && typeof onProgress === 'function') {
            xhr.upload.onprogress = function (ev) {
              if (ev && ev.lengthComputable) onProgress(ev.loaded / ev.total);
            };
          }
          xhr.onload = function () {
            var j = null;
            try { j = JSON.parse(xhr.responseText || '{}'); } catch (e) { j = null; }
            if (xhr.status === 200 && j && j.ok && j.value) resolve({ ok: true, value: j.value });
            else resolve({ ok: false, status: xhr.status, reason: (j && j.error && j.error.code) || 'upload-failed', detail: (j && j.error && j.error.message) || '' });
          };
          xhr.onerror = function () { resolve({ ok: false, reason: 'network' }); };
          xhr.onabort = function () { resolve({ ok: false, reason: 'aborted' }); };
          xhr.send(file);
        } catch (e) {
          resolve({ ok: false, reason: 'xhr-failed', detail: String(e && e.message) });
        }
      });
    },
    modelCatalog: function () {
      return rpcNoArg('session/modelCatalog');
    },
    selectModel: function (sessionId, provider, model, reasoningEffort) {
      var req = { sessionId: sessionId, provider: provider, model: model };
      if (reasoningEffort) req.reasoningEffort = reasoningEffort;
      return rpc('session/selectModel', req);
    },
  };

  api.connect = connect;
  api.parsePairLink = parsePairLink;
  api.disconnect = function () { clearConn(); conn = null; };
  api.conn = function () { return conn; };
  api.reload = function () { startOnline(); };
  api.version = VERSION;
  window.dshMobileApi = api;
  window.dshMobileConnect = connect;
  window.dshMobileParsePairLink = parsePairLink;
  window.__dshVersion = VERSION;

  // ── 离线（file://）时的假数据：只服务排版断言 ─────────────────────
  var MOCK = {
    sessions: [
      { id: 'session-7929b8cc', title: '创建每日新闻定时推送任务', updatedAt: '3 分钟前' },
      { id: 'session-2f5899d4', title: '服务器介绍', updatedAt: '7 分钟前' },
      { id: 'session-d7609b3a', title: '验证活动页布局', updatedAt: '2 周前' },
    ],
    turns: [
      {
        turn: 1,
        prompt: '给我创建一个定时任务，明早 8 点推送当天科技与财经新闻。',
        promptParts: [{ type: 'text', text: '给我创建一个定时任务，明早 8 点推送当天科技与财经新闻。' }],
        response: '定时任务已创建 ✅\n\n| 触发时间 | 2026-10-16 08:00 (Asia/Shanghai) |\n| 任务名 | 每日科技+财经新闻早报 |',
      },
      {
        turn: 2,
        prompt: '看看这张图',
        promptParts: [
          { type: 'image', attachmentId: 'mock-image', mediaType: 'image/png', width: 630, height: 482, bytes: 324777, name: '截图.png' },
          { type: 'text', text: '看看这张图' },
        ],
        response: '（离线预览：真机下这里显示真实回复）',
      },
    ],
  };

  /** 把时间戳变成"刚刚 / 5 分钟前 / 昨天"——列表副标题用，比原始 id 有用得多 */
  function relTime(ts) {
    if (!ts) return '';
    var t = (typeof ts === 'number') ? ts : Date.parse(ts);
    if (!t || isNaN(t)) return '';
    if (t < 1e12) t = t * 1000;   // 秒级时间戳
    var diff = Date.now() - t;
    if (diff < 0) return '刚刚';
    var min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小时前';
    var day = Math.floor(hr / 24);
    if (day === 1) return '昨天';
    if (day < 30) return day + ' 天前';
    var d = new Date(t);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  /** 文件大小：1 字节也要能读出来（真机上文件类附件必须显示大小） */
  function fmtBytes(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '';
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + ' KB';
    if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
    return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  /**
   * 轻提示（toast）。
   *
   * ⚠️ 为什么必须有：真机实测用户点了「任务/插件/我的/附件」**完全没反应** ✗ ——
   * 死按钮比"提示暂未开放"更糟（用户会以为 App 卡死）。凡是还没做的入口，
   * 一律给一句明确反馈，别让它看起来像坏了。
   */
  function toast(msg) {
    var box = document.getElementById('dsh-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'dsh-toast';
      box.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);' +
        'max-width:80vw;padding:10px 16px;border-radius:12px;background:rgba(20,28,40,.94);' +
        'color:#e8eefc;font-size:13px;line-height:1.5;text-align:center;z-index:99;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.35);opacity:0;transition:opacity .18s ease;pointer-events:none';
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.style.opacity = '1';
    clearTimeout(box.__t);
    box.__t = setTimeout(function () { box.style.opacity = '0'; }, 2600);
  }
  window.__dshToast = toast;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  /** 把会话列表渲染进 #page-list（保留搜索框与"新建会话"） */
  function renderList(sessions) {
    var page = document.getElementById('page-list');
    if (!page) return;
    Array.prototype.slice.call(page.querySelectorAll('.row-btn, .list-empty')).forEach(function (n) {
      n.remove();
    });
    // 本地搜索过滤（真机上原来那个"搜索会话内容"只是个假框，点了没反应 ✗）
    var q = String((document.getElementById('list-search') || {}).value || '').trim().toLowerCase();
    var list = (sessions || []).filter(function (s) {
      if (!q) return true;
      var hay = ((s.title || '') + ' ' + (s.preview || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    if (!list.length) {
      var em = el('div', 'list-empty');
      em.textContent = q ? '没有匹配的会话' : '还没有会话 —— 在电脑上随便聊几句，这里就会出现';
      page.appendChild(em);
      return;
    }
    list.forEach(function (s) {
      var b = el('button', 'row-btn');
      b.setAttribute('data-id', s.id || '');
      var t = el('span', 't');
      var titleText = s.title && String(s.title).trim() !== '' ? s.title : '新会话';
      // 副标题用**最后一轮的内容预览**（真机反馈"很不好用"：以前只有一行「新会话」，
      // 完全看不出点进去是什么）；没有预览时才退回时间/工作区。
      var subText = (s.preview && String(s.preview).trim()) || relTime(s.updatedAt) || (s.workspace ? String(s.workspace) : '');
      t.appendChild(el('span', 'title', titleText));
      t.appendChild(el('span', 'sub', subText));
      b.appendChild(t);
      var meta = el('span', 'meta');
      meta.appendChild(el('span', 'time', relTime(s.updatedAt) || ''));
      if (s.turnCount) meta.appendChild(el('span', 'turns', s.turnCount + ' 轮'));
      meta.appendChild(el('span', 'chev', '›'));
      b.appendChild(meta);
      b.addEventListener('click', function () {
        openSession(s.id);
      });
      page.appendChild(b);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // 聊天页状态
  // ══════════════════════════════════════════════════════════════════════
  var currentSessionId = '';
  var chatTurns = [];            // 当前会话的轮次（含附件元数据）
  var chatSubscribedId = '';     // SSE 正在跟的会话 id
  var traceTimer = null, traceSig = '';
  var traceVisible = false;
  var approvalPollTimer = null;
  var pendingApprovals = [];     // 手机待审批
  var pendingAtts = [];          // 待发送附件
  var modelCatalog = null;       // session/modelCatalog 结果
  var currentModel = { provider: '', model: '' };   // 当前会话的模型（投影里的真值）
  var attachmentUrlCache = {};   // attachmentId → 已加载过的图片 url

  function stopTracePoll() { if (traceTimer) { clearInterval(traceTimer); traceTimer = null; } traceSig = ''; }
  function stopApprovalPoll() { if (approvalPollTimer) { clearInterval(approvalPollTimer); approvalPollTimer = null; } }

  /** 思考/工具：穿插进聊天气泡（桌面端那条「思考 · …」折叠块） */
  function loadTrace(id) {
    api.trace(id).then(function (r) {
      if (!r || !r.ok || !Array.isArray(r.turns)) return;
      var sig = r.turns.length + ':' + JSON.stringify(r.turns).length;
      if (sig === traceSig) return;
      traceSig = sig;
      var byTurn = {};
      r.turns.forEach(function (t) { byTurn[t.turn] = (t.items || []); });
      Array.prototype.slice.call(document.querySelectorAll('#page-chat .think')).forEach(function (n) { n.remove(); });
      Array.prototype.slice.call(document.querySelectorAll('#page-chat .msg')).forEach(function (node) {
        var turn = node.getAttribute('data-turn');
        var items = turn && byTurn[turn];
        if (!items || !items.length) return;
        var nT = items.filter(function (x) { return x.kind === 'reasoning'; }).length;
        var nX = items.filter(function (x) { return x.kind === 'tool'; }).length;
        var box = el('details', 'think');
        var sum = el('summary', 'think-sum');
        sum.textContent = '思考' + (nT ? ' · ' + nT + ' 段' : '') + (nX ? ' · ' + nX + ' 次工具' : '');
        box.appendChild(sum);
        items.forEach(function (x) {
          if (x.kind === 'reasoning') box.appendChild(el('div', 'think-text', x.text));
          else box.appendChild(el('div', 'think-tool', x.name + '  ' + String(x.args || '').slice(0, 160)));
        });
        node.parentNode.insertBefore(box, node);
      });
    }).catch(function () {});
  }
  function startTracePoll(id) { stopTracePoll(); loadTrace(id); traceTimer = setInterval(function () { loadTrace(id); }, 1500); }

  /** 任务页：真数据（DSH 的定时任务表） */
  function loadTasks() {
    var list = document.getElementById('tasks-list');
    if (!list) return;
    list.innerHTML = '<div class="list-empty">正在读取…</div>';
    jfetch('/mobile/api/tasks').then(function (r) {
      if (!r || !r.ok) { list.innerHTML = '<div class="list-empty">任务列表拿不到</div>'; return; }
      var ts = r.tasks || [];
      var sub = document.getElementById('tasks-sub');
      if (sub) sub.textContent = ts.length + ' 个定时任务';
      if (!ts.length) { list.innerHTML = '<div class="list-empty">还没有定时任务</div>'; return; }
      list.textContent = '';
      ts.forEach(function (t) {
        var row = el('div', 'plugin-row');
        var head = el('div');
        head.appendChild(el('span', 'pn', String(t.title || t.id || '')));
        if (t.kind) head.appendChild(el('span', 'pv', String(t.kind)));
        row.appendChild(head);
        if (t.prompt) row.appendChild(el('div', 'pd', String(t.prompt).slice(0, 90)));
        list.appendChild(row);
      });
    }).catch(function () {});
  }
  window.__dshLoadTasks = loadTasks;

  /** 我的页：账号/连接、外观、设置、意见反馈、关于、断开 */
  function renderMine() {
    var list = document.getElementById('mine-list');
    if (!list) return;
    var origin = '';
    try { origin = (JSON.parse(localStorage.getItem('dshMobile.conn') || '{}').origin) || ''; } catch (e) {}
    var theme = '';
    try { theme = localStorage.getItem('dshMobile.theme') || ''; } catch (e) {}
    var ver = document.getElementById('mine-ver');
    if (ver) ver.textContent = 'v' + VERSION;

    function section(title) {
      var h = el('div', 'mine-section', title);
      list.appendChild(h);
    }
    function row(label, value, onClick) {
      var r = el('button', 'mine-row');
      var l = el('span', 'mine-label', label);
      r.appendChild(l);
      if (value) r.appendChild(el('span', 'mine-value', value));
      r.appendChild(el('span', 'mine-chev', '›'));
      if (onClick) r.addEventListener('click', onClick);
      list.appendChild(r);
      return r;
    }
    list.textContent = '';
    section('连接');
    row('服务器', origin || '未连接', function () {
      if (typeof toast === 'function') toast(origin || '还没连接');
    });
    row('模型', (document.getElementById('chip-model') || {}).textContent || '—');
    row('强度', (document.getElementById('chip-effort') || {}).textContent || '—');

    section('设置');
    row('外观', theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统', function () {
      var order = ['', 'light', 'dark'];
      var cur = order.indexOf(theme); cur = order[(cur + 1) % order.length];
      theme = cur;
      if (cur === '') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', cur);
      try { localStorage.setItem('dshMobile.theme', cur); } catch (e) {}
      renderMine();
    });
    row('清空界面缓存', '会重新拉取页面', function () {
      try { localStorage.removeItem('dshMobile.mineVer'); } catch (e) {}
      if (typeof toast === 'function') toast('已清空，重新进入即可');
    });

    section('帮助');
    row('意见反馈', 'contact@deepwhale.org.cn', function () {
      if (typeof toast === 'function') toast('意见反馈：contact@deepwhale.org.cn');
    });
    row('使用说明 / 常见问题', '官网', function () {
      if (typeof toast === 'function') toast('https://deepwhale.org.cn');
    });

    section('关于');
    row('版本', VERSION);
    row('断开连接', '需要重新扫码', function () {
      try { localStorage.removeItem('dshMobile.conn'); } catch (e) {}
      conn = null;
      ONLINE = false;
      stopChatStream();
      stopApprovalPoll();
      if (window.__dshMobile && window.__dshMobile.showPage) window.__dshMobile.showPage('connect');
    });
  }
  window.__dshRenderMine = renderMine;

  // ══════════════════════════════════════════════════════════════════════
  // 附件
  // ══════════════════════════════════════════════════════════════════════
  var MAX_IMAGE_EDGE = 1600;     // 长边像素：手机相机原图 4000+ px，缩到这个再传（中继隧道 4G 下必须）
  var JPEG_QUALITY = 0.82;
  var MAX_ATTACHMENTS = 9;

  function pendingCount() { return pendingAtts.length; }
  window.__dshPendingCount = pendingCount;
  window.__dshClearInput = function () {
    pendingAtts = [];
    renderAttStrip();
    var ta = document.getElementById('input');
    if (ta) ta.value = '';
  };

  /** 选附件入口：camera / gallery / file（<input type=file> 由 HTML 提供） */
  window.__dshPick = function (kind) {
    var id = kind === 'camera' ? 'file-camera' : kind === 'gallery' ? 'file-gallery' : 'file-any';
    var input = document.getElementById(id);
    if (!input) return;
    input.value = '';   // 同一个文件再选一次也要触发 change
    input.click();
  };

  /** 压缩图片：createImageBitmap 优先，老 WebView 退回 <img> */
  function compressImage(file) {
    return new Promise(function (resolve) {
      function done(bitmap, w, h) {
        try {
          var scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(w, h));
          var tw = Math.max(1, Math.round(w * scale));
          var th = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement('canvas');
          canvas.width = tw; canvas.height = th;
          var ctx = canvas.getContext('2d');
          // JPEG 没透明通道：铺白底，避免 PNG 透明区变黑
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, tw, th);
          ctx.drawImage(bitmap, 0, 0, tw, th);
          var dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
          resolve({
            ok: true,
            dataUrl: dataUrl,
            base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
            mediaType: 'image/jpeg',
            width: tw,
            height: th,
            bytes: Math.round((dataUrl.length - dataUrl.indexOf(',')) * 0.75),
          });
        } catch (e) {
          resolve({ ok: false, reason: String(e && e.message) });
        }
      }
      try {
        if (typeof createImageBitmap === 'function') {
          createImageBitmap(file).then(function (bm) {
            done(bm, bm.width, bm.height);
            try { bm.close(); } catch (e) {}
          }).catch(function () { fallback(); });
          return;
        }
      } catch (e) { /* 走 fallback */ }
      fallback();
      function fallback() {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          done(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
          try { URL.revokeObjectURL(url); } catch (e) {}
        };
        img.onerror = function () { resolve({ ok: false, reason: 'decode-failed' }); };
        img.src = url;
      }
    });
  }

  /** 加一个待发送附件（图片先压缩；文件保留 File，发送时才上传） */
  function addAttachment(file) {
    if (!file) return Promise.resolve();
    if (pendingAtts.length >= MAX_ATTACHMENTS) {
      toast('一次最多 ' + MAX_ATTACHMENTS + ' 个附件');
      return Promise.resolve();
    }
    var isImage = /^image\//.test(String(file.type || '')) || /\.(png|jpe?g|webp|gif|bmp|heic)$/i.test(String(file.name || ''));
    var item = {
      key: 'att-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      kind: isImage ? 'image' : 'file',
      name: file.name || (isImage ? '图片' : '文件'),
      size: file.size || 0,
      file: file,
      progress: 0,
    };
    pendingAtts.push(item);
    renderAttStrip();
    if (!isImage) return Promise.resolve();
    return compressImage(file).then(function (r) {
      if (!r.ok) {
        removeAttachment(item.key);
        toast('图片读不出来：' + (r.reason || '格式不支持'));
        return;
      }
      item.previewUrl = r.dataUrl;
      item.base64 = r.base64;
      item.mediaType = r.mediaType;
      item.width = r.width;
      item.height = r.height;
      item.size = r.bytes;
      item.name = (item.name || 'image').replace(/\.[^.]+$/, '') + '.jpg';
      renderAttStrip();
    });
  }

  function removeAttachment(key) {
    pendingAtts = pendingAtts.filter(function (a) { return a.key !== key; });
    renderAttStrip();
  }

  function renderAttStrip() {
    var strip = document.getElementById('att-strip');
    if (!strip) return;
    strip.textContent = '';
    if (!pendingAtts.length) { strip.hidden = true; return; }
    strip.hidden = false;
    pendingAtts.forEach(function (a) {
      var box;
      if (a.kind === 'image') {
        box = el('div', 'att-thumb');
        if (a.previewUrl) {
          var img = el('img');
          img.src = a.previewUrl;
          img.alt = a.name || '';
          box.appendChild(img);
        } else {
          box.appendChild(el('div', 'think-text', '处理中…'));
        }
      } else {
        box = el('div', 'att-file');
        box.appendChild(el('div', 'ico', '📄'));
        var dd = el('div', 'dd');
        dd.appendChild(el('span', 'n', a.name || '文件'));
        dd.appendChild(el('span', 's', fmtBytes(a.size) + (a.progress > 0 && a.progress < 1 ? ' · 上传 ' + Math.round(a.progress * 100) + '%' : '')));
        box.appendChild(dd);
      }
      var x = el('button', 'dx', '✕');
      x.setAttribute('aria-label', '移除附件');
      x.addEventListener('click', function () { removeAttachment(a.key); });
      box.appendChild(x);
      strip.appendChild(box);
    });
  }

  (function wireAttachmentInputs() {
    [['file-camera', 'camera'], ['file-gallery', 'gallery'], ['file-any', 'file']].forEach(function (pair) {
      var input = document.getElementById(pair[0]);
      if (!input) return;
      input.addEventListener('change', function () {
        var files = Array.prototype.slice.call(input.files || []);
        var chain = Promise.resolve();
        files.forEach(function (f) {
          chain = chain.then(function () { return addAttachment(f); });
        });
        input.value = '';
      });
    });
  })();

  // E2E / 调试钩子：把 File 对象直接塞进待发送附件
  // （Electron 里没法点系统文件选择器；真机上走 <input type=file>，同一条 addAttachment 路径）
  window.__dshAttachFiles = function (files) {
    var chain = Promise.resolve();
    Array.prototype.slice.call(files || []).forEach(function (f) {
      chain = chain.then(function () { return addAttachment(f); });
    });
    return chain.then(function () { return pendingAtts.length; });
  };
  /** E2E / 调试用状态快照（真机排障也能用：在控制台敲一下就知道卡在哪） */
  window.__dshState = function () {
    return {
      online: ONLINE,
      sessionId: currentSessionId,
      turns: chatTurns.length,
      approvals: pendingApprovals.length,
      pendingAtts: pendingAtts.length,
      sending: sending,
      page: (document.getElementById('page-chat') || {}).hidden === false ? 'chat' : 'other',
      msgs: document.querySelectorAll('#page-chat .msg').length,
      imgs: document.querySelectorAll('#page-chat .att-img').length,
      traceRows: document.querySelectorAll('#trace-list .trace-turn').length,
      model: (document.getElementById('chip-model') || {}).textContent || '',
      effort: (document.getElementById('chip-effort') || {}).textContent || '',
    };
  };

  // ══════════════════════════════════════════════════════════════════════
  // 聊天渲染
  // ══════════════════════════════════════════════════════════════════════
  function makeImgCard(part, sid, eager) {
    var wrap = el('div');
    wrap.style.marginTop = '8px';
    var img = el('img', 'att-img');
    img.alt = part.name || '图片';
    if (eager) {
      img.loading = 'lazy';
      img.src = api.attachmentUrl(sid, part);
      attachmentUrlCache[part.attachmentId] = img.src;
    } else {
      // 老消息里的图片不预加载：中继隧道下几十张图一起拉会把页面拖死
      var ph = el('div', 'att-file');
      ph.appendChild(el('div', 'ico', '🖼'));
      var dd = el('div', 'dd');
      dd.appendChild(el('span', 'n', part.name || '图片'));
      dd.appendChild(el('span', 's', '点击加载' + (part.width && part.height ? ' · ' + part.width + '×' + part.height : '') + (part.bytes ? ' · ' + fmtBytes(part.bytes) : '')));
      ph.appendChild(dd);
      ph.addEventListener('click', function () {
        if (attachmentUrlCache[part.attachmentId]) {
          img.src = attachmentUrlCache[part.attachmentId];
        } else {
          img.src = api.attachmentUrl(sid, part);
          attachmentUrlCache[part.attachmentId] = img.src;
        }
        ph.replaceWith(wrap);
      });
      wrap.appendChild(ph);
      return wrap;
    }
    img.addEventListener('click', function () {
      var viewer = document.getElementById('viewer');
      var vimg = document.getElementById('viewer-img');
      if (viewer && vimg) { vimg.src = img.src; viewer.hidden = false; }
    });
    wrap.appendChild(img);
    return wrap;
  }

  function makeFileCard(part) {
    var card = el('div', 'att-file');
    card.appendChild(el('div', 'ico', '📄'));
    var dd = el('div', 'dd');
    dd.appendChild(el('span', 'n', part.name || '文件'));
    dd.appendChild(el('span', 's', (part.bytes ? fmtBytes(part.bytes) + ' · ' : '') + '已发送到电脑端会话'));
    card.appendChild(dd);
    card.addEventListener('click', function () {
      toast('文件在电脑端会话里，模型可直接读取');
    });
    return card;
  }

  function makeUserBubble(turn, sid, eagerImages) {
    var wrap = el('div', 'msg me');
    wrap.setAttribute('data-turn', String(turn.turn));
    var parts = turn.promptParts && turn.promptParts.length
      ? turn.promptParts
      : (turn.prompt ? [{ type: 'text', text: turn.prompt }] : []);
    var textParts = parts.filter(function (p) { return p.type === 'text'; });
    var attParts = parts.filter(function (p) { return p.type !== 'text'; });
    attParts.forEach(function (p) {
      if (p.type === 'image') wrap.appendChild(makeImgCard(p, sid, eagerImages));
      else wrap.appendChild(makeFileCard(p));
    });
    if (textParts.length) {
      var text = textParts.map(function (p) { return p.text; }).join('\n');
      wrap.appendChild(document.createTextNode(text));
    }
    if (!textParts.length && !attParts.length) wrap.appendChild(document.createTextNode('（空消息）'));
    return wrap;
  }

  function makeAssistantBubble(turn) {
    var wrap = el('div', 'msg');
    wrap.setAttribute('data-turn', String(turn.turn));
    var text = turn.response || '';
    var parts = text.split('\n\n');
    parts.forEach(function (p, i) {
      if (/^\|/.test(p)) {
        var pre = el('pre');
        pre.textContent = p;
        wrap.appendChild(pre);
      } else if (i === 0) {
        wrap.appendChild(document.createTextNode(p));
      } else {
        var d = el('div');
        d.textContent = p;
        wrap.appendChild(d);
      }
    });
    return wrap;
  }

  function pageNearBottom() {
    var page = document.getElementById('page-chat');
    if (!page) return true;
    return page.scrollHeight - page.scrollTop - page.clientHeight < 80;
  }
  function scrollChatToBottom() {
    var page = document.getElementById('page-chat');
    if (!page) return;
    try {
      page.scrollTop = page.scrollHeight;
      var sc = page.closest ? page.closest('.scroll') : null;
      if (sc) sc.scrollTop = sc.scrollHeight;
    } catch (e) {}
  }

  /** 渲染聊天（turns = [{turn, promptParts, response}]）；保留底部位置感知 */
  function renderChatTurns(turns) {
    var page = document.getElementById('page-chat');
    if (!page) return;
    var stick = pageNearBottom();
    Array.prototype.slice.call(page.querySelectorAll('.msg, .think')).forEach(function (n) { n.remove(); });
    Array.prototype.slice.call(page.querySelectorAll('.traj-row')).forEach(function (n) { n.remove(); });
    var list = turns || [];
    var lastTurn = list.length ? list[list.length - 1].turn : 0;
    list.forEach(function (t) {
      var eager = t.turn >= lastTurn - 1;   // 只有最近两轮的图直接加载
      page.insertBefore(makeUserBubble(t, currentSessionId, eager), null);
      if (t.response) page.insertBefore(makeAssistantBubble(t), null);
    });
    if (ONLINE && currentSessionId && list.length && !traceTimer) {
      startTracePoll(currentSessionId);   // 思考/工具折叠块（1.5s 轮询事件流；已在轮询就别重建）
    }
    if (stick) scrollChatToBottom();
  }

  /** 合并 SSE 增量（replace=true 时整体替换） */
  function applyChatDelta(delta) {
    if (!delta || !Array.isArray(delta.turns)) return;
    if (delta.replace) {
      chatTurns = delta.turns;
    } else {
      var byTurn = {};
      chatTurns.forEach(function (t) { byTurn[t.turn] = t; });
      delta.turns.forEach(function (t) { byTurn[t.turn] = t; });
      chatTurns = Object.keys(byTurn).map(function (k) { return byTurn[k]; })
        .sort(function (a, b) { return a.turn - b.turn; });
    }
    if (traceVisible) return;   // 轨迹 tab 打开时不抢画面
    renderChatTurns(chatTurns);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 审批
  // ══════════════════════════════════════════════════════════════════════
  function renderApprovals(list) {
    pendingApprovals = list || [];
    var slot = document.getElementById('approval-slot');
    var demo = document.getElementById('approval-card');
    if (demo) demo.style.display = ONLINE ? 'none' : '';
    if (!slot) return;
    slot.textContent = '';
    if (!pendingApprovals.length) return;
    pendingApprovals.forEach(function (ap) {
      var card = el('div', 'approval');
      var who = el('div', 'who');
      who.appendChild(el('span', '', '审批中：'));
      var b = el('b', '', String(ap.toolName || '工具'));
      who.appendChild(b);
      card.appendChild(who);
      card.appendChild(el('div', '', String(ap.displayReason || ap.reason || '这个操作需要你授权后才能继续。')));
      if (ap.callId) {
        var cmd = el('div', 'cmd', '调用 ' + String(ap.callId));
        card.appendChild(cmd);
      }
      var acts = el('div', 'acts');
      var deny = el('button', 'btn grow danger', '拒绝');
      var allow = el('button', 'btn grow primary', '允许一次');
      function answer(outcome) {
        if (deny.disabled) return;
        deny.disabled = true;
        allow.disabled = true;
        allow.textContent = '已提交…';
        api.answerApproval(ap.id, outcome).then(function (r) {
          if (r && r.ok) {
            toast(outcome === 'allowed-once' ? '已允许一次' : '已拒绝');
            refreshApprovals();
          } else {
            allow.textContent = '允许一次';
            deny.disabled = false;
            allow.disabled = false;
            toast('回答失败：' + ((r && r.reason) || '未知原因'));
          }
        }).catch(function () {
          allow.textContent = '允许一次';
          deny.disabled = false;
          allow.disabled = false;
          toast('回答失败：网络错误');
        });
      }
      deny.addEventListener('click', function () { answer('rejected'); });
      allow.addEventListener('click', function () { answer('allowed-once'); });
      acts.appendChild(deny);
      acts.appendChild(allow);
      card.appendChild(acts);
      slot.appendChild(card);
    });
  }

  function refreshApprovals() {
    if (!ONLINE || !currentSessionId) return;
    api.approvals(currentSessionId).then(function (r) {
      if (!r || !r.ok) return;
      var list = r.approvals || [];
      var had = pendingApprovals.length;
      renderApprovals(list);
      if (list.length > had) toast('有新的审批请求（可在这里允许/拒绝）');
    }).catch(function () {});
  }

  function startApprovalPoll() {
    stopApprovalPoll();
    if (!ONLINE) return;
    refreshApprovals();
    approvalPollTimer = setInterval(refreshApprovals, 3000);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 轨迹 tab（完整列表视图：思考 + 工具调用）
  // ══════════════════════════════════════════════════════════════════════
  var traceListBox = null;
  function traceBox() {
    if (!traceListBox) traceListBox = document.getElementById('trace-list');
    return traceListBox;
  }

  function renderTraceList(trace, events) {
    var box = traceBox();
    if (!box) return;
    box.textContent = '';
    var turns = (trace && trace.turns) || [];
    var nThink = 0, nTool = 0, nTurns = 0;
    turns.forEach(function (t) {
      (t.items || []).forEach(function (it) {
        if (it.kind === 'reasoning') nThink += 1;
        else if (it.kind === 'tool') nTool += 1;
      });
      if ((t.items || []).length) nTurns += 1;
    });
    var sum = el('div', 'trace-sum');
    sum.textContent = nTurns
      ? nTurns + ' 轮有思考/工具记录 · ' + nThink + ' 段思考 · ' + nTool + ' 次工具调用'
      : '这个会话还没有思考/工具记录';
    box.appendChild(sum);

    turns.forEach(function (t) {
      var items = t.items || [];
      if (!items.length) return;
      var card = el('div', 'trace-turn');
      var head = el('div', 'th');
      head.appendChild(el('span', '', '第 ' + String(t.turn) + ' 轮'));
      var nt = items.filter(function (x) { return x.kind === 'reasoning'; }).length;
      var nx = items.filter(function (x) { return x.kind === 'tool'; }).length;
      head.appendChild(el('span', 'cnt', (nt ? nt + ' 思考' : '') + (nt && nx ? ' · ' : '') + (nx ? nx + ' 工具' : '')));
      card.appendChild(head);
      items.forEach(function (it) {
        if (it.kind === 'reasoning') {
          var r = el('div', 'trace-item think');
          var lab = el('div', 'tl', '思考 · 第 ' + String(it.step || '?') + ' 步');
          r.appendChild(lab);
          r.appendChild(document.createTextNode(it.text || ''));
          card.appendChild(r);
        } else if (it.kind === 'tool') {
          var x = el('div', 'trace-item tool');
          var lab2 = el('div', 'tl', '工具 · 第 ' + String(it.step || '?') + ' 步');
          x.appendChild(lab2);
          x.appendChild(document.createTextNode(String(it.name || '') + '\n' + String(it.args || '')));
          card.appendChild(x);
        }
      });
      box.appendChild(card);
    });

    // 事件时间线兜底：没有 trace（比如旧会话/刚开）时，至少给事件列表
    if (!turns.length && events && events.length) {
      var tl = el('div', 'trace-sum', '事件时间线（' + events.length + ' 条）');
      box.appendChild(tl);
      events.slice(-200).forEach(function (e) {
        var row = el('div', 'traj-row');
        row.appendChild(el('span', 'traj-badge', e.label || e.type || '事件'));
        if (e.detail) row.appendChild(el('span', 'traj-detail', String(e.detail).slice(0, 160)));
        if (e.seq !== null && e.seq !== undefined) row.appendChild(el('span', 'traj-seq', '#' + e.seq));
        box.appendChild(row);
      });
    }
  }

  function loadTraceList() {
    if (!currentSessionId || !ONLINE) {
      renderTraceList({ turns: [] }, []);
      return;
    }
    Promise.all([
      api.trace(currentSessionId).catch(function () { return null; }),
      api.trajectory(currentSessionId).catch(function () { return null; }),
    ]).then(function (res) {
      var trace = res[0] && res[0].ok ? res[0] : { turns: [] };
      var events = res[1] && res[1].ok ? (res[1].events || []) : [];
      renderTraceList(trace, events);
    });
  }

  function showTrace() {
    traceVisible = true;
    var box = traceBox();
    if (box) box.hidden = false;
    Array.prototype.slice.call(document.querySelectorAll('#page-chat .msg, #page-chat .think')).forEach(function (n) { n.hidden = true; });
    var slot = document.getElementById('approval-slot');
    if (slot) slot.hidden = true;
    loadTraceList();
    stopTracePoll();
    stopApprovalPoll();
    traceTimer = setInterval(loadTraceList, 2500);
    setTimeout(scrollChatToBottom, 30);
  }

  function showChat() {
    traceVisible = false;
    var box = traceBox();
    if (box) box.hidden = true;
    Array.prototype.slice.call(document.querySelectorAll('#page-chat .msg, #page-chat .think')).forEach(function (n) { n.hidden = false; });
    var slot = document.getElementById('approval-slot');
    if (slot) slot.hidden = false;
    stopTracePoll();
    if (ONLINE && currentSessionId) {
      startTracePoll(currentSessionId);
      startApprovalPoll();
    }
    var page = document.getElementById('page-chat');
    if (page) page.scrollTop = page.scrollHeight;
    scrollChatToBottom();
  }
  window.__dshShowTrace = showTrace;
  window.__dshShowChat = showChat;

  // ══════════════════════════════════════════════════════════════════════
  // SSE：聊天全文 + 附件 + 审批（页面隐藏就断开 —— 省电，也让桌面端在用户离开手机时接管审批）
  // ══════════════════════════════════════════════════════════════════════
  var chatStream = null;
  function stopChatStream() {
    if (chatStream) {
      try { chatStream.close(); } catch (e) {}
      chatStream = null;
    }
    chatSubscribedId = '';
  }
  function subscribeChat(id) {
    stopChatStream();
    if (!id || !ONLINE) return;
    if (typeof EventSource === 'undefined') return;
    chatSubscribedId = id;
    var url = base() + '/mobile/api/stream?id=' + enc(id) + authQuery();
    try {
      var es = new EventSource(url);
      chatStream = es;
      es.addEventListener('chat', function (ev) {
        if (currentSessionId !== id || traceVisible) return;
        try {
          var d = JSON.parse(ev.data || '{}');
          applyChatDelta(d);
        } catch (e) { /* 单条坏数据不影响连接 */ }
      });
      es.addEventListener('approval', function (ev) {
        if (currentSessionId !== id) return;
        try {
          var d = JSON.parse(ev.data || '{}');
          var list = d.approvals || [];
          var had = pendingApprovals.length;
          renderApprovals(list);
          if (list.length > had) toast('有新的审批请求（可在这里允许/拒绝）');
        } catch (e) {}
      });
      es.addEventListener('turns', function () {
        // 投影预览（兼容旧界面用）；聊天页已由 chat 事件驱动，忽略即可
      });
    } catch (e) {
      /* EventSource 不可用（老 WebView）→ 退回一次性快照，不影响可用性 */
    }
  }

  // 页面隐藏（切后台/锁屏）就断 SSE：手机在口袋里时，审批交回桌面端，不要干等
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopChatStream();
      stopTracePoll();
      stopApprovalPoll();
    } else if (ONLINE && currentSessionId && !traceVisible) {
      subscribeChat(currentSessionId);
      refreshChatSnapshot();
      startApprovalPoll();
    }
  });

  /** 主动拉一次聊天快照（SSE 断线/刚进来时的兜底） */
  function refreshChatSnapshot() {
    if (!ONLINE || !currentSessionId) return Promise.resolve();
    return api.chat(currentSessionId).then(function (r) {
      if (r && r.ok && Array.isArray(r.turns)) {
        chatTurns = r.turns;
        if (!traceVisible) renderChatTurns(chatTurns);
      }
      return r;
    }).catch(function () { return null; });
  }

  // ══════════════════════════════════════════════════════════════════════
  // 打开会话 / 发送
  // ══════════════════════════════════════════════════════════════════════
  function openSession(id) {
    currentSessionId = id || '';
    chatTurns = [];
    traceVisible = false;
    var box = traceBox();
    if (box) box.hidden = true;
    Array.prototype.slice.call(document.querySelectorAll('#page-chat .traj-row')).forEach(function (n) { n.remove(); });
    if (window.__dshMobile && window.__dshMobile.showPage) window.__dshMobile.showPage('chat');
    showChat();
    if (!ONLINE) {
      renderChatTurns(MOCK.turns);
      return;
    }
    subscribeChat(id);            // 先订阅，避免首屏之后的变化丢掉
    refreshChatSnapshot();       // 首屏快照（SSE 也会推一份，谁先到谁渲染）
    startApprovalPoll();
    api.session(id).then(function (r) {
      // chips 显示**真值**（模型/强度/工作区来自投影 modelSelection 等，不是写死的假标签）
      var meta = (r && r.meta) || {};
      currentModel = { provider: String(meta.provider || ''), model: String(meta.model || '') };
      var cm = document.getElementById('chip-model');
      if (cm && meta.model) cm.textContent = shortModelName(String(meta.model));
      var ce = document.getElementById('chip-effort');
      if (ce && meta.effort) ce.textContent = String(meta.effort);
      var cw = document.getElementById('chip-ws');
      if (cw && meta.workspace) { var parts = String(meta.workspace).split('/'); cw.textContent = parts[parts.length - 1] || '未分组'; }
      // 如果 SSE 还没来，用 /session 返回的 chat 字段兜底
      if (!chatTurns.length && r && r.chat && Array.isArray(r.chat.turns)) {
        chatTurns = r.chat.turns;
        if (!traceVisible) renderChatTurns(chatTurns);
      }
    }).catch(function () {});
  }

  function shortModelName(m) {
    var s = String(m || '');
    // 模型 id 形如 deepseek-chat / deepseek-reasoner / deepseek-v4；chip 上只放可读的一段
    return s.length > 18 ? s.slice(0, 18) + '…' : s;
  }

  /** 发送：先建会话（若还没有），传附件，再 prompt */
  var sending = false;
  function send(text) {
    var hasAtt = pendingAtts.length > 0;
    if (!text || !text.trim()) {
      if (!hasAtt) return Promise.resolve({ ok: false, reason: 'empty' });
    }
    if (sending) { toast('上一条还在发送…'); return Promise.resolve({ ok: false, reason: 'busy' }); }
    sending = true;
    // ⚠️ 必须切到会话页：只在 openSession 里切是不够的 —— 用户直接输入发送时
    //    页面还停在列表页，消息渲染了但看不见（E2E 断言抓到的真实 bug）。
    if (window.__dshMobile && window.__dshMobile.showPage) window.__dshMobile.showPage('chat');
    if (!ONLINE) {
      var page = document.getElementById('page-chat');
      page.insertBefore(el('div', 'msg me', text || '（附件）'), null);
      page.insertBefore(el('div', 'msg', '（离线预览，不会真的发送）'), null);
      sending = false;
      return Promise.resolve({ ok: true, offline: true });
    }
    var atts = pendingAtts.slice();
    var content = [];
    var ensure = currentSessionId ? Promise.resolve({ ok: true, value: { sessionId: currentSessionId } }) : api.create();
    return ensure
      .then(function (r) {
        var sid = (r.value && (r.value.sessionId || r.value.id)) || currentSessionId;
        if (!sid) throw new Error('no-session');
        currentSessionId = sid;
        if (!chatSubscribedId) subscribeChat(sid);
        // 附件按顺序：图片走 base64 content part；文件先上传拿 receiptId
        var chain = Promise.resolve();
        atts.forEach(function (a) {
          chain = chain.then(function () {
            if (a.kind === 'image' && a.base64) {
              content.push({
                type: 'image',
                mediaType: a.mediaType || 'image/jpeg',
                data: a.base64,
                name: a.name || 'image.jpg',
              });
              return;
            }
            content.push({ type: 'file', receiptId: '__uploading__' });
            var idx = content.length - 1;
            return api.uploadFile(sid, a.file, function (p) {
              a.progress = p;
              renderAttStrip();
            }).then(function (up) {
              if (!up.ok) {
                content.splice(idx, 1);
                throw new Error('附件上传失败：' + (up.reason || '未知'));
              }
              content[idx] = { type: 'file', receiptId: up.value.receiptId };
            });
          });
        });
        return chain.then(function () {
          if (text && text.trim()) content.push({ type: 'text', text: text.trim() });
          return api.prompt(sid, content).then(function (p) {
            return { ok: p.ok, sessionId: sid, prompt: p };
          });
        });
      })
      .then(function (res) {
        sending = false;
        if (res.ok) {
          pendingAtts = [];
          renderAttStrip();
          attachmentUrlCache = {};
          refreshChatSnapshot();
          setTimeout(scrollChatToBottom, 60);
          return res;
        }
        toast('发送失败：' + ((res.prompt && res.prompt.error && (res.prompt.error.code || res.prompt.error.message)) || '未知原因'));
        return res;
      })
      .catch(function (e) {
        sending = false;
        toast('发送失败：' + String((e && e.message) || e).slice(0, 80));
        return { ok: false, reason: String((e && e.message) || e) };
      });
  }
  window.dshMobileSend = send;
  window.dshMobileReload = startOnline;

  // ⚠️ 这三个按钮以前**画了但没接线** ✗（真机反馈"点进会话退不出"）——
  //    返回 / 新建会话 / 刷新 是手机端最基本的三个动作，必须能点。
  function backToList() {
    try { stopChatStream(); } catch (e) {}
    try { stopTracePoll(); } catch (e) {}
    try { stopApprovalPoll(); } catch (e) {}
    currentSessionId = '';
    pendingApprovals = [];
    renderApprovals([]);
    if (window.__dshMobile && window.__dshMobile.showPage) window.__dshMobile.showPage('list');
    startOnline();   // 回列表时刷新数据（会话可能有新消息）
  }
  window.__dshBack = backToList;
  window.__dshBackToList = backToList;
  window.__dshNew = function () {
    if (!ONLINE) {
      toast('还没连接，先配对');
      return;
    }
    api.create().then(function (r) {
      var id = r && (r.value && (r.value.sessionId || r.value.id) || r.id || (r.session && r.session.id));
      if (id) {
        openSession(id);
      } else {
        toast('新建失败' + (r && r.error && r.error.message ? '：' + r.error.message : ''));
      }
    });
  };
  window.__dshRefresh = function () { startOnline(); };

  /** 页面切换（index.html 的 showPage 会调）：离开聊天页断流，回列表刷新 */
  window.__dshPageChanged = function (name) {
    if (name !== 'chat') {
      stopChatStream();
      stopTracePoll();
      stopApprovalPoll();
    }
  };

  // ══════════════════════════════════════════════════════════════════════
  // chips：模型 / 强度 切换（真值来自 DSH 的 modelCatalog + 投影）
  // ══════════════════════════════════════════════════════════════════════
  function findCatalogModel() {
    if (!modelCatalog || !modelCatalog.groups) return null;
    var wantModel = currentModel.model || (document.getElementById('chip-model') || {}).textContent || '';
    var wantProvider = currentModel.provider || (modelCatalog.default && modelCatalog.default.provider);
    // 1) 先按投影里的**模型 id** 精确匹配（chip 上显示的是短名，不能拿它当 id）
    for (var gi = 0; gi < modelCatalog.groups.length; gi += 1) {
      var g = modelCatalog.groups[gi];
      if (wantProvider && g.id !== wantProvider) continue;
      for (var mi = 0; mi < (g.models || []).length; mi += 1) {
        var m = g.models[mi];
        if (m.id === wantModel) return { provider: g.id, providerName: g.name || g.id, model: m };
      }
    }
    // 2) 退一步按显示名/任意 provider 匹配
    for (var gj = 0; gj < modelCatalog.groups.length; gj += 1) {
      var g1 = modelCatalog.groups[gj];
      for (var mj = 0; mj < (g1.models || []).length; mj += 1) {
        var m1 = g1.models[mj];
        if (m1.id === wantModel || m1.name === wantModel) return { provider: g1.id, providerName: g1.name || g1.id, model: m1 };
      }
    }
    // 退而求其次：默认模型
    if (wantProvider) {
      for (var gj = 0; gj < modelCatalog.groups.length; gj += 1) {
        var g2 = modelCatalog.groups[gj];
        if (g2.id !== wantProvider) continue;
        if ((g2.models || []).length) return { provider: g2.id, providerName: g2.name || g2.id, model: g2.models[0] };
      }
    }
    return null;
  }

  function renderModelSheet() {
    var box = document.getElementById('model-list');
    if (!box) return;
    box.textContent = '';
    var sub = document.getElementById('sheet-model-sub');
    if (!modelCatalog) {
      box.appendChild(el('div', 'list-empty', '正在读取可用模型…'));
      return;
    }
    var cur = findCatalogModel();
    if (sub) sub.textContent = (modelCatalog.routableProviders || []).length + ' 个可用渠道';
    (modelCatalog.groups || []).forEach(function (g) {
      var head = el('div', 'mine-section', String(g.name || g.id));
      box.appendChild(head);
      (g.models || []).forEach(function (m) {
        var b = el('button', 'opt');
        b.appendChild(document.createTextNode(String(m.name || m.id)));
        if (m.description) b.appendChild(el('span', 'sub', String(m.description).slice(0, 14)));
        var selected = cur && cur.provider === g.id && cur.model.id === m.id;
        if (selected) b.setAttribute('aria-current', 'true');
        b.appendChild(el('span', 'ck', selected ? '✓' : ''));
        b.addEventListener('click', function () {
          if (selected) { window.__dshCloseSheets && window.__dshCloseSheets(); return; }
          var effort = m.reasoning && m.reasoning.defaultEffort ? m.reasoning.defaultEffort : undefined;
          pickModel(g.id, m, effort, b);
        });
        box.appendChild(b);
      });
    });
    if (!(modelCatalog.groups || []).length) {
      box.appendChild(el('div', 'list-empty', '没有可用模型（电脑端没配 API Key？）'));
    }
  }

  function pickModel(provider, model, effort, btn) {
    if (!currentSessionId) { toast('先进入一个会话'); return; }
    if (btn) { btn.disabled = true; }
    api.selectModel(currentSessionId, provider, model.id, effort).then(function (r) {
      if (btn) btn.disabled = false;
      if (r && r.ok) {
        currentModel = { provider: provider, model: model.id };
        var cm = document.getElementById('chip-model');
        if (cm) cm.textContent = shortModelName(model.name || model.id);
        var ce = document.getElementById('chip-effort');
        var eff = (r.value && r.value.selected && r.value.selected.reasoningEffort) || effort || '';
        if (ce) ce.textContent = eff || '默认';
        toast('已切到 ' + String(model.name || model.id));
        if (window.__dshCloseSheets) window.__dshCloseSheets();
      } else {
        toast('切换失败：' + ((r && r.error && (r.error.code || r.error.message)) || '未知原因'));
      }
    }).catch(function () { if (btn) btn.disabled = false; toast('切换失败：网络错误'); });
  }

  function openModelSheet() {
    renderModelSheet();
    if (modelCatalog) return;
    api.modelCatalog().then(function (r) {
      if (r && r.ok && r.value) {
        modelCatalog = r.value;
        renderModelSheet();
      } else {
        var box = document.getElementById('model-list');
        if (box) box.textContent = '读不到模型目录（' + JSON.stringify((r && r.error) || {}).slice(0, 80) + '）';
      }
    }).catch(function () {});
  }
  window.__dshOpenModelSheet = openModelSheet;

  function renderEffortSheet() {
    var box = document.getElementById('effort-list');
    if (!box) return;
    box.textContent = '';
    var cur = findCatalogModel();
    var efforts = (cur && cur.model && cur.model.reasoning && cur.model.reasoning.efforts) || [];
    var ce = document.getElementById('chip-effort');
    var curEffort = (ce && ce.textContent) || '';
    if (!efforts.length) {
      box.appendChild(el('div', 'list-empty', cur ? '这个模型没有强度选项' : '先选一个模型'));
      return;
    }
    efforts.forEach(function (e) {
      var b = el('button', 'opt');
      b.appendChild(document.createTextNode(String(e.name || e.id)));
      if (e.description) b.appendChild(el('span', 'sub', String(e.description).slice(0, 12)));
      var selected = String(e.id) === curEffort || String(e.name) === curEffort;
      if (selected) b.setAttribute('aria-current', 'true');
      b.appendChild(el('span', 'ck', selected ? '✓' : ''));
      b.addEventListener('click', function () {
        if (selected) { window.__dshCloseSheets && window.__dshCloseSheets(); return; }
        pickModel(cur.provider, cur.model, e.id, b);
      });
      box.appendChild(b);
    });
  }
  function openEffortSheet() {
    if (!modelCatalog) {
      api.modelCatalog().then(function (r) {
        if (r && r.ok && r.value) modelCatalog = r.value;
        renderEffortSheet();
      }).catch(function () { renderEffortSheet(); });
    } else {
      renderEffortSheet();
    }
  }
  window.__dshOpenEffortSheet = openEffortSheet;

  // ══════════════════════════════════════════════════════════════════════
  // 令牌失效：401/403 不要"进去了但全死" —— 明确回到连接页并说明原因
  // ══════════════════════════════════════════════════════════════════════
  function showConnectExpired(detail) {
    ONLINE = false;
    stopChatStream();
    stopApprovalPoll();
    var prevOrigin = (conn && conn.origin) || '';
    clearConn();
    conn = null;
    if (window.__dshMobile && window.__dshMobile.showPage) window.__dshMobile.showPage('connect');
    var originEl = document.getElementById('conn-origin');
    if (originEl && prevOrigin) originEl.value = prevOrigin;
    var err = document.getElementById('conn-err');
    if (err) err.textContent = '连接已失效（电脑重启或令牌已轮换），请重新扫码。' + (detail ? '（' + detail + '）' : '');
    toast('连接已失效，请重新扫码');
  }

  // 搜索框：本地过滤（真机上原来点它没反应 ✗）
  (function () {
    var box = document.getElementById('list-search');
    if (!box) return;
    box.addEventListener('input', function () { renderList(null); });
  })();

  // 还没做的入口：给明确反馈（别让用户以为按钮坏了）
  (function wireUnimplemented() {
    var items = [
      ['nav-plugins', '插件：还没做，下一步接'],
      ['chip-ws', '当前工作区：切换还没做（会随会话显示真值）'],
    ];
    items.forEach(function (it) {
      var node = document.getElementById(it[0]);
      if (!node) return;
      node.addEventListener('click', function () {
        if (it[0] === 'chip-ws') {
          toast(it[1]);
          return;
        }
        toast(it[1]);
      });
    });
  })();

  // ── 启动 ─────────────────────────────────────────────────────────
  function boot() {
    // ⚠️ 外壳跳转过来时会带 `?token=…`（见 Android 壳的连接逻辑）——必须**接住它**：
    //    否则页面的 API 请求没有令牌 → 网关 401 → 页面退回连接页（实测：壳跳转成功但列表 0 行）。
    try {
      var qs = new URLSearchParams(location.search || '');
      var urlToken = qs.get('token');
      // ⚠️ 每次都用 URL 里的令牌：localStorage 里可能是上次会话的旧令牌（网关重启会换）
      //    → 旧令牌让所有请求 401 → 页面「能进但全死」（真机多次踩到 ✗）
      if (urlToken) {
        conn = { origin: '', token: urlToken };   // origin 空 = 同源
        saveConn(conn);
        // 把令牌从地址栏抹掉（别留在历史里）
        try { history.replaceState(null, '', location.pathname); } catch (e) {}
      }
    } catch (e) {}

    // 已配对（存过地址）→ 直接在线
    if (conn && conn.token) {
      // 有令牌即可在线（同源或跨源都一样）
      ONLINE = true;
      SAME_ORIGIN = !conn.origin;
      startOnline();
      return;
    }
    // ⚠️ **安全默认：先显示连接页**。
    //    之前写成"探测失败才显示"，实测在独立 App 里不生效（页面停在列表页的静态演示
    //    内容上，用户根本不知道要配对）。现在的顺序：先给连接页 → 探测到同源可用再隐藏。
    if (window.__dshMobile && window.__dshMobile.showPage) window.__dshMobile.showPage('connect');
      // ⚠️ 不做"无令牌探测"：以前这里 fetch /mobile/api/health（不带令牌）→ 必然 401/404 ✗
      //    用户一进来看到「接口 404」以为坏了。没令牌本来就该配对，探测毫无意义。
  }

  // ── 插件页（真数据）────────────────────────────────────────────
  function loadPlugins() {
    var list = document.getElementById('plugins-list');
    if (!list) return;
    list.innerHTML = '<div class="list-empty">正在读取…</div>';
    jfetch('/mobile/api/plugins').then(function (r) {
      if (!r || !r.ok) {
        list.innerHTML = '<div class="list-empty">插件列表拿不到（' + (r && r.status ? r.status : '网络错误') + '）</div>';
        return;
      }
      var ps = r.plugins || [];
      var sub = document.getElementById('plugins-sub');
      if (sub) sub.textContent = ps.length + ' 个已安装';
      if (!ps.length) {
        list.innerHTML = '<div class="list-empty">还没有安装插件</div>';
        return;
      }
      list.textContent = '';
      ps.forEach(function (p) {
        var row = el('div', 'plugin-row');
        var head = el('div');
        head.appendChild(el('span', 'pn', String(p.name || p.id || '')));
        if (p.version) head.appendChild(el('span', 'pv', 'v' + p.version));
        row.appendChild(head);
        if (p.description) row.appendChild(el('div', 'pd', String(p.description)));
        list.appendChild(row);
      });
    }).catch(function () {
      list.innerHTML = '<div class="list-empty">插件列表拿不到</div>';
    });
  }
  window.__dshLoadPlugins = loadPlugins;

  function startOnline() {
    if (!ONLINE) {
      renderList(MOCK.sessions);   // file:// 下用假数据（只服务排版断言）
      return;
    }
    var chat = document.getElementById('page-chat');
    if (chat) {
      Array.prototype.slice.call(chat.querySelectorAll('.msg, .think, .traj-row')).forEach(function (n) { n.remove(); });
    }
    // ⚠️ health 失败不能静默放弃 ✗（真机实测：401 → 页面死、一个接口都不发、用户看到「进去了但全死」）
    api.health().then(function (h) {
      if (!h || !h.ok) {
        var status = h && h.status;
        if (status === 401 || status === 403) {
          // 令牌失效（桌面重启/网关轮换）→ 明确回连接页，不要留在一个"看起来能点但全 401"的界面
          showConnectExpired('HTTP ' + status);
          return;
        }
        if (typeof toast === 'function') toast('在线状态检查失败' + (status ? '（' + status + '）' : ''));
      }
      api.list().then(function (r) {
        if (r && r.ok) renderList(r.sessions || []);
        else if (typeof toast === 'function') toast('会话列表拉取失败' + (r && r.status ? '（' + r.status + '）' : ''));
      });
    }).catch(function () {
      if (typeof toast === 'function') toast('连不上电脑：检查是否同一 WiFi / 电脑是否开着手机访问');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
