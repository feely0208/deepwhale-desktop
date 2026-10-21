(function () {
  var q = document.getElementById('q');
  var sendBtn = document.getElementById('send');
  var cancelBtn = document.getElementById('cancel');
  var msg = document.getElementById('msg');
  var hint = document.getElementById('hint');

  function say(text, kind) {
    msg.textContent = text || '';
    msg.className = kind || '';
  }

  async function submit() {
    var text = (q.value || '').trim();
    if (!text) { say('先写一句要问的', 'warn'); q.focus(); return; }
    sendBtn.disabled = true;
    sendBtn.textContent = '发送中…';
    try {
      var r = await window.dsh.petAsk(text);
      if (r && r.ok) {
        say(r.mode === 'clipboard'
          ? '已复制到剪贴板，到主界面按 ⌘V 粘贴发送'
          : '已带到主界面', 'ok');
        q.value = '';
        setTimeout(function () { window.dsh.petAskClose && window.dsh.petAskClose(); }, 900);
      } else {
        say((r && r.error) || '发送失败', 'err');
      }
    } catch (e) {
      say('发送失败：' + (e && e.message ? e.message : e), 'err');
    }
    sendBtn.disabled = false;
    sendBtn.textContent = '发送';
  }

  sendBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', function () { window.dsh.petAskClose && window.dsh.petAskClose(); });
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { window.dsh.petAskClose && window.dsh.petAskClose(); }
  });
  // 窗口显示后自动聚焦
  setTimeout(function () { q.focus(); }, 60);
})();
