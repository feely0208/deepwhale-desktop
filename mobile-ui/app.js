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
  /** 是否是"由网关/DSH 直接打开的页面"（此时同源即已认证，不用再配对） */
  var SAME_ORIGIN = location.protocol === 'http:' || location.protocol === 'https:';
  var ONLINE = !!(conn && conn.origin) || SAME_ORIGIN;

  /** 当前所有请求的基地址（独立 App 时是网关地址；同源打开时空串） */
  function base() {
    if (conn && conn.origin) return conn.origin;
    return '';
  }
  function authQuery() {
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
    return fetch(url, Object.assign({ credentials: base() ? 'omit' : 'same-origin' }, opts || {})).then(function (r) {
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
      t.appendChild(el('span', 'title', s.title || s.id || '(未命名)'));
      t.appendChild(el('span', 'sub', s.id || ''));
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

  // ── 启动 ─────────────────────────────────────────────────────────
  function boot() {
    // 独立 App 且还没配对 → 显示连接页（真实用户的第一步）
    if (SAME_ORIGIN === false && !(conn && conn.origin)) {
      if (window.__dshMobile && window.__dshMobile.showPage) window.__dshMobile.showPage('connect');
      return;
    }
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
