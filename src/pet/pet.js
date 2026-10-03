/* 桌面宠物页逻辑：
 * - 帧动画宠物（默认）：spritesheet 标准（manifest.json + spritesheet.png），canvas 播放；
 * - 普通自定义宠物：userData/pets 下的 .gif/.svg/.png/.jpg/.webp（img）；
 * - 拖拽/右键菜单/悬停互动通过 preload 桥。
 *
 * 2026-10-03 两轮改进：
 *   ① 播放改用 requestAnimationFrame + 真实时间累积（setInterval 会漂移，一顿一顿的）；
 *      帧时长读 manifest 每行的 speed，再乘一个"当前动作倍率"；
 *   ② ★ 动作调度重做。用户反馈「十几组动作并没有生效，只有原地的动效，拖拽也只有方向变化」，
 *      查下来是两个设计问题：
 *        - 鼠标一停在宠物上就锁死在 `waving`，而随机动作只在 idle 时才调度 →
 *          **悬停时永远只有挥手那一个动作**；
 *        - 拖拽按"每帧位移"分级，窗口是跟着光标走的，每帧位移很小、又看不出走路/跑步的差别。
 *      现在：悬停期间每 ~3.6s 换一个随机动作；点一下宠物立刻做一个随机动作；
 *      拖拽按**平滑速度(px/ms)**分级，并用倍率让快跑明显更快；
 *      闲置随机动作也加密到 7~12 秒一次。
 *   ③ 状态切换加 140ms 交叉淡入（硬切在 12 帧循环上会"咔"一下）。
 *
 * 调试钩子 window.__petDebug：动作调度在独立窗口里，出问题时从外面看不见，
 * 自检脚本（scripts/test-pet-actions.js）靠它把状态/切帧拿出去断言。
 */
