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

  var ONLINE = location.protocol === 'http:' || location.protocol === 'https:';

  function jfetch(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {})).then(function (r) {
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

  window.dshMobileApi = api;

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
    page.scrollTop = page.scrollHeight;
  }

  var currentSessionId = '';
  function openSession(id) {
    currentSessionId = id || '';
    if (window.__dshMobile && window.__dshMobile.showPage) window.__dshMobile.showPage('chat');
    if (!ONLINE) {
      renderChat({ messages: MOCK.messages });
      return;
    }
    api.session(id).then(function (r) {
      var msgs = (r.messagesSample || []).map(function () {
        return { role: 'assistant', text: '(见轨迹)' };
      });
      // 真消息在 /mobile/api/session 的 sample 里是摘要形态；先用最小可用渲染，
      // 精确映射（role/content → 文本）在下一步按实测字段补。
      renderChat({ messages: msgs.length ? msgs : [] });
    });
  }

  /** 发送：先建会话（若还没有），再 prompt，再轮询读回 */
  function send(text) {
    if (!text || !text.trim()) return Promise.resolve({ ok: false, reason: 'empty' });
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
                  renderChat({
                    messages: [{ role: 'user', text: text }, { role: 'assistant', text: '已收到 ' + count + ' 条消息（流式渲染下一步接）' }],
                  });
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
    if (!ONLINE) {
      renderList(MOCK.sessions);
      return;
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
