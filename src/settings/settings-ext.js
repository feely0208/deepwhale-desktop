/* DSH 设置页扩展：在左侧导航（通用设置/模型/插件/Agent 预设）下方顺延注入
 * "宠物 / 用量 / 皮肤"三个设置栏。
 * - 注入到页面主世界；通过 window.dsh（preload 桥）与主进程通信；
 * - 用 MutationObserver 监听设置页挂载，挂载一次注入一次；
 * - 全部样式跟随 DSH 的 --dsw-alias-* 主题变量，与界面划一。 */
(function () {
  if (window.__dshSettingsExtInstalled) return;
  if (!window.dsh || !window.dsh.skinList) return;
  window.__dshSettingsExtInstalled = true;

  var PANEL_ID = 'dsh-ext-panel';
  var NAV_PREFIX = 'dsh-ext-nav-';
  var SEC_PREFIX = 'dsh-ext-sec-';

  /* ---------- DOM 定位（按类名前缀，容忍哈希变化） ---------- */
  function hasClassPrefix(el, prefix) {
    return typeof el.className === 'string' && el.className.split(/\s+/).some(function (c) { return c.indexOf(prefix) === 0; });
  }

  function findNavList() {
    var all = document.querySelectorAll('nav, div');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (hasClassPrefix(el, 'navList') || (typeof el.className === 'string' && el.className.indexOf('navList') !== -1)) {
        if (el.querySelectorAll('[class*="navLabel"]').length >= 3) return el;
      }
    }
    return null;
  }

  function findPanel(navList) {
    var el = navList;
    while (el && !(typeof el.className === 'string' && el.className.indexOf('panel') !== -1)) {
      el = el.parentElement;
    }
    return el;
  }

  function findContent(panel) {
    var divs = panel.querySelectorAll('div');
    for (var i = 0; i < divs.length; i++) {
      if (typeof divs[i].className === 'string' && divs[i].className.indexOf('content') !== -1) return divs[i];
    }
    return null;
  }

  /* ---------- 面板构建 ---------- */
  function buildPanelHtml() {
    return (
      '<div id="' + PANEL_ID + '" class="dsh-ext-panel" style="display:none">' +
      '  <section class="dsh-ext-section" id="' + SEC_PREFIX + 'pet">' +
      '    <h3>宠物</h3>' +
      '    <div class="dsh-ext-row">当前宠物：<b id="dsh-ext-pet-current">默认宠物（橙色小团子）</b></div>' +
      '    <div class="dsh-ext-preview" id="dsh-ext-pet-preview"><span class="ph">默认团子</span></div>' +
      '    <div class="dsh-ext-list" id="dsh-ext-pet-list"></div>' +
      '    <label class="dsh-ext-check"><input type="checkbox" id="dsh-ext-pet-visible" /> 显示宠物</label>' +
      '    <label class="dsh-ext-check"><input type="checkbox" id="dsh-ext-pet-clickthrough" /> 穿透点击（可点到宠物后面的内容）</label>' +
      '    <button class="dsh-ext-btn" id="dsh-ext-pet-open">打开宠物目录…</button>' +
      '  </section>' +
      '  <section class="dsh-ext-section" id="' + SEC_PREFIX + 'usage">' +
      '    <h3>用量与额度</h3>' +
      '    <div class="dsh-ext-grid">' +
      '      <div class="row"><span class="k">状态</span><span id="dsh-ext-u-status">…</span></div>' +
      '      <div class="row"><span class="k">总余额</span><span id="dsh-ext-u-total">—</span></div>' +
      '      <div class="row"><span class="k">赠送 / 充值</span><span id="dsh-ext-u-split">—</span></div>' +
      '      <div class="row"><span class="k">今日请求</span><span id="dsh-ext-u-req">0</span></div>' +
      '      <div class="row"><span class="k">累计 tokens（估）</span><span id="dsh-ext-u-tok">0</span></div>' +
      '    </div>' +
      '    <div class="dsh-ext-err" id="dsh-ext-u-err" hidden></div>' +
      '    <button class="dsh-ext-btn" id="dsh-ext-u-refresh">立即刷新</button>' +
      '  </section>' +
      '  <section class="dsh-ext-section" id="' + SEC_PREFIX + 'skin">' +
      '    <h3>皮肤</h3>' +
      '    <div class="dsh-ext-list" id="dsh-ext-skin-list"></div>' +
      '    <label class="dsh-ext-check"><input type="checkbox" id="dsh-ext-skin-custom" /> 启用自定义 CSS（userData/custom.css）</label>' +
      '    <button class="dsh-ext-btn" id="dsh-ext-skin-open">打开自定义 CSS…</button>' +
      '  </section>' +
      '</div>'
    );
  }

  /* ---------- 导航注入 ---------- */
  function inject(navList) {
    var cells = navList.children;
    if (!cells.length) return;
    var template = cells[0];

    var defs = [
      { id: 'pet', label: '宠物' },
      { id: 'usage', label: '用量' },
      { id: 'skin', label: '皮肤' },
    ];
    defs.forEach(function (def) {
      var cell = template.cloneNode(true);
      cell.id = NAV_PREFIX + def.id;
      cell.className = (cell.className || '').replace(/\bactive\b/gi, '').replace(/\s+/g, ' ').trim();
      var label = cell.querySelector('[class*="navLabel"]');
      if (label) label.textContent = def.label;
      else cell.textContent = def.label;
      navList.appendChild(cell);
    });

    // 面板挂到内容区
    var panel = findPanel(navList);
    var content = panel ? findContent(panel) : null;
    if (content) {
      var wrap = document.createElement('div');
      wrap.innerHTML = buildPanelHtml();
      var panelEl = wrap.firstChild;
      content.appendChild(panelEl);
      bindPanel(panelEl);
    }

    // 导航点击：我们的项激活对应面板；DSH 项则恢复原内容
    if (!navList.__dshExtBound) {
      navList.__dshExtBound = true;
      navList.addEventListener('click', function (e) {
        var cell = e.target && e.target.closest ? e.target.closest('button') : null;
        if (!cell) return;
        if (cell.id && cell.id.indexOf(NAV_PREFIX) === 0) {
          activate(cell.id.slice(NAV_PREFIX.length));
        } else {
          deactivate();
        }
      });
    }
  }

  /* ---------- 面板逻辑 ---------- */
  function bindPanel(panelEl) {
    // 宠物
    var petListEl = document.getElementById('dsh-ext-pet-list');
    var petCurrentEl = document.getElementById('dsh-ext-pet-current');
    var petPreviewEl = document.getElementById('dsh-ext-pet-preview');
    var petVisibleEl = document.getElementById('dsh-ext-pet-visible');
    var petClickEl = document.getElementById('dsh-ext-pet-clickthrough');

    function renderPets(state) {
      var current = state.current;
      var items = [
        { name: null, label: '默认宠物（橙色小团子）' }
      ].concat((state.list || []).map(function (n) { return { name: n, label: n }; }));

      petListEl.innerHTML = '';
      items.forEach(function (it) {
        var div = document.createElement('div');
        div.className = 'dsh-ext-item' + (current === it.name ? ' active' : '');
        div.textContent = it.label;
        div.addEventListener('click', function () {
          window.dsh.petSelect(it.name);
          petCurrentEl.textContent = it.label;
          Array.prototype.forEach.call(petListEl.children, function (c) { c.classList.remove('active'); });
          div.classList.add('active');
        });
        petListEl.appendChild(div);
      });
      petCurrentEl.textContent = current ? current : '默认宠物（橙色小团子）';
      petVisibleEl.checked = !!state.visible;
      petClickEl.checked = !!state.clickThrough;
      if (state.previewDataUri) {
        petPreviewEl.innerHTML = '<img src="' + state.previewDataUri + '" alt="pet" />';
      } else {
        petPreviewEl.innerHTML = '<span class="ph">' + (current ? 'GIF 不支持预览' : '默认团子') + '</span>';
      }
    }

    window.dsh.petState().then(renderPets);
    petVisibleEl.addEventListener('change', function () { window.dsh.petSetVisible(petVisibleEl.checked); });
    petClickEl.addEventListener('change', function () { window.dsh.petSetClickThrough(petClickEl.checked); });
    document.getElementById('dsh-ext-pet-open').addEventListener('click', function () { window.dsh.petOpenFolder(); });

    // 用量
    var uStatus = document.getElementById('dsh-ext-u-status');
    var uTotal = document.getElementById('dsh-ext-u-total');
    var uSplit = document.getElementById('dsh-ext-u-split');
    var uReq = document.getElementById('dsh-ext-u-req');
    var uTok = document.getElementById('dsh-ext-u-tok');
    var uErr = document.getElementById('dsh-ext-u-err');

    function fmtTokens(n) {
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
      return String(n);
    }
    function renderUsage(data) {
      if (!data) return;
      if (data.error) {
        uErr.textContent = data.error;
        uErr.hidden = false;
        uStatus.textContent = '未连接';
        return;
      }
      uErr.hidden = true;
      var low = !!data.lowBalance;
      var unavailable = data.available === false;
      uStatus.textContent = unavailable ? '不可用' : low ? '余额偏低' : '正常';
      var first = data.balanceInfos && data.balanceInfos[0];
      if (first) {
        uTotal.textContent = first.totalBalance + ' ' + first.currency;
        uSplit.textContent = '赠 ' + first.grantedBalance + ' / 充 ' + first.toppedUpBalance;
      }
      uReq.textContent = String(data.todayRequests || 0);
      uTok.textContent = fmtTokens((data.totalInputTokens || 0) + (data.totalOutputTokens || 0));
    }
    window.dsh.onUsageUpdate(renderUsage);
    document.getElementById('dsh-ext-u-refresh').addEventListener('click', function () { window.dsh.usageRefresh(); });

    // 皮肤
    var skinListEl = document.getElementById('dsh-ext-skin-list');
    var skinCustomEl = document.getElementById('dsh-ext-skin-custom');

    window.dsh.skinState().then(function (state) {
      skinCustomEl.checked = !!state.customCssEnabled;
      window.dsh.skinList().then(function (names) {
        skinListEl.innerHTML = '';
        names.forEach(function (n) {
          var div = document.createElement('div');
          div.className = 'dsh-ext-item' + (state.current === n ? ' active' : '');
          div.textContent = n;
          div.addEventListener('click', function () {
            window.dsh.skinSet(n);
            Array.prototype.forEach.call(skinListEl.children, function (c) { c.classList.remove('active'); });
            div.classList.add('active');
          });
          skinListEl.appendChild(div);
        });
      });
    });
    skinCustomEl.addEventListener('change', function () { window.dsh.skinToggleCustomCss(skinCustomEl.checked); });
    document.getElementById('dsh-ext-skin-open').addEventListener('click', function () { window.dsh.skinOpenCss(); });
  }

  /* ---------- 激活/恢复 ---------- */
  function getPanelEl() { return document.getElementById(PANEL_ID); }
  function getContent() {
    var navList = findNavList();
    var panel = navList ? findPanel(navList) : null;
    return panel ? findContent(panel) : null;
  }

  function activate(id) {
    var content = getContent();
    var panelEl = getPanelEl();
    if (!content || !panelEl) return;
    // 隐藏 DSH 原内容
    Array.prototype.forEach.call(content.children, function (c) {
      if (c !== panelEl) c.style.display = 'none';
    });
    // 显示对应分栏
    panelEl.style.display = '';
    Array.prototype.forEach.call(panelEl.querySelectorAll('.dsh-ext-section'), function (s) {
      s.style.display = (s.id === SEC_PREFIX + id) ? '' : 'none';
    });
    // 导航 active 态
    var navList = findNavList();
    if (navList) {
      Array.prototype.forEach.call(navList.querySelectorAll('button'), function (b) {
        if (b.id && b.id.indexOf(NAV_PREFIX) === 0) {
          b.classList.toggle('dsh-ext-nav-active', b.id === NAV_PREFIX + id);
        }
      });
    }
    // 首次打开用量栏时主动刷新一次
    if (id === 'usage') window.dsh.usageRefresh();
  }

  function deactivate() {
    var content = getContent();
    var panelEl = getPanelEl();
    if (!content || !panelEl) return;
    panelEl.style.display = 'none';
    Array.prototype.forEach.call(content.children, function (c) {
      if (c !== panelEl) c.style.display = '';
    });
    var navList = findNavList();
    if (navList) {
      Array.prototype.forEach.call(navList.querySelectorAll('button'), function (b) {
        if (b.id && b.id.indexOf(NAV_PREFIX) === 0) b.classList.remove('dsh-ext-nav-active');
      });
    }
  }

  /* ---------- 观察设置页挂载 ---------- */
  function maybeInject() {
    if (document.getElementById(NAV_PREFIX + 'pet')) return; // 本挂载周期已注入
    var navList = findNavList();
    if (navList) inject(navList);
  }

  var observer = new MutationObserver(function () { maybeInject(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  maybeInject();
})();