(function () {
  var petEl = document.getElementById('pet');
  var customEl = document.getElementById('custom-pet');
  var spriteCanvas = document.getElementById('sprite-pet');
  var spriteCtx = spriteCanvas ? spriteCanvas.getContext('2d') : null;

  var params = new URLSearchParams(window.location.search);
  var baseFrameMs = parseInt(params.get('frameMs') || '130', 10) || 130;
  // 调度节奏（自检脚本会传很小的值来快速验证）
  var idleMinMs = parseInt(params.get('actionMs') || '5000', 10) || 5000;
  var idleSpanMs = parseInt(params.get('actionSpanMs') || '4000', 10) || 4000;
  var hoverMs = parseInt(params.get('hoverMs') || '2800', 10) || 2800;
  var holdMs = parseInt(params.get('holdMs') || '3600', 10) || 3600;          // 单个动作保持多久
  var holdLongMs = parseInt(params.get('holdLongMs') || '5200', 10) || 5200;  // 站立/顶球这种"表演"多停一会

  /* ================= 帧动画宠物（spritesheet） ================= */
  var isSprite = false;
  var sheetImg = null;
  var spriteInfo = null;
  var curRow = null;
  var frameIdx = 0;
  var accMs = 0;
  var lastTs = 0;
  var spriteState = 'idle';
  var speedMul = 1;              // 当前动作倍率（拖拽分级用）
  var spriteActionTimer = null;
  var hoverTimer = null;
  var holdTimer = null;
  var rafId = null;
  var watchdogId = null;   // rAF 被平台节流时的兜底定时器（见 startLoop）
  var hovered = false;
  var dragging = false;
  var sideView = false;          // manifest.sideView：侧面视角的宠物才随位置翻转
  var faceRight = false;         // 素材默认朝左；true = 画布水平镜像
  var dashUntil = 0;             // 冲刺结束时刻（这段时间内冻结按位置调头）
  var facingTimer = null;

  // 招牌动作（用户点名"排在最前面"、要优先看到）：喷水 / 跳跃 / 甩水 / 顶球 / 翻跟头。
  // 甩水=swimming（尾巴摆得快 + 身后涟漪水花），diving 也算招牌（下潜带水泡）。
  var ACTION_POOL = ['dash', 'waving', 'jumping', 'flip', 'ball', 'swimming', 'diving'];
  // 安静的动作只在偶尔出现（不让宠物看起来像复读机，但也不占主要出场机会）
  var ACTION_POOL_RARE = ['standing', 'look', 'review', 'sleeping'];
  var lastAction = null;

  var spriteName = params.get('sprite');
  if (spriteName && spriteCtx && window.dsh && window.dsh.petSpriteInfo) {
    isSprite = true;
    spriteCanvas.hidden = false;
    window.dsh.petSpriteInfo(spriteName).then(function (info) {
      if (!info || !info.manifest) return;
      spriteInfo = info;
      sideView = !!info.manifest.sideView;   // 侧面宠物（如青色大肥鱼）才需要按位置转向
      var img = new Image();
      img.onload = function () {
        sheetImg = img;
        setSpriteState('idle');
        scheduleSpriteAction();
        startLoop();
        startFacingWatch();
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

  function findByState(name) {
    var rows = (spriteInfo && spriteInfo.manifest.rows) || [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].state === name) return rows[i];
    }
    return null;
  }

  function findRow(state) {
    var rows = (spriteInfo && spriteInfo.manifest.rows) || [];
    if (!rows.length) return null;
    // 翻跟头要"看起来顺时针"：素材默认朝左（未镜像）用 flip；
    // 镜像朝右时改用反向那一行，否则屏幕上会变成逆时针。
    if (state === 'flip' && faceRight) {
      var rev = findByState('flip-rev');
      if (rev) return rev;
    }
    var exact = findByState(state);
    if (exact) return exact;
    // 速度/方向名对不上时回落：fast-running-right → running-right → walking-right → swimming → idle
    var m = /^(?:fast-)?(?:walking|jogging|running)(-left|-right)?$/.exec(state);
    if (m) {
      var dir = m[1] || '';
      var cands = ['running' + dir, 'walking' + dir, 'swimming', 'idle'];
      for (var k = 0; k < cands.length; k++) {
        var r = findByState(cands[k]);
        if (r) return r;
      }
    }
    return rows[0];
  }

  /** 当前帧应显示多久（manifest 的 speed 是倍率：<1 更快；再乘当前动作倍率） */
  function frameDuration() {
    var speed = (curRow && curRow.speed) || 1;
    return Math.max(30, Math.min(900, baseFrameMs * speed * speedMul));
  }

  var FADE_MS = 140;
  var fadeFrom = null;

  function setSpriteState(state, opts) {
    if (!spriteInfo || !sheetImg) return;
    var row = findRow(state);
    if (!row) return;
    var mul = (opts && opts.speed) || 1;
    if (spriteState === state && curRow === row && speedMul === mul) return;
    // 切换动作时做一次短交叉淡入：挥手/拖拽这些是硬切，
    // 硬切在 12 帧循环上会"咔"一下，用户要的是"流畅不要生硬"。
    if (curRow && (curRow !== row || state !== spriteState)) {
      fadeFrom = { row: curRow, idx: frameIdx, t0: performance.now() };
    }
    spriteState = state;
    curRow = row;
    speedMul = mul;
    frameIdx = 0;
    accMs = 0;
    drawSpriteFrame();
  }

  function drawFrameAt(row, idx) {
    var m = spriteInfo.manifest;
    var cw = m.cellWidth || 192;
    var ch = m.cellHeight || 208;
    if (spriteCanvas.width !== cw || spriteCanvas.height !== ch) {
      spriteCanvas.width = cw;
      spriteCanvas.height = ch;
    }
    // 侧面宠物 + 该动作不是"有方向"的那些（running/walking-left|right 自带朝向）
    // → 按当前位置水平镜像，让它总是面向屏幕中间（用户要求：拖到左边应朝右）。
    var directional = /-(left|right)$/.test((row && row.state) || '');
    if (sideView && faceRight && !directional) {
      spriteCtx.save();
      spriteCtx.translate(cw, 0);
      spriteCtx.scale(-1, 1);
      spriteCtx.drawImage(sheetImg, idx * cw, row.row * ch, cw, ch, 0, 0, cw, ch);
      spriteCtx.restore();
      return;
    }
    spriteCtx.drawImage(sheetImg, idx * cw, row.row * ch, cw, ch, 0, 0, cw, ch);
  }

  /** 按"宠物在屏幕左半还是右半"决定朝向：左半朝右、右半朝左（面向屏幕中间） */
  function updateFacing() {
    if (!sideView) return;
    if (performance.now() < dashUntil) return;   // 正在冲刺：别半路翻脸
    var sc = window.screen || {};
    var availLeft = typeof sc.availLeft === 'number' ? sc.availLeft : 0;
    var availW = sc.availWidth || sc.width || 0;
    if (!availW) return;
    var center = availLeft + availW / 2;
    var me = window.screenX + (window.outerWidth || 180) / 2;
    var right = me < center;
    if (right !== faceRight) {
      faceRight = right;
      drawSpriteFrame();
    }
  }

  function startFacingWatch() {
    updateFacing();
    if (facingTimer) clearInterval(facingTimer);
    // 拖动是主进程直接移动窗口，渲染层只能轮询位置（1.2s 足够，翻转本身有淡入）
    facingTimer = setInterval(updateFacing, 1200);
  }

  function drawSpriteFrame() {
    if (!sheetImg || !spriteInfo || !curRow) return;
    spriteCtx.clearRect(0, 0, spriteCanvas.width, spriteCanvas.height);
    if (fadeFrom) {
      var p = (performance.now() - fadeFrom.t0) / FADE_MS;
      if (p >= 1) {
        fadeFrom = null;
      } else {
        spriteCtx.globalAlpha = 1;
        drawFrameAt(fadeFrom.row, fadeFrom.idx);
        spriteCtx.globalAlpha = Math.max(0, Math.min(1, p));
        drawFrameAt(curRow, frameIdx);
        spriteCtx.globalAlpha = 1;
        return;
      }
    }
    drawFrameAt(curRow, frameIdx);
  }

  /** 用真实时间累积推进帧：掉帧时补步，不会越走越偏 */
  var lastAdvanceAt = 0;
  function advance(now) {
    if (!lastTs) lastTs = now;
    var dt = now - lastTs;
    lastTs = now;
    if (dt > 200) dt = 200;           // 窗口被挂起后回来不要"快进"
    accMs += dt;
    var dur = frameDuration();
    var frames = (curRow && curRow.frames) || 1;
    var advanced = false;
    while (accMs >= dur) {
      accMs -= dur;
      frameIdx = (frameIdx + 1) % frames;
      advanced = true;
    }
    if (advanced || fadeFrom) drawSpriteFrame();
    lastAdvanceAt = now;
  }

  function startLoop() {
    if (rafId !== null) return;
    lastTs = 0;
    rafId = requestAnimationFrame(function tick(ts) {
      advance(typeof ts === 'number' ? ts : performance.now());
      rafId = requestAnimationFrame(tick);
    });
    // ⚠️ 2026-10-03 兜底（Windows 用户实测宠物"冻住"）：
    //    Windows 的遮挡检测可能把 rAF 节流到几乎不回调，精灵就停在某一帧。
    //    定时器不受这个节流影响；一旦发现 rAF 掉队（>120ms 没推进），
    //    就用同一套真实时间逻辑补上，保证动作总能往前走。
    if (watchdogId === null) {
      watchdogId = setInterval(function () {
        var now = performance.now();
        if (now - lastAdvanceAt > 120) advance(now);
      }, 80);
    }
  }

  /* ================= 动作调度 ================= */

  /** 挑下一个动作：招牌动作为主（85%），安静动作偶尔出现；同一动作不连着来 */
  function pickAction() {
    var main = ACTION_POOL.filter(function (st) { return !!findByState(st); });
    var rare = ACTION_POOL_RARE.filter(function (st) { return !!findByState(st); });
    var pool = (Math.random() < 0.15 && rare.length) ? rare : main;
    if (!pool.length) pool = main.concat(rare);
    if (!pool.length) return null;
    var pick = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && pick === lastAction) {
      pick = pool[(pool.indexOf(pick) + 1) % pool.length];
    }
    lastAction = pick;
    return pick;
  }

  /**
   * 冲刺划水：朝自己面向的方向真的窜出去半个屏幕（主进程负责移动窗口）。
   * 用户指定的"默认第一个动作"——点一下宠物就走这个，最容易被人发现。
   */
  function playDash() {
    if (!findByState('dash')) {
      playRandomAction();
      return spriteState;
    }
    setSpriteState('dash');
    dashUntil = performance.now() + 900;   // 冲刺期间冻结"按位置调头"，别半路翻脸
    if (window.dsh && typeof window.dsh.petDash === 'function') {
      window.dsh.petDash(faceRight ? 1 : -1);
    }
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(function () {
      if (spriteState === 'dash') {
        dashUntil = 0;
        setSpriteState('idle');
        updateFacing();                      // 落点变了 → 重新判定朝向（面向屏幕中间）
      }
    }, 820);
    return spriteState;
  }

  /** 立刻做一个随机动作（悬停轮到、闲置到点都会走这里） */
  function playRandomAction() {
    var action = pickAction();
    if (!action) {
      setSpriteState('waving');
      return spriteState;
    }
    if (action === 'dash') return playDash();   // 抽到冲刺：走"真的窜出去"那条路
    setSpriteState(action);
    if (holdTimer) clearTimeout(holdTimer);
    if (!hovered) {
      // 悬停时不回 idle —— 交给悬停计时器轮下一个动作，不然一直来回闪
      var hold = (action === 'ball' || action === 'standing') ? holdLongMs : holdMs;
      holdTimer = setTimeout(function () {
        if (spriteState === action && !hovered && !dragging) setSpriteState('idle');
      }, hold);
    }
    return spriteState;
  }

  // 闲置时周期性随机小动作（5~9 秒一次）
  function scheduleSpriteAction() {
    if (spriteActionTimer) clearTimeout(spriteActionTimer);
    spriteActionTimer = setTimeout(function () {
      if (spriteState === 'idle' && !dragging && !hovered) playRandomAction();
      scheduleSpriteAction();
    }, idleMinMs + Math.random() * idleSpanMs);
  }

  // 悬停期间轮播动作（这是"动作多不多"的关键：以前悬停锁死在挥手）
  function startHoverCycle() {
    stopHoverCycle();
    setSpriteState('waving');
    hoverTimer = setInterval(function () {
      if (!hovered || dragging) return;
      playRandomAction();
    }, hoverMs);
  }

  function stopHoverCycle() {
    if (hoverTimer) {
      clearInterval(hoverTimer);
      hoverTimer = null;
    }
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  /* ================= 交互：悬停 / 点击 / 拖拽 ================= */

  petEl.addEventListener('pointerenter', function () {
    hovered = true;
    // 穿透模式下告诉主进程"光标在宠物身上了" → 临时接收鼠标事件（否则点不动它）
    if (window.dsh && typeof window.dsh.petHover === 'function') window.dsh.petHover(true);
    if (!isSprite) return;
    if (performance.now() < dashUntil) return;   // 冲刺中：别打断
    startHoverCycle();
  });
  petEl.addEventListener('pointerleave', function () {
    hovered = false;
    if (window.dsh && typeof window.dsh.petHover === 'function') window.dsh.petHover(false);
    stopHoverCycle();
    // ⚠️ 冲刺时窗口会滑走，光标必然离开窗口 → 这里**不能**把动作切回 idle，
    //    否则冲刺动画刚开头就被掐断（用户实测："划水还是之前一样"，只看到滑动）。
    if (isSprite && !dragging && performance.now() >= dashUntil) setSpriteState('idle');
  });

  // 手动拖拽（不用 -webkit-app-region: drag，它会吞掉右键事件）
  var lastX = 0;
  var lastMoveTs = 0;
  var downAt = 0;
  var downX = 0;
  var moved = false;

  petEl.addEventListener('pointerdown', function (e) {
    dragging = true;
    lastX = e.screenX;
    downX = e.screenX;
    downAt = Date.now();
    moved = false;
    lastMoveTs = performance.now();
    stopHoverCycle();
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
    if (Math.abs(e.screenX - downX) > 3) moved = true;
    if (isSprite) {
      // 按**平滑速度**分级：位置在跟着光标走，逐帧位移不可靠；
      // 用 px/ms（并按帧间隔归一）判断快慢，再用倍率拉开差别。
      var now = performance.now();
      var dt = Math.max(8, now - lastMoveTs);
      lastMoveTs = now;
      var v = Math.abs(dx) / dt;                 // px per ms
      var dir = dx >= 0 ? '-right' : '-left';
      if (v < 0.05) {
        setSpriteState('jumping');
      } else if (v < 0.22) {
        setSpriteState('walking' + dir, { speed: 1.15 });
      } else if (v < 0.55) {
        setSpriteState('jogging' + dir, { speed: 0.95 });
      } else {
        setSpriteState('fast-running' + dir, { speed: 0.55 });
      }
    }
    window.dsh.petDragMove();
    updateFacing();
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    if (isSprite) setSpriteState('idle');
    window.dsh.petDragEnd();
    updateFacing();
    // 没怎么动 = 当成"点一下"：**默认第一个动作就是冲刺划水**（用户指定），
    // 点它就直接窜半个屏幕，最容易发现。
    if (!moved && Date.now() - downAt < 450) {
      playDash();
    } else if (hovered) {
      startHoverCycle();
    }
  }
  petEl.addEventListener('pointerup', endDrag);
  petEl.addEventListener('pointercancel', endDrag);

  // 右键菜单：通知主进程弹原生 Menu
  petEl.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    window.dsh.petContextMenu();
  });

  /* ================= 自检钩子（scripts/test-pet-actions.js 用） ================= */
  window.__petDebug = {
    info: function () {
      return {
        isSprite: isSprite,
        state: spriteState,
        row: curRow ? curRow.row : -1,
        frames: curRow ? curRow.frames : 0,
        frame: frameIdx,
        speedMul: speedMul,
        hovered: hovered,
        dragging: dragging,
        sideView: sideView,
        faceRight: faceRight,
        rows: (spriteInfo && spriteInfo.manifest && spriteInfo.manifest.rows) || [],
      };
    },
    set: function (state, speed) {
      dashUntil = 0;                 // 强制切状态时解除"冲刺冻结朝向"（自检要用）
      setSpriteState(state, { speed: speed });
      return spriteState;
    },
    random: function () {
      return playRandomAction();
    },
    dash: function () {
      return playDash();
    },
    /** 画布校验和：用来断言"不同动作真的画出了不同的画面" */
    hash: function () {
      var d = spriteCtx.getImageData(0, 0, spriteCanvas.width, spriteCanvas.height).data;
      var h = 0;
      for (var i = 0; i < d.length; i += 97) {
        h = (h * 31 + d[i]) % 2147483647;
      }
      return h;
    },
    setFacing: function (right) {
      faceRight = !!right;
      drawSpriteFrame();
      return faceRight;
    },
    updateFacing: function () {
      updateFacing();
      return faceRight;
    },
    hover: function (on) {
      hovered = !!on;
      if (hovered) startHoverCycle();
      else {
        stopHoverCycle();
        setSpriteState('idle');
      }
      return spriteState;
    },
  };
})();
