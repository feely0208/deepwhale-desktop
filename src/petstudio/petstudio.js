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
          refreshPets();
        });
        petsEl.appendChild(div);
      });
    });
  }

  refreshPets();
})();
