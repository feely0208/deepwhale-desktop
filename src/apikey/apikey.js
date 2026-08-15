/* API Key 设置窗逻辑（通过 preload 桥调用主进程 safeStorage 加密保存） */
(function () {
  var input = document.getElementById('key');

  function done() {
    window.dsh.closeWindow();
  }

  document.getElementById('save').addEventListener('click', function () {
    window.dsh.setApiKey(input.value.trim());
    done();
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
