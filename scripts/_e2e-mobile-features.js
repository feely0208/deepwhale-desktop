// Electron 驱动：手机端界面能力断言（不可见窗口，不打扰用户）
// 由 scripts/check-mobile-features-e2e.mjs 拉起：env 提供 DSH_E2E_BASE / DSH_E2E_TOKEN / DSH_E2E_SHOTS
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-features-userdata-')));
const BASE = process.env.DSH_E2E_BASE;
const TOKEN = process.env.DSH_E2E_TOKEN;
const SHOTS = process.env.DSH_E2E_SHOTS || '/tmp/dsh-mobile-features/shots';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const logStep = (m) => { try { console.log('[step] ' + m); } catch (e) {} };
// executeJavaScript 没有超时：页面里某个 Promise 永远不 settle 就会把整个驱动挂死（踩过两次）。
// 统一包一层 Promise.race，超时返回 {timeout:true}，断言脚本照常给出结论。
const evalJs = (w, code, timeoutMs = 15000) =>
  Promise.race([
    w.webContents.executeJavaScript(code).catch((e) => JSON.stringify({ error: String(e.message).slice(0, 200) })),
    new Promise((resolve) => setTimeout(() => resolve(JSON.stringify({ timeout: true })), timeoutMs)),
  ]);
const shot = async (w, name) => {
  try {
    fs.writeFileSync(path.join(SHOTS, name), (await w.webContents.capturePage()).toPNG());
  } catch (e) {}
};
let stateTimeouts = 0;
const state = async (w) => {
  const raw = await evalJs(w, 'JSON.stringify(window.__dshState ? window.__dshState() : {})', 5000);
  try {
    const v = JSON.parse(raw);
    if (v && v.timeout) stateTimeouts += 1;
    return v || {};
  } catch {
    return {};
  }
};


/** 把当前会话切到一个"支持图片输入"的模型（部署里 deepseek-flash 支持；找不到就算了） */
async function selectVisionModel(w) {
  const raw = await evalJs(
    w,
    `window.dshMobileApi.modelCatalog().then(function(r){
       if(!r.ok) return JSON.stringify({ok:false});
       var cat=r.value||{}; var groups=cat.groups||[];
       for (var i=0;i<groups.length;i++){ var ms=groups[i].models||[];
         for (var j=0;j<ms.length;j++){ if(String(ms[j].id).indexOf('flash')>=0 || String(ms[j].name||'').indexOf('Flash')>=0)
           return JSON.stringify({ok:true, provider:groups[i].id, model:ms[j].id}); } }
       return JSON.stringify({ok:false});
     })`,
    30000,
  );
  let v = null;
  try { v = JSON.parse(raw); } catch {}
  if (!v || !v.ok) return null;
  const sid = (await state(w)).sessionId;
  if (!sid) return null;
  await evalJs(
    w,
    `window.dshMobileApi.selectModel(${JSON.stringify(sid)}, ${JSON.stringify(v.provider)}, ${JSON.stringify(v.model)}).then(function(x){return JSON.stringify(x)})`,
    30000,
  );
  logStep('已切到 vision 模型 ' + v.model);
  return v;
}

