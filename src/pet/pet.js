/* 桌面宠物页逻辑：拖拽 + 右键菜单 + 悬停开心（通过 preload 暴露的最小 IPC 桥） */
(function () {
  var petEl = document.getElementById('pet');
  var svgEl = document.getElementById('default-pet');
  var customEl = document.getElementById('custom-pet');

  // 自定义宠物：来自主进程 loadFile 的 query 参数（.gif 或 .svg 均可）
  var params = new URLSearchParams(window.location.search);
  var file = params.get('file');
  if (file) {
    customEl.src = '../assets/pets/' + encodeURIComponent(file);
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
