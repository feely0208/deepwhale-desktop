/* API Key 设置窗逻辑（通过 preload 桥调用主进程 safeStorage 加密保存） */
(function () {
  var input = document.getElementById('key');
  var saveBtn = document.getElementById('save');
  var statusEl = document.getElementById('status');

  function done() {
    if (window.dsh && window.dsh.closeWindow) window.dsh.closeWindow();
  }

  input.addEventListener('input', function () {
    saveBtn.disabled = input.value.trim().length === 0;
  });

  saveBtn.addEventListener('click', function () {
    var key = input.value.trim();
    if (!key) return;
    if (!window.dsh || !window.dsh.setApiKey) {
      statusEl.style.color = '#d1242f';
      statusEl.textContent = '桥接不可用，请重启应用后重试';
      if (window.dsh && window.dsh.usageLog) window.dsh.usageLog('对话框: 桥接缺失');
      return;
    }
    if (window.dsh.usageLog) window.dsh.usageLog('对话框: 点击保存, key长度=' + key.length);
    window.dsh.setApiKey(key);
    if (window.dsh.usageLog) window.dsh.usageLog('对话框: 已调用 setApiKey');
    statusEl.textContent = '已保存 ✓（可关闭窗口）';
    saveBtn.disabled = true;
    setTimeout(done, 600);
  });

  document.getElementById('clear').addEventListener('click', function () {
    window.dsh.setApiKey('');
    done();
  });

  document.getElementById('cancel').addEventListener('click', done);

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('save').click();
    else if (e.key === 'Escape') done();
  });

  input.focus();
})();