app.whenReady().then(async () => {
  const out = { rows: 0, chatMsgs: 0, attachCards: 0, imageLoaded: false, imageNaturalWidth: 0, traceRows: 0, modelOptions: 0, chipModelAfter: '', attachmentSent: false, approvalShown: false, approvalAnswered: false, jsError: '', notes: [] };
  const w = new BrowserWindow({
    show: false,
    width: 390,
    height: 844,
    opacity: 0,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  const pageLogs = [];
  w.webContents.on('console-message', (_e, level, msg) => {
    const m = String(msg || '');
    if (!/Security Warning|Electron Security/.test(m)) pageLogs.push(m.slice(0, 240));
  });
  // 看门狗：驱动自己也要有兜底（渲染进程崩了/某个 Promise 永不 settle 时不能永远挂着）
  const hardStop = setTimeout(async () => {
    out.notes.push('watchdog: 6 分钟强制结束');
    out.pageLogs = pageLogs.slice(-30);
    console.log('FEATURES_RESULT ' + JSON.stringify(out));
    app.exit(0);
  }, 6 * 60 * 1000);
  hardStop.unref?.();
  try {
    // ⚠️ 直接打开带我们网关令牌的 /mobile/：不要先开 `/?token=` 再开 /mobile/ ——
    //    网关换来的 DSH cookie 与"页面自己拿的令牌"是两条路，第二步会落回连接页（实测：页面全离线）。
    //    真机上也是直接开 `http://<网关>/mobile/?token=<令牌>`。
    await w.loadURL(`${BASE}/mobile/?token=${encodeURIComponent(TOKEN)}`);
    await wait(3500);
    logStep('页面已载入');
    await shot(w, '1-list.png');

    // ── 列表页 ──
    out.rows = await evalJs(w, "document.querySelectorAll('.row-btn').length");
    out.composerOnList = await evalJs(w, "getComputedStyle(document.querySelector('.composer')).display");
    out.notes.push('rows=' + out.rows + ' composerOnList=' + JSON.stringify(out.composerOnList));

    // ── 进入"有聊天记录"的会话：列表按最后活动排序，最近几条可能是刚建的空会话，
    //    所以逐行点进去找（找到有 ≥2 条消息的就停），不能写死第一行（实测：第一行是空会话）。
    logStep('找一个有聊天记录的会话');
    const wantSession = process.env.DSH_E2E_SESSION || '';
    if (wantSession) {
      const selector = `.row-btn[data-id="${wantSession}"]`;
      logStep('按 id 精确打开会话 ' + wantSession);
      await evalJs(w, `(function(){var b=document.querySelector(${JSON.stringify(selector)}); if(b){b.click(); return true;} return false;})()`);
      await wait(2500);
    }
    const rowCount = await evalJs(w, "document.querySelectorAll('.row-btn').length");
    let foundSession = false;
    for (let idx = 0; idx < Math.min(Number(rowCount) || 0, 8); idx += 1) {
      await evalJs(w, `(function(){var b=document.querySelectorAll('.row-btn')[${idx}]; if(b) b.click(); return !!b;})()`);
      await wait(1200);
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const s = await state(w);
        if ((s.msgs || 0) >= 2) break;
        await wait(500);
      }
      const s = await state(w);
      if ((s.msgs || 0) >= 2) {
        foundSession = true;
        out.openedIndex = idx;
        break;
      }
      await evalJs(w, "(function(){ if(window.__dshBack) window.__dshBack(); return true; })()");
      await wait(1500);
    }
    out.foundSession = foundSession;
    await wait(1500);
    out.chatMsgs = await evalJs(w, "document.querySelectorAll('#page-chat .msg').length");
    out.attachCards = await evalJs(w, "document.querySelectorAll('#page-chat .att-file, #page-chat .att-img').length");
    out.turns = await evalJs(w, "document.querySelectorAll('#page-chat .msg').length");
    await shot(w, '2-chat-with-attachments.png');

    // ── 点开一个图片占位卡：图片必须真的从 /mobile/api/attachment 取回 ──
    const clickImage = await evalJs(
      w,
      `(function(){
        var cards = Array.prototype.slice.call(document.querySelectorAll('#page-chat .msg.me .att-file'));
        for (var i = 0; i < cards.length; i++) {
          var t = (cards[i].textContent || '');
          if (/图片|png|jpg|jpeg|webp/i.test(t)) { cards[i].click(); return true; }
        }
        // 没有占位卡就看是不是已经有图
        return document.querySelectorAll('#page-chat .att-img').length > 0 ? 'already' : false;
      })()`,
    );
    out.notes.push('clickImage=' + JSON.stringify(clickImage));
    if (clickImage) {
      for (let i = 0; i < 20; i += 1) {
        const nw = await evalJs(
          w,
          `(function(){ var i = document.querySelector('#page-chat .att-img'); return i ? (i.naturalWidth || 0) : 0; })()`,
        );
        if (typeof nw === 'number' && nw > 0) {
          out.imageLoaded = true;
          out.imageNaturalWidth = nw;
          break;
        }
        await wait(400);
      }
    }
    await shot(w, '3-image-loaded.png');

    // ── 轨迹 tab ──
    await evalJs(w, "(function(){var t=document.getElementById('tab-trace'); if(t) t.click(); return true;})()");
    await wait(3000);
    out.traceRows = await evalJs(w, "document.querySelectorAll('#trace-list .trace-turn, #trace-list .traj-row').length");
    logStep('轨迹 tab');
    await shot(w, '4-trace-tab.png');
    await evalJs(w, "(function(){var c=document.getElementById('tab-chat'); if(c) c.click(); return true;})()");
    await wait(800);

    // ── 新建一个会话 → 界面里带附件真发（新会话用默认模型，避免被后面切模型影响）──
    const sidBefore = (await state(w)).sessionId;
    logStep('新建会话（带附件发送用）');
    await evalJs(w, "(function(){ if(window.__dshNew) window.__dshNew(); return true; })()", 20000);
    {
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const s = await state(w);
        if (s.sessionId && s.sessionId !== sidBefore) break;
        await wait(500);
      }
    }
    await selectVisionModel(w);
    await wait(1200);
    const before = await state(w);
    out.newSessionId = before.sessionId;
    const sendResult = await evalJs(
      w,
      `(function(){
        var b64 = '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';
        var bin = atob(b64); var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        var f = new File([arr], 'e2e-shot.png', { type: 'image/png' });
        return window.__dshAttachFiles([f]).then(function (n) {
          return window.dshMobileSend('E2E 手机端带附件发送').then(function (r) { return { pending: n, send: r }; });
        });
      })()`,
      60000,
    );
    out.notes.push('send=' + JSON.stringify(sendResult).slice(0, 300));
    let sent = false;
    {
      const deadline = Date.now() + 75000;
      while (Date.now() < deadline) {
        const s = await state(w);
        if ((s.turns || 0) > (before.turns || 0)) {
          sent = true;
          break;
        }
        await wait(1000);
      }
    }
    out.attachmentSent = sent;
    out.sendToast = await evalJs(w, "(document.getElementById('dsh-toast')||{}).textContent || ''");
    if (!sent && /attachment-invalid/.test(String(out.sendToast))) {
      out.notes.push('图片发送被拒（模型不支持图片），改用文本文件再试一次');
      const fileSend = await evalJs(
        w,
        `(function(){
          var f = new File(['E2E 附件文件内容 line1\nline2\n'], 'e2e-note.txt', { type: 'text/plain' });
          return window.__dshAttachFiles([f]).then(function (n) {
            return window.dshMobileSend('E2E 手机端带附件发送（文件）').then(function (r) { return { pending: n, send: r }; });
          });
        })()`,
        60000,
      );
      out.notes.push('fileSend=' + JSON.stringify(fileSend).slice(0, 260));
      const deadline = Date.now() + 75000;
      while (Date.now() < deadline) {
        const s = await state(w);
        if ((s.turns || 0) > (before.turns || 0)) {
          sent = true;
          out.sentKind = 'file';
          break;
        }
        await wait(1000);
      }
      out.attachmentSent = sent;
    } else if (sent) {
      out.sentKind = 'image';
    }
    await wait(1500);
    out.chatMsgsAfterSend = await evalJs(w, "document.querySelectorAll('#page-chat .msg').length");
    logStep('附件发送完成' + (sent ? '' : '（未成功）'));
    await shot(w, '5-attachment-sent.png');

    // ── 手机审批卡：让模型发起一次需要审批的调用 ──
    logStep('发起审批用例 prompt');
    // 只发起、不等待：send() 的 Promise 在极端情况下可能一直不 settle，不能让它拖死驱动
    await evalJs(
      w,
      `(function(){ try { window.dshMobileSend('请立即调用 bash 工具执行 echo mobile-ui-approval。这次调用必须同时带 sandbox_permissions="danger-full-access" 和 justification="测试手机端审批卡：需要在沙箱外执行 echo 验证审批流程"。不要解释，直接调用工具。'); return true; } catch (e) { return String(e); } })()`,
      15000,
    );
    out.notes.push('approvalPrompt=sent');
    {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const s = await state(w);
        if ((s.approvals || 0) > 0) break;
        await wait(1000);
      }
    }
    const withApproval = await state(w);
    if ((withApproval.approvals || 0) > 0) {
      out.approvalShown = true;
      out.approvalCards = await evalJs(w, "document.querySelectorAll('#approval-slot .approval').length");
      await shot(w, '6-approval-card.png');
      await evalJs(
        w,
        "(function(){var c=document.querySelector('#approval-slot .approval'); if(!c) return false; var bs=c.querySelectorAll('button'); var allow=null; for(var i=0;i<bs.length;i++){ if(/允许/.test(bs[i].textContent||'')) allow=bs[i]; } if(allow){allow.click(); return true;} return false;})()",
      );
      let cleared = false;
      {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const s = await state(w);
          if ((s.approvals || 0) === 0) {
            cleared = true;
            break;
          }
          await wait(800);
        }
      }
      out.approvalAnswered = cleared;
      await shot(w, '7-approval-answered.png');
    } else {
      out.approvalNote = '90s 内模型没有发起需要审批的调用';
    }

    // ── chips：模型选择（放在最后：切模型会改全局默认，别影响前面的附件用例）──
    logStep('模型 chips');
    await evalJs(w, "(function(){var b=document.getElementById('chip-model'); if(b) b.click(); return true;})()");
    await wait(2500);
    out.modelOptions = await evalJs(w, "document.querySelectorAll('#model-list button.opt').length");
    await shot(w, '8-model-sheet.png');
    if (out.modelOptions > 0) {
      const clicked = await evalJs(
        w,
        "(function(){var bs=document.querySelectorAll('#model-list button.opt'); if(bs.length>1) bs[1].click(); else if(bs.length) bs[0].click(); return bs.length;})()",
      );
      out.notes.push('modelClicks=' + JSON.stringify(clicked));
      await wait(2500);
    }
    out.chipModelAfter = await evalJs(w, "(document.getElementById('chip-model')||{}).textContent || ''");
    await evalJs(w, "(function(){ if(window.__dshCloseSheets) window.__dshCloseSheets(); return true; })()");
    await shot(w, '9-chip-model.png');

    // 强度面板至少能打开并给出状态（没有强度选项也算通过，不算失败）
    await evalJs(w, "(function(){var b=document.getElementById('chip-effort'); if(b) b.click(); return true;})()");
    await wait(1500);
    out.effortOptions = await evalJs(w, "document.querySelectorAll('#effort-list button.opt').length");
    await evalJs(w, "(function(){ if(window.__dshCloseSheets) window.__dshCloseSheets(); return true; })()");

    // ── 模型能力预判：面板标出「不支持图片」，并在选图发送时**提前拦住**（不发出去）──
    logStep('模型能力预判（inputModalities）');
    await evalJs(w, "(function(){var b=document.getElementById('chip-model'); if(b) b.click(); return true;})()");
    await wait(3000);   // 等插件代查宿主 llm 后的徽标渲染
    out.capWarns = await evalJs(w, "document.querySelectorAll('#model-list .cap-warn').length");
    await shot(w, '11-caps-badge.png');
    if (typeof out.capWarns === 'number' && out.capWarns > 0) {
      await evalJs(
        w,
        "(function(){var bs=document.querySelectorAll('#model-list button.opt');for(var i=0;i<bs.length;i++){if(bs[i].querySelector('.cap-warn')){bs[i].click();return true;}}return false;})()",
      );
      await wait(2000);
      out.chipModelNoImage = await evalJs(w, "(document.getElementById('chip-model')||{}).textContent || ''");
      await evalJs(w, "(function(){ if(window.__dshCloseSheets) window.__dshCloseSheets(); return true; })()");
      out.capsGuard = await evalJs(
        w,
        `(async function(){
          var b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
          var bin = atob(b64); var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          var f = new File([bytes], 'caps-deny.png', { type: 'image/png' });
          var n = await window.__dshAttachFiles([f]);
          var before = (window.__dshState().turns || 0);
          var send = await window.dshMobileSend('E2E 模型能力预检拦截');
          var after = (window.__dshState().turns || 0);
          return { pending: n, send: send, before: before, after: after };
        })()`,
        20000,
      );
      await wait(800);
      out.capsGuardSheetShown = await evalJs(w, "!document.getElementById('sheet-model').hidden");
      out.capsGuardToast = await evalJs(w, "(document.getElementById('dsh-toast')||{}).textContent || ''");
      await shot(w, '12-caps-guard.png');
      await evalJs(w, "(function(){ if(window.__dshCloseSheets) window.__dshCloseSheets(); return true; })()");
    }

    // ── 「这个模型不支持图片」的引导（真实错误分类 + 自动弹模型面板）──
    logStep('模型不支持图片的引导');
    await evalJs(
      w,
      `(function(){ if(!window.__dshHandleSendFailure) return 'no-hook';
        window.__dshHandleSendFailure({ ok:false, prompt:{ error:{ code:'session/attachment-invalid', details:{ reason:'MODEL_DOES_NOT_SUPPORT_IMAGES' } } } });
        return 'called'; })()`,
    );
    await wait(900);
    out.imageModelHintShown = await evalJs(w, "!document.getElementById('sheet-model').hidden");
    out.imageModelHintToast = await evalJs(w, "(document.getElementById('dsh-toast')||{}).textContent || ''");
    await shot(w, '10-image-model-hint.png');
    await evalJs(w, "(function(){ if(window.__dshCloseSheets) window.__dshCloseSheets(); return true; })()");

    // ── 运行中「停止」按钮：桌面端跑的时候按钮变方块，手机端以前没有（真机反馈停不了）──
    logStep('停止按钮（运行中 → 方块 → 取消）');
    // 先等会话真的空闲（上一步的审批/发送可能还在跑，race 会让"空闲时是发送键"误判）
    for (let i = 0; i < 40; i += 1) {
      const st = await state(w);
      if (st.running !== true) break;
      await wait(500);
    }
    out.stopIdleAria = await evalJs(w, "document.getElementById('btn-send').getAttribute('aria-label')");
    await evalJs(w, "(function(){ if(window.__dshClearInput) window.__dshClearInput(); return true; })()");
    await selectVisionModel(w);
    await wait(1200);
    await evalJs(
      w,
      "(function(){ try { window.dshMobileSend('请立即调用 bash 工具执行 echo stop-button-e2e，这次调用必须带 sandbox_permissions=\"danger-full-access\" 和 justification=\"测试手机端停止按钮\"。不要解释，直接调用。'); return true; } catch(e){ return String(e); } })()",
    );
    let running = false;
    let stopSnap = null;
    for (let i = 0; i < 40; i += 1) {
      await wait(400);
      const raw = await evalJs(
        w,
        "(function(){var b=document.getElementById('btn-send');var s=window.__dshState?window.__dshState():{};return JSON.stringify({running:s.running===true,stop:b?b.classList.contains('stop'):false,aria:b?b.getAttribute('aria-label'):'',rect:!!(b&&b.querySelector('rect'))});})()",
        5000,
      );
      try {
        const snap = JSON.parse(raw);
        if (snap && snap.stop === true) { running = true; stopSnap = snap; break; }
        if (snap && snap.running === true) { running = true; stopSnap = snap; }
      } catch (e) {}
    }
    out.runningDetected = running;
    if (stopSnap) {
      out.stopAria = stopSnap.aria;
      out.stopClass = stopSnap.stop;
      out.stopHasRect = stopSnap.rect;
    }
    if (running) {
      // 排队消息 dock：跑着的时候再发一条 → 应进入「排队中」，且能编辑/删除（桌面端同款）
      // 先等上一条（触发审批的那条）离开队列，否则"删一条"可能删错对象
      for (let i = 0; i < 30; i += 1) {
        const st = await state(w);
        if ((st.queueCount || 0) === 0) break;
        await wait(500);
      }
      await evalJs(w, "(function(){ try { window.dshMobileSend('E2E 排队消息 A'); return true; } catch(e){ return String(e); } })()");
      let queued = false;
      for (let i = 0; i < 20; i += 1) {
        await wait(400);
        const st = await state(w);
        if ((st.queueCount || 0) >= 1) { queued = true; break; }
      }
      out.queueDetected = queued;
      if (queued) {
        out.queueDockVisible = await evalJs(w, "!document.getElementById('queue-dock').hidden");
        out.queueActionButtons = await evalJs(w, "document.querySelectorAll('#queue-dock .queue-acts button').length");
        out.queueTexts = await evalJs(w, "JSON.stringify((window.__dshState ? window.__dshState().queueTexts : []))");
        await shot(w, '16-queue-dock.png');
        // 编辑
        await evalJs(w, "(function(){var b=document.querySelector('#queue-dock .q-edit'); if(b) b.click(); return true;})()");
        await wait(400);
        out.queueEditOpened = await evalJs(w, "!!document.getElementById('queue-edit-input')");
        await evalJs(
          w,
          "(function(){var ta=document.getElementById('queue-edit-input'); if(!ta) return false; ta.value='E2E 排队消息 A（已编辑）'; var b=document.querySelector('#queue-dock button.save'); if(b) b.click(); return true;})()",
        );
        await wait(1200);
        out.queueEditedTexts = await evalJs(w, "JSON.stringify((window.__dshState ? window.__dshState().queueTexts : []))");
        // 删除：按文字定位那一条（队列里可能还有别的消息，不能盲点第一条）
        await evalJs(
          w,
          "(function(){var rows=document.querySelectorAll('#queue-dock .q-item');for(var i=0;i<rows.length;i++){if((rows[i].textContent||'').indexOf('E2E 排队消息 A')>=0){var b=rows[i].querySelector('.q-del');if(b){b.click();return true;}}}var b=document.querySelector('#queue-dock .q-del');if(b){b.click();return true;}return false;})()",
        );
        let removed = false;
        for (let i = 0; i < 20; i += 1) {
          await wait(400);
          const texts = await evalJs(w, "JSON.stringify((window.__dshState ? window.__dshState().queueTexts : []))");
          let list = [];
          try { list = JSON.parse(String(texts || '[]')); } catch (e) {}
          if (!list.some((t) => String(t).indexOf('E2E 排队消息 A') >= 0)) { removed = true; break; }
        }
        out.queueRemoved = removed;
        await shot(w, '17-queue-removed.png');
      }
      await shot(w, '15-stop-button.png');
      await evalJs(w, "(function(){ document.getElementById('btn-send').click(); return true; })()");
      let cleared = false;
      for (let i = 0; i < 30; i += 1) {
        await wait(600);
        const st = await state(w);
        if (st.running !== true) { cleared = true; break; }
      }
      out.stopCleared = cleared;
      await shot(w, '16-stop-cleared.png');
    }

    // ── 加号菜单（文件 + 斜杠指令）与权限预设：对齐桌面端 composer 的「+」/「权限」 ──
    logStep('加号菜单与权限预设');
    await evalJs(w, "(function(){var b=document.getElementById('btn-plus'); if(b) b.click(); return true;})()");
    await wait(1800);
    out.plusSheetVisible = await evalJs(w, "!document.getElementById('sheet-commands').hidden");
    out.commandRows = await evalJs(w, "document.querySelectorAll('#command-list button.opt').length");
    out.hasFileRow = await evalJs(w, "!!document.getElementById('cmd-file')");
    out.commandNames = await evalJs(w, "JSON.stringify(Array.prototype.slice.call(document.querySelectorAll('#command-list button.opt')).map(function(b){return b.getAttribute('data-command');}))");
    await shot(w, '18-plus-menu.png');

    // 权限面板
    await evalJs(w, "(function(){var b=document.querySelector('#command-list button[data-command=permission]'); if(b) b.click(); return true;})()");
    await wait(1600);
    out.permissionSheetVisible = await evalJs(w, "!document.getElementById('sheet-permission').hidden");
    out.permissionOptions = await evalJs(w, "document.querySelectorAll('#permission-list button.opt').length");
    out.permissionLabels = await evalJs(w, "JSON.stringify(Array.prototype.slice.call(document.querySelectorAll('#permission-list button.opt')).map(function(b){return b.textContent;}))");
    await shot(w, '19-permission-sheet.png');
    await evalJs(w, "(function(){var b=document.querySelector('#permission-list button[data-permission=read-only]'); if(b) b.click(); return true;})()");
    await wait(2000);
    out.permissionAfterReadOnly = (await state(w)).permission;
    // 恢复成完全权限（别把测试环境留在只读）
    await evalJs(w, "(function(){var b=document.getElementById('btn-plus'); if(b) b.click(); return true;})()");
    await wait(1200);
    await evalJs(w, "(function(){var b=document.querySelector('#command-list button[data-command=permission]'); if(b) b.click(); return true;})()");
    await wait(1400);
    await evalJs(w, "(function(){var b=document.querySelector('#permission-list button[data-permission=\"danger-full-access\"]'); if(b) b.click(); return true;})()");
    await wait(2000);
    out.permissionRestored = (await state(w)).permission;

    // 执行一条指令（压缩；内容太少可能返回 error，但不应崩）
    await evalJs(w, "(function(){ if(window.__dshCloseSheets) window.__dshCloseSheets(); var b=document.getElementById('btn-plus'); if(b) b.click(); return true;})()");
    await wait(1200);
    await evalJs(w, "(function(){var b=document.querySelector('#command-list button[data-command=compact]'); if(b) b.click(); return true;})()");
    await wait(2500);
    out.compactToast = await evalJs(w, "(document.getElementById('dsh-toast')||{}).textContent || ''");
    out.afterCommandJsError = await evalJs(w, "(document.getElementById('dsh-js-error')||{}).textContent || ''");

    // ── 我的页：连接状态 / 返回按钮 / 官网可点 / 版本 → 本版更新内容 ──
    logStep('我的页（连接状态/返回/官网/版本更新）');
    await evalJs(w, "(function(){ if(window.__dshMobile) window.__dshMobile.showPage('mine'); if(window.__dshRenderMine) window.__dshRenderMine(); return true; })()");
    await wait(1200);
    out.mineVisible = await evalJs(w, "!document.getElementById('page-mine').hidden");
    out.mineHasBackButton = await evalJs(w, "!!document.getElementById('mine-back')");
    out.mineRows = await evalJs(w, "document.querySelectorAll('#mine-list .mine-row').length");
    out.mineRowChevrons = await evalJs(
      w,
      "JSON.stringify(Array.prototype.slice.call(document.querySelectorAll('#mine-list .mine-row')).map(function(r){return {t:(r.querySelector('.mine-label')||{}).textContent,chev:!!r.querySelector('.mine-chev')};}))",
    );
    // 模型行点开模型面板
    await evalJs(w, "(function(){var rows=document.querySelectorAll('#mine-list .mine-row');for(var i=0;i<rows.length;i++){if(/模型/.test((rows[i].querySelector('.mine-label')||{}).textContent||'')){rows[i].click();return true;}}return false;})()");
    await wait(1200);
    out.mineModelSheet = await evalJs(w, "!document.getElementById('sheet-model').hidden");
    await evalJs(w, "(function(){ if(window.__dshCloseSheets) window.__dshCloseSheets(); return true; })()");
    // 强度行点开强度面板
    await evalJs(w, "(function(){var rows=document.querySelectorAll('#mine-list .mine-row');for(var i=0;i<rows.length;i++){if(/强度/.test((rows[i].querySelector('.mine-label')||{}).textContent||'')){rows[i].click();return true;}}return false;})()");
    await wait(1200);
    out.mineEffortSheet = await evalJs(w, "!document.getElementById('sheet-effort').hidden");
    await evalJs(w, "(function(){ if(window.__dshCloseSheets) window.__dshCloseSheets(); return true; })()");
    const mineState = await state(w);
    out.serverText = mineState.serverText || '';
    await shot(w, '20-mine.png');
    // 版本 → 本版更新
    await evalJs(w, "(function(){var rows=document.querySelectorAll('#mine-list .mine-row'); for(var i=0;i<rows.length;i++){ if(/版本/.test(rows[i].textContent||'')){ rows[i].click(); return true; } } return false; })()");
    await wait(1500);
    out.whatsnewSheet = await evalJs(w, "!document.getElementById('sheet-whatsnew').hidden");
    out.whatsnewItems = await evalJs(w, "document.querySelectorAll('#whatsnew-list .whatsnew-item').length");
    out.whatsnewTitle = await evalJs(w, "(document.querySelector('#whatsnew-list .whatsnew-title')||{}).textContent || ''");
    await shot(w, '21-whatsnew.png');
    await evalJs(w, "(function(){ if(window.__dshCloseSheets) window.__dshCloseSheets(); return true; })()");
    // 权限 chip
    out.permissionChipText = await evalJs(w, "(document.getElementById('chip-permission')||{}).textContent || ''");

    // ── 真机反馈过的三处样式回归：深色主题 body / 发送箭头实心 / 只有 3 个 composer chip ──
    logStep('主题与样式回归');
    out.chipCount = await evalJs(w, "document.querySelectorAll('.chips .chip').length");
    out.hasWsChip = await evalJs(w, "!!document.getElementById('chip-ws')");
    await evalJs(w, "(function(){ document.documentElement.setAttribute('data-theme','dark'); return true; })()");
    await wait(500);
    out.darkBodyBg = await evalJs(w, "getComputedStyle(document.body).backgroundColor");
    out.darkSendStroke = await evalJs(w, "getComputedStyle(document.querySelector('#btn-send path')).stroke");
    out.darkSendPath = await evalJs(w, "document.querySelector('#btn-send path').getAttribute('d') || ''");
    await shot(w, '13-dark-theme.png');
    await evalJs(w, "(function(){ document.documentElement.setAttribute('data-theme','light'); return true; })()");
    await wait(400);
    out.lightViewerBg = await evalJs(w, "getComputedStyle(document.getElementById('viewer')).backgroundColor");
    await shot(w, '14-light-theme.png');
    await evalJs(w, "(function(){ document.documentElement.removeAttribute('data-theme'); return true; })()");

    // ── JS 错误条 ──
    out.jsError = await evalJs(w, "(document.getElementById('dsh-js-error')||{}).textContent || ''");
    out.page = w.webContents.getURL();
    out.stateTimeouts = stateTimeouts;
    out.pageLogs = pageLogs.slice(-30);
  } catch (e) {
    out.fatal = String(e && e.message);
  }
  console.log('FEATURES_RESULT ' + JSON.stringify(out));
  app.exit(0);
});
