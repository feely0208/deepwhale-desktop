/* =========================================================================
   log.js — 本地运行日志（技术事件，不含业务内容）
   -------------------------------------------------------------------------
   与鸿蒙端保持同一策略：
     · 只记：时间 / 模块 / 事件 / 结果 / 错误码 / 耗时 / 设备参数
     · 不记：案件、客户、文书、证据等业务内容；不记完整 API Key
     · 容量：环形缓冲，最多 1000 条或 30 天
     · 位置：本机，不上传。是否提供给我们由用户决定
   ========================================================================= */
(function () {
  'use strict';

  var KEY = 'dw_desktop_log_v1';
  var MAX = 1000;                    // 最多保留条数
  var MAX_AGE = 30 * 24 * 3600 * 1000;  // 最多保留 30 天

  function now() { return Date.now(); }

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) { return []; }
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function write(arr) {
    try {
      // 先按时间淘汰，再按条数截断
      var cut = now() - MAX_AGE;
      var kept = arr.filter(function (x) { return x.t >= cut; });
      if (kept.length > MAX) { kept = kept.slice(kept.length - MAX); }
      localStorage.setItem(KEY, JSON.stringify(kept));
      return kept.length;
    } catch (e) { return -1; }
  }

  /** 脱敏：Key 只留前 6 位 + 末 4 位；机器码只留末 4 位 */
  function maskKey(k) {
    var s = String(k || '');
    if (s.length <= 12) { return s ? '***' : ''; }
    return s.slice(0, 6) + '…' + s.slice(-4);
  }
  function maskMachine(m) {
    var s = String(m || '');
    return s.length > 4 ? '…' + s.slice(-4) : s;
  }
  function errBrief(e) {
    if (!e) { return ''; }
    var m = (e && e.message) || String(e);
    return String(m).slice(0, 160);
  }

  var Log = {
    enabled: true,

    /** 记录一条 */
    push: function (level, mod, event, detail) {
      if (!Log.enabled) { return; }
      var rec = { t: now(), lv: level, mod: mod, ev: event };
      if (detail !== undefined && detail !== null && detail !== '') {
        rec.d = typeof detail === 'string' ? detail.slice(0, 200) : detail;
      }
      var arr = read();
      arr.push(rec);
      write(arr);
    },

    i: function (mod, ev, d) { Log.push('i', mod, ev, d); },
    w: function (mod, ev, d) { Log.push('w', mod, ev, d); },
    e: function (mod, ev, d) { Log.push('e', mod, ev, d); },

    /** 操作路径 */
    act: function (mod, action) { Log.push('a', mod, action); },

    /** 带耗时的调用包装 */
    span: function (mod, ev) {
      var t0 = now();
      return function (ok, detail) {
        Log.push(ok === false ? 'e' : 'i', mod, ev,
          (ok === false ? '失败 ' : '成功 ') + (now() - t0) + 'ms' + (detail ? ' ' + detail : ''));
      };
    },

    count: function () { return read().length; },

    recent: function (n) { var a = read(); return a.slice(Math.max(0, a.length - (n || 50))); },

    /** 导出为文本 */
    exportText: function () {
      var arr = read();
      var head = [
        '深鲸·律师端（桌面端）· 运行日志',
        '导出时间：' + new Date().toLocaleString('zh-CN', { hour12: false }),
        '记录条数：' + arr.length + '（最多保留 30 天或 1000 条）',
        '说明：仅记录技术事件，不含案件、客户、文书、证据等业务内容，',
        '      不含完整 API Key。日志仅存本机，是否提供给我们由您决定。',
        '─'.repeat(60), ''
      ].join('\n');
      var lv = { i: '信息', w: '警告', e: '错误', a: '操作' };
      var body = arr.map(function (x) {
        var ts = new Date(x.t).toLocaleString('zh-CN', { hour12: false });
        var d = x.d === undefined ? '' : (typeof x.d === 'string' ? x.d : JSON.stringify(x.d));
        return '[' + ts + '] [' + (lv[x.lv] || x.lv) + '] [' + x.mod + '] ' + x.ev + (d ? ' — ' + d : '');
      }).join('\n');
      return head + body;
    },

    clear: function () { try { localStorage.removeItem(KEY); } catch (e) {} return 0; },

    maskKey: maskKey,
    maskMachine: maskMachine,
    errBrief: errBrief
  };

  window.Log = Log;

  // 启动即记一条环境信息（不含任何业务内容）
  Log.i('启动', '客户端启动', (navigator.platform || '') + ' / ' + (navigator.userAgent || '').slice(0, 80));
})();
