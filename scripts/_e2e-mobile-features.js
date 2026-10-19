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

const evalJs = (w, code) => w.webContents.executeJavaScript(code).catch((e) => JSON.stringify({ error: String(e.message).slice(0, 200) }));
const shot = async (w, name) => {
  try {
    fs.writeFileSync(path.join(SHOTS, name), (await w.webContents.capturePage()).toPNG());
  } catch (e) {}
};
const state = async (w) => {
  const raw = await evalJs(w, 'JSON.stringify(window.__dshState ? window.__dshState() : {})');
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

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
  try {
    await w.loadURL(`${BASE}/?token=${TOKEN}`); // 拿 DSH cookie
    await wait(1200);
    await w.loadURL(`${BASE}/mobile/`); // 我们插件的手机端界面
    await wait(3000);
    await shot(w, '1-list.png');

    // ── 列表页 ──
    out.rows = await evalJs(w, "document.querySelectorAll('.row-btn').length");
    out.notes.push('rows=' + out.rows);

    // ── 进入最近一个会话（附件断言建的那个）──
    await evalJs(w, "(function(){var b=document.querySelector('.row-btn'); if(b) b.click(); return !!b;})()");
    await wait(3500);
    // 等聊天内容
    for (let i = 0; i < 30; i += 1) {
      const s = await state(w);
      if ((s.msgs || 0) >= 2) break;
      await wait(500);
    }
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
    await shot(w, '4-trace-tab.png');
    await evalJs(w, "(function(){var c=document.getElementById('tab-chat'); if(c) c.click(); return true;})()");
    await wait(800);

    // ── chips：模型选择 ──
    await evalJs(w, "(function(){var b=document.getElementById('chip-model'); if(b) b.click(); return true;})()");
    await wait(2500);
    out.modelOptions = await evalJs(w, "document.querySelectorAll('#model-list button.opt').length");
    await shot(w, '5-model-sheet.png');
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
    await shot(w, '6-chip-model.png');

    // 强度面板至少能打开并给出状态（没有强度选项也算通过，不算失败）
    await evalJs(w, "(function(){var b=document.getElementById('chip-effort'); if(b) b.click(); return true;})()");
    await wait(1500);
    out.effortOptions = await evalJs(w, "document.querySelectorAll('#effort-list button.opt').length");
    await evalJs(w, "(function(){ if(window.__dshCloseSheets) window.__dshCloseSheets(); return true; })()");

    // ── 界面里带附件发送（真发）──
    const before = await state(w);
    const sendResult = await evalJs(
      w,
      `(function(){
        var b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        var bin = atob(b64); var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        var f = new File([arr], 'e2e-shot.png', { type: 'image/png' });
        return window.__dshAttachFiles([f]).then(function (n) {
          return window.dshMobileSend('E2E 手机端带附件发送').then(function (r) { return { pending: n, send: r }; });
        });
      })()`,
    );
    out.notes.push('send=' + JSON.stringify(sendResult).slice(0, 300));
    let sent = false;
    for (let i = 0; i < 90; i += 1) {
      const s = await state(w);
      if ((s.turns || 0) > (before.turns || 0)) {
        sent = true;
        break;
      }
      await wait(1000);
    }
    out.attachmentSent = sent;
    await wait(1500);
    out.chatMsgsAfterSend = await evalJs(w, "document.querySelectorAll('#page-chat .msg').length");
    await shot(w, '7-attachment-sent.png');

    // ── 手机审批卡：让模型发起一次需要审批的调用 ──
    const beforeApproval = await state(w);
    const promptResult = await evalJs(
      w,
      `window.dshMobileSend('请立即用 bash 工具执行 echo mobile-ui-approval，并且这次调用一定要带上 sandbox_permissions 参数（值用 workspace-write）。不要解释，直接调用工具。')`,
    );
    out.notes.push('approvalPrompt=' + JSON.stringify(promptResult).slice(0, 200));
    void beforeApproval;
    for (let i = 0; i < 120; i += 1) {
      const s = await state(w);
      if ((s.approvals || 0) > 0) break;
      await wait(1000);
    }
    const withApproval = await state(w);
    if ((withApproval.approvals || 0) > 0) {
      out.approvalShown = true;
      out.approvalCards = await evalJs(w, "document.querySelectorAll('#approval-slot .approval').length");
      await shot(w, '8-approval-card.png');
      await evalJs(
        w,
        "(function(){var c=document.querySelector('#approval-slot .approval'); if(!c) return false; var bs=c.querySelectorAll('button'); var allow=null; for(var i=0;i<bs.length;i++){ if(/允许/.test(bs[i].textContent||'')) allow=bs[i]; } if(allow){allow.click(); return true;} return false;})()",
      );
      let cleared = false;
      for (let i = 0; i < 40; i += 1) {
        const s = await state(w);
        if ((s.approvals || 0) === 0) {
          cleared = true;
          break;
        }
        await wait(800);
      }
      out.approvalAnswered = cleared;
      await shot(w, '9-approval-answered.png');
    } else {
      out.approvalNote = '90s 内模型没有发起需要审批的调用';
    }

    // ── JS 错误条 ──
    out.jsError = await evalJs(w, "(document.getElementById('dsh-js-error')||{}).textContent || ''");
    out.page = w.webContents.getURL();
  } catch (e) {
    out.fatal = String(e && e.message);
  }
  console.log('FEATURES_RESULT ' + JSON.stringify(out));
  app.exit(0);
});
