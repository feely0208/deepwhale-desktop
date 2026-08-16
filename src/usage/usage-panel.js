/* 注入式用量面板：右下角可折叠，展示 DeepSeek API 余额（额度）与本地累计用量。
 * 由主进程 executeJavaScript 注入到页面主世界；数据经 preload 的
 * window.dsh.onUsageUpdate 推送（渲染层只拿脱敏展示数据，不接触 API Key）。 */
(function () {
  if (document.getElementById('dsh-usage-panel')) return; // 防重复注入
  if (!window.dsh || typeof window.dsh.onUsageUpdate !== 'function') return;

  var PANEL_ID = 'dsh-usage-panel';
  var panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML =
    '<div class="uph">' +
    '  <span class="dot" id="dsh-up-dot"></span>' +
    '  <span class="title">DeepSeek 用量</span>' +
    '  <span class="arrow">▾</span>' +
    '</div>' +
    '<div class="upb">' +
    '  <div class="row"><span class="k">状态</span><span class="v" id="dsh-up-status">…</span></div>' +
    '  <div class="row"><span class="k">API Key</span><span class="v" id="dsh-up-key">—</span></div>' +
    '  <div class="row"><span class="k">总余额</span><span class="v" id="dsh-up-total">—</span></div>' +
    '  <div class="row"><span class="k">赠送 / 充值</span><span class="v" id="dsh-up-split">—</span></div>' +
    '  <div class="row"><span class="k">今日请求</span><span class="v" id="dsh-up-requests">0</span></div>' +
    '  <div class="row"><span class="k">累计 tokens（估）</span><span class="v" id="dsh-up-tokens">0</span></div>' +
    '  <div class="bars">' +
    '    <div class="bar-caption">余额充足度</div>' +
    '    <div class="bar"><i class="bar-fill" id="dsh-up-bar"></i></div>' +
    '    <div class="bar-caption">额度构成（赠送 / 充值）</div>' +
    '    <div class="bar seg" id="dsh-up-seg"></div>' +
    '  </div>' +
    '  <div class="err-line" id="dsh-up-err" hidden></div>' +
    '  <div class="refresh-btn" id="dsh-up-refresh">立即刷新</div>' +
    '</div>';
  document.body.appendChild(panel);

  var dot = panel.querySelector('#dsh-up-dot');
  var statusEl = panel.querySelector('#dsh-up-status');
  var keyEl = panel.querySelector('#dsh-up-key');
  var totalEl = panel.querySelector('#dsh-up-total');
  var splitEl = panel.querySelector('#dsh-up-split');
  var reqEl = panel.querySelector('#dsh-up-requests');
  var tokEl = panel.querySelector('#dsh-up-tokens');
  var errEl = panel.querySelector('#dsh-up-err');
  var upBar = panel.querySelector('#dsh-up-bar');
  var upSeg = panel.querySelector('#dsh-up-seg');

  var collapsed = false;
  try {
    collapsed = localStorage.getItem('dsh-usage-panel-collapsed') === '1';
  } catch (_) {
    /* ignore */
  }
  panel.classList.toggle('collapsed', collapsed);

  panel.querySelector('.uph').addEventListener('click', function () {
    collapsed = !collapsed;
    panel.classList.toggle('collapsed', collapsed);
    try {
      localStorage.setItem('dsh-usage-panel-collapsed', collapsed ? '1' : '0');
    } catch (_) {
      /* ignore */
    }
  });

  /* 手动拖动定位（按住标题栏拖动；点击仍用于折叠/展开） */
  (function () {
    var header = panel.querySelector('.uph');
    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    header.addEventListener('pointerdown', function (e) {
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      var r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top;
      header.setPointerCapture && header.setPointerCapture(e.pointerId);
    });
    header.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      moved = true;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = Math.max(0, Math.min(window.innerWidth - 60, ox + dx)) + 'px';
      panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, oy + dy)) + 'px';
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        try {
          localStorage.setItem('dsh-usage-panel-pos', JSON.stringify({ left: panel.style.left, top: panel.style.top }));
        } catch (_) { /* ignore */ }
      }
    }
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
  })();

  /* 恢复上次拖放位置 */
  try {
    var savedPos = localStorage.getItem('dsh-usage-panel-pos');
    if (savedPos) {
      var pos = JSON.parse(savedPos);
      if (pos && pos.left && pos.top) {
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = pos.left;
        panel.style.top = pos.top;
      }
    }
  } catch (_) { /* ignore */ }

  panel.querySelector('#dsh-up-refresh').addEventListener('click', function (e) {
    e.stopPropagation();
    window.dsh.usageRefresh();
  });

  function fmtTokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  function renderBars(data) {
    var first = data.balanceInfos && data.balanceInfos[0];
    if (!first) return;
    var total = parseFloat(first.totalBalance) || 0;
    var granted = parseFloat(first.grantedBalance) || 0;
    var topped = parseFloat(first.toppedUpBalance) || 0;
    var pct = Math.min(100, Math.max(0, (total / 10) * 100));
    upBar.style.width = pct.toFixed(0) + '%';
    upBar.className = 'bar-fill' + (pct >= 50 ? ' ok' : pct >= 25 ? ' warn' : ' err');
    if (total > 0) {
      var g = Math.min(100, (granted / total) * 100).toFixed(1);
      var t = Math.min(100, (topped / total) * 100).toFixed(1);
      upSeg.innerHTML = '<i class="seg-granted" style="width:' + g + '%"></i><i class="seg-topped" style="width:' + t + '%"></i>';
    } else {
      upSeg.innerHTML = '';
    }
  }

  function update(data) {
    if (!data) return;
    if (data.error) {
      dot.className = 'dot err';
      statusEl.textContent = '未连接';
      errEl.textContent = data.error;
      errEl.hidden = false;
      totalEl.textContent = '—';
      splitEl.textContent = '—';
      upBar.style.width = '0%';
      upSeg.innerHTML = '';
      return;
    }
    errEl.hidden = true;
    var low = !!data.lowBalance;
    var unavailable = data.available === false;
    dot.className = 'dot ' + (low || unavailable ? 'low' : 'ok');
    statusEl.textContent = unavailable ? '不可用' : low ? '余额偏低' : '正常';

    var first = data.balanceInfos && data.balanceInfos[0];
    if (first) {
      totalEl.textContent = first.totalBalance + ' ' + first.currency;
      splitEl.textContent = '赠 ' + first.grantedBalance + ' / 充 ' + first.toppedUpBalance;
    } else {
      totalEl.textContent = '—';
      splitEl.textContent = '—';
    }
    keyEl.textContent = data.apiKeyConfigured ? '已配置 ✓' : '未配置';
    keyEl.style.color = data.apiKeyConfigured ? '#1a7f37' : '#9a6700';
    reqEl.textContent = String(data.todayRequests || 0);
    tokEl.textContent = fmtTokens((data.totalInputTokens || 0) + (data.totalOutputTokens || 0));
    renderBars(data);
  }

  // 供主进程直接推送（executeJavaScript 可调用）
  window.__usagePanel = { update: update };
  window.dsh.onUsageUpdate(update);
})();
