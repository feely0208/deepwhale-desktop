/* 首次启动引导窗逻辑。
 *
 * 只在**全新安装的第一次启动**出现（判断见主进程 index.ts：
 * 本次启动前 settings.json 不存在，且未标记 onboarded）。
 * 用户点「开始使用」后写入标记，之后永不再显示。
 *
 * 本页只做两件事：可选的 API Key 配置、结束引导。
 * 不做多步向导——保持简单，减少出错面。
 */
(function () {
  var setKeyBtn = document.getElementById('setkey');
  var startBtn = document.getElementById('start');
  var statusEl = document.getElementById('keystatus');

  function finish() {
    if (window.dsh && window.dsh.welcomeFinish) {
      window.dsh.welcomeFinish();
    } else if (window.dsh && window.dsh.closeWindow) {
      // 桥不可用时的兜底：至少把窗口关掉
      window.dsh.closeWindow();
    }
  }

  if (setKeyBtn) {
    setKeyBtn.addEventListener('click', function () {
      if (!window.dsh || !window.dsh.welcomeOpenApiKey) {
        statusEl.style.color = '#d1242f';
        statusEl.textContent = '桥接不可用，请重启应用后重试';
        return;
      }
      window.dsh.welcomeOpenApiKey();
      statusEl.style.color = '#1a7f37';
      statusEl.textContent = '已打开配置窗口，保存后回到本页点「开始使用」即可。';
    });
  }

  if (startBtn) {
    startBtn.addEventListener('click', finish);
  }

  // Esc / Enter 都等价于「开始使用」，避免用户找不到出口
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      finish();
    }
  });
})();
