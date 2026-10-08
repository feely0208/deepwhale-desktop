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

  function leafByText(text, allowContains) {
    var all = document.querySelectorAll('button, [role="button"], a, div, span, p');
    var loose = null;
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.children.length !== 0) continue;
      var t = (n.textContent || '').trim();
      if (t === text) return n;
      if (!loose && allowContains && t.indexOf(text) >= 0) loose = n;
    }
    return loose;
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
    if (document.getElementById(CARD_ID)) return;
    // 期望：与「工作区文件」「新建终端」**并列**，排在它们后面（用户明确要求"占第三个位置"）
    var termLeaf = leafByText('新建终端', true) || leafByText('在会话工作区运行命令', true);
    var wsLeaf = leafByText('工作区文件') || leafByText('浏览会话工作区的文件', true);
    var refCard = (termLeaf && cardOf(termLeaf)) || (wsLeaf && cardOf(wsLeaf));
    if (!refCard) {
      warnOnce('「开始」面板还没出现（它只在空白会话时渲染）——本机内文件卡片等它出现再插');
      return;
    }
    if (!refCard.parentElement) return;

    // 样式对齐官方那两张卡（图2）：浅色圆角卡 + 左侧图标 + 标题/副标题 + 右侧提示
    var CP = palette();
    var card = el(
      'div',
      'display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;' +
        'padding:14px 16px;margin-top:10px;border-radius:12px;cursor:pointer;' +
        'background:' + CP.bg + ';color:' + CP.text + ';' +
        'border:1px solid ' + CP.border + ';' +
        'transition:background .15s ease,border-color .15s ease;',
    );
    card.id = CARD_ID;
    card.setAttribute('role', 'button');
    card.tabIndex = 0;

    var icon = el('span', 'flex:none;width:28px;height:28px;display:flex;align-items:center;justify-content:center;');
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none">' +
      '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2c.7 0 1.3.3 1.8.8l1 1.2h7A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9z" ' +
      'fill="#F2B21B" opacity=".95"/><path d="M3 10h18v6.5A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5V10z" fill="#FFC94A"/></svg>';

    var textBox = el('span', 'flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;');
    textBox.appendChild(el('span', 'font-size:15px;font-weight:500;line-height:1.35;', '本机内文件'));
    textBox.appendChild(el('span', 'font-size:13px;opacity:.6;line-height:1.35;', '浏览这台电脑上的其他文件'));

    var hint = el('span', 'flex:none;font-size:12px;opacity:.45;letter-spacing:.5px;',
      (state.shortcut || '') || '');   // 跟随「本机内文件快捷键」设置（改了就变）

    card.appendChild(icon);
    card.appendChild(textBox);
    card.appendChild(hint);

    card.addEventListener('mouseenter', function () { card.style.borderColor = 'rgba(20,165,184,.55)'; });
    card.addEventListener('mouseleave', function () { card.style.borderColor = CP.border; });
    var open = function () {
      togglePanel(true);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') open();
    });

    refCard.parentElement.insertBefore(card, refCard.nextSibling);
    console.log('[localfiles] 本机内文件卡片已插入「开始」面板（第三项）');
  }

  /* ---------------- 面板：照官方「工作区文件」的形状（图1） ----------------
     用户 2026-10-04 给了官方那张截图并说「照这个样子来部署」：
       · 顶部一个页签「文件夹图标 + 名称 + ✕」
       · 下面是**路径条**（可直接编辑/粘贴，回车跳转）+ 刷新按钮
       · 再下面是**条目列表**（目录在前、文件显示大小），点目录进入、点文件用系统程序打开
     数据来自主进程 localfiles:list（只读列目录，不递归）。 */

  var state = { home: '', shortcuts: [], dir: '', parent: '', entries: [] };

  /**
   * 主题色板（2026-10-04 用户实测：浅色主题下这个面板白底 + 浅灰字 = 看不见）。
   * 原因：样式依赖 DSH 的 CSS 变量（--dsw-alias-text-1 等），而浅色主题下变量名/取值不同，
   * 我的兜底色又是深色主题的浅灰字 → 白底浅灰字。现在**自己带一套**，两种主题都清楚。
   */
  function isDarkTheme() {
    try {
      if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return true;
      if (document.documentElement.hasAttribute('data-ds-dark-theme')) return true;
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
      return true;
    }
  }

  function palette() {
    return isDarkTheme()
      ? {
          bg: '#16191e', text: '#e8eaed', dim: 'rgba(232,234,237,.62)', faint: 'rgba(232,234,237,.45)',
          border: 'rgba(255,255,255,.16)', hover: 'rgba(255,255,255,.08)', chip: 'rgba(255,255,255,.12)',
          inputBg: 'rgba(0,0,0,.22)', accent: '#14A5B8', accentText: '#04131a',
        }
      : {
          bg: '#ffffff', text: '#24292f', dim: 'rgba(36,41,47,.62)', faint: 'rgba(36,41,47,.45)',
          border: 'rgba(0,0,0,.14)', hover: 'rgba(0,0,0,.05)', chip: 'rgba(0,0,0,.06)',
          inputBg: '#ffffff', accent: '#0E7C8C', accentText: '#ffffff',
        };
  }


  function togglePanel(show) {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = buildPanel();
      document.body.appendChild(panel);
    }
    panel.style.display = show ? 'flex' : 'none';
    if (show) {
      // 打开时确保先拿到"起始目录"（roots 是异步拉的，可能还没回来 ——
      // 第一版就因此把空路径丢给主进程，面板显示"需要绝对路径"，实机一看就是坏的）
      void ensureRoots().then(function () {
        var input = document.getElementById(PANEL_ID + '-path');
        var last = '';
        try {
          last = localStorage.getItem('dsh-local-files-last') || '';
        } catch (e) {
          last = '';
        }
        if (input && !input.value) input.value = state.home || '';
        // 记住上次目录（B2）：打开面板直接回到你上次在看的地方
        if (!state.dir) void navigate(last || (input && input.value) || state.home || '');
      });
    }
  }

  async function ensureRoots() {
    if (state.home || typeof dsh.localFilesRoots !== 'function') return;
    try {
      var roots = await dsh.localFilesRoots();
      if (roots) {
        state.home = roots.home || '';
        state.shortcuts = roots.shortcuts || [];
        state.shortcut = roots.shortcut || '';
      }
    } catch (e) {
      /* 忽略：下面 navigate 会给出友好错误 */
    }
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.display = 'none';
  }

  function fmtSize(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function buildPanel() {
    var P = palette();
    var panel = el('div', '');
    panel.id = PANEL_ID;
    panel.style.cssText =
      'position:fixed;top:0;right:0;bottom:0;width:min(460px,94vw);z-index:2147483000;' +
      'display:none;flex-direction:column;' +
      'background:' + P.bg + ';color:' + P.text + ';border-left:1px solid ' + P.border + ';' +
      'box-shadow:-10px 0 28px rgba(0,0,0,.28);font-size:13px;';

    // 顶部：页签（图标 + 名称 + ✕）—— 对齐图1
    var tabRow = el('div', 'flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px 8px;');
    var tab = el('div', 'display:flex;align-items:center;gap:7px;padding:5px 10px;border-radius:9px;' +
      'background:' + P.chip + ';font-size:13px;font-weight:500;');
    var tabIcon = el('span', 'width:16px;height:16px;display:flex;align-items:center;justify-content:center;');
    tabIcon.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none">' +
      '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2c.7 0 1.3.3 1.8.8l1 1.2h7A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9z" ' +
      'fill="#F2B21B" opacity=".95"/><path d="M3 10h18v6.5A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5V10z" fill="#FFC94A"/></svg>';
    tab.appendChild(tabIcon);
    tab.appendChild(el('span', '', '本机内文件'));
    var tabClose = el('button', 'border:0;background:transparent;color:inherit;opacity:.55;cursor:pointer;' +
      'font-size:13px;line-height:1;padding:0 2px;', '✕');
    tabClose.addEventListener('click', closePanel);
    tab.appendChild(tabClose);
    tabRow.appendChild(tab);
    panel.appendChild(tabRow);

    // 路径条 + 刷新/上级（对齐图1的那一行）
    var pathRow = el('div', 'flex:none;display:flex;align-items:center;gap:6px;padding:0 12px 8px;');
    var input = document.createElement('input');
    input.id = PANEL_ID + '-path';
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = '/Users/…（可直接编辑或粘贴）';
    input.style.cssText =
      // 官方那行是"纯文本 + 刷新"，这里保持可编辑但去掉边框，观感一致
      'flex:1 1 auto;min-width:0;padding:6px 2px;border-radius:8px;font-size:12.5px;' +
      'border:1px solid transparent;background:transparent;color:' + P.dim + ';outline:none;';
    input.addEventListener('focus', function () {
      input.style.borderColor = P.border;
      input.style.background = P.inputBg;
      input.style.color = P.text;
    });
    input.addEventListener('blur', function () {
      input.style.borderColor = 'transparent';
      input.style.background = 'transparent';
      input.style.color = P.dim;
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') void navigate(input.value);
      if (e.key === 'Escape') closePanel();
    });
    var upBtn = el('button', 'flex:none;width:28px;height:28px;border-radius:8px;cursor:pointer;' +
      'border:1px solid ' + P.border + ';background:transparent;color:' + P.text + ';', '↑');
    upBtn.title = '上一级';
    upBtn.addEventListener('click', function () {
      if (state.parent) void navigate(state.parent);
    });
    var refreshBtn = el('button', 'flex:none;width:28px;height:28px;border-radius:8px;cursor:pointer;' +
      'border:1px solid ' + P.border + ';background:transparent;color:' + P.text + ';', '⟳');
    refreshBtn.title = '刷新';
    refreshBtn.addEventListener('click', function () {
      void navigate(state.dir || input.value);
    });
    // B2：复制当前路径（用户在会话里要粘贴路径时最常用）
    var copyBtn = el('button', 'flex:none;width:28px;height:28px;border-radius:8px;cursor:pointer;' +
      'border:1px solid ' + P.border + ';background:transparent;color:' + P.text + ';font-size:11px;', '⧉');
    copyBtn.title = '复制当前路径';
    copyBtn.addEventListener('click', function () {
      var v = (input.value || state.dir || '').trim();
      if (!v) return;
      try {
        void navigator.clipboard.writeText(v);
        copyBtn.textContent = '✓';
        setTimeout(function () { copyBtn.textContent = '⧉'; }, 1200);
      } catch (e) {
        /* 剪贴板不可用就算了 */
      }
    });
    pathRow.appendChild(input);
    pathRow.appendChild(upBtn);
    pathRow.appendChild(refreshBtn);
    pathRow.appendChild(copyBtn);
    panel.appendChild(pathRow);

    // 预览区（2026-10-04 用户：官方能在侧栏内直接预览，我们也要）——
    // 单击文件行就渲染在这里；双击仍然用系统程序打开
    var preview = el('div', 'flex:none;display:none;flex-direction:column;gap:6px;' +
      'margin:0 12px 8px;border-radius:10px;border:1px solid ' + P.border + ';overflow:hidden;');
    preview.id = PANEL_ID + '-preview';
    var pvHead = el('div', 'display:flex;align-items:center;gap:8px;padding:7px 10px;font-size:12px;' +
      'border-bottom:1px solid ' + P.border + ';');
    var pvName = el('span', 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', '');
    pvName.id = PANEL_ID + '-preview-name';
    var pvClose = el('button', 'flex:none;border:0;background:transparent;color:' + P.dim + ';cursor:pointer;font-size:12px;', '关闭');
    pvClose.addEventListener('click', function () {
      preview.style.display = 'none';
      preview.textContent = '';
      preview.appendChild(pvHead);
      preview.appendChild(pvBody);
    });
    pvHead.appendChild(pvName);
    pvHead.appendChild(pvClose);
    var pvBody = el('div', 'max-height:46vh;overflow:auto;background:' + (isDarkTheme() ? 'rgba(0,0,0,.25)' : 'rgba(0,0,0,.03)') + ';');
    pvBody.id = PANEL_ID + '-preview-body';
    preview.appendChild(pvHead);
    preview.appendChild(pvBody);
    panel.appendChild(preview);

    // 列表
    var list = el('div', 'flex:1 1 auto;overflow:auto;padding:2px 6px 14px;');
    list.id = PANEL_ID + '-list';
    panel.appendChild(list);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel();
    });
    return panel;
  }

  // 官方「工作区文件」同款的行：SVG 图标 + 名称，无多余按钮，**双击打开**
  function iconFor(dir) {
    var wrap = el('span', 'flex:none;width:18px;height:18px;display:flex;align-items:center;justify-content:center;');
    wrap.innerHTML = dir
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
        'stroke-linecap="round" stroke-linejoin="round" style="opacity:.62">' +
        '<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6c.5 0 1 .2 1.4.6l1.2 1.2H19a2 2 0 0 1 2 2v7.2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
        'stroke-linecap="round" stroke-linejoin="round" style="opacity:.5">' +
        '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/></svg>';
    return wrap;
  }

  function rowFor(entry) {
    var P = palette();
    // 行高与留白对齐官方：约 44px、左右 14px，无分隔线，仅 hover 高亮
    var row = el('div', 'display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:8px;cursor:default;');
    row.title = entry.path;
    row.appendChild(iconFor(entry.dir));
    var name = el('span', 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'font-size:13.5px;line-height:1.35;', entry.name);
    row.appendChild(name);
    if (!entry.dir) {
      row.appendChild(el('span', 'flex:none;font-size:11.5px;color:' + P.faint + ';', fmtSize(entry.size)));
    }
    row.addEventListener('click', function () {
      if (!entry.dir) void previewFile(entry);
    });
    row.addEventListener('mouseenter', function () { row.style.background = P.hover; });
    row.addEventListener('mouseleave', function () { row.style.background = 'transparent'; });
    // 用户要求："双击文件夹就直接打开" —— 单击不动作，双击进入/打开
    row.addEventListener('dblclick', function () {
      if (entry.dir) void navigate(entry.path);
      else if (typeof dsh.localFilesOpen === 'function') dsh.localFilesOpen(entry.path);
    });
    return row;
  }

  /** 面板内预览：图片 / PDF / 文本 / Office（主进程转 PDF） */
  async function previewFile(entry) {
    var P = palette();
    var box = document.getElementById(PANEL_ID + '-preview');
    var body = document.getElementById(PANEL_ID + '-preview-body');
    var nameEl = document.getElementById(PANEL_ID + '-preview-name');
    if (!box || !body) return;
    box.style.display = 'flex';
    if (nameEl) nameEl.textContent = entry.name;
    body.textContent = '';
    body.appendChild(el('div', 'padding:14px;font-size:12.5px;color:' + P.dim + ';', '正在打开…'));

    if (typeof dsh.localFilesPreview !== 'function') {
      body.textContent = '';
      body.appendChild(el('div', 'padding:14px;font-size:12.5px;color:' + P.dim + ';', '当前环境不支持预览，请双击用系统程序打开。'));
      return;
    }
    var res;
    try {
      res = await dsh.localFilesPreview(entry.path);
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    body.textContent = '';
    if (!res || !res.ok) {
      var tip = el('div', 'padding:14px;font-size:12.5px;line-height:1.7;color:' + P.dim + ';');
      tip.textContent = (res && res.error) || '无法预览';
      var openBtn = el('button', 'margin:0 14px 14px;padding:6px 12px;border-radius:8px;cursor:pointer;' +
        'border:1px solid ' + P.border + ';background:transparent;color:' + P.text + ';font-size:12.5px;', '用系统程序打开');
      openBtn.addEventListener('click', function () {
        if (typeof dsh.localFilesOpen === 'function') dsh.localFilesOpen(entry.path);
      });
      body.appendChild(tip);
      body.appendChild(openBtn);
      return;
    }
    if (res.kind === 'image') {
      var img = document.createElement('img');
      img.src = res.dataUri;
      img.style.cssText = 'display:block;max-width:100%;margin:0 auto;';
      body.appendChild(img);
    } else if (res.kind === 'pdf') {
      var frame = document.createElement('iframe');
      frame.src = res.dataUri;
      frame.style.cssText = 'display:block;width:100%;height:46vh;border:0;background:#fff;';
      body.appendChild(frame);
    } else if (res.kind === 'text') {
      var pre = el('pre', 'margin:0;padding:12px;font-size:12px;line-height:1.6;white-space:pre-wrap;' +
        'word-break:break-word;color:' + P.text + ';font-family:ui-monospace,SFMono-Regular,Menlo,monospace;',
        res.text || '');
      body.appendChild(pre);
      if (res.truncated) {
        body.appendChild(el('div', 'padding:0 12px 10px;font-size:11.5px;color:' + P.faint + ';', '（内容较长，仅显示前 300KB）'));
      }
    } else if (res.kind === 'video') {
      /* 视频（2026-10-08 加）：用户最早要的就是这个 —— 点开 mp4 能直接播。
         用 <video controls>，不自动播放（自动播会突然出声，很唐突）。 */
      var v = document.createElement('video');
      v.src = res.dataUri;
      v.controls = true;
      v.preload = 'metadata';
      v.style.cssText = 'display:block;width:100%;max-height:46vh;background:#000;';
      body.appendChild(v);
    } else if (res.kind === 'html') {
      /* 本地网页（2026-10-08 加）：以前走文本分支，只显示源码 —— 那不叫预览。
         现在塞进 iframe 真渲染。**安全是这个分支的第一约束**：
           · sandbox="" —— 不带 allow-scripts（脚本一律不执行）、不带 allow-same-origin
             （iframe 拿到不透明源，拿不到应用的 origin/存储/DOM）；
           · 用 srcdoc 而不是 src=file://，避免以文件协议加载本地资源。
         代价（已知并接受）：页面里的**相对资源**（外链 css/图片）在沙箱里取不到，
         自包含的单文件网页正常显示。 */
      var htmlFrame = document.createElement('iframe');
      htmlFrame.setAttribute('sandbox', '');
      htmlFrame.setAttribute('referrerpolicy', 'no-referrer');
      htmlFrame.srcdoc = res.text || '';
      htmlFrame.style.cssText = 'display:block;width:100%;height:46vh;border:0;background:#fff;';
      body.appendChild(htmlFrame);
    } else {
      body.appendChild(el('div', 'padding:14px;font-size:12.5px;color:' + P.dim + ';', '这种格式暂不支持预览。'));
    }
  }

  async function navigate(dir) {
    var input = document.getElementById(PANEL_ID + '-path');
    var list = document.getElementById(PANEL_ID + '-list');
    if (!list) return;
    if (typeof dsh.localFilesList !== 'function') {
      warnOnce('没有 window.dsh.localFilesList 桥（浏览器里直接打开 DSH 时正常）');
      list.textContent = '当前环境不支持浏览本机文件。';
      return;
    }
    var res;
    try {
      res = await dsh.localFilesList(dir);
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    if (!res || !res.ok) {
      list.textContent = '';
      list.appendChild(el('div', 'padding:12px;opacity:.8;', '打不开这个目录：' + ((res && res.error) || '未知错误')));
      return;
    }
    state.dir = res.dir;
    state.parent = res.parent;
    try {
      localStorage.setItem('dsh-local-files-last', res.dir);
    } catch (e) {
      /* 隐私模式下写不了，忽略 */
    }
    state.entries = res.entries || [];
    if (input) input.value = res.dir;

    list.textContent = '';
    if (!state.entries.length) {
      list.appendChild(el('div', 'padding:12px;opacity:.6;', '这个目录里没有可直接显示的内容'));
      return;
    }
    state.entries.forEach(function (entry) { list.appendChild(rowFor(entry)); });
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

  // 「开始」面板是异步渲染的（新建会话时才出现），切会话也会重绘 ——
  // ⚠️ 第一版只轮询 30 秒，用户几分钟后才新建会话 → 卡片永远不出现（2026-10-04 实机反馈）。
  //    现在改成**常驻**：MutationObserver 去抖 + 便宜的定时器双保险，只要面板出现就补上。
  void init();
  var lastCheck = 0;
  function ensureCard() {
    var now = Date.now();
    if (now - lastCheck < 400) return;   // 去抖：DSH 界面很热闹，别每次都查
    lastCheck = now;
    if (document.getElementById(CARD_ID)) return;
    buildCard();
  }
  try {
    new MutationObserver(ensureCard).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  } catch (e) {
    /* 观察不了就只靠下面的定时器 */
  }
  setInterval(ensureCard, 2000);
})();
