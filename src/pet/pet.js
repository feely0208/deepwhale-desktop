/* 桌面宠物页逻辑：
 * - 帧动画宠物（默认）：spritesheet 标准（manifest.json + spritesheet.png），canvas 播放，
 *   状态：idle/working/waving/jumping/running-left/running-right 等；
 * - 普通自定义宠物：userData/pets 下的 .gif/.svg/.png/.jpg/.webp（img）；
 * - 拖拽/右键菜单/悬停互动通过 preload 桥。
 */
(function () {
  var petEl = document.getElementById('pet');
  var customEl = document.getElementById('custom-pet');
  var spriteCanvas = document.getElementById('sprite-pet');
  var spriteCtx = spriteCanvas ? spriteCanvas.getContext('2d') : null;

  var params = new URLSearchParams(window.location.search);
  var frameMs = parseInt(params.get('frameMs') || '130', 10) || 130;

  /* ================= 帧动画宠物（spritesheet） ================= */
  var isSprite = false;
  var sheetImg = null;
  var spriteInfo = null;
  var curRow = null;
  var frameIdx = 0;
  var frameTimer = null;
  var spriteState = 'idle';
  var spriteActionTimer = null;

  var spriteName = params.get('sprite');
  if (spriteName && spriteCtx && window.dsh && window.dsh.petSpriteInfo) {
    isSprite = true;
    spriteCanvas.hidden = false;
    window.dsh.petSpriteInfo(spriteName).then(function (info) {
      if (!info || !info.manifest) return;
      spriteInfo = info;
      var img = new Image();
      img.onload = function () {
        sheetImg = img;
        setSpriteState('idle');
        scheduleSpriteAction();
      };
      img.src = info.sheetDataUri;
    });
  } else {
    var src = params.get('src');
    if (src) {
      customEl.src = encodeURI(src);
      customEl.hidden = false;
    }
  }

  function findRow(state) {
    var rows = (spriteInfo && spriteInfo.manifest.rows) || [];
    return rows.find(function (r) { return r.state === state; }) || rows[0];
  }

  function setSpriteState(state, opts) {
    if (!spriteInfo || !sheetImg) return;
    var row = findRow(state);
    if (!row) return;
    if (spriteState === state && curRow === row) return;
    spriteState = state;
    curRow = row;
    frameIdx = 0;
    if (frameTimer) clearInterval(frameTimer);
    var speed = (opts && opts.speed) || frameMs;
    frameTimer = setInterval(function () {
      frameIdx = (frameIdx + 1) % (curRow.frames || 1);
      drawSpriteFrame();
    }, speed);
    drawSpriteFrame();
  }

  function drawSpriteFrame() {
    if (!sheetImg || !spriteInfo) return;
    var m = spriteInfo.manifest;
    var cw = m.cellWidth || 192;
    var ch = m.cellHeight || 208;
    spriteCanvas.width = cw;
    spriteCanvas.height = ch;
    spriteCtx.clearRect(0, 0, cw, ch);
    spriteCtx.drawImage(sheetImg, frameIdx * cw, curRow.row * ch, cw, ch, 0, 0, cw, ch);
  }

  // 空闲时周期性随机小动作：工作 / 挥手 / 跳跃（每 16~26 秒一次，持续约 4.5 秒）
  function scheduleSpriteAction() {
    if (spriteActionTimer) clearTimeout(spriteActionTimer);
    spriteActionTimer = setTimeout(function () {
      if (spriteState === 'idle') {
        var r = Math.random();
        var action = r < 0.5 ? 'working' : r < 0.78 ? 'waving' : 'jumping';
        setSpriteState(action);
        setTimeout(function () {
          if (spriteState === action) setSpriteState('idle');
        }, 4500);
      }
      scheduleSpriteAction();
    }, 16000 + Math.random() * 10000);
  }

  /* ================= 交互：悬停 / 点击 / 拖拽 ================= */

  // 悬停 → 挥手（帧动画宠物）
  petEl.addEventListener('pointerenter', function () {
    if (isSprite) setSpriteState('waving');
  });
  petEl.addEventListener('pointerleave', function () {
    if (isSprite && spriteState === 'waving') setSpriteState('idle');
  });

  // 手动拖拽（不用 -webkit-app-region: drag，它会吞掉右键事件）
  var dragging = false;
  var lastX = 0;

  petEl.addEventListener('pointerdown', function (e) {
    dragging = true;
    lastX = e.screenX;
    try {
      petEl.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    if (isSprite) setSpriteState('jumping');
    window.dsh.petDragStart();
  });

  petEl.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var dx = e.screenX - lastX;
    lastX = e.screenX;
    if (isSprite) {
      // 按拖动速度切换动作：走路 < 快走 < 慢跑 < 快跑；方向决定左/右
      var dir = dx >= 0 ? '' : '-left';
      var adx = Math.abs(dx);
      var st;
      if (adx < 3) st = 'jumping';
      else if (adx < 8) st = 'walking' + dir;
      else if (adx < 15) st = 'fast-walking' + dir;
      else if (adx < 24) st = 'jogging' + dir;
      else st = 'fast-running' + dir;
      setSpriteState(st, { speed: Math.max(60, frameMs - 40) });
    }
    window.dsh.petDragMove();
  });

  function endDrag() {
    if (dragging) {
      dragging = false;
      if (isSprite && (spriteState === 'jumping' || spriteState.indexOf('running') === 0)) {
        setSpriteState('idle');
      }
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
