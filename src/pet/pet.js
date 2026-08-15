/* 桌面宠物页逻辑：
 * - 默认宠物：SVG 泪滴（CSS 动画）；
 * - 自定义宠物：userData/pets 下的 .gif/.svg/.png/.jpg/.webp（img）；
 * - 帧动画宠物：spritesheet 标准（manifest.json + spritesheet.png），canvas 播放，
 *   状态：idle/working/waving/jumping/running-left/running-right 等；
 * - 拖拽/右键菜单/悬停互动通过 preload 桥。
 */
(function () {
  var petEl = document.getElementById('pet');
  var svgEl = document.getElementById('default-pet');
  var customEl = document.getElementById('custom-pet');
  var spriteCanvas = document.getElementById('sprite-pet');
  var spriteCtx = spriteCanvas ? spriteCanvas.getContext('2d') : null;

  var params = new URLSearchParams(window.location.search);

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
    svgEl.hidden = true;
    customEl.hidden = true;
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
    // 普通自定义宠物：src（.gif/.svg/.png/.jpg/.webp）
    var src = params.get('src');
    if (src) {
      customEl.src = encodeURI(src);
      customEl.hidden = false;
      svgEl.hidden = true;
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
    var speed = (opts && opts.speed) || 130;
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

  // 空闲时周期性随机小动作：工作 / 挥手 / 跳跃（每 15~25 秒一次，持续约 4 秒）
  function scheduleSpriteAction() {
    if (spriteActionTimer) clearTimeout(spriteActionTimer);
    spriteActionTimer = setTimeout(function () {
      if (spriteState === 'idle') {
        var r = Math.random();
        var action = r < 0.45 ? 'working' : r < 0.75 ? 'waving' : 'jumping';
        setSpriteState(action);
        setTimeout(function () {
          if (spriteState === action) setSpriteState('idle');
        }, 4200);
      }
      scheduleSpriteAction();
    }, 15000 + Math.random() * 10000);
  }

  /* ================= 交互：悬停 / 点击 / 拖拽 ================= */

  // 悬停开心蹦跶（SVG 宠物）/ 挥手（帧动画宠物）
  var happyTimer = null;
  petEl.addEventListener('pointerenter', function () {
    if (isSprite) {
      setSpriteState('waving');
    } else {
      petEl.classList.add('happy');
      if (happyTimer) clearTimeout(happyTimer);
      happyTimer = setTimeout(function () {
        petEl.classList.remove('happy');
      }, 1300);
    }
  });
  petEl.addEventListener('pointerleave', function () {
    if (isSprite && spriteState === 'waving') setSpriteState('idle');
  });

  // 手动拖拽（不用 -webkit-app-region: drag，它会吞掉右键事件）
  var dragging = false;
  var lastX = 0;
  var lastY = 0;

  petEl.addEventListener('pointerdown', function (e) {
    dragging = true;
    lastX = e.screenX;
    lastY = e.screenY;
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
    lastY = e.screenY;
    if (isSprite) {
      setSpriteState(Math.abs(dx) < 2 ? 'jumping' : dx > 0 ? 'running-right' : 'running-left', { speed: 90 });
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
