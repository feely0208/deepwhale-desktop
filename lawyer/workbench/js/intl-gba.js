/* =========================================================================
   intl-gba.js — 港澳大湾区专项：九市执业 · 港澳律师资质 · 合作区政策 · 合作登记
   -------------------------------------------------------------------------
   依据新《律师法》第六十二条：港澳法律执业者/执业律师通过粤港澳大湾区律师执业考试，
   取得内地资质后可在 广/深/珠/佛/惠/莞/中/江/肇 九市从事规定范围法律业务。
   说明：报名条件/执业范围由司法部规定，本地为参考知识 + 合作登记（localStorage）。
   ========================================================================= */
(function () {
  var LS = { coop: "intl-gba.coop" };
  var now = function () { return new Date(); };
  var dateStr = function (d) { d = d || now(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); };
  var byId = function (id) { return document.getElementById(id); };

  var CITIES = [
    { n: "广州", d: "省城与两岸三地法律资源集聚地；粤港澳大湾区核心引擎。" },
    { n: "深圳", d: "前海深港现代服务业合作区；跨境争议解决与涉外法律服务密度高。" },
    { n: "珠海", d: "横琴粤澳深度合作区；承接澳门多元产业与跨境事务。" },
    { n: "佛山", d: "制造业大市，涉外贸易与知识产权需求突出。" },
    { n: "惠州", d: "电子信息产业带，涉外合同/合规需求。" },
    { n: "东莞", d: "外贸制造强市，涉外劳动争议与贸易争端。" },
    { n: "中山", d: "珠西装备制造，跨境投资与贸易。" },
    { n: "江门", d: "侨乡，华侨涉外继承/婚姻家庭事务较多。" },
    { n: "肇庆", d: "珠三角西部节点，涉外基建与投资。" },
  ];
  var ZONES = [
    { k: "qianhai", n: "前海（深圳）", d: "深港现代服务业合作区；支持跨境执业、涉外法律人才引进、国际商事争议解决（前海法院/深圳国际仲裁院）。" },
    { k: "hengqin", n: "横琴（珠海）", d: "粤澳深度合作区；澳车北上、跨境产业与生活便利化、澳门法律人才来内地执业探索。" },
    { k: "nansha", n: "南沙（广州）", d: "粤港澳全面合作示范区；跨境贸易、航运、科技创新与国际商事调解/仲裁。" },
  ];
  var QUALIFY = [
    "考试由国务院司法行政部门组织（粤港澳大湾区律师执业考试）。",
    "适用对象：香港特别行政区法律执业者、澳门特别行政区执业律师。",
    "通过考试取得内地执业资质后，可在广东省广州、深圳、珠海、佛山、惠州、东莞、中山、江门、肇庆九市从事规定范围法律业务。",
    "报名条件、申请执业程序、执业范围等事项由司法部规定（以官方为准）。",
  ];
  var state = { tab: "cities" };
  function loadCoop() { try { var l = localStorage.getItem(LS.coop); var a = l ? JSON.parse(l) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function saveCoop(a) { try { localStorage.setItem(LS.coop, JSON.stringify(a)); } catch (e) { } }
  function aiGba(obj) {
    try { return (window.__callAI && window.__callAI("gba-lawyer", obj)) || "<p>（AI 桥未接）</p>"; }
    catch (e) { return "<p>AI 生成失败。</p>"; }
  }

  function render(container, title, sub) {
    var coop = loadCoop();
    var html =
      "<style>.intl-chip{background:rgba(127,127,127,.09);border-radius:999px;padding:4px 12px;font-size:12px;border:1px solid transparent;cursor:pointer}.intl-chip.on{background:linear-gradient(135deg,#4f8cff,#7aa8ff);color:#fff}.intl-note{font-size:12px;opacity:.62}.intl-sec{display:none}.intl-sec.on{display:block}.intl-city{padding:14px;border:1px solid rgba(127,127,127,.14);border-radius:14px;background:rgba(127,127,127,.04)}.intl-coop{padding:10px 0;border-bottom:1px solid rgba(127,127,127,.12);font-size:13px}</style>"
      + '<div class="page-head"><div><h1>' + esc(title) + "</h1><div class='sub'>" + esc(sub) + "</div></div></div>"
      + '<div class="tabs" style="margin-bottom:14px">'
      + [["cities", "大湾区 · 九市执业"], ["qualify", "港澳律师资质"], ["zones", "合作区政策"], ["coop", "合作登记(" + coop.length + ")"]]
        .map(function (t) { return '<button class="' + (state.tab === t[0] ? "active" : "") + '" data-tab="' + t[0] + '">' + t[1] + "</button>"; }).join("")
      + "</div>";

    // 九市
    html += '<div class="intl-sec' + (state.tab === "cities" ? " on" : "") + '" data-sec="cities"><div class="card glow"><div class="card-head"><h2>粤港澳大湾区 · 九市执业</h2><span class="badge badge-info">新《律师法》第六十二条</span></div>'
      + "<div class='intl-note' style='margin-bottom:12px'>港澳法律执业者通过大湾区律师执业考试取得内地资质后，可在以下九市从事规定范围法律业务：</div>"
      + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">'
      + CITIES.map(function (c) { return '<div class="intl-city"><b>' + esc(c.n) + "</b><p style='margin:6px 0 0;font-size:12px;opacity:.8'>" + esc(c.d) + "</p></div>"; }).join("") + "</div>"
      + '<div class="card-head" style="margin-top:16px"><h2>AI 指引</h2></div><div class="ai-box">' + aiGba({ type: "九市执业", target: "粤港澳大湾区九市" }) + "</div></div></div>";

    // 资质
    html += '<div class="intl-sec' + (state.tab === "qualify" ? " on" : "") + '" data-sec="qualify"><div class="card glow"><div class="card-head"><h2>港澳律师 · 大湾区执业资质指引</h2><span class="badge badge-info">以司法部规定为准</span></div>'
      + QUALIFY.map(function (q, i) { return '<div style="padding:9px 0;border-bottom:1px solid rgba(127,127,127,.1)"><b>' + (i + 1) + ".</b> " + esc(q) + "</div>"; }).join("") +
      "<div class='intl-note' style='margin-top:10px'>注：本地为要点参考，报名/执业范围/流程以司法部最新规定及官方公告为准。若你是香港/澳门执业者，建议咨询内地或港澳律师协会。</div></div></div>";

    // 合作区
    html += '<div class="intl-sec' + (state.tab === "zones" ? " on" : "") + '" data-sec="zones"><div class="card glow"><div class="card-head"><h2>合作区政策 · 跨境便利化</h2><span class="badge badge-info">参考</span></div>'
      + ZONES.map(function (z) { return '<div style="padding:12px 0;border-bottom:1px solid rgba(127,127,127,.1)"><b>' + esc(z.n) + "</b><p style='margin:6px 0 0;font-size:13px;opacity:.8'>" + esc(z.d) + "</p></div>"; }).join("") +
      "</div></div>";

    // 合作登记
    html += '<div class="intl-sec' + (state.tab === "coop" ? " on" : "") + '" data-sec="coop"><div class="card glow"><div class="card-head"><h2>湾区跨境协作登记</h2><span class="badge badge-info">本地留档</span></div>'
      + '<div class="doc-meta"><div class="mi"><b>港澳律师</b><span><input id="coName" class="intl-input" style="width:100%" placeholder="姓名 / 律所 / 资质"></span></div>'
      + '<div class="mi"><b>协作事项</b><span><input id="coItem" class="intl-input" style="width:100%" placeholder="如：涉外仲裁 / 跨境尽调 / 湾区诉讼"></span></div>'
      + '<div class="mi"><b>关联案件</b><span><input id="coCase" class="intl-input" style="width:100%" placeholder="案件/事项名称"></span></div>'
      + '<div class="mi"><b>状态</b><span><select id="coStatus" class="intl-input" style="width:100%"><option value="洽谈中">洽谈中</option><option value="合作中">合作中</option><option value="已结">已结</option></select></span></div></div>'
      + '<button class="btn btn-primary glow" id="coAdd">＋ 登记协作</button>'
      + '<div id="coList" style="margin-top:14px"></div></div></div>';

    container.innerHTML = html;
    bind(container);
  }

  function bind(container) {
    container.querySelectorAll("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.tab = b.getAttribute("data-tab");
        container.querySelectorAll("[data-sec]").forEach(function (s) { s.classList.toggle("on", s.getAttribute("data-sec") === state.tab); });
        container.querySelectorAll("[data-tab]").forEach(function (x) { x.classList.toggle("active", x === b); });
      });
    });
    var add = byId("coAdd"); if (add) add.addEventListener("click", function () { addCoop(container); });
    renderCoop(container);
  }
  function addCoop(container) {
    var name = (byId("coName") ? byId("coName").value : "").trim(), item = (byId("coItem") ? byId("coItem").value : "").trim(), c = (byId("coCase") ? byId("coCase").value : "").trim(), st = byId("coStatus") ? byId("coStatus").value : "洽谈中";
    if (!name) { alert("请填写港澳律师"); return; }
    var a = loadCoop(); a.unshift({ id: "c" + Date.now(), name: name, item: item, caseRef: c, status: st, date: dateStr() }); saveCoop(a);
    container.remove; render(container); if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已登记", "success");
  }
  function renderCoop(container) {
    var el = byId("coList"); if (!el) return;
    var a = loadCoop();
    if (!a.length) { el.innerHTML = "<div class='empty'>暂无协作登记。</div>"; return; }
    el.innerHTML = a.map(function (x) {
      return '<div class="intl-coop"><b>' + esc(x.name) + "</b>" + (x.item ? " · " + esc(x.item) : "") + (x.caseRef ? " · 关联：" + esc(x.caseRef) : "") +
        ' <span class="badge badge-info">' + esc(x.status) + "</span>" +
        '<span style="font-size:11px;opacity:.55;margin-left:8px">' + esc(x.date) + "</span>" +
        '<button class="btn btn-sm btn-ghost" data-cdel="' + x.id + '" style="float:right">删</button></div>';
    }).join("");
    el.querySelectorAll("[data-cdel]").forEach(function (b) {
      b.addEventListener("click", function () { var id = b.getAttribute("data-cdel"); if (!confirm("删除该登记？")) return; saveCoop(loadCoop().filter(function (x) { return x.id !== id; })); renderCoop(container); });
    });
  }

  window.IntlGba = { render: render, CITIES: CITIES, ZONES: ZONES, QUALIFY: QUALIFY };
})();
