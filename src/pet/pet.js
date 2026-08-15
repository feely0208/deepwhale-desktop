/* 桌面宠物页逻辑：拖拽 + 右键菜单（通过 preload 暴露的最小 IPC 桥） */
(function () {
  const petEl = document.getElementById('pet');
  const gifEl = document.getElementById('gif-pet');
  const svgEl = document.getElementById('default-pet');

  // GIF 模式：来自主进程 loadFile 的 query 参数
  const params = new URLSearchParams(window.location.search);
  const gif = params.get('gif');
  if (gif) {
    gifEl.src = '../assets/pets/' + encodeURIComponent(gif);
    gifEl.hidden = false;
    svgEl.hidden = true;
  }

  // 手动拖拽（不用 -webkit-app-region: drag，它会吞掉右键事件）
  let dragging = false;
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
