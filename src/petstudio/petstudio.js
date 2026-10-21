/* 宠物工坊：SVG 实时编辑预览保存 + 导入图片生成宠物（去白底）+ 当前宠物列表切换 */
(function () {
  if (!window.dsh || !window.dsh.petState) return; // 无 preload 桥时静默（仅测试环境）
  var stage = document.getElementById('stage');
  var codeEl = document.getElementById('svg-code');
  var nameEl = document.getElementById('save-name');
  var statusEl = document.getElementById('status');
  var petsEl = document.getElementById('pets');

  // 默认示例：Codex 风格橙色泪滴
  var DEFAULT_SVG =
    '<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">\n' +
    '  <defs>\n' +
    '    <linearGradient id="b" x1="0" y1="0" x2="0" y2="1">\n' +
    '      <stop offset="0%" stop-color="#ffc39b"/>\n' +
    '      <stop offset="36%" stop-color="#ff8a3d"/>\n' +
    '      <stop offset="100%" stop-color="#ed6a14"/>\n' +
    '    </linearGradient>\n' +
    '  </defs>\n' +
    '  <path d="M40 5 C53 5 63 15 63 27 C63 43 56 57 44 72 C42.5 74 37.5 74 36 72 C24 57 17 43 17 27 C17 15 27 5 40 5 Z" fill="url(#b)"/>\n' +
    '  <ellipse cx="30" cy="21" rx="7" ry="4" fill="#fff" opacity="0.5" transform="rotate(-20 30 21)"/>\n' +
    '  <ellipse cx="32" cy="38" rx="4" ry="5.2" fill="#2b1a0e"/>\n' +
    '  <ellipse cx="48" cy="38" rx="4" ry="5.2" fill="#2b1a0e"/>\n' +
    '  <circle cx="33.6" cy="35.6" r="1.6" fill="#fff"/>\n' +
    '  <circle cx="49.6" cy="35.6" r="1.6" fill="#fff"/>\n' +
    '  <ellipse cx="22" cy="47" rx="4.4" ry="2.6" fill="#ff9d6b" opacity="0.75"/>\n' +
    '  <ellipse cx="58" cy="47" rx="4.4" ry="2.6" fill="#ff9d6b" opacity="0.75"/>\n' +
    '  <path d="M37 49 Q40 53 43 49" stroke="#2b1a0e" stroke-width="2.2" fill="none" stroke-linecap="round"/>\n' +
    '</svg>';

  codeEl.value = DEFAULT_SVG;

  function preview(svgText) {
    try {
      // 包一层根节点避免多根
      stage.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">' + svgText.replace(/^<\?xml[^>]*\?>/, '').replace(/<svg[^>]*>|<\/svg>/g, '') + '</svg>';
    } catch (e) {
      stage.innerHTML = '<div style="color:#d1242f;font-size:12px">SVG 解析失败：' + e.message + '</div>';
    }
  }

  document.getElementById('btn-apply').addEventListener('click', function () {
    preview(codeEl.value);
    statusEl.textContent = '已应用预览（保存后才会成为宠物）';
  });

  document.getElementById('btn-save').addEventListener('click', function () {
    var name = (nameEl.value || '').trim();
    if (!name) name = 'my-pet.svg';
    if (!/\.svg$/i.test(name)) name += '.svg';
    window.dsh.petStudioSave(name, codeEl.value);
    statusEl.textContent = '已保存 ' + name + ' → 右键宠物 → 宠物皮肤 即可切换';
    refreshPets();
  });

  document.getElementById('btn-import').addEventListener('click', function () {
    window.dsh.petStudioImport().then(function (r) {
      if (!r) return;
      if (r.ok) {
        statusEl.textContent = '已生成透明宠物 ' + r.name + '（自动去白底）';
        refreshPets();
      } else if (!r.canceled) {
        statusEl.textContent = '导入失败：' + (r.error || '未知错误');
      }
    });
  });

  function refreshPets() {
    window.dsh.petState().then(function (state) {
      petsEl.innerHTML = '';
      var items = (state.list || []).map(function (n) { return { name: n, label: n }; });
      items.forEach(function (it) {
        var div = document.createElement('div');
        div.className = 'pet-item' + (state.current === it.name ? ' active' : '');
        div.textContent = it.label;
        div.addEventListener('click', function () {
          window.dsh.petSelect(it.name);
          // 2026-10-20 修：petSelect 是 send（异步、不等待主进程），立刻 refreshPets
          // 拿到的是**旧的 current**，列表高亮不动 → 用户看着像"点了没反应"。
          // 延迟一拍等主进程写完 store 再刷新。设置页的宠物切换早先同款问题。
          setTimeout(refreshPets, 160);
        });
        petsEl.appendChild(div);
      });
    });
  }

  refreshPets();

  // ── AI 一句话生成（2026-10-20 加）──────────────────────────────
  // 之前只有「设置 → 宠物」里才有这个功能，用户打开宠物工坊找不到，
  // 还以为 SVG 模板就是"生成结果"。这里补上，符合"做宠物就在工坊做"的直觉。
  var forgeDesc = document.getElementById('studio-forge-desc');
  var forgeStyle = document.getElementById('studio-forge-style');
  var forgeProv = document.getElementById('studio-forge-provider');
  var forgeKey = document.getElementById('studio-forge-key');
  var forgeRun = document.getElementById('studio-forge-run');
  var forgeDocBtn = document.getElementById('studio-forge-doc');
  var forgeMsg = document.getElementById('studio-forge-msg');

  function forgeSay(text, kind) {
    forgeMsg.textContent = text || '';
    forgeMsg.className = 'forge-msg' + (kind ? ' ' + kind : '');
  }

  if (window.dsh && window.dsh.petForgeConfig) {
    window.dsh.petForgeConfig().then(function (cfg) {
      if (!cfg) return;
      if (cfg.provider) forgeProv.value = cfg.provider;
      if (cfg.apiKey) forgeKey.value = cfg.apiKey;
    });
  }

  function saveCfg() {
    if (window.dsh && window.dsh.petForgeSetConfig) {
      window.dsh.petForgeSetConfig({ provider: forgeProv.value, apiKey: forgeKey.value });
    }
  }
  if (forgeProv) forgeProv.addEventListener('change', saveCfg);
  if (forgeKey) forgeKey.addEventListener('blur', saveCfg);

  if (forgeDocBtn) {
    forgeDocBtn.addEventListener('click', function () {
      if (window.dsh && window.dsh.petForgeOpenDoc) {
        window.dsh.petForgeOpenDoc().then(function (r) {
          if (r && r.ok === false) forgeSay('打开说明失败：' + (r.error || ''), 'err');
        });
      }
    });
  }

  if (forgeRun) {
    forgeRun.addEventListener('click', function () {
      var desc = (forgeDesc.value || '').trim();
      if (!desc) { forgeSay('先描述一下你想要的宠物', 'warn'); forgeDesc.focus(); return; }
      var key = (forgeKey.value || '').trim();
      if (!key) { forgeSay('请填 API Key（需支持图像生成，DeepSeek 模型不生图）', 'warn'); forgeKey.focus(); return; }
      saveCfg();
      forgeRun.disabled = true;
      forgeRun.textContent = '生成中…';
      forgeSay('正在生成，约需 30~60 秒，请稍候…');
      window.dsh.petForge({
        description: desc,
        style: forgeStyle.value,
        provider: forgeProv.value,
        apiKey: key
      }).then(function (r) {
        forgeRun.disabled = false;
        forgeRun.textContent = '生成';
        if (r && r.ok) {
          forgeSay('已生成「' + (r.name || '新宠物') + '」，已加入下方列表', 'ok');
          forgeDesc.value = '';
          refreshPets();
        } else {
          forgeSay((r && r.error) || '生成失败', 'err');
        }
      }).catch(function (e) {
        forgeRun.disabled = false;
        forgeRun.textContent = '生成';
        forgeSay('生成失败：' + (e && e.message ? e.message : String(e)), 'err');
      });
    });
  }
})();
