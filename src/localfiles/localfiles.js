/**
 * localfiles.js —— 注入到 DSH 页面的「本机内文件」（2026-10-04）
 *
 * 用户要求：在「开始」面板里，与「工作区文件」「新建终端」**并列占第三个位置**。
 *
 * 为什么用 DOM 注入而不是注册插件插槽（当时查证过）：
 *   hero 面板的插槽 `conversation.hero.workspace` 与 `.directoryFlow` 都是
 *   **single（单占用）**，占用者是官方的 client-ui-workspace，**没有 list 槽**可以追加
 *   第三个条目 → 注册插槽做不到"并列第三项"。
 *   所以走我们已有的注入路线（同侧栏下载进度条那套）：按**文字**定位、结构上插兄弟节点、
 *   找不到只 warn 一次、绝不抛错影响页面。
 *
 * 交互：
 *   点第三张卡 → 右侧浮出「本机内文件」面板
 *   ├─ 顶部：快捷位置（主目录/桌面/下载/文稿）+ 面包屑 + 「上一级」
 *   ├─ 列表：文件夹在前，文件显示大小/时间
 *   ├─ 点文件夹 = 进入；点文件 = 用系统默认程序打开（"不用再开别的软件"）
 *   └─ 每行两个小按钮：在访达中显示 / 复制路径
 */
