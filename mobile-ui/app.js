/**
 * 深鲸 Mobile · 数据层（手机端 1.1.0）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 分工（方案 B，见 docs/mobile-rpc-protocol.md）
 *   读（会话列表 / 详情 / 消息）→ **我们自己的** `/mobile/api/*`（由 dsh-shell-mobile 插件提供）
 *   写（建会话 / 发消息）      → DSH 基础 RPC `/api/session/create`、`/api/session/prompt`
 * 两条都**同源**：手机访问的地址就是我们网关后面的 DSH，插件的 /mobile/ 直接发这个界面。
 *
 * 环境区分（重要）：
 *   · 通过网关/DSH 打开（http(s)）→ 走真接口；
 *   · 以 file:// 打开（排版断言脚本就是这么跑的）→ 用内置假数据，**不联网**，
 *     这样"排版断言"和"功能联调"互不干扰。
 */
(function () {
  'use strict';

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

  function jfetch(path, opts) {
    var url = base() + path + authQuery();
    // 跨域（独立 App）时必须带凭据：DSH 的鉴权是 cookie，omit 会让网关拿到 403（实测）
    return fetch(url, Object.assign({ credentials: base() ? 'include' : 'same-origin' }, opts || {})).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, reason: 'bad-json', status: r.status };
      });
    });
  }

  /** DSH 基础 RPC：POST /api/<ns>/<method>，body 见协议文档 */
  function rpc(nsMethod, args) {
    var rid = 'mobile-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    return jfetch('/api/' + nsMethod, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: rid,
        method: nsMethod,
        payload: { args: { request: args } },
      }),
    }).then(function (res) {
      var r = res && res.result;
      if (r && r.ok) return { ok: true, value: r.value };
      return { ok: false, error: (r && r.error) || res };
    });
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
      return jfetch('/mobile/api/session?id=' + encodeURIComponent(id));
    },
    trajectory: function (id) {
      return jfetch('/mobile/api/trajectory?id=' + encodeURIComponent(id));
    },
    create: function () {
      return rpc('session/create', {});
    },
    prompt: function (sessionId, text, mode) {
      var requestId = 'mobile-p-' + Date.now().toString(36);
      return rpc('session/prompt', {
        requestId: requestId,
        sessionId: sessionId,
        mode: mode || 'queue',
        content: [{ type: 'text', text: text }],
      });
    },
  };

  api.connect = connect;
  api.parsePairLink = parsePairLink;
  api.disconnect = function () { clearConn(); conn = null; };
  api.conn = function () { return conn; };
  api.reload = function () { startOnline(); };
  window.dshMobileApi = api;
  window.dshMobileConnect = connect;
  window.dshMobileParsePairLink = parsePairLink;

  // ── 离线（file://）时的假数据：只服务排版断言 ─────────────────────
  var MOCK = {
    sessions: [
      { id: 'session-7929b8cc', title: '创建每日新闻定时推送任务', updatedAt: '3 分钟前' },
      { id: 'session-2f5899d4', title: '服务器介绍', updatedAt: '7 分钟前' },
      { id: 'session-d7609b3a', title: '验证活动页布局', updatedAt: '2 周前' },
    ],
    messages: [
      { role: 'user', text: '给我创建一个定时任务，明早 8 点推送当天科技与财经新闻。' },
      {
        role: 'assistant',
        text: '定时任务已创建 ✅\n\n| 触发时间 | 2026-10-16 08:00 (Asia/Shanghai) |\n| 任务名 | 每日科技+财经新闻早报 |',
        meta: '耗时 3 秒 · 2 项上下文 · 1 次工具调用',
      },
    ],
  };

  function fmtTime(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    try {
      var d = new Date(v);
      var mins = Math.round((Date.now() - d.getTime()) / 60000);
      if (mins < 1) return '刚刚';
      if (mins < 60) return mins + ' 分钟前';
      if (mins < 60 * 24) return Math.round(mins / 60) + ' 小时前';
      return Math.round(mins / 1440) + ' 天前';
    } catch (e) {
      return '';
    }
  }

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

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /** 把会话列表渲染进 #page-list（保留搜索框与"新建会话"） */
  function renderList(sessions) {
    var page = document.getElementById('page-list');
    if (!page) return;
    Array.prototype.slice.call(page.querySelectorAll('.row-btn')).forEach(function (n) {
      n.remove();
    });
    sessions.forEach(function (s) {
      var b = el('button', 'row-btn');
      b.setAttribute('data-id', s.id || '');
      var t = el('span', 't');
      // ⚠️ 以前标题回落到原始 `session-<uuid>`（真机实测：列表里全是长 id，没法用 ✗）
      //    现在：有标题用标题，没有就说"新会话"，副标题显示相对时间（没有时间再退到工作区）
      var titleText = s.title && String(s.title).trim() !== '' ? s.title : '新会话';
      var subText = relTime(s.updatedAt) || (s.workspace ? String(s.workspace) : '');
      t.appendChild(el('span', 'title', titleText));
      t.appendChild(el('span', 'sub', subText));
      b.appendChild(t);
      b.appendChild(el('span', 'time', fmtTime(s.updatedAt)));
      b.addEventListener('click', function () {
        openSession(s.id);
      });
      page.appendChild(b);
    });
  }

  function messageNode(m) {
    var wrap = el('div', 'msg' + (m.role === 'user' ? ' me' : ''));
    var text = m.text || '';
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
    if (m.meta) wrap.appendChild(el('div', 'meta', m.meta));
    return wrap;
  }

  function renderChat(session) {
    var page = document.getElementById('page-chat');
    if (!page) return;
    Array.prototype.slice.call(page.querySelectorAll('.msg')).forEach(function (n) {
      n.remove();
    });
    var tabs = page.querySelector('.tabs');
    (session.messages || []).forEach(function (m) {
      page.insertBefore(messageNode(m), null);
      void tabs;
    });
    // 滚到底：设置的是页面容器本身，但真正的滚动容器可能是它的父级/自身（实测截图停在中间）
    try {
      page.scrollTop = page.scrollHeight;
      var sc = page.closest ? page.closest('.scroll') : null;
      if (sc) sc.scrollTop = sc.scrollHeight;
      var last = page.lastElementChild;
      if (last && last.scrollIntoView) last.scrollIntoView({ block: 'end' });
    } catch (e) {}
  }

  var currentSessionId = '';

  /** 轨迹 tab：把事件按时间线渲染（类型徽标 + 摘要） */
  function renderTrajectory(events) {
    var page = document.getElementById('page-chat');
    if (!page) return;
    Array.prototype.slice.call(page.querySelectorAll('.traj-row')).forEach(function (n) { n.remove(); });
    events.forEach(function (e) {
      var row = el('div', 'traj-row');
      var badge = el('span', 'traj-badge', e.label || e.type || '事件');
      row.appendChild(badge);
      if (e.detail) row.appendChild(el('span', 'traj-detail', String(e.detail).slice(0, 160)));
      if (e.seq !== null && e.seq !== undefined) row.appendChild(el('span', 'traj-seq', '#' + e.seq));
      page.appendChild(row);
    });
  }

  function showTrajectory() {
    var page = document.getElementById('page-chat');
    if (page) {
      Array.prototype.slice.call(page.querySelectorAll('.msg')).forEach(function (n) { n.remove(); });
    }
    if (!ONLINE || !currentSessionId) {
      renderTrajectory([
        { label: '回合开始', detail: '第 1 轮', seq: 1 },
        { label: '用户消息', detail: '离线预览', seq: 2 },
        { label: '模型回复', detail: '离线预览', seq: 3 },
      ]);
      return;
    }
    api.trajectory(currentSessionId).then(function (r) {
      renderTrajectory((r && r.events) || []);
    });
  }
  window.dshMobileTrajectory = showTrajectory;
  function openSession(id) {
    currentSessionId = id || '';
    if (window.__dshMobile && window.__dshMobile.showPage) window.__dshMobile.showPage('chat');
    if (!ONLINE) {
      renderChat({ messages: MOCK.messages });
      return;
    }
    api.session(id).then(function (r) {
      // 我们的接口已把消息规范化成 {role,text,source}（见插件里的契约注释）
      var msgs = (r && r.messages) || [];
      renderChat({
        // system 提示词不是聊天内容（实测第一条就是"You are an AI agent…"）→ 过滤掉
        messages: msgs
          .filter(function (m) {
            // 只显示真正的聊天：system 角色与 kind=context（运行时上下文/skill 清单）都不是聊天
            return m.role !== 'system' && m.kind !== 'context' && (m.text || '').trim() !== '';
          })
          .map(function (m) {
            return { role: m.role === 'user' ? 'user' : 'assistant', text: m.text || '' };
          }),
      });
    });
  }

  /** 发送：先建会话（若还没有），再 prompt，再轮询读回 */
  function send(text) {
    if (!text || !text.trim()) return Promise.resolve({ ok: false, reason: 'empty' });
    // ⚠️ 必须切到会话页：只在 openSession 里切是不够的 —— 用户直接输入发送时
    //    页面还停在列表页，消息渲染了但看不见（E2E 断言抓到的真实 bug）。
    if (window.__dshMobile && window.__dshMobile.showPage) window.__dshMobile.showPage('chat');
    if (!ONLINE) {
      var page = document.getElementById('page-chat');
      page.insertBefore(messageNode({ role: 'user', text: text }), null);
      page.insertBefore(messageNode({ role: 'assistant', text: '（离线预览，不会真的发送）' }), null);
      return Promise.resolve({ ok: true, offline: true });
    }
    var ensure = currentSessionId ? Promise.resolve({ ok: true, value: { sessionId: currentSessionId } }) : api.create();
    return ensure
      .then(function (r) {
        var sid = (r.value && (r.value.sessionId || r.value.id)) || currentSessionId;
        if (!sid) return { ok: false, reason: 'no-session', detail: r };
        currentSessionId = sid;
        return api.prompt(sid, text).then(function (p) {
          return { ok: p.ok, sessionId: sid, prompt: p };
        });
      })
      .then(function (res) {
        if (res.ok) {
          // 轮询读回（流式下一步做）：2s 内每 600ms 拉一次
          var tries = 0;
          var tick = function () {
            tries += 1;
            if (tries > 4 || !res.sessionId) return;
            api.session(res.sessionId).then(function (s) {
              if (s && s.ok) {
                var count = s.messageCount || 0;
                if (count > 0) {
                  var msgs = (s.messages || [])
                    .filter(function (m) {
                      return m.role !== 'system' && m.kind !== 'context' && (m.text || '').trim() !== '';
                    })
                    .map(function (m) {
                      return { role: m.role === 'user' ? 'user' : 'assistant', text: m.text || '' };
                    });
                  if (!msgs.length) {
                    msgs = [
                      { role: 'user', text: text },
                      { role: 'assistant', text: '已收到 ' + count + ' 条消息（流式渲染下一步接）' },
                    ];
                  }
                  renderChat({ messages: msgs });
                } else {
                  setTimeout(tick, 600);
                }
              }
            });
          };
          setTimeout(tick, 600);
        }
        return res;
      });
  }
  window.dshMobileSend = send;
  window.dshMobileReload = startOnline;   // 配对成功后由外壳/测试调用，或本文件内部调用

  // ── 启动 ─────────────────────────────────────────────────────────
  function boot() {
    // ⚠️ 外壳跳转过来时会带 `?token=…`（见 Android 壳的连接逻辑）——必须**接住它**：
    //    否则页面的 API 请求没有令牌 → 网关 401 → 页面退回连接页（实测：壳跳转成功但列表 0 行）。
    try {
      var qs = new URLSearchParams(location.search || '');
      var urlToken = qs.get('token');
      if (urlToken && !(conn && conn.token)) {
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
    fetch('/mobile/api/health', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (h) {
        if (!h || !h.ok) return;      // 同源连不上 → 留在连接页（正确）
        SAME_ORIGIN = true;
        ONLINE = true;
        if (window.__dshMobile && window.__dshMobile.showPage) window.__dshMobile.showPage('list');
        startOnline();
      });
  }

  function startOnline() {
    if (!ONLINE) {
      renderList(MOCK.sessions);   // file:// 下用假数据（只服务排版断言）
      return;
    }
    // 真数据模式：骨架里的静态演示内容（假会话行、假审批卡）全部清掉 ——
    // 否则会让人以为"真的有审批待办"（假绿，比没有更坏）。
    var card = document.getElementById('approval-card');
    if (card) card.style.display = 'none';
    var chat = document.getElementById('page-chat');
    if (chat) {
      Array.prototype.slice.call(chat.querySelectorAll('.msg')).forEach(function (n) { n.remove(); });
    }
    api.health().then(function (h) {
      if (!h || !h.ok) return;
      api.list().then(function (r) {
        if (r && r.ok) renderList(r.sessions || []);
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
