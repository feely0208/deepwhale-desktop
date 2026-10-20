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
  // ⚠️ 默认**不**常驻显示（用户会看到一条吓人的红条）；排障时加 ?jsdebug=1 或
  //    localStorage.dshMobile.jsdebug='1' 再开（真机排障仍可用）
  var DEBUG_ERRS = false;
  try {
    DEBUG_ERRS = /(?:[?&]jsdebug=1(?:&|$))/.test(location.search) ||
      localStorage.getItem('dshMobile.jsdebug') === '1';
  } catch (e) { DEBUG_ERRS = false; }
  if (DEBUG_ERRS) {
    window.addEventListener('error', function (ev) {
      bar('JS 错误：' + (ev.message || '') + '\n@' + String(ev.filename || '').split('/').pop() + ':' + ev.lineno);
    });
    window.addEventListener('unhandledrejection', function (ev) {
      var r = ev.reason;
      bar('未捕获 Promise：' + String((r && (r.message || r)) || ''));
    });
  }
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
  /**
   * API 的基地址。
   * ⚠️ 中继模式（外出）下页面地址是 `https://deepwhale.org.cn/_relay/t/<id>/mobile/`，
   *    接口是 `/mobile/api/*`（**绝对路径**）。若 base 为空，浏览器会把它解析成
   *    `https://deepwhale.org.cn/mobile/api/*` —— 丢了 `/_relay/t/<id>` 前缀 → 中继 404
   *    （真机现场：列表/任务都报 404）。所以同源时必须带上"页面路径里 `/mobile/` 之前的前缀"。
   */
  function base() {
    if (conn && conn.origin) return conn.origin;
    try {
      if (!/^https?:$/.test(location.protocol)) return '';   // file:// 等离线场景
      var p = String(location.pathname || '');
      var i = p.indexOf('/mobile/');
      if (i > 0) return location.origin + p.slice(0, i);
      return location.origin;
    } catch (e) {
      return '';
    }
  }
  /**
   * 令牌查询串。⚠️ 必须按**目标路径**决定 `?` 还是 `&`：
   *   旧实现看的是 base() 里有没有 `?` —— 而 base 是 origin（永远没有 `?`），
   *   于是 `/mobile/api/chat?id=…` 会被拼成 `…?id=…?token=…`（两个问号）。
   *   之前能跑是因为**网关**在转发前把 `token=` 那段从 URL 里剥掉了（顺带把第二个 `?` 收拾干净）；
   *   但这是"靠网关擦屁股"，直连 DSH 时 id 就会带着 `?token=…` → 查不到会话。现在按路径判断。
   */
  function authQuery(path) {
    if (!(conn && conn.token)) return '';
    var sep = String(path || '').indexOf('?') >= 0 ? '&' : '?';
    return sep + 'token=' + encodeURIComponent(conn.token);
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
    var url = base() + path + authQuery(path);
    // 跨域（独立 App）时必须带凭据：DSH 的鉴权是 cookie，omit 会让网关拿到 403（实测）
    return fetch(url, Object.assign({ credentials: base() ? 'include' : 'same-origin' }, opts || {})).then(function (r) {
      return r.json().catch(function () {
        if (typeof toast === 'function') toast('接口 ' + r.status + '：' + String(path).slice(0, 46));
        return { ok: false, reason: 'bad-json', status: r.status };
      });
    });
  }

  /** 和 jfetch 一样，但**失败不弹 toast**（后台探测用，比如本版更新说明读不到时不该打扰用户） */
  function jfetchQuiet(path, opts) {
    var url = base() + path + authQuery(path);
    return fetch(url, Object.assign({ credentials: base() ? 'include' : 'same-origin' }, opts || {})).then(function (r) {
      if (!r.ok) return { ok: false, reason: 'http-' + r.status, status: r.status };
      return r.json().catch(function () { return { ok: false, reason: 'bad-json', status: r.status }; });
    }).catch(function () { return { ok: false, reason: 'network' }; });
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
  /** 和 rpc() 的区别：args 原样当 args 字段（commands/list 这类入参不是 {request} 的 RPC） */
  function rpcRaw(nsMethod, args) {
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
    /** 这个会话是否正在跑一轮（手机端「停止」按钮靠它） */
    sessionStatus: function (id) {
      return jfetch('/mobile/api/session-status?id=' + enc(id));
    },
    /** 停止当前这一轮（官方 RPC，桌面端「停止」用的同一个） */
    cancel: function (id) {
      return rpc('session/cancel', { sessionId: id });
    },
    /** 正在排队的消息（桌面端能 插话发送 / 编辑 / 删除，手机端也要） */
    queue: function (id) {
      return jfetch('/mobile/api/queue?id=' + enc(id));
    },
    /** 改一条排队消息：{kind:'steer'|'remove'|'edit'}（记法见宿主 QueueAction） */
    updateQueue: function (sid, itemId, action) {
      return rpc('session/updateQueue', { sessionId: sid, itemId: itemId, action: action });
    },
    /** 斜杠指令目录（桌面端加号菜单就是它：目标/计划/压缩/权限/模型/导出日志/插件命令…） */
    commands: function (sid) {
      return rpcRaw('commands/list', { agentId: sid });
    },
    /** 执行一条斜杠指令（不发给模型，走宿主 commands.execute） */
    runCommand: function (sid, line) {
      return rpcRaw('commands/execute', { agentId: sid, line: line, submittedAttachments: [] });
    },
    /** 权限预设目录（只读/工作区/完全权限/自动审查） */
    permissionCatalog: function () {
      return rpcRaw('permissionPresets/catalog', {});
    },
    /** 本版更新内容（桌面端随包 assets/whatsnew.json，插件代读） */
    whatsnew: function () {
      return jfetchQuiet('/mobile/api/whatsnew');
    },
    answerApproval: function (id, outcome) {
      return jfetch('/mobile/api/approval/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id, outcome: outcome }),
      });
    },
    attachmentUrl: function (sid, part) {
      var p = '/mobile/api/attachment?sid=' + enc(sid) + '&id=' + enc(part.attachmentId);
      return base() + p + authQuery(p);
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
          var uploadPath = '/api/session/uploadFileBinary?sessionId=' + enc(sessionId) +
            '&name=' + enc(file.name || 'file');
          var url = base() + uploadPath + authQuery(uploadPath);
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
    /** 模型能力（能不能读图）：会话目录不返回 inputModalities，插件代查宿主 llm */
    modelCaps: function (pairs) {
      return jfetch('/mobile/api/model-caps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairs: pairs || [] }),
      });
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
  var sessionRunning = false;     // 当前会话是否正在跑一轮
  var queueItems = [];            // 正在排队的消息（跑着的时候发出去的话）
  var editingQueueId = null;      // 正在编辑的排队消息 id
  var runningPollTimer = null;
  var approvalPollTimer = null;
  var pendingApprovals = [];     // 手机待审批
  var pendingAtts = [];          // 待发送附件
  var modelCatalog = null;       // session/modelCatalog 结果
  var modelCaps = {};            // "provider/model" → { inputModalities, supportsImages }
  var modelCapsLoading = false;
  var modelCapsFetched = false;   // 每次目录只查一次（否则 render→load→render 会自循环）
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
    // opts.chev === false → 不要“›”（只有真的会跳转下一步的才配箭头）
    function row(label, value, onClick, opts) {
      var o = opts || {};
      var r = el('button', 'mine-row');
      var l = el('span', 'mine-label', label);
      r.appendChild(l);
      if (value) r.appendChild(el('span', 'mine-value', value));
      if (o.chev !== false) r.appendChild(el('span', 'mine-chev', '›'));
      if (onClick) r.addEventListener('click', onClick);
      list.appendChild(r);
      return r;
    }
    list.textContent = '';
    var host = '';
    try { host = String(location.hostname || ''); } catch (e) { host = ''; }
    var mode = /^[0-9.]+$/.test(host) || host === 'localhost' ? '局域网' : (host ? '公网中继' : '未知网络');
    var isConnected = !!ONLINE;
    section('连接');
    row('服务器', isConnected ? ('已连接 · ' + mode) : '未连接', null, { chev: false });
    row('模型', (document.getElementById('chip-model') || {}).textContent || '—', function () {
      if (window.__dshOpenModelSheet) window.__dshOpenModelSheet();
      if (window.__dshOpenSheetById) window.__dshOpenSheetById('sheet-model');
    });
    row('强度', (document.getElementById('chip-effort') || {}).textContent || '—', function () {
      if (window.__dshOpenEffortSheet) window.__dshOpenEffortSheet();
      if (window.__dshOpenSheetById) window.__dshOpenSheetById('sheet-effort');
    });

    section('设置');
    row('外观', theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统', function () {
      var order = ['', 'light', 'dark'];
      var cur = order.indexOf(theme); cur = order[(cur + 1) % order.length];
      theme = cur;
      if (cur === '') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', cur);
      try { localStorage.setItem('dshMobile.theme', cur); } catch (e) {}
      renderMine();
    }, { chev: false });
    row('清空界面缓存', '会重新拉取页面', function () {
      try { localStorage.removeItem('dshMobile.mineVer'); } catch (e) {}
      if (typeof toast === 'function') toast('已清空，重新进入即可');
    }, { chev: false });

    section('帮助');
    row('意见反馈', 'service@deepwhale.org', function () {
      if (typeof toast === 'function') toast('意见反馈邮箱：service@deepwhale.org');
    }, { chev: false });
    var OFFICIAL = 'https://deepwhale.org.cn';
    function openExternal(url, label) {
      // 鸿蒙壳会拦截外链并用系统浏览器打开（见 手机端交付/HAP）；桌面浏览器直接跳
      try {
        location.href = url;
      } catch (e) {
        if (typeof toast === 'function') toast(label + '：' + url);
      }
    }
    row('官网', 'deepwhale.org.cn', function () { openExternal(OFFICIAL, '官网'); });

    section('关于');
    var versionRow = row('版本', 'v' + VERSION + (desktopAppVersion ? ' · 桌面 ' + desktopAppVersion : ''), function () {
      if (whatsnewFailed) return;   // 读不到就别弹"读不到"给用户看
      openWhatsnew();
    });
    // 读不到更新说明时：不留一个点了没反应的箭头（真机反馈）
    if (whatsnewFailed && versionRow) hideVersionChevron();
    row('断开连接', '需要重新扫码', function () {
      try { localStorage.removeItem('dshMobile.conn'); } catch (e) {}
      conn = null;
      ONLINE = false;
      stopChatStream();
      stopApprovalPoll();
      stopRunningPoll();
      sessionRunning = false;
      if (window.__dshMobile && window.__dshMobile.showPage) window.__dshMobile.showPage('connect');
    });
    prefetchWhatsnew();
  }
  var desktopAppVersion = '';
  var whatsnewFailed = false;
  var whatsnewPrefetching = false;
  /** 读不到更新说明时把「版本」行的箭头藏起来（别留一个点了没反应的箭头） */
  function hideVersionChevron() {
    var rows = document.querySelectorAll('#mine-list .mine-row');
    for (var i = 0; i < rows.length; i += 1) {
      if (/版本/.test(rows[i].textContent || '')) {
        var chev = rows[i].querySelector('.mine-chev');
        if (chev) chev.style.visibility = 'hidden';
        rows[i].onclick = null;
        return;
      }
    }
  }
  var whatsnewData = null;
  function renderWhatsnew() {
    var box = document.getElementById('whatsnew-list');
    var sub = document.getElementById('whatsnew-sub');
    if (!box) return;
    box.textContent = '';
    if (sub) sub.textContent = '';
    var draw = function (data) {
      var versions = (data && data.versions) || {};
      var keys = Object.keys(versions);
      if (sub) sub.textContent = data && data.appVersion ? ('桌面 v' + data.appVersion + ' / 手机 v' + VERSION) : ('手机 v' + VERSION);
      if (!keys.length) {
        box.appendChild(el('div', 'list-empty', '没有更新说明'));
        return;
      }
      keys.slice(0, 2).forEach(function (k, idx) {
        var v = versions[k] || {};
        box.appendChild(el('div', 'whatsnew-ver', (idx === 0 ? '最新：' : '上一版：') + 'v' + k + (v['date'] ? ' · ' + v['date'] : '')));
        if (v.title) box.appendChild(el('div', 'whatsnew-title', String(v.title)));
        (v.items || []).forEach(function (it) {
          var row = el('div', 'whatsnew-item');
          row.appendChild(el('span', 'kind', String(it.kind || 'note')));
          row.appendChild(el('div', '', String(it.text || '')));
          box.appendChild(row);
        });
      });
    };
    if (whatsnewData) draw(whatsnewData);
    else box.appendChild(el('div', 'list-empty', '正在读取…'));
    api.whatsnew().then(function (r) {
      if (r && r.ok) {
        whatsnewData = r;
        desktopAppVersion = String(r.appVersion || desktopAppVersion || '');
        draw(r);
      } else {
        whatsnewFailed = true;
        box.textContent = '读不到更新说明（桌面端可能还没带 assets/whatsnew.json）';
        hideVersionChevron();
      }
    }).catch(function () {
      whatsnewFailed = true;
      box.textContent = '读不到更新说明（网络）';
      hideVersionChevron();
    });
  }
  /** 进「我的」页就预读一次：失败就把版本行的箭头藏掉（别等用户点了才没反应） */
  function prefetchWhatsnew() {
    if (whatsnewData || whatsnewFailed || whatsnewPrefetching) return;
    whatsnewPrefetching = true;
    api.whatsnew().then(function (r) {
      whatsnewPrefetching = false;
      if (r && r.ok) {
        whatsnewData = r;
        desktopAppVersion = String(r.appVersion || desktopAppVersion || '');
        var rows = document.querySelectorAll('#mine-list .mine-row');
        for (var i = 0; i < rows.length; i += 1) {
          if (/版本/.test(rows[i].textContent || '')) {
            var v = rows[i].querySelector('.mine-value');
            if (v) v.textContent = 'v' + VERSION + (desktopAppVersion ? ' · 桌面 ' + desktopAppVersion : '');
          }
        }
      } else {
        whatsnewFailed = true;
        hideVersionChevron();
      }
    }).catch(function () {
      whatsnewPrefetching = false;
      whatsnewFailed = true;
      hideVersionChevron();
    });
  }

  function openWhatsnew() {
    renderWhatsnew();
    if (window.__dshOpenSheetById) window.__dshOpenSheetById('sheet-whatsnew');
  }
  window.__dshRenderWhatsnew = renderWhatsnew;

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
      running: sessionRunning,
      permission: currentPermission,
      permissionChip: (document.getElementById('chip-permission') || {}).textContent || '',
      serverText: (function () {
        var rows = document.querySelectorAll('#mine-list .mine-row');
        for (var i = 0; i < rows.length; i += 1) {
          if (rows[i].querySelector('.mine-label') && /服务器/.test(rows[i].textContent || '')) {
            var v = rows[i].querySelector('.mine-value');
            return v ? String(v.textContent) : '';
          }
        }
        return '';
      })(),
      commandCount: (commandDescriptors || []).length,
      queueCount: queueItems.length,
      queueTexts: queueItems.map(function (x) { return x.text; }),
      modelCapsKnown: Object.keys(modelCaps).length,
      modelCapsNoImage: Object.keys(modelCaps).filter(function (k) { return modelCaps[k] && modelCaps[k].supportsImages === false; }).length,
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
        // ⚠️ 不能用 `ph.replaceWith(wrap)`：wrap 是 ph 的父节点，会抛
        //    HierarchyRequestError: The new child element contains the parent（真机/E2E 都炸）
        //    正确做法：把占位卡从 wrap 里换掉，再把 <img> 放进 wrap（wrap 已经在 DOM 里）。
        if (ph.parentNode) ph.parentNode.removeChild(ph);
        if (attachmentUrlCache[part.attachmentId]) {
          img.src = attachmentUrlCache[part.attachmentId];
        } else {
          img.src = api.attachmentUrl(sid, part);
          attachmentUrlCache[part.attachmentId] = img.src;
        }
        wrap.appendChild(img);
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
  // 发送 / 停止按钮
  //   桌面端：跑的时候右侧按钮变成"蓝圆 + 白方块"，点了取消这一轮。
  //   手机端以前永远只有"上箭头"，用户反馈「没有停止按钮，等于停不了」→ 对齐桌面端。
  // ══════════════════════════════════════════════════════════════════════
  var ICON_SEND = '<svg class="ic" viewBox="0 0 24 24" width="20" height="20"><path d="M12 19.5V5"/><path d="M5.5 11.5 12 5l6.5 6.5"/></svg>';
  var ICON_STOP = '<svg class="ic" viewBox="0 0 24 24" width="20" height="20"><rect x="7.2" y="7.2" width="9.6" height="9.6" rx="2.6"/></svg>';

  function renderSendButton() {
    var b = document.getElementById('btn-send');
    if (!b) return;
    if (sessionRunning) {
      b.classList.add('stop');
      b.setAttribute('aria-label', '停止');
      b.innerHTML = ICON_STOP;
    } else {
      b.classList.remove('stop');
      b.setAttribute('aria-label', '发送');
      b.innerHTML = ICON_SEND;
    }
  }

  function setRunning(v) {
    var next = v === true;
    if (next === sessionRunning) return;
    sessionRunning = next;
    renderSendButton();
  }
  window.__dshIsRunning = function () { return sessionRunning; };
  window.__dshSetRunning = setRunning;   // E2E/排障用（真机由 SSE status + 轮询驱动）

  function cancelTurn() {
    if (!currentSessionId) { toast('先进入一个会话'); return; }
    toast('正在停止…');
    api.cancel(currentSessionId).then(function (r) {
      if (r && r.ok) toast('已请求停止');
      else toast('停止失败：' + ((r && r.error && (r.error.code || r.error.message)) || '未知原因'));
      setTimeout(refreshRunning, 500);
    }).catch(function () { toast('停止失败：网络错误'); });
  }

  function refreshRunning() {
    if (!ONLINE || !currentSessionId) return;
    api.sessionStatus(currentSessionId).then(function (r) {
      if (r && r.ok) setRunning(r.running === true);
    }).catch(function () {});
    refreshQueue();
  }

  function startRunningPoll() {
    stopRunningPoll();
    if (!ONLINE) return;
    refreshRunning();
    runningPollTimer = setInterval(refreshRunning, 2500);
  }

  function stopRunningPoll() {
    if (runningPollTimer) { clearInterval(runningPollTimer); runningPollTimer = null; }
  }

  // ── 排队消息 dock：和桌面端一样，排队中的消息可以「插话发送 / 编辑 / 删除」──
  function queueEl(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = String(text);
    return n;
  }

  function queueItemLabel(it) {
    var bits = [];
    if (it.text) bits.push(String(it.text).replace(/\s+/g, ' ').trim());
    if (it.images) bits.push('（图片 ' + it.images + '）');
    if (it.files) bits.push('（文件 ' + it.files + '）');
    return bits.join(' ') || '（空消息）';
  }

  function renderQueueDock() {
    var dock = document.getElementById('queue-dock');
    if (!dock) return;
    dock.textContent = '';
    if (!currentSessionId || (!queueItems.length && !editingQueueId)) {
      dock.hidden = true;
      return;
    }
    dock.hidden = false;
    if (editingQueueId) {
      var it0 = null;
      for (var i0 = 0; i0 < queueItems.length; i0 += 1) if (queueItems[i0].id === editingQueueId) it0 = queueItems[i0];
      var wrap = queueEl('div', 'queue-edit');
      var ta = document.createElement('textarea');
      ta.id = 'queue-edit-input';
      ta.value = it0 ? it0.text : '';
      ta.setAttribute('aria-label', '编辑排队消息');
      wrap.appendChild(ta);
      var btns = queueEl('div', 'q-btns');
      var save = queueEl('button', 'save', '保存');
      var cancel = queueEl('button', '', '取消');
      save.addEventListener('click', saveQueueEdit);
      cancel.addEventListener('click', function () { editingQueueId = null; renderQueueDock(); });
      btns.appendChild(save);
      btns.appendChild(cancel);
      wrap.appendChild(btns);
      dock.appendChild(wrap);
      return;
    }
    queueItems.forEach(function (it) {
      var row = queueEl('div', 'queue-item');
      row.setAttribute('data-queue-id', it.id);
      row.appendChild(queueEl('span', 'qtag', '排队中'));
      row.appendChild(queueEl('div', 'qtxt', queueItemLabel(it)));
      var acts = queueEl('div', 'queue-acts');
      var steer = queueEl('button', 'q-steer', '插话发送');
      var edit = queueEl('button', 'q-edit', '编辑');
      var del = queueEl('button', 'q-del', '删除');
      steer.addEventListener('click', function () { queueAction(it.id, { kind: 'steer' }, '已插话发送'); });
      edit.addEventListener('click', function () {
        editingQueueId = it.id;
        renderQueueDock();
        var ta = document.getElementById('queue-edit-input');
        if (ta) { try { ta.focus(); } catch (e) {} }
      });
      del.addEventListener('click', function () { queueAction(it.id, { kind: 'remove' }, '已删除排队消息'); });
      acts.appendChild(steer);
      acts.appendChild(edit);
      acts.appendChild(del);
      row.appendChild(acts);
      dock.appendChild(row);
    });
  }

  function queueAction(itemId, action, okText) {
    if (!currentSessionId) return;
    api.updateQueue(currentSessionId, itemId, action).then(function (r) {
      if (r && r.ok) {
        toast(okText);
        if (editingQueueId === itemId) editingQueueId = null;
        setTimeout(refreshQueue, 300);
      } else {
        toast('操作失败：' + ((r && r.error && (r.error.code || r.error.message)) || '未知原因'));
      }
    }).catch(function () { toast('操作失败：网络错误'); });
  }

  function saveQueueEdit() {
    var itemId = editingQueueId;
    var ta = document.getElementById('queue-edit-input');
    var text = ta ? String(ta.value || '').trim() : '';
    if (!itemId) return;
    if (!text) { toast('内容不能为空'); return; }
    api.updateQueue(currentSessionId, itemId, { kind: 'edit', content: [{ type: 'text', text: text }] }).then(function (r) {
      if (r && r.ok) {
        toast('已保存修改');
        editingQueueId = null;
        setTimeout(refreshQueue, 300);
        renderQueueDock();
      } else {
        toast('保存失败：' + ((r && r.error && (r.error.code || r.error.message)) || '未知原因'));
      }
    }).catch(function () { toast('保存失败：网络错误'); });
  }
  window.__dshRenderQueue = renderQueueDock;

  function refreshQueue() {
    if (!ONLINE || !currentSessionId) return;
    api.queue(currentSessionId).then(function (r) {
      if (r && r.ok && Array.isArray(r.items)) {
        queueItems = r.items;
        if (editingQueueId && !queueItems.some(function (x) { return x.id === editingQueueId; })) editingQueueId = null;
        renderQueueDock();
      }
    }).catch(function () {});
  }

  // 右上角按钮点击：跑着 → 停止；空闲 → 发送
  window.__dshSendAction = function () {
    if (sessionRunning && currentSessionId) { cancelTurn(); return; }
    if (window.__dshDoSend) window.__dshDoSend();
  };
  window.__dshRenderSendButton = renderSendButton;



  /** chip 里的文字统一放进 .txt span：长模型名靠 CSS 省略号收住，不会溢出按钮 */
  function setChipLabel(elOrId, text) {
    var el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
    if (!el) return;
    el.textContent = '';
    var span = document.createElement('span');
    span.className = 'txt';
    span.textContent = String(text == null ? '' : text);
    el.appendChild(span);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 加号菜单（文件 + 斜杠指令）与权限预设 —— 对齐桌面端 composer 的「+」和「权限」
  // ══════════════════════════════════════════════════════════════════════
  var COMMAND_LABELS = {
    goal: ['目标', '设置或查看长期任务目标'],
    plan: ['计划', '进入或退出计划模式'],
    feedback: ['反馈', '发送关于当前会话的反馈'],
    compact: ['压缩', '压缩以上对话内容'],
    permission: ['权限', '切换权限预设（沙箱模式与审批策略）'],
    model: ['模型', '选择本会话使用的模型'],
    export: ['下载日志', '将当前会话内容导出为 ZIP'],
  };
  var COMMAND_ORDER = ['goal', 'plan', 'feedback', 'compact', 'permission', 'model', 'export'];
  var PERMISSION_LABELS = {
    'read-only': ['仅可查看', '不允许修改文件'],
    'workspace-write': ['工作区内修改', '只能改工作区里的文件'],
    'danger-full-access': ['完全权限', '不限制沙箱（谨慎）'],
    auto: ['自动审查', '由自动审查决定（EXP）'],
  };
  var commandDescriptors = null;
  var commandSessionId = '';
  var currentPermission = '';

  function commandLabel(d) {
    var m = COMMAND_LABELS[d.name];
    return m ? m[0] : String(d.name);
  }
  function commandDesc(d) {
    var m = COMMAND_LABELS[d.name];
    if (m && m[1]) return m[1];
    return String(d.description || '');
  }

  function renderCommands() {
    var box = document.getElementById('command-list');
    if (!box) return;
    box.textContent = '';
    if (!currentSessionId) {
      box.appendChild(el('div', 'list-empty', '先进入一个会话'));
      return;
    }
    var draw = function (list) {
      var byName = {};
      (list || []).forEach(function (x) { byName[String(x.name)] = x; });
      // 「模型」在桌面端是客户端条目而不是宿主指令，这里补一条 synthetic（命令目录里没有也要显示）
      if (!byName.model) byName.model = { name: 'model', description: '选择本会话使用的模型' };
      var names = [];
      COMMAND_ORDER.forEach(function (n) { if (byName[n]) { names.push(n); } });
      Object.keys(byName).forEach(function (n) { if (names.indexOf(n) < 0) { names.push(n); } });
      box.textContent = '';
      if (!names.length) {
        box.appendChild(el('div', 'list-empty', '没有可用指令'));
        return;
      }
      names.forEach(function (n) {
        var d = byName[n];
        var b = el('button', 'opt');
        b.setAttribute('data-command', n);
        b.appendChild(document.createTextNode(commandLabel(d)));
        b.appendChild(el('span', 'cname', String(d.name)));
        var sub = commandDesc(d);
        if (sub) b.appendChild(el('span', 'sub', sub.length > 16 ? sub.slice(0, 16) + '…' : sub));
        b.addEventListener('click', function () { onCommandPicked(d); });
        box.appendChild(b);
      });
    };
    if (commandDescriptors && commandSessionId === currentSessionId) {
      draw(commandDescriptors);
      return;
    }
    box.appendChild(el('div', 'list-empty', '正在读取指令…'));
    api.commands(currentSessionId).then(function (r) {
      if (r && r.ok) {
        commandDescriptors = r.value || [];
        commandSessionId = currentSessionId;
        draw(commandDescriptors);
      } else {
        box.textContent = '读不到指令列表';
      }
    }).catch(function () { box.textContent = '读不到指令列表（网络）'; });
  }

  function onCommandPicked(d) {
    if (window.__dshCloseSheets) window.__dshCloseSheets();
    if (d.name === 'model') {
      if (window.__dshOpenModelSheet) window.__dshOpenModelSheet();
      if (window.__dshOpenSheetById) window.__dshOpenSheetById('sheet-model');
      return;
    }
    if (d.name === 'permission') {
      renderPermissions();
      if (window.__dshOpenSheetById) window.__dshOpenSheetById('sheet-permission');
      return;
    }
    if (d.input && d.input.hint) {
      var ta = document.getElementById('input');
      if (ta) {
        ta.value = '/' + d.name + ' ';
        try { ta.focus(); } catch (e) {}
        toast(String(d.input.hint));
      }
      return;
    }
    executeCommand('/' + d.name);
  }

  function executeCommand(line) {
    if (!currentSessionId) { toast('先进入一个会话'); return; }
    toast('执行 ' + line + '…');
    api.runCommand(currentSessionId, line).then(function (r) {
      if (r && r.ok) {
        var res = (r.value && r.value.result) || {};
        if (res.kind === 'error') toast(String(res.text || '执行失败'));
        else if (res.text) toast(String(res.text).slice(0, 80));
        else toast(line + ' 已执行');
        refreshChatSnapshot();
        refreshQueue();
        refreshPermission();
      } else {
        toast('执行失败：' + ((r && r.error && (r.error.message || r.error.code)) || '未知原因'));
      }
    }).catch(function () { toast('执行失败：网络错误'); });
  }

  function refreshPermission() {
    if (!ONLINE || !currentSessionId) return;
    api.session(currentSessionId).then(function (r) {
      if (r && r.ok && r.value && r.value.meta) {
        currentPermission = String(r.value.meta.permission || '');
        renderPermissionChip();
        renderPermissionsIfOpen();
      }
    }).catch(function () {});
  }

  function renderPermissions() {
    var box = document.getElementById('permission-list');
    if (!box) return;
    box.textContent = '';
    box.appendChild(el('div', 'list-empty', '正在读取权限预设…'));
    Promise.all([api.permissionCatalog(), api.session(currentSessionId)]).then(function (arr) {
      var cat = (arr[0] && arr[0].ok && arr[0].value) || { options: [] };
      var meta = (arr[1] && arr[1].ok && arr[1].value && arr[1].value.meta) || {};
      currentPermission = String(meta.permission || currentPermission || '');
      box.textContent = '';
      (cat.options || []).forEach(function (o) {
        var lab = PERMISSION_LABELS[o.value] || [String(o.name || o.value), String(o.description || '')];
        var b = el('button', 'opt perm-row');
        b.setAttribute('data-permission', String(o.value));
        b.setAttribute('title', String(o.value));
        b.appendChild(el('span', 'perm-label', lab[0]));
        var desc = lab[1] || String(o.description || '');
        b.appendChild(el('span', 'perm-desc', desc || String(o.value)));
        var isCur = String(o.value) === currentPermission;
        if (isCur) b.setAttribute('aria-current', 'true');
        b.appendChild(el('span', 'ck', isCur ? '✓' : ''));
        b.addEventListener('click', function () { setPermission(o.value, lab[0]); });
        box.appendChild(b);
      });
      if (!(cat.options || []).length) box.appendChild(el('div', 'list-empty', '没有可用预设'));
    }).catch(function () { box.textContent = '读不到权限预设'; });
  }

  var PERMISSION_CHIP_LABELS = {
    'read-only': '仅可查看',
    'workspace-write': '工作区内',
    'danger-full-access': '完全权限',
    auto: '自动审查',
  };
  function renderPermissionChip() {
    var b = document.getElementById('chip-permission');
    if (!b) return;
    setChipLabel(b, PERMISSION_CHIP_LABELS[currentPermission] || '权限');
    b.setAttribute('aria-label', '权限：' + (PERMISSION_CHIP_LABELS[currentPermission] || '未设置'));
  }

  function setPermission(value, label) {
    if (value === currentPermission) {
      toast('已经是「' + label + '」');
      if (window.__dshCloseSheets) window.__dshCloseSheets();
      return;
    }
    if (window.__dshCloseSheets) window.__dshCloseSheets();
    toast('切换权限：' + label + '…');
    api.runCommand(currentSessionId, '/permission ' + value).then(function (r) {
      if (r && r.ok) {
        currentPermission = value;
        renderPermissionChip();
        toast('权限已切换：' + label);
        refreshPermission();
      } else {
        toast('切换失败：' + ((r && r.error && (r.error.message || r.error.code)) || '未知原因'));
      }
    }).catch(function () { toast('切换失败：网络错误'); });
  }

  function renderPermissionsIfOpen() {
    var sheet = document.getElementById('sheet-permission');
    if (sheet && !sheet.hidden) renderPermissions();
  }

  window.__dshRenderCommands = renderCommands;
  window.__dshRenderPermissions = renderPermissions;
  window.__dshRenderPermissionChip = renderPermissionChip;

  // ══════════════════════════════════════════════════════════════════════
  // 审批
  // ══════════════════════════════════════════════════════════════════════
  function renderApprovals(list) {
    var prevCount = pendingApprovals.length;
    var wasNearBottom = pageNearBottom();
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
    // 新审批必须**看得见**：卡片在聊天流末尾，用户可能停在上面读消息。
    // 只在用户本来就贴着底部时自动滚（避免把正在翻旧消息的人拽走），并保留 toast 提醒。
    if (pendingApprovals.length > prevCount && wasNearBottom) {
      setTimeout(function () {
        try {
          var first = slot.querySelector('.approval');
          if (first && first.scrollIntoView) first.scrollIntoView({ block: 'nearest' });
        } catch (e) {}
      }, 30);
    }
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
    var sp = '/mobile/api/stream?id=' + enc(id);
    var url = base() + sp + authQuery(sp);
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
      es.addEventListener('queue', function (ev) {
        if (currentSessionId !== id) return;
        try {
          var d = JSON.parse(ev.data || '{}');
          queueItems = Array.isArray(d.items) ? d.items : [];
          if (editingQueueId && !queueItems.some(function (x) { return x.id === editingQueueId; })) editingQueueId = null;
          renderQueueDock();
        } catch (e) {}
      });
      es.addEventListener('status', function (ev) {
        if (currentSessionId !== id) return;
        try {
          var d = JSON.parse(ev.data || '{}');
          setRunning(d.running === true);
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
    sessionRunning = false;      // 先按空闲渲染，紧接的状态查询/SSE 会纠正
    queueItems = [];
    editingQueueId = null;
    renderSendButton();
    renderQueueDock();
    startApprovalPoll();
    startRunningPoll();
    api.session(id).then(function (r) {
      // chips 显示**真值**（模型/强度/工作区来自投影 modelSelection 等，不是写死的假标签）
      var meta = (r && r.meta) || {};
      currentModel = { provider: String(meta.provider || ''), model: String(meta.model || '') };
      currentPermission = String(meta.permission || '');
      renderPermissionChip();
      var cm = document.getElementById('chip-model');
      if (cm && meta.model) setChipLabel(cm, shortModelName(String(meta.model)));
      // chip 上尽量显示**目录里的展示名**（DeepSeek-V4.1-Flash）而不是 id（deepseek-flash）
      if (cm && meta.model) {
        var applyDisplayName = function () {
          var shown = catalogModelName(meta.provider, meta.model);
          if (shown) setChipLabel(cm, shortModelName(shown));
        };
        if (modelCatalog) applyDisplayName();
        else if (!modelCapsLoading) api.modelCatalog().then(function (r) {
          if (r && r.ok && r.value) { modelCatalog = r.value; applyDisplayName(); }
        }).catch(function () {});
      }
      var ce = document.getElementById('chip-effort');
      if (ce && meta.effort) setChipLabel(ce, String(meta.effort));
      var cw = document.getElementById('chip-ws');
      if (cw && meta.workspace) {
        var parts = String(meta.workspace).split('/');
        var wsName = parts[parts.length - 1] || '未分组';
        cw.textContent = wsName.length > 10 ? wsName.slice(0, 9) + '…' : wsName;
      }
      // 如果 SSE 还没来，用 /session 返回的 chat 字段兜底
      if (!chatTurns.length && r && r.chat && Array.isArray(r.chat.turns)) {
        chatTurns = r.chat.turns;
        if (!traceVisible) renderChatTurns(chatTurns);
      }
    }).catch(function () {});
  }

  function shortModelName(m) {
    var s = String(m || '');
    // 现在 composer 只有 3 枚 chip（附件/模型/强度），模型 chip 吃满剩余宽度 → 尽量显示全名，
    // 只有极端长的自定义模型名才截断（面板里始终能看到全名）。
    return s.length > 24 ? s.slice(0, 23) + '…' : s;
  }

  /**
   * 发送失败的**分类**处理（别把宿主的结构化错误原样丢给用户）。
   * 最常踩的一种：当前模型是纯文本模型，却带了图片 → 宿主报
   * `session/attachment-invalid` + details.reason=`MODEL_DOES_NOT_SUPPORT_IMAGES`。
   * 这时光弹一句英文错误没用，用户不知道下一步做什么 —— 直接告诉他换模型，并把模型面板弹出来。
   * 待发送附件**不清空**（失败后保留），换完模型可以直接重发。
   */
  function handleSendFailure(res) {
    var err = res && res.prompt && res.prompt.error;
    var code = err && err.code ? String(err.code) : '';
    var reason = err && err.details && err.details.reason ? String(err.details.reason) : '';
    var raw = code || (err && err.message) || '未知原因';
    if (code === 'session/attachment-invalid' && /MODEL_DOES_NOT_SUPPORT_IMAGES/.test(reason)) {
      if (currentModel && currentModel.model) {
        modelCaps[capsKey(currentModel.provider, currentModel.model)] = {
          provider: currentModel.provider,
          model: currentModel.model,
          inputModalities: ['text'],
          supportsImages: false,
        };
        try { localStorage.setItem('dshMobile.modelCaps', JSON.stringify(modelCaps)); } catch (e) {}
      }
      toast('这个模型不支持图片输入：换一个支持图片的模型再发（附件已保留）');
      setTimeout(function () {
        try {
          if (window.__dshOpenModelSheet) window.__dshOpenModelSheet();
          if (window.__dshOpenSheetById) window.__dshOpenSheetById('sheet-model');
        } catch (e) {}
      }, 350);
      return;
    }
    if (code === 'session/attachment-invalid' && /FILE_NOT_STAGED/.test(reason)) {
      toast('文件上传的凭据过期了，请重新选择文件再发');
      return;
    }
    toast('发送失败：' + raw);
  }
  window.__dshHandleSendFailure = handleSendFailure;   // E2E/排障用（和 __dshState 同类）

  /** 发送：先建会话（若还没有），传附件，再 prompt */
  var sending = false;
  function send(text) {
    var hasAtt = pendingAtts.length > 0;
    if (!text || !text.trim()) {
      if (!hasAtt) return Promise.resolve({ ok: false, reason: 'empty' });
    }
    if (sending) { toast('上一条还在发送…'); return Promise.resolve({ ok: false, reason: 'busy' }); }
    // 先看"当前模型能不能读图"：宿主有 inputModalities（插件代查），别等发出去 401/报错才提示
    var hasImage = pendingAtts.some(function (a) { return a.kind === 'image'; });
    if (hasImage && currentModel && currentModel.model) {
      var capsNow = capsOf(currentModel.provider, currentModel.model);
      if (capsNow && capsNow.supportsImages === false) {
        toast('当前模型不支持图片：先切一个能读图的模型（附件已保留）');
        if (window.__dshOpenModelSheet) window.__dshOpenModelSheet();
        // 光渲染列表不够，面板本身要打开（面板开关在 index.html 的内联脚本里）
        if (window.__dshOpenSheetById) window.__dshOpenSheetById('sheet-model');
        return Promise.resolve({ ok: false, reason: 'model-no-image' });
      }
    }
    sending = true;
    setTimeout(refreshQueue, 1200);   // 跑着的时候这条会进"排队中"dock
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
        handleSendFailure(res);
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

  /** modelCatalog 里按 provider/model id 找展示名（找不到就返回空，调用方保持原样） */
  function catalogModelName(provider, modelId) {
    var groups = (modelCatalog && modelCatalog.groups) || [];
    for (var i = 0; i < groups.length; i += 1) {
      var g = groups[i];
      if (provider && g.id !== provider) continue;
      var models = g.models || [];
      for (var j = 0; j < models.length; j += 1) {
        if (models[j].id === modelId) return String(models[j].name || '');
      }
    }
    return '';
  }

  function capsKey(provider, model) { return String(provider || '') + '/' + String(model || ''); }
  function capsOf(provider, model) { return modelCaps[capsKey(provider, model)] || null; }
  /** 读一次所有目录模型的"能不能读图"（插件代查宿主，10 分钟缓存，失败静默） */
  function loadModelCaps(done) {
    if (modelCapsLoading || modelCapsFetched || !modelCatalog) return;
    var pairs = [];
    (modelCatalog.groups || []).forEach(function (g) {
      (g.models || []).forEach(function (m) { pairs.push({ provider: g.id, model: m.id }); });
    });
    if (!pairs.length) return;
    modelCapsLoading = true;
    modelCapsFetched = true;
    api.modelCaps(pairs).then(function (r) {
      modelCapsLoading = false;
      if (r && r.ok && r.caps) {
        Object.keys(r.caps).forEach(function (k) { modelCaps[k] = r.caps[k]; });
        try { localStorage.setItem('dshMobile.modelCaps', JSON.stringify(modelCaps)); } catch (e) {}
        if (typeof done === 'function') done();
      }
    }).catch(function () { modelCapsLoading = false; });
  }
  try {
    var savedCaps = localStorage.getItem('dshMobile.modelCaps');
    if (savedCaps) modelCaps = JSON.parse(savedCaps) || {};
  } catch (e) { modelCaps = {}; }

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
        var caps = capsOf(g.id, m.id);
        if (caps && caps.supportsImages === false) b.appendChild(el('span', 'cap-warn', '不支持图片'));
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
    loadModelCaps(function () { renderModelSheet(); });
  }

  function pickModel(provider, model, effort, btn) {
    if (!currentSessionId) { toast('先进入一个会话'); return; }
    if (btn) { btn.disabled = true; }
    api.selectModel(currentSessionId, provider, model.id, effort).then(function (r) {
      if (btn) btn.disabled = false;
      if (r && r.ok) {
        currentModel = { provider: provider, model: model.id };
        var cm = document.getElementById('chip-model');
        if (cm) setChipLabel(cm, shortModelName(model.name || model.id));
        var ce = document.getElementById('chip-effort');
        var eff = (r.value && r.value.selected && r.value.selected.reasoningEffort) || effort || '';
        if (ce) setChipLabel(ce, eff || '默认');
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
      // ⚠️ 必须显式切到列表页：showPage 负责**隐藏输入区/chips**（列表页不该挂聊天输入框，
      //    上一版真机反馈"列表页底部白占 1/3 屏"就是它）——以前只有点返回才调用它，
      //    冷启动直接进列表时 composer 还是可见的（E2E 截图抓到）。
      if (window.__dshMobile && window.__dshMobile.showPage) window.__dshMobile.showPage('list');
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