(function () {
  'use strict';

  var CARD_ID = 'dsh-local-files-card';
  var PANEL_ID = 'dsh-local-files-panel';
  if (window.__dshLocalFilesLoaded) return;
  window.__dshLocalFilesLoaded = true;

  var dsh = window.dsh || {};
  var hasBridge = typeof dsh.localFilesList === 'function';

  function warnOnce(msg) {
    if (window.__dshLocalFilesWarned) return;
    window.__dshLocalFilesWarned = true;
    console.warn('[localfiles] ' + msg);
  }

  function el(tag, style, text) {
    var n = document.createElement(tag);
    if (style) n.style.cssText = style;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------------- 定位「开始」面板里那两张卡 ---------------- */

  function leafByText(text) {
    var all = document.querySelectorAll('button, [role="button"], a, div, span, p');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.children.length === 0 && (n.textContent || '').trim() === text) return n;
    }
    return null;
  }

  /** 从文字叶子往上找到"卡片"那一层：够宽、够高、且是可点的 */
  function cardOf(leaf) {
    var n = leaf;
    for (var up = 0; up < 4 && n; up++) {
      var r = n.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 44 && r.height <= 200) return n;
      n = n.parentElement;
    }
    return null;
  }

  function buildCard() {
    var anchor = leafByText('工作区文件') || leafByText('浏览会话工作区的文件');
    if (!anchor) {
      warnOnce('没找到「开始」面板的工作区卡片，本机内文件入口未注入（不影响其它功能）');
      return;
    }
    var refCard = cardOf(anchor);
    if (!refCard || !refCard.parentElement) {
      warnOnce('找到了文字但没定位到卡片容器，未注入');
      return;
    }
    if (document.getElementById(CARD_ID)) return;

    // 用与官方卡片同款的浅色圆角卡（内联样式，避免依赖 DSH 的 class）
    var card = el(
      'div',
      'display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;' +
        'padding:14px 16px;margin-top:10px;border-radius:12px;cursor:pointer;' +
        'background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.96));' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));' +
        'box-shadow:0 1px 2px rgba(0,0,0,.06);transition:background .15s,transform .15s;',
    );
    card.id = CARD_ID;
    card.setAttribute('role', 'button');
    card.tabIndex = 0;

    var icon = el(
      'span',
      'flex:none;width:28px;height:28px;display:flex;align-items:center;justify-content:center;' +
        'font-size:17px;line-height:1;',
      '🗂️',
    );
    var textBox = el('span', 'flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;');
    textBox.appendChild(el('span', 'font-size:14px;font-weight:600;', '本机内文件'));
    textBox.appendChild(
      el('span', 'font-size:12px;opacity:.65;', '浏览这台电脑上的文件（不用再开别的软件）'),
    );
    var hint = el('span', 'flex:none;font-size:12px;opacity:.5;', '点击打开');
    card.appendChild(icon);
    card.appendChild(textBox);
    card.appendChild(hint);

    card.addEventListener('mouseenter', function () {
      card.style.transform = 'translateY(-1px)';
    });
    card.addEventListener('mouseleave', function () {
      card.style.transform = 'none';
    });
    var open = function () {
      togglePanel(true);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') open();
    });

    refCard.parentElement.insertBefore(card, refCard.nextSibling);
  }

  /* ---------------- 面板 ---------------- */

  function togglePanel(show) {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = buildPanel();
      document.body.appendChild(panel);
    }
    panel.style.display = show ? 'flex' : 'none';
    if (show) void navigate(state.rootsHome || '');
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.display = 'none';
  }

  var state = {
    rootsHome: '',
    shortcuts: [],
    dir: '',
    parent: '',
    entries: [],
  };

  function buildPanel() {
    var panel = el('div', '');
    panel.id = PANEL_ID;
    panel.style.cssText =
      'position:fixed;top:0;right:0;bottom:0;width:min(560px,92vw);z-index:2147483000;' +
      'display:none;flex-direction:column;background:var(--dsw-alias-bg-overlay,rgba(20,23,28,.98));' +
      'color:var(--dsw-alias-text-1,#e8eaed);box-shadow:-12px 0 32px rgba(0,0,0,.35);' +
      'backdrop-filter:blur(2px);font-size:13px;';

    // 头部
    var head = el('div', 'flex:none;padding:14px 16px 10px;border-bottom:1px solid rgba(128,128,128,.25);');
    var titleRow = el('div', 'display:flex;align-items:center;gap:10px;');
    titleRow.appendChild(el('span', 'font-size:15px;font-weight:700;flex:1 1 auto;', '本机内文件'));
    var upBtn = el('button', 'padding:4px 10px;border-radius:7px;cursor:pointer;font-size:12px;', '上一级');
    upBtn.addEventListener('click', function () {
      if (state.parent) void navigate(state.parent);
    });
    var closeBtn = el('button', 'padding:4px 10px;border-radius:7px;cursor:pointer;font-size:12px;', '关闭');
    closeBtn.addEventListener('click', closePanel);
    titleRow.appendChild(upBtn);
    titleRow.appendChild(closeBtn);
    head.appendChild(titleRow);

    var crumbs = el('div', 'margin-top:8px;font-size:12px;opacity:.75;word-break:break-all;');
    crumbs.id = PANEL_ID + '-crumbs';
    head.appendChild(crumbs);

    var quick = el('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;');
    quick.id = PANEL_ID + '-quick';
    head.appendChild(quick);
    panel.appendChild(head);

    // 列表
    var list = el('div', 'flex:1 1 auto;overflow:auto;padding:8px 8px 16px;');
    list.id = PANEL_ID + '-list';
    panel.appendChild(list);

    // Esc 关闭
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel();
    });
    return panel;
  }

  function fmtSize(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function rowFor(entry) {
    var row = el(
      'div',
      'display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;cursor:pointer;',
    );
    row.addEventListener('mouseenter', function () {
      row.style.background = 'rgba(128,128,128,.18)';
    });
    row.addEventListener('mouseleave', function () {
      row.style.background = 'transparent';
    });
    row.appendChild(el('span', 'flex:none;width:20px;text-align:center;', entry.dir ? '📁' : '📄'));
    var name = el('span', 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', entry.name);
    name.title = entry.path;
    row.appendChild(name);
    row.appendChild(el('span', 'flex:none;opacity:.55;font-size:11px;', entry.dir ? '' : fmtSize(entry.size)));

    var revealBtn = el('button', 'flex:none;padding:2px 7px;border-radius:6px;font-size:11px;cursor:pointer;', '显示');
    revealBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (typeof dsh.localFilesReveal === 'function') dsh.localFilesReveal(entry.path);
    });
    var openBtn = el('button', 'flex:none;padding:2px 7px;border-radius:6px;font-size:11px;cursor:pointer;', '打开');
    openBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (typeof dsh.localFilesOpen === 'function') dsh.localFilesOpen(entry.path);
    });
    row.appendChild(revealBtn);
    row.appendChild(openBtn);

    row.addEventListener('click', function () {
      if (entry.dir) void navigate(entry.path);
      else if (typeof dsh.localFilesOpen === 'function') dsh.localFilesOpen(entry.path);
    });
    return row;
  }

  async function navigate(dir) {
    if (!hasBridge) {
      warnOnce('没有 window.dsh.localFilesList 桥（浏览器里直接打开 DSH 时正常），面板显示空');
      return;
    }
    var res;
    try {
      res = await dsh.localFilesList(dir);
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    var listEl = document.getElementById(PANEL_ID + '-list');
    var crumbs = document.getElementById(PANEL_ID + '-crumbs');
    var quick = document.getElementById(PANEL_ID + '-quick');
    if (!listEl || !crumbs) return;

    if (!res || !res.ok) {
      listEl.textContent = '';
      listEl.appendChild(el('div', 'padding:14px;opacity:.8;', '打不开这个目录：' + ((res && res.error) || '未知错误')));
      return;
    }
    state.dir = res.dir;
    state.parent = res.parent;
    state.entries = res.entries || [];
    crumbs.textContent = res.dir;

    if (quick && !quick.childNodes.length) {
      (state.shortcuts || []).forEach(function (s) {
        var b = el('button', 'padding:3px 9px;border-radius:7px;font-size:12px;cursor:pointer;', s.label);
        b.addEventListener('click', function () {
          void navigate(s.path);
        });
        quick.appendChild(b);
      });
    }

    listEl.textContent = '';
    if (!state.entries.length) {
      listEl.appendChild(el('div', 'padding:14px;opacity:.7;', '这个目录里没有可直接显示的内容'));
      return;
    }
    state.entries.forEach(function (entry) {
      listEl.appendChild(rowFor(entry));
    });
  }

  /* ---------------- 启动：拉 roots，然后注入卡片 ---------------- */

  async function init() {
    if (hasBridge) {
      try {
        var roots = await dsh.localFilesRoots();
        if (roots) {
          state.rootsHome = roots.home || '';
          state.shortcuts = roots.shortcuts || [];
        }
      } catch (e) {
        /* 忽略：面板打开时还会再试 */
      }
    }
    buildCard();
  }

  // 对外暴露：设置页那条「本机内文件」入口也走这里开面板
  //（「开始」面板只在空白会话时出现，所以必须给一个**永远可达**的入口）
  window.__dshLocalFiles = { open: function () { togglePanel(true); }, close: closePanel };

  // 「开始」面板是异步渲染的，且切会话/新建会话时会重绘 —— 用轻量定时器兜底补插
  void init();
  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    if (!document.getElementById(CARD_ID)) buildCard();
    if (tries > 40 || document.getElementById(CARD_ID)) clearInterval(timer);
  }, 750);
})();
