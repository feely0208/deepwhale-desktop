/* =========================================================================
   intl-docs.js — 涉外双语文书：模板库 + 生成/编辑 + 法律翻译 + 认证指引 + 已生成
   -------------------------------------------------------------------------
   P0·高频。沿现有「文书管理」思路，加【语言】维度：中英双栏模板、生成、AI 翻译/润色、
   打印/复制导出、公证/认证/海牙认证指引。产出存本地（localStorage）。
   ========================================================================= */
(function () {
  var LS = { saved: "intl-docs.saved" };
  var now = function () { return new Date(); };
  var dateStr = function (d) { d = d || now(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); };
  var byId = function (id) { return document.getElementById(id); };

  // —— 双语文书模板库（示例骨架；正式以实际模板为准） ——
  var TEMPLATES = [
    { id: "nda", name: "跨境保密协议", en: "Mutual Non-Disclosure Agreement", intro: "跨境商务/尽调前置保密安排。", bodyCn: ["本协议由以下双方就保密信息披露事项达成一致：", "接收方应对披露方提供的保密信息承担保密义务。", "保密义务自本协议签署之日起生效，期限两年。"], bodyEn: ["This Agreement is entered into between the following parties regarding confidential information.", "The Receiving Party shall keep the confidential information provided by the Disclosing Party in confidence.", "This obligation takes effect upon signature and continues for two years."] },
    { id: "poa", name: "授权委托书（域外使用）", en: "Power of Attorney (for use abroad)", intro: "涉外诉讼/仲裁/公证认证的授权委托。", bodyCn: ["委托人现委托受托人作为代理人，办理下列事项：", "代理人权限包括：代为立案、举证、出庭、调解、和解、签收法律文书等。"], bodyEn: ["The Principal hereby appoints the Agent to handle the following matters.", "The Agent is authorized to file, present evidence, appear in court, mediate, settle, and sign legal documents."] },
    { id: "complaint", name: "涉外民事起诉状", en: "Foreign-related Civil Complaint", intro: "涉外民事一审起诉状骨架。", bodyCn: ["原告：____；住所地：____；法定代表人：____。", "诉讼请求：1) ____；2) ____。", "事实与理由：____。"], bodyEn: ["Plaintiff: ____; Domicile: ____; Legal representative: ____.", "Claims: 1) ____; 2) ____.", "Facts and grounds: ____."] },
    { id: "arb", name: "仲裁申请书", en: "Arbitration Application", intro: "涉外/国际仲裁申请书骨架。", bodyCn: ["申请人：____；被申请人：____。", "仲裁请求：1) ____；2) ____。", "事实与理由：____。仲裁依据：____。"], bodyEn: ["Claimant: ____; Respondent: ____.", "Arbitration claims: 1) ____; 2) ____.", "Facts and grounds: ____. Arbitration basis: ____."] },
    { id: "opinion", name: "法律意见书", en: "Legal Opinion", intro: "涉外交易/合规法律意见书骨架。", bodyCn: ["致：____。", "我们就____出具如下法律意见：", "一、____；二、____；三、结论与建议。"], bodyEn: ["To: ____.", "We hereby issue this opinion regarding ____.", "I. ____; II. ____; III. Conclusion and recommendations."] },
    { id: "guarantee", name: "涉外担保函", en: "Cross-border Guarantee Letter", intro: "跨境担保/履约担保文件。", bodyCn: ["担保人：____。", "担保范围：____；担保方式：连带责任保证。", "本担保函适用____法律。"], bodyEn: ["Guarantor: ____.", "Scope: ____; Method: joint and several liability.", "This guarantee is governed by ____ law."] },
  ];

  // —— 认证/公证/海牙认证指引（参考） ——
  var CERT_GUIDE = [
    { k: "notary", t: "公证", d: "境内文件涉外公证书：由公证处办理，确认签名/印鉴/文件真实性。" },
    { k: "legalize", t: "领事认证", d: "公证书外交部或地方外办认证目的国驻华使领馆认证（适用非海牙公约成员）。" },
    { k: "apostille", t: "海牙认证(Apostille)", d: "中国已加入《取消外国公文书认证要求的公约》(海牙公约)，部分文件仅需附加证明书(Apostille)，免领事认证。" },
    { k: "dual", t: "中英对照", d: "涉外文件建议中英对照并公证翻译；术语一致、份数/份数核对。" },
  ];

  var state = { tab: "library", current: null, mode: "cn" };
  function loadSaved() { try { var l = localStorage.getItem(LS.saved); var a = l ? JSON.parse(l) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function saveSaved(a) { try { localStorage.setItem(LS.saved, JSON.stringify(a)); } catch (e) { } }
  function aiTranslate(text, dir) {
    try { return (window.__callAI && window.__callAI("legal-translation", { text: text, dir: dir })) || "<p>（AI 桥未接）</p>"; }
    catch (e) { return "<p>AI 生成失败。</p>"; }
  }
  function aiPolish(text) {
    try { return (window.__callAI && window.__callAI("legal-polish", { text: text })) || "<p>（AI 桥未接）</p>"; }
    catch (e) { return "<p>AI 生成失败。</p>"; }
  }

  function render(container, title, sub) {
    var saved = loadSaved();
    var html =
      "<style>.intl-chip{background:rgba(127,127,127,.09);border-radius:999px;padding:4px 12px;font-size:12px;border:1px solid transparent;cursor:pointer}.intl-chip.on{background:linear-gradient(135deg,#4f8cff,#7aa8ff);color:#fff}.intl-note{font-size:12px;opacity:.62}.intl-sec{display:none}.intl-sec.on{display:block}.intl-two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.intl-ta{width:100%;min-height:180px;resize:vertical;border-radius:10px;border:1px solid rgba(127,127,127,.25);background:rgba(127,127,127,.05);color:inherit;font-family:inherit;font-size:13px;padding:10px}.intl-saved{display:block;padding:10px 0;border-bottom:1px solid rgba(127,127,127,.12);font-size:13px}</style>"
      + '<div class="page-head"><div><h1>' + esc(title) + "</h1><div class='sub'>" + esc(sub) + "</div></div></div>"
      + '<div class="tabs" style="margin-bottom:14px">'
      + [["library", "双语模板库"], ["gen", "生成 / 编辑"], ["trans", "法律翻译"], ["cert", "认证指引"], ["saved", "已生成(" + saved.length + ")"]].
        map(function (t) { return '<button class="' + (state.tab === t[0] ? "active" : "") + '" data-tab="' + t[0] + '">' + t[1] + "</button>"; }).join("")
      + "</div>";

    // 模板库
    html += '<div class="intl-sec' + (state.tab === "library" ? " on" : "") + '" data-sec="library"><div class="card glow"><div class="card-head"><h2>涉外双语文书模板库</h2><span class="badge badge-info">中英对照 · 点击生成</span></div>'
      + TEMPLATES.map(function (t) { return '<div class="intl-saved">' +
        '<span class="link" data-open="' + t.id + '" style="font-weight:600">' + esc(t.name) + "</span>" +
        '<span style="font-size:11px;opacity:.6;margin-left:8px">' + esc(t.en) + "</span>" +
        '<div class="tl-meta" style="font-size:12px;opacity:.7">' + esc(t.intro) + "</div>" +
        '<div style="margin-top:6px"><button class="btn btn-sm btn-primary" data-use="' + t.id + '"> 生成</button></div></div>'; }).join("") +
      "</div></div>";

    // 生成/编辑
    html += '<div class="intl-sec' + (state.tab === "gen" ? " on" : "") + '" data-sec="gen"><div class="card glow" id="genWrap"><div class="card-head"><h2> 生成 / 编辑</h2><span class="badge badge-info">中英双栏 · 可编辑</span></div>'
      + '<div class="intl-note" style="margin-bottom:10px">' + (TEMPLATES.find(function (t) { return t.id === state.current; }) ? "当前模板：" + esc(TEMPLATES.find(function (t) { return t.id === state.current; }).name) : "请先在『双语模板库』选择一个模板生成") + "</div>"
      + '<div class="intl-two" id="genEdit"><div><div style="font-weight:600;margin-bottom:6px">中文</div><textarea id="gCn" class="intl-ta"></textarea></div>'
      + '<div><div style="font-weight:600;margin-bottom:6px">English</div><textarea id="gEn" class="intl-ta"></textarea></div></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">'
      + '<button class="btn btn-sm btn-ghost" id="gTrans"> 中英 翻译</button>'
      + '<button class="btn btn-sm btn-ghost" id="gPolish"> AI 润色校对</button>'
      + '<button class="btn btn-sm btn-ghost" id="gPrint"> 打印/PDF</button>'
      + '<button class="btn btn-sm btn-ghost" id="gCopy"> 复制</button>'
      + '<button class="btn btn-sm btn-primary" id="gSave"> 保存</button>'
      + "</div><div id='genOut' style='margin-top:10px'></div></div></div>";

    // 法律翻译
    html += '<div class="intl-sec' + (state.tab === "trans" ? " on" : "") + '" data-sec="trans"><div class="card glow"><div class="card-head"><h2> 法律翻译</h2><span class="badge badge-info">中英术语一致 · 可编辑</span></div>'
      + '<div class="intl-two"><div><div style="font-weight:600;margin-bottom:6px">文本</div><textarea id="tSrc" class="intl-ta" placeholder="粘贴中文或英文法律文本…"></textarea></div>'
      + '<div><div style="font-weight:600;margin-bottom:6px">译文</div><textarea id="tDst" class="intl-ta" placeholder="译文将显示在这里"></textarea></div></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">'
      + '<button class="btn btn-sm btn-primary" id="tToEn">中  英</button>'
      + '<button class="btn btn-sm btn-ghost" id="tToCn">英  中</button>'
      + "</div>"
      + '<div class="card-head" style="margin-top:14px"><h2> 中英法律术语对照（常用）</h2></div>'
      + '<div class="doc-meta"><div class="mi"><b>诉讼</b><span>起诉状 complaint · 答辩状 statement of defense · 证据 evidence · 一审 first instance</span></div>'
      + '<div class="mi"><b>仲裁</b><span>仲裁申请书 application for arbitration · 仲裁庭 tribunal · 裁决 award · 承认与执行 recognition & enforcement</span></div>'
      + '<div class="mi"><b>交易</b><span>保密协议 NDA · 违约 breach · 准据法 governing law · 争议解决 dispute resolution</span></div></div>'
      + "<div id='tOut' style='margin-top:10px'></div></div></div>";

    // 认证指引
    html += '<div class="intl-sec' + (state.tab === "cert" ? " on" : "") + '" data-sec="cert"><div class="card glow"><div class="card-head"><h2> 公证 / 认证 / 海牙认证指引</h2><span class="badge badge-info">参考 · 以当地要求为准</span></div>'
      + CERT_GUIDE.map(function (c) { return '<div style="padding:10px 0;border-bottom:1px solid rgba(127,127,127,.1)"><b>' + esc(c.t) + "</b>：" + esc(c.d) + "</div>"; }).join("") +
      "<div class='intl-note' style='margin-top:10px'>海牙公约适用与否、认证要求视目的国而定，务必提前核实，避免文件因认证瑕疵被拒。</div></div></div>";

    // 已生成
    html += '<div class="intl-sec' + (state.tab === "saved" ? " on" : "") + '" data-sec="saved"><div class="card glow"><div class="card-head"><h2>已生成双语文书（' + saved.length + "）</h2><span class=\"badge badge-info\">本地留档</span></div>"
      + (saved.length ? saved.map(function (s) { return '<div class="intl-saved">' +
        '<span style="font-weight:600">' + esc(s.name) + "</span>" +
        '<span style="font-size:11px;opacity:.6;margin-left:8px">' + esc(s.date) + "</span>" +
        '<div style="margin-top:6px"><button class="btn btn-sm btn-ghost" data-view="' + s.id + '">预览</button> <button class="btn btn-sm btn-ghost" data-dels="' + s.id + '">删除</button></div>'
        + '<div class="intl-box" data-b="' + s.id + '" style="display:none"></div></div>'; }).join("") : '<div class="empty">尚未保存双语文书。</div>') +
      "</div></div>";

    container.innerHTML = html;
    bind(container);
    if (state.tab === "gen" && state.current) prefillGen(container);
  }

  function bind(container) {
    container.querySelectorAll("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.tab = b.getAttribute("data-tab");
        container.querySelectorAll("[data-sec]").forEach(function (s) { s.classList.toggle("on", s.getAttribute("data-sec") === state.tab); });
        container.querySelectorAll("[data-tab]").forEach(function (x) { x.classList.toggle("active", x === b); });
        if (state.tab === "gen" && state.current) prefillGen(container);
      });
    });
    container.querySelectorAll("[data-use]").forEach(function (b) {
      b.addEventListener("click", function () { state.current = b.getAttribute("data-use"); state.tab = "gen"; switchTabAndRender(container, "gen"); });
    });
    container.querySelectorAll("[data-open]").forEach(function (b) {
      b.addEventListener("click", function () {
        var t = TEMPLATES.find(function (x) { return x.id === b.getAttribute("data-open"); });
        var box = container.querySelector('[data-b="' + t.id + '"]'); // reuse
      });
    });
    var gTrans = byId("gTrans"); if (gTrans) gTrans.addEventListener("click", function () { var cn = byId("gCn").value; var en = byId("gEn"); if (en) en.value = aiTranslate(cn, "cn-en").replace(/<[^>]+>/g, ""); setGenOut(byId("genOut"), "中英翻译（骨架·待 LLM 接入后为准）"); });
    var gPolish = byId("gPolish"); if (gPolish) gPolish.addEventListener("click", function () { var cn = byId("gCn").value; setGenOut(byId("genOut"), aiPolish(cn)); });
    var gPrint = byId("gPrint"); if (gPrint) gPrint.addEventListener("click", function () { printGen(); });
    var gCopy = byId("gCopy"); if (gCopy) gCopy.addEventListener("click", function () { var v = (byId("gCn") ? byId("gCn").value : "") + "\n\n==========\n\n" + (byId("gEn") ? byId("gEn").value : ""); try { navigator.clipboard.writeText(v); setGenOut(byId("genOut"), "已复制到剪贴板"); } catch (e) { setGenOut(byId("genOut"), "复制失败（请手动复制）"); } });
    var gSave = byId("gSave"); if (gSave) gSave.addEventListener("click", function () { saveGen(container); });
    var tToEn = byId("tToEn"); if (tToEn) tToEn.addEventListener("click", function () { var d = byId("tDst"); if (d) d.value = aiTranslate((byId("tSrc") || { value: "" }).value, "cn-en").replace(/<[^>]+>/g, ""); setGenOut(byId("tOut"), "已生成译文（骨架·待 LLM 接入后为准）"); });
    var tToCn = byId("tToCn"); if (tToCn) tToCn.addEventListener("click", function () { var d = byId("tDst"); if (d) d.value = aiTranslate((byId("tSrc") || { value: "" }).value, "en-cn").replace(/<[^>]+>/g, ""); setGenOut(byId("tOut"), "已生成译文（骨架·待 LLM 接入后为准）"); });
    container.querySelectorAll("[data-view]").forEach(function (b) {
      b.addEventListener("click", function () { var id = b.getAttribute("data-view"); var s = loadSaved().find(function (x) { return x.id === id; }); var box = container.querySelector('[data-b="' + id + '"]'); if (box) { box.style.display = "block"; box.innerHTML = viewHtml(s); } });
    });
    container.querySelectorAll("[data-dels]").forEach(function (b) {
      b.addEventListener("click", function () { var id = b.getAttribute("data-dels"); if (!confirm("删除该文书？")) return; saveSaved(loadSaved().filter(function (x) { return x.id !== id; })); render(container); if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已删除", "success"); });
    });
  }

  function switchTabAndRender(container, tab) { state.tab = tab; render(container); }

  function prefillGen(container) {
    var t = TEMPLATES.find(function (x) { return x.id === state.current; }); if (!t) return;
    var cn = byId("gCn"), en = byId("gEn");
    if (cn) { cn.value = t.bodyCn.join("\n\n"); }
    if (en) { en.value = t.bodyEn.join("\n\n"); }
  }
  function setGenOut(el, msg) { if (!el) return; el.innerHTML = '<div class="ai-box">' + esc(msg) + "</div>"; }
  function saveGen(container) {
    var t = TEMPLATES.find(function (x) { return x.id === state.current; });
    var cnv = (byId("gCn") || { value: "" }).value, env = (byId("gEn") || { value: "" }).value;
    if (!cnv && !env) { alert("内容为空"); return; }
    var s = { id: "d" + Date.now(), name: t ? t.name : "未命名双语文书", date: dateStr(), cn: cnv, en: env };
    var a = loadSaved(); a.unshift(s); saveSaved(a); render(container);
    if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已保存", "success");
  }
  function viewHtml(s) {
    if (!s) return "<div class='empty'>未找到</div>";
    return '<div class="ai-box"><b>' + esc(s.name) + "</b>（" + esc(s.date) + "）<br><br>" +
      "<b>中文</b><br><pre style='white-space:pre-wrap;font-family:inherit;font-size:13px;margin:6px 0'>" + esc(s.cn) + "</pre>" +
      "<b>English</b><br><pre style='white-space:pre-wrap;font-family:inherit;font-size:13px;margin:6px 0'>" + esc(s.en) + "</pre></div>";
  }
  function printGen() {
    var w = window.open("", "_blank");
    if (!w) { alert("请允许弹出窗口以打印"); return; }
    var cn = (byId("gCn") || { value: "" }).value, en = (byId("gEn") || { value: "" }).value;
    w.document.write("<html><head><title>双语文书</title><style>body{font-family:SimSun,'Songti SC',serif;font-size:14px;line-height:1.9;padding:40px}h1{font-size:20px;text-align:center}</style></head><body><h1>双语文书</h1><h2>中文</h2><pre style='white-space:pre-wrap;font-family:inherit'>" + esc(cn) + "</pre><h2>English</h2><pre style='white-space:pre-wrap;font-family:inherit'>" + esc(en) + "</pre></body></html>");
    w.document.close(); setTimeout(function () { w.focus(); w.print(); }, 300);
  }

  window.IntlDocs = { render: render, TEMPLATES: TEMPLATES };
})();
