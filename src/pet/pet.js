/* 桌面宠物页逻辑：拖拽 + 右键菜单 + 悬停开心 + 周期小动作（通过 preload 桥） */
(function () {
  var petEl = document.getElementById('pet');
  var svgEl = document.getElementById('default-pet');
  var customEl = document.getElementById('custom-pet');

  // 自定义宠物：来自主进程 loadFile 的 query 参数 src（用户宠物目录的 file:// 地址，.gif/.svg 均可）
  var params = new URLSearchParams(window.location.search);
  var src = params.get('src');
  if (src) {
    customEl.src = encodeURI(src);
    customEl.hidden = false;
    svgEl.hidden = true;
  }

  // 悬停开心蹦跶
  var happyTimer = null;
  petEl.addEventListener('pointerenter', function () {
    petEl.classList.add('happy');
    if (happyTimer) clearTimeout(happyTimer);
    happyTimer = setTimeout(function () {
      petEl.classList.remove('happy');
    }, 1300);
  });

  // 周期小动作（仿 Codex 宠物：随机挥手 / 打盹）
  var actions = ['wave', 'sleep'];
  var actionTimer = null;
  function scheduleAction() {
    var delay = 11000 + Math.random() * 10000;
    actionTimer = setTimeout(function () {
      var a = actions[Math.floor(Math.random() * actions.length)];
      petEl.classList.add('action-' + a);
      setTimeout(function () {
        petEl.classList.remove('action-' + a);
        scheduleAction();
      }, a === 'sleep' ? 2600 : 1400);
    }, delay);
  }
  scheduleAction();

  // 手动拖拽（不用 -webkit-app-region: drag，它会吞掉右键事件）
  var dragging = false;
  petEl.addEventListener('pointerdown', function (e) {
    dragging = true;
    try {
      petEl.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    window.dsh.petDragStart();
  });

  petEl.addEventListener('pointermove', function () {
    if (dragging) window.dsh.petDragMove();
  });

  function endDrag() {
    if (dragging) {
      dragging = false;
      window.dsh.petDragEnd();
    }
  }
  petEl.addEventListener('pointerup', endDrag);
  petEl.addEventListener('pointercancel', endDrag);

  // 右键菜单：通知主进程弹原生 Menu
  petEl.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    window.dsh.petContextMenu();
  });
})();
