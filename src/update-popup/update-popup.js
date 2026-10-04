/**
 * 更新弹窗的渲染层（2026-10-04）
 *
 * 用户要求：「弹出的更新页面需要你精心设计一个，不要太敷衍的那种，用辉光底加一些你的创意」
 *  + 「更新内容在设置页面就不要显示了，增加一个选项按钮在帮助里面」
 *
 * 两个入口共用这一个弹窗：
 *   · 下载开始时自动弹出（显示进度 + 本版更新内容 + 重启按钮）
 *   · 帮助菜单「本版更新内容…」手动打开（只看说明，进度区隐藏）
 *
 * 数据由主进程推送：
 *   { type: 'state', phase, percent, message }   更新状态
 *   { type: 'notes', version, title, date, items }
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var KIND_ICON = { feat: '✨', fix: '🛠', perf: '⚡', docs: '📘', security: '🔒' };

  function renderItems(items) {
    var ul = $('items');
    var empty = $('notes-empty');
    ul.textContent = '';
    if (!items || !items.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    items.forEach(function (it) {
      var li = document.createElement('li');
      var k = document.createElement('span');
      k.className = 'k';
      k.textContent = KIND_ICON[it.kind] || '•';
      var t = document.createElement('span');
      t.textContent = it.text;
      li.appendChild(k);
      li.appendChild(t);
      ul.appendChild(li);
    });
  }

  function applyNotes(msg) {
    $('notes-title').textContent = '本版更新内容';
    $('notes-tag').textContent = msg.version ? 'v' + msg.version : '';
    if (msg.title) {
      $('title').textContent = '深鲸桌面 ' + (msg.version || '');
      $('subtitle').textContent = msg.title + (msg.date ? '　·　' + msg.date : '');
    } else if (msg.version) {
      $('title').textContent = '深鲸桌面 ' + msg.version;
    }
    renderItems(msg.items);
  }

  function applyState(st) {
    var phase = st && st.phase ? st.phase : 'idle';
    var pct = st && typeof st.percent === 'number' ? st.percent : null;
    var bar = document.querySelector('.bar');
    var progress = $('progress-wrap');

    if (phase === 'downloaded') {
      progress.hidden = false;
      bar.classList.remove('indet');
      $('fill').style.width = '100%';
      $('pct').textContent = '100%';
      $('speed').textContent = '';
      $('status').textContent = '下载完成，重启应用后生效。';
      $('eyebrow').textContent = '下载完成';
      var b = $('btn-restart');
      b.disabled = false;
      b.textContent = '立即重启';
    } else if (phase === 'downloading') {
      progress.hidden = false;
      var later2 = $('btn-later');
      if (later2) later2.hidden = false;
      bar.classList.toggle('indet', pct === null);
      $('fill').style.width = (pct === null ? 0 : pct) + '%';
      $('pct').textContent = pct === null ? '—' : pct + '%';
      $('speed').textContent = pct === null ? '' : '已下载';
      $('status').textContent = pct === null ? '正在连接更新源…' : '正在下载安装包，可继续使用，不打断当前工作。';
      $('eyebrow').textContent = '正在下载更新';
      var b2 = $('btn-restart');
      b2.disabled = true;
      b2.textContent = '下载中…';
    } else {
      // 手动打开（帮助菜单）或更新已结束：只显示说明
      progress.hidden = true;
      $('eyebrow').textContent = '深鲸桌面更新';     // 别和下面「本版更新内容」重复
      var b3 = $('btn-restart');
      b3.disabled = false;
      b3.textContent = '知道了';
      var later = $('btn-later');
      if (later) later.hidden = true;                // 「稍后」只在真下载时有意义
    }
  }

  window.addEventListener('message', function () {});
  // 主进程通过 preload 暴露的桥推送
  if (window.dshPopup && typeof window.dshPopup.on === 'function') {
    window.dshPopup.on(function (msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'state') applyState(msg);
      else if (msg.type === 'notes') applyNotes(msg);
    });
  }

  function send(action) {
    if (window.dshPopup && typeof window.dshPopup.action === 'function') window.dshPopup.action(action);
  }
  $('btn-restart').addEventListener('click', function () { send('restart'); });
  $('btn-later').addEventListener('click', function () { send('later'); });
  $('btn-close').addEventListener('click', function () { send('close'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') send('close');
  });

  // 先按"仅说明"渲染，避免打开瞬间是空白
  applyState({ phase: 'idle' });
  if (window.dshPopup && typeof window.dshPopup.ready === 'function') window.dshPopup.ready();
})();
