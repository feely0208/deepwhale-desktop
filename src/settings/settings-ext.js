/* DSH 设置页扩展：在左侧导航（通用设置/模型/插件/Agent 预设）下方顺延注入
 * "宠物 / 用量 / 皮肤"三个设置栏。
 * - 注入到页面主世界；通过 window.dsh（preload 桥）与主进程通信；
 * - 用 MutationObserver 监听设置页挂载，挂载一次注入一次；
 * - 全部样式跟随 DSH 的 --dsw-alias-* 主题变量，与界面划一。 */
(function () {
  if (window.__dshSettingsExtInstalled) return;
  if (!window.dsh || !window.dsh.themeState || !window.dsh.petState) return;
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
      '    <div class="dsh-ext-row">当前宠物：<b id="dsh-ext-pet-current">—</b></div>' +
      '    <div class="dsh-ext-preview" id="dsh-ext-pet-preview"><span class="ph">—</span></div>' +
      '    <div class="dsh-ext-list" id="dsh-ext-pet-list"></div>' +
      '    <label class="dsh-ext-check"><input type="checkbox" id="dsh-ext-pet-visible" /> 显示宠物</label>' +
      '    <label class="dsh-ext-check"><input type="checkbox" id="dsh-ext-pet-clickthrough" /> 穿透点击（可点到宠物后面的内容）</label>' +
      '    <div class="dsh-ext-row">动画帧率：<b id="dsh-ext-pet-fps-val">130ms/帧</b></div>' +
      '    <input type="range" class="dsh-ext-range" id="dsh-ext-pet-frame" min="40" max="300" step="5" />' +
      '    <div class="dsh-ext-row">宠物大小：<b id="dsh-ext-pet-scale-val">100%</b></div>' +
      '    <input type="range" class="dsh-ext-range" id="dsh-ext-pet-scale" min="0.6" max="2" step="0.1" />' +
      '    <div class="dsh-ext-btns">' +
      '      <button class="dsh-ext-btn" id="dsh-ext-pet-open">打开宠物目录…</button>' +
      '      <button class="dsh-ext-btn" id="dsh-ext-pet-studio">宠物工坊…</button>' +
      '    </div>' +
      '  </section>' +
      '  <section class="dsh-ext-section" id="' + SEC_PREFIX + 'usage">' +
      '    <h3>用量与额度</h3>' +
      '    <div class="dsh-ext-grid">' +
      '      <div class="row"><span class="k">状态</span><span id="dsh-ext-u-status">…</span></div>' +
      '      <div class="row"><span class="k">API Key</span><span id="dsh-ext-u-key">—</span></div>' +
      '      <div class="dsh-ext-row">配置 API Key（加密保存）：</div>' +
      '      <input type="password" class="dsh-ext-key-input" id="dsh-ext-u-key-input" placeholder="sk-..." spellcheck="false" autocomplete="off" />' +
      '      <div class="dsh-ext-btns">' +
      '        <button class="dsh-ext-btn" id="dsh-ext-u-key-save">保存 Key</button>' +
      '        <button class="dsh-ext-btn" id="dsh-ext-u-key-clear">清除</button>' +
      '      </div>' +
      '      <label class="dsh-ext-check"><input type="checkbox" id="dsh-ext-u-keepdsh" /> 退出时保留 DSH 服务（下次启动秒开）</label>' +
      '      <div class="row"><span class="k">总余额</span><span id="dsh-ext-u-total">—</span></div>' +
      '      <div class="row"><span class="k">赠送 / 充值</span><span id="dsh-ext-u-split">—</span></div>' +
      '      <div class="row"><span class="k">今日请求</span><span id="dsh-ext-u-req">0</span></div>' +
      '      <div class="row"><span class="k">累计 tokens（估）</span><span id="dsh-ext-u-tok">0</span></div>' +
      '    </div>' +
      '    <div class="dsh-ext-bars">' +
      '      <div class="dsh-ext-bar-caption">余额充足度</div>' +
      '      <div class="dsh-ext-bar"><i class="dsh-ext-bar-fill" id="dsh-ext-u-bar"></i></div>' +
      '      <div class="dsh-ext-bar-caption">额度构成（赠送 / 充值）</div>' +
      '      <div class="dsh-ext-bar dsh-ext-bar-seg" id="dsh-ext-u-seg"></div>' +
      '    </div>' +
      '    <div class="dsh-ext-err" id="dsh-ext-u-err" hidden></div>' +
      '    <button class="dsh-ext-btn" id="dsh-ext-u-refresh">立即刷新</button>' +
      '  </section>' +
      '  <section class="dsh-ext-section" id="' + SEC_PREFIX + 'skin">' +
      '    <h3>皮肤（背景）</h3>' +
      '    <div class="dsh-ext-row">内置背景（默认，纯 CSS 绘制；照官方 harness 官网那套深蓝辉光做的）</div>' +
      '    <div class="dsh-ext-btns">' +
      '      <button class="dsh-ext-btn" id="dsh-ext-skin-preset-blue">深蓝辉光</button>' +
      '      <button class="dsh-ext-btn" id="dsh-ext-skin-preset-none">纯色</button>' +
      '    </div>' +
      '    <div class="dsh-ext-row">自定义背景图片（选了图就盖过内置背景；主题外观请在 DSH 通用设置里调整）</div>' +
      '    <div class="dsh-ext-preview dsh-ext-preview-bg" id="dsh-ext-skin-preview"><span class="ph">未设置</span></div>' +
      '    <div class="dsh-ext-btns">' +
      '      <button class="dsh-ext-btn" id="dsh-ext-skin-pick">选择图片…</button>' +
      '      <button class="dsh-ext-btn" id="dsh-ext-skin-clear">移除背景</button>' +
      '    </div>' +
      '    <div class="dsh-ext-row">背景可见度：<b id="dsh-ext-skin-opacity-val">85%</b></div>' +
      '    <input type="range" class="dsh-ext-range" id="dsh-ext-skin-opacity" min="0.3" max="1" step="0.05" />' +
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
      cell.className = (cell.className || '').replace(/active/gi, '').replace(/\s+/g, ' ').trim();
      // 清掉克隆自"选中态"的残留子元素（高亮色块等）
      cell.querySelectorAll('[class*="active"]').forEach(function (el) { el.remove(); });
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
    var frameEl = document.getElementById('dsh-ext-pet-frame');
    var frameValEl = document.getElementById('dsh-ext-pet-fps-val');
    var scaleEl = document.getElementById('dsh-ext-pet-scale');
    var scaleValEl = document.getElementById('dsh-ext-pet-scale-val');

    function renderPets(state) {
      var current = state.current;
      petListEl.innerHTML = '';
      (state.list || []).forEach(function (n) {
        var div = document.createElement('div');
        div.className = 'dsh-ext-item' + (current === n ? ' active' : '');
        div.textContent = n;
        div.addEventListener('click', function () {
          window.dsh.petSelect(n);
          petCurrentEl.textContent = n;
          Array.prototype.forEach.call(petListEl.children, function (c) { c.classList.remove('active'); });
          div.classList.add('active');
        });
        petListEl.appendChild(div);
      });
      petCurrentEl.textContent = current || '—';
      petVisibleEl.checked = !!state.visible;
      petClickEl.checked = !!state.clickThrough;
      var fm = state.frameMs || 130;
      frameEl.value = String(fm);
      frameValEl.textContent = fm + 'ms/帧';
      var sc = state.scale || 1;
      scaleEl.value = String(sc);
      scaleValEl.textContent = Math.round(sc * 100) + '%';
      if (state.previewDataUri) {
        petPreviewEl.innerHTML = '<img src="' + state.previewDataUri + '" alt="pet" />';
      } else {
        petPreviewEl.innerHTML = '<span class="ph">' + (current || '—') + '</span>';
      }
    }

    window.dsh.petState().then(renderPets);
    petVisibleEl.addEventListener('change', function () { window.dsh.petSetVisible(petVisibleEl.checked); });
    petClickEl.addEventListener('change', function () { window.dsh.petSetClickThrough(petClickEl.checked); });
    frameEl.addEventListener('input', function () { frameValEl.textContent = frameEl.value + 'ms/帧'; });
    frameEl.addEventListener('change', function () {
      window.dsh.petSetConfig(parseInt(frameEl.value, 10), parseFloat(scaleEl.value));
    });
    scaleEl.addEventListener('input', function () { scaleValEl.textContent = Math.round(parseFloat(scaleEl.value) * 100) + '%'; });
    scaleEl.addEventListener('change', function () {
      window.dsh.petSetConfig(parseInt(frameEl.value, 10), parseFloat(scaleEl.value));
    });
    document.getElementById('dsh-ext-pet-open').addEventListener('click', function () { window.dsh.petOpenFolder(); });
    document.getElementById('dsh-ext-pet-studio').addEventListener('click', function () { window.dsh.petStudioOpen(); });

    // 用量
    var uStatus = document.getElementById('dsh-ext-u-status');
    var uKey = document.getElementById('dsh-ext-u-key');
    var uTotal = document.getElementById('dsh-ext-u-total');
    var uSplit = document.getElementById('dsh-ext-u-split');
    var uReq = document.getElementById('dsh-ext-u-req');
    var uTok = document.getElementById('dsh-ext-u-tok');
    var uErr = document.getElementById('dsh-ext-u-err');
    var uKeyInput = document.getElementById('dsh-ext-u-key-input');
    document.getElementById('dsh-ext-u-key-save').addEventListener('click', function () {
      var k = uKeyInput.value.trim();
      if (k) { window.dsh.setApiKey(k); uKeyInput.value = ''; window.dsh.usageRefresh(); }
    });
    document.getElementById('dsh-ext-u-key-clear').addEventListener('click', function () {
      window.dsh.setApiKey('');
      window.dsh.usageRefresh();
    });
    var keepDshEl = document.getElementById('dsh-ext-u-keepdsh');
    if (keepDshEl && window.dsh.getSetting) {
      window.dsh.getSetting('keepDshRunning').then(function (v) {
        keepDshEl.checked = v !== false;
      }).catch(function () { /* ignore */ });
      keepDshEl.addEventListener('change', function () {
        window.dsh.setSetting('keepDshRunning', keepDshEl.checked);
      });
    }
    var uBar = document.getElementById('dsh-ext-u-bar');
    var uSeg = document.getElementById('dsh-ext-u-seg');

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
      // 余额充足度：以 ¥10 为满格参考
      var pct = Math.min(100, Math.max(0, (total / 10) * 100));
      uBar.style.width = pct.toFixed(0) + '%';
      uBar.className = 'dsh-ext-bar-fill' + (pct >= 50 ? ' ok' : pct >= 25 ? ' warn' : ' err');
      // 额度构成：赠送 / 充值 两段
      if (total > 0) {
        var g = Math.min(100, (granted / total) * 100).toFixed(1);
        var t = Math.min(100, (topped / total) * 100).toFixed(1);
        uSeg.innerHTML = '<i class="seg-granted" style="width:' + g + '%"></i><i class="seg-topped" style="width:' + t + '%"></i>';
      } else {
        uSeg.innerHTML = '';
      }
    }
    function renderUsage(data) {
      if (!data) return;
      uKey.textContent = data.apiKeyConfigured ? '已配置 ✓' : '未配置';
      uKey.style.color = data.apiKeyConfigured ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)';
      if (data.error) {
        uErr.textContent = data.error;
        uErr.hidden = false;
        uStatus.textContent = '未连接';
        uBar.style.width = '0%';
        uSeg.innerHTML = '';
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
      renderBars(data);
    }
    window.dsh.onUsageUpdate(renderUsage);
    document.getElementById('dsh-ext-u-refresh').addEventListener('click', function () { window.dsh.usageRefresh(); });

    // 皮肤（背景图片 + 透明度；主题外观交给 DSH 通用设置）
    var skinPreviewEl = document.getElementById('dsh-ext-skin-preview');
    var opacityEl = document.getElementById('dsh-ext-skin-opacity');
    var opacityValEl = document.getElementById('dsh-ext-skin-opacity-val');
    window.dsh.themeState().then(function (state) {
      opacityEl.value = String(state.skinOpacity);
      opacityValEl.textContent = Math.round(state.skinOpacity * 100) + '%';
      if (state.previewDataUri) {
        skinPreviewEl.innerHTML = '<img src="' + state.previewDataUri + '" alt="bg" />';
      } else {
        skinPreviewEl.innerHTML = '<span class="ph">未设置</span>';
      }
    });
    document.getElementById('dsh-ext-skin-pick').addEventListener('click', function () { window.dsh.skinPickImage(); });
    document.getElementById('dsh-ext-skin-clear').addEventListener('click', function () { window.dsh.skinClearImage(); });
    document.getElementById('dsh-ext-skin-preset-blue').addEventListener('click', function () { window.dsh.skinSetPreset('deepseek-blue'); });
    document.getElementById('dsh-ext-skin-preset-none').addEventListener('click', function () { window.dsh.skinSetPreset('none'); });
    opacityEl.addEventListener('input', function () {
      var v = parseFloat(opacityEl.value);
      opacityValEl.textContent = Math.round(v * 100) + '%';
      window.dsh.skinSetOpacity(v);
    });
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
    // 显示对应分栏（必须用 block，空字符串会被 CSS 类 .dsh-ext-section{display:none} 兜底隐藏）
    panelEl.style.display = 'block';
    Array.prototype.forEach.call(panelEl.querySelectorAll('.dsh-ext-section'), function (s) {
      s.style.display = s.id === SEC_PREFIX + id ? 'block' : 'none';
    });
    // 选中态：仅当前选中项显示高亮色块，其余全部清除（含 DSH 自己的 active 残留）
    var navList = findNavList();
    if (navList) {
      Array.prototype.forEach.call(navList.querySelectorAll('button'), function (b) {
        b.classList.remove('dsh-ext-nav-on');
        b.className = String(b.className || '').replace(/active/gi, '').replace(/\s+/g, ' ').trim();
      });
      var cell = document.getElementById(NAV_PREFIX + id);
      if (cell) cell.classList.add('dsh-ext-nav-on');
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

  /* ---------- 在「当前版本」旁边补上 DeepWhale Desktop 的版本号 ----------
   * 通用设置里原本只显示 DSH 运行时的版本（如 0.1.7-rc.2），
   * 用户想确认壳是哪个版本得翻安装包或关于窗口，很别扭。
   * 版本号由主进程注入为 window.__dshShellVersion（settings-inject.ts）。
   * 按文本前缀找节点：DSH 的类名带哈希，靠结构定位不可靠。
   * 只认**叶子节点**，否则会匹配到包住整页的外层容器，把版本号贴到离谱的位置。 */
  function maybeInjectShellVersion() {
    var v = window.__dshShellVersion;
    if (!v) return;
    if (document.getElementById('dsh-ext-shell-version')) return; // 已贴过
    var els = document.querySelectorAll('div, span, p, li, td');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.children.length > 0) continue;
      var t = (el.textContent || '').trim();
      if (t.indexOf('当前版本') !== 0) continue;
      var sep = document.createElement('span');
      sep.textContent = '　·　';
      sep.style.opacity = '.5';
      var tag = document.createElement('span');
      tag.id = 'dsh-ext-shell-version';
      tag.textContent = 'DeepWhale Desktop ' + v;
      el.appendChild(sep);
      el.appendChild(tag);
      appendShellActions(el); // 见下方：检查更新 / 彻底退出后台 / 下载进度
      return;
    }
  }

  /* ---------- 版本号右侧：检查更新 + 彻底退出后台 + 下载进度 ----------
   * 2026-10-03 新增。起因：一位 Windows 用户的托盘图标不可见（图标为空，
   * 或被 Windows 折叠进「^」溢出区）—— 而「检查更新」「退出」当时**只**放在
   * 托盘菜单里，于是关窗最小化后彻底无路可走：退不出后台，新安装包也装不上。
   * 用户建议把这两个动作放在设置里版本号旁边（他一眼就能找到的地方）。
   *
   * 顺带补下载进度：mac 上是"静默下载 dmg"，285MB 一路上没有任何动静，
   * 用户会以为卡死。进度条 + 百分比，心里踏实。
   *
   * 与主进程的通道：window.dshShell.*（由 src/preload/preload.ts 暴露）。 */
  function appendShellActions(host) {
    if (!host || host.querySelector('#dsh-ext-shell-actions')) return;
    var box = document.createElement('span');
    box.id = 'dsh-ext-shell-actions';
    box.style.cssText = 'display:inline-flex;align-items:center;gap:8px;margin-left:auto;padding-left:16px;';

    // 下载进度（默认隐藏；download-progress 事件到达才显示）
    var bar = document.createElement('span');
    bar.id = 'dsh-ext-update-progress';
    bar.style.cssText = 'display:none;align-items:center;gap:6px;font-size:12px;opacity:.85;';
    var track = document.createElement('span');
    track.style.cssText = 'display:inline-block;width:96px;height:6px;border-radius:3px;background:rgba(128,128,128,.25);overflow:hidden;';
    var fill = document.createElement('span');
    fill.id = 'dsh-ext-update-progress-fill';
    fill.style.cssText = 'display:block;width:0%;height:100%;border-radius:3px;background:#05648B;transition:width .2s;';
    track.appendChild(fill);
    var label = document.createElement('span');
    label.id = 'dsh-ext-update-progress-label';
    label.textContent = '正在下载…';
    bar.appendChild(track);
    bar.appendChild(label);

    function mkBtn(text, id, action) {
      var b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      b.textContent = text;
      b.style.cssText = 'font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;cursor:pointer;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;white-space:nowrap;';
      b.addEventListener('click', function () {
        try { action(); } catch (e) { /* 不让按钮异常影响设置页 */ }
      });
      return b;
    }
    box.appendChild(mkBtn('检查更新', 'dsh-ext-check-update', function () {
      if (window.dsh && window.dsh.checkUpdate) window.dsh.checkUpdate();
    }));
    box.appendChild(mkBtn('彻底退出后台', 'dsh-ext-quit-app', function () {
      if (window.dsh && window.dsh.quitApp) window.dsh.quitApp();
    }));
    box.appendChild(bar);
    host.appendChild(box);

    try {
      if (window.dsh && window.dsh.onUpdateState) {
        window.dsh.onUpdateState(function (st) {
          var downloading = !!(st && (st.phase === 'downloading' || st.phase === 'downloaded'));
          bar.style.display = downloading ? 'inline-flex' : 'none';
          if (!downloading) return;
          if (st.phase === 'downloaded') {
            fill.style.width = '100%';
            label.textContent = '已下载好，去安装';
          } else {
            var p = typeof st.percent === 'number' ? st.percent : 0;
            fill.style.width = p + '%';
            label.textContent = '正在下载 ' + p + '%';
          }
        });
      }
    } catch (e) { /* 订阅失败不影响按钮 */ }
  }

  /* ---------- 侧栏「设置」右侧：下载进度（常驻可见，带百分比）----------
   * 2026-10-03 加。用户要求「下载过程可视化，放在设置按钮右方空白处」。
   *
   * ★ 1.0.46 加固。起因：1.0.45 上线后用户反馈「你看更新，只是图标有进度条，
   *   设置旁边并没有显示……图标栏那么小一般他们不会关注到的」。
   *   实测（冒烟探针）确认：条**插上了、也能跟着进度走**，但只有 6px 高、没有文字、
   *   且只在下载那几秒出现 —— 用户根本注意不到。所以本轮改三件事：
   *   ① 带百分比文字（"下载中 67%"）—— 一根细条给不了"确定感"；
   *   ② 条加高加亮（8px / 青蓝 #14A5B8）；
   *   ③ 定位收紧：只认**可点**的那个「设置」（设置面板自己的标题也是叶子节点、
   *      文字同样是「设置」，靠"第一个匹配"会插错地方），且只认可见的候选；
   *      找不到就记一条日志、什么都不插（绝不乱插到别的标题上）。
   *
   * 与设置页版本行那条的分工：那条只在设置页开着时可见，谁也不会开着设置页等下载；
   * 侧栏这条才是"任何时候都看得见"的那个。Dock 徽标继续作为兜底。 */
  var SIDE_BAR_MIN_ROW = 150; // 行宽小于此值视为侧栏折叠 → 藏掉文字，只留条让它铺满
  // 2026-10-03 用户实机验收后的视觉要求（1.0.47）：
  //   「进度条要在设置后面铺满到便捷框（留适当空隙即可）而且进度条要适当宽大些」
  //   → 条不再固定 64px，而是吃满「设置」右侧到便捷框之间的剩余宽度；高度 8 → 12px。
  var SIDE_BAR_TRACK_H = 12;  // 条高（原 8px，太细看不见）
  var SIDE_BAR_GAP_PX = 9;    // 与「设置」文字、与右侧便捷框之间的空隙

  function rectVisible(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** 找侧栏那个「设置」按钮（可点 + 可见），排除设置面板自己的同名标题。 */
  function findSidebarSettingsAnchor() {
    var all = document.querySelectorAll('button, [role="button"], a, span, div');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length > 0) continue;
      if ((el.textContent || '').trim() !== '设置') continue;
      var btn = el.closest ? el.closest('button,[role="button"],a') : null;
      if (!btn) continue; // 设置面板的标题不是可点元素 → 排除
      // 窗口隐藏（最小化到托盘）时布局尺寸不可信，此时不做可见性判断
      if (document.visibilityState === 'visible' && (!rectVisible(btn) || !rectVisible(el))) continue;
      return { label: el, btn: btn };
    }
    return null;
  }

  /**
   * 进度条动画（2026-10-04 用户：「给进度条做个动效，别那么傻傻的跑」）。
   *
   * 纯 CSS，不引 rAF、不在侧栏跑常驻 JS 动画（侧栏是常驻 DOM，动效必须便宜）：
   *   · 填充：宽度缓动推进（.45s 缓出）+ 一条青色流光从左往右扫过（1.4s 一轮）
   *   · 百分比未知：切成"不定态"——一段 36% 宽的填充在轨道里来回游走
   *   · 已下载好：满条 + 一次闪光，然后静止
   *   · 尊重 prefers-reduced-motion：只留宽度过渡，关掉流光与游走
   */
  function ensureProgressAnimCss() {
    if (document.getElementById('dsh-ext-anim')) return;
    var st = document.createElement('style');
    st.id = 'dsh-ext-anim';
    st.textContent = [
      '@keyframes dsh-dl-sweep{0%{transform:translateX(-120%)}100%{transform:translateX(520%)}}',
      '@keyframes dsh-dl-run{0%{transform:translateX(-130%)}100%{transform:translateX(300%)}}',
      '@keyframes dsh-dl-flash{0%{opacity:.05}45%{opacity:.55}100%{opacity:0}}',
      '#dsh-ext-dl-fill:after{content:"";position:absolute;top:0;bottom:0;width:45%;',
      'background:linear-gradient(90deg,rgba(127,227,240,0),rgba(127,227,240,.55),rgba(127,227,240,0));',
      'animation:dsh-dl-sweep 1.4s linear infinite}',
      '#dsh-ext-dl-runner{display:none}',
      '#dsh-ext-dl.indet #dsh-ext-dl-fill{display:none}',
      '#dsh-ext-dl.indet #dsh-ext-dl-runner{display:block;animation:dsh-dl-run 1.25s cubic-bezier(.45,.05,.55,.95) infinite}',
      '#dsh-ext-dl-flash{opacity:0}',
      '#dsh-ext-dl.done #dsh-ext-dl-flash{animation:dsh-dl-flash .7s ease-out 1}',
      '#dsh-ext-update-progress-fill{transition:width .45s cubic-bezier(.22,.61,.36,1) !important}',
      '@media (prefers-reduced-motion: reduce){',
      '#dsh-ext-dl-fill:after{animation:none;opacity:0}',
      '#dsh-ext-dl.indet #dsh-ext-dl-runner{animation:none;transform:none;opacity:.55}',
      '#dsh-ext-dl.done #dsh-ext-dl-flash{animation:none}}',
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  }

  /**
   * 设置页「本版更新内容」卡片（2026-10-04 用户提议）：
   *   「升级了什么用户根本不知道，体验感不好」→ 版本行下面直接列出这一版改了什么。
   * 数据来自壳主进程（shell:whatsnew → 先 CDN 后随包兜底，见 src/main/whatsnew.ts）。
   */
  /** 版本区域的锚点：优先设置页那条更新进度行，其次找含「当前版本」的那一行容器 */
  function versionAnchor() {
    var row = document.getElementById('dsh-ext-update-progress');
    if (row) return row;
    var all = document.querySelectorAll('div, section');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      var t = (n.textContent || '').trim();
      if (t.indexOf('当前版本') === 0 && n.children.length > 0 && t.length < 120) return n;
    }
    return null;
  }

  function renderWhatsNewCard() {
    if (document.getElementById('dsh-ext-whatsnew')) return;
    var dsh = window.dsh || {};
    if (typeof dsh.whatsNew !== 'function') return;
    // 壳版本由主进程在注入时写在页面上（见 settings-inject.ts 的 window.__dshShellVersion）
    var ver = String(window.__dshShellVersion || '').replace(/^v/, '');
    if (!ver) return;
    Promise.resolve(dsh.whatsNew(ver)).then(function (entry) {
      if (!entry || !entry.items || !entry.items.length) return;
      if (document.getElementById('dsh-ext-whatsnew')) return;
      // 挂在版本行下面（找不到版本行就退回设置页顶部，宁可位置一般也要看得见）
      var anchorRow = versionAnchor();
      if (!anchorRow || !anchorRow.parentElement) return;

      var box = document.createElement('div');
      box.id = 'dsh-ext-whatsnew';
      box.style.cssText =
        'margin:10px 0 4px;padding:10px 12px;border-radius:8px;' +
        'background:rgba(20,165,184,.10);border:1px solid rgba(20,165,184,.35);font-size:12px;line-height:1.7;';
      var head = document.createElement('div');
      head.style.cssText = 'font-weight:700;color:#14A5B8;margin-bottom:4px;';
      head.textContent = '本版更新内容' + (entry.title ? '：' + entry.title : '') + '（v' + ver + '）';
      box.appendChild(head);
      entry.items.slice(0, 6).forEach(function (it) {
        var line = document.createElement('div');
        line.style.cssText = 'display:flex;gap:6px;align-items:flex-start;';
        var dot = document.createElement('span');
        dot.style.cssText = 'flex:none;opacity:.75;';
        dot.textContent = it.kind === 'fix' ? '🛠' : '✨';
        var txt = document.createElement('span');
        txt.textContent = it.text;
        line.appendChild(dot);
        line.appendChild(txt);
        box.appendChild(line);
      });
      anchorRow.parentElement.insertBefore(box, anchorRow.nextSibling);
      console.log('[dsh-ext] 本版更新内容已显示（' + entry.items.length + ' 条）');
    }).catch(function () { /* 取不到就不显示，别打扰用户 */ });
  }

  /**
   * 设置页的「本机内文件」入口（2026-10-04）
   * 「开始」面板里的第三张卡是主要入口，但那个面板只在空白会话时出现 ——
   * 这里给一个**永远可达**的入口，功能不至于"找不到就等于没有"。
   */
  function renderLocalFilesEntry() {
    if (document.getElementById('dsh-ext-localfiles')) return;
    var anchorRow = versionAnchor();
    if (!anchorRow || !anchorRow.parentElement) return;
    var bar = document.createElement('div');
    bar.id = 'dsh-ext-localfiles';
    bar.style.cssText = 'margin:8px 0 4px;display:flex;gap:8px;flex-wrap:wrap;';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '📂 本机内文件…';
    btn.style.cssText =
      'padding:5px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;' +
      'border:1px solid rgba(20,165,184,.5);background:rgba(20,165,184,.12);color:#14A5B8;';
    btn.addEventListener('click', function () {
      if (window.__dshLocalFiles && typeof window.__dshLocalFiles.open === 'function') {
        window.__dshLocalFiles.open();
      } else {
        console.warn('[dsh-ext] 本机内文件模块未注入（localfiles.js 没加载？）');
      }
    });
    var tip = document.createElement('span');
    tip.style.cssText = 'align-self:center;font-size:11px;opacity:.6;';
    tip.textContent = '浏览这台电脑上的文件，不用退出当前会话';
    bar.appendChild(btn);
    bar.appendChild(tip);
    anchorRow.parentElement.insertBefore(bar, anchorRow.nextSibling);
  }

  function maybeInjectSidebarProgress() {
    renderWhatsNewCard();
    renderLocalFilesEntry();
    if (document.getElementById('dsh-ext-dl')) return;
    var anchor = findSidebarSettingsAnchor();
    if (!anchor) {
      if (!window.__dshExtSidebarWarned) {
        window.__dshExtSidebarWarned = true;
        console.warn('[dsh-ext] 未找到侧栏「设置」按钮，下载进度未注入（不影响其它功能）');
      }
      return;
    }
    var row = anchor.btn.parentElement || anchor.label.parentElement;
    if (!row) return;
    // ⚠️ 2026-10-03（1.0.47 实测修正）：DSH 侧栏「设置」的真实结构是
    //     label → div(display:contents) → button.VOzbGW_trigger(≈70px, **overflow:hidden**)
    //                                    → div(≈70px) → div.VOzbGW_triggerRow(≈260px)
    //   插在按钮里会被 overflow 裁掉 —— 打包态冒烟实测只量到 62px（用户要的"铺满"根本出不来）。
    //   所以宿主要**上浮到够宽的那一层**（triggerRow），条才有空间铺满。
    for (var up = 0; up < 4 && row.parentElement; up++) {
      var w = row.getBoundingClientRect().width;
      if (w >= SIDE_BAR_MIN_ROW) break;
      row = row.parentElement;
    }

    var wrap = document.createElement('span');
    wrap.id = 'dsh-ext-dl';
    // flex:1 → 吃满「设置」右侧的剩余宽度，一直顶到便捷框前（左右各留 GAP）
    wrap.style.cssText =
      'display:none;align-items:center;gap:7px;' +
      'margin-left:' + SIDE_BAR_GAP_PX + 'px;margin-right:' + SIDE_BAR_GAP_PX + 'px;' +
      'flex:1 1 auto;min-width:0;font-size:12px;line-height:1;';
    var track = document.createElement('span');
    // 条吃满 wrap 的全部宽度（百分比数字改成叠在条上，不再挤占空间）
    track.style.cssText =
      'position:relative;display:block;flex:1 1 auto;min-width:60px;height:' + SIDE_BAR_TRACK_H + 'px;' +
      'border-radius:' + Math.round(SIDE_BAR_TRACK_H / 2) + 'px;background:rgba(128,128,128,.28);overflow:hidden;';
    var fill = document.createElement('span');
    fill.id = 'dsh-ext-dl-fill';
    // position:relative + overflow:hidden → 让 ::after 的流光被裁在填充范围内
    fill.style.cssText =
      'position:relative;display:block;width:0%;height:100%;overflow:hidden;border-radius:' +
      Math.round(SIDE_BAR_TRACK_H / 2) + 'px;background:#14A5B8;' +
      'transition:width .45s cubic-bezier(.22,.61,.36,1);';
    track.appendChild(fill);
    var txt = document.createElement('span');
    txt.id = 'dsh-ext-dl-text';
    // 叠在条右端：白字 + 细描边，青蓝填充与灰色轨道上都看得清
    txt.style.cssText =
      'position:absolute;right:6px;top:50%;transform:translateY(-50%);white-space:nowrap;' +
      'font-size:10px;font-weight:700;letter-spacing:.2px;color:#fff;' +
      // 灰轨道上也压得住：阴影加重一档（实测 0 0 2px/.5 在 8% 时偏淡）
      'text-shadow:0 1px 2px rgba(0,0,0,.75),0 0 3px rgba(0,0,0,.55);pointer-events:none;';
    txt.textContent = '下载中 0%';
    track.appendChild(txt);
    var runner = document.createElement('span');
    runner.id = 'dsh-ext-dl-runner';
    runner.style.cssText =
      'position:absolute;top:0;bottom:0;left:0;width:36%;border-radius:' +
      Math.round(SIDE_BAR_TRACK_H / 2) + 'px;background:#14A5B8;';
    track.appendChild(runner);
    var flash = document.createElement('span');
    flash.id = 'dsh-ext-dl-flash';
    flash.style.cssText =
      'position:absolute;inset:0;border-radius:' + Math.round(SIDE_BAR_TRACK_H / 2) +
      'px;background:#7FE3F0;pointer-events:none;';
    track.appendChild(flash);
    wrap.appendChild(track);
    row.appendChild(wrap);

    try {
      row.style.display = 'flex';
      row.style.alignItems = 'center';
    } catch (e) { /* 行样式动不了也不影响条本身 */ }
    try {
      // 侧栏折叠（行放不下文字）时只留条 —— 条会自己铺满剩余宽度，不挤坏布局
      if (rectVisible(row) && row.getBoundingClientRect().width < SIDE_BAR_MIN_ROW) {
        txt.style.display = 'none';
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ---------- 更新状态订阅：同时驱动「设置页版本行」与「侧栏」两条进度条 ---------- */
  function renderUpdateProgress(st) {
    var downloading = !!(st && (st.phase === 'downloading' || st.phase === 'downloaded'));
    var downloaded = !!(st && st.phase === 'downloaded');
    // 百分比未知（真实下载刚起步 / 预览的不定态阶段）→ 走"游走"，别钉在 0% 干等
    var indet = downloading && !downloaded && !(st && typeof st.percent === 'number');
    var pct = st && typeof st.percent === 'number' ? st.percent : (downloaded ? 100 : 0);

    ensureProgressAnimCss();

    // 侧栏条：条 + 百分比文字
    var side = document.getElementById('dsh-ext-dl');
    if (side) {
      side.style.display = downloading ? 'inline-flex' : 'none';
      side.className = (indet ? 'indet ' : '') + (downloaded ? 'done' : '');
      var sf = document.getElementById('dsh-ext-dl-fill');
      if (sf) sf.style.width = pct + '%';
      var stx = document.getElementById('dsh-ext-dl-text');
      if (stx) {
        stx.textContent = downloaded ? '已下好，重启生效' : (indet ? '正在下载…' : '下载中 ' + pct + '%');
      }
    }
    // 设置页版本行那条：带文字
    var box = document.getElementById('dsh-ext-update-progress');
    if (box) {
      box.style.display = downloading ? 'inline-flex' : 'none';
      var bf = document.getElementById('dsh-ext-update-progress-fill');
      if (bf) bf.style.width = pct + '%';
      var bl = document.getElementById('dsh-ext-update-progress-label');
      if (bl) bl.textContent = downloaded ? '已下载好，去安装' : '正在下载 ' + pct + '%';
    }
  }

  function startUpdateProgressWatch() {
    if (window.__dshExtUpdateWatch) return;
    window.__dshExtUpdateWatch = true;
    try {
      if (window.dsh && window.dsh.onUpdateState) {
        window.dsh.onUpdateState(function (st) {
          // 兜底：万一注入时机没赶上（或侧栏后来才渲染出来），下载一开始就把条补上
          maybeInjectSidebarProgress();
          renderUpdateProgress(st);
        });
      }
    } catch (e) { /* 订阅失败不影响其它功能 */ }
  }

  /* ---------- 观察设置页挂载 ---------- */
  function maybeInject() {
    maybeInjectShellVersion();
    maybeInjectSidebarProgress();
    startUpdateProgressWatch();
    if (document.getElementById(NAV_PREFIX + 'pet')) return; // 本挂载周期已注入
    var navList = findNavList();
    if (navList) inject(navList);
  }

  var observer = new MutationObserver(function () { maybeInject(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  maybeInject();

  /* ---------- 外部 Key 联动 ----------
   * DSH 模型区等任意位置填入 sk- 开头的 Key（失焦/回车）时，自动同步到用量面板，
   * 让用量/余额查询也能用上（不依赖具体控件结构，按 sk- 前缀识别）。 */
  if (!window.__dshExtKeySyncInstalled) {
    window.__dshExtKeySyncInstalled = true;
    var lastSyncedKey = null;
    function trySyncExternalKey(target) {
      if (!target || !window.dsh || typeof window.dsh.setApiKey !== 'function') return;
      if (target.id === 'dsh-ext-u-key-input') return; // 自己的输入框由保存按钮处理
      var v = String(target.value || '').trim();
      if (/^sk-[A-Za-z0-9]{8,}/.test(v) && v !== lastSyncedKey) {
        lastSyncedKey = v;
        window.dsh.setApiKey(v);
        if (typeof window.dsh.usageRefresh === 'function') window.dsh.usageRefresh();
      }
    }
    document.addEventListener('change', function (e) { trySyncExternalKey(e.target); }, true);
  }
})();
