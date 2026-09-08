/* =========================================================================
   intl-arb.js — 国际仲裁与跨境争议解决：机构对比 · 争议解决条款 · 程序节点 · 执行 · 涉案登记
   -------------------------------------------------------------------------
   涉外高频刚需：涉外商事争议的争议解决条款设计、国际仲裁程序管理、裁决/判决执行可行性。
   本地为参考知识 + 工具化生成 + 记录（localStorage）。
   ========================================================================= */
(function () {
  var LS = { cases: "intl-arb.cases", nodes: "intl-arb.nodes" };
  var now = function () { return new Date(); };
  var dateStr = function (d) { d = d || now(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); };
  var byId = function (id) { return document.getElementById(id); };
  var daysLeft = function (d) { var diff = Math.ceil((new Date(d) - now().setHours(0, 0, 0, 0)) / 86400000); return diff; };

  var INSTITUTIONS = [
    { n: "CIETAC 中国国际经济贸易仲裁委员会", place: "北京", lang: "中文/英文", d: "中国国际仲裁主力机构，涉外/国际商事仲裁经验丰富。" },
    { n: "SHIAC 上海国际经济贸易仲裁委员会", place: "上海", lang: "中/英", d: "国际化程度高，含自贸区、临港新片区争议解决。" },
    { n: "SCIA 深圳国际仲裁院", place: "深圳（前海）", lang: "中/英", d: "跨境/粤港澳特色，涉外仲裁改革先行。" },
    { n: "HKIAC 香港国际仲裁中心", place: "香港", lang: "英文/中文", d: "中立、认可度高，裁决在世界范围执行便利。" },
    { n: "SIAC 新加坡国际仲裁中心", place: "新加坡", lang: "英文", d: "高效、程序透明，在新加坡执行便利（商事枢纽）。" },
    { n: "ICC 国际商会仲裁院", place: "巴黎", lang: "英文/法文", d: "全球性机构，复杂跨国争议，程序成熟。" },
    { n: "LCIA 伦敦国际仲裁院", place: "伦敦", lang: "英文", d: "保密、灵活，条款精炼、程序高效。" },
  ];
  var ENFORCE = [
    { t: "《纽约公约》承认与执行", d: "中国为缔约国；外国仲裁裁决可在缔约国获承认与执行。申请需提交裁决正本/副本、仲裁协议等；法院审查注重正当程序与公共政策。" },
    { t: "外国法院判决承认与执行", d: "除互惠或相关国际条约外，通常需依互惠原则；可依《民事诉讼法》及双边司法协助条约办理。" },
    { t: "港澳台裁决/判决", d: "内地与香港/澳门有相互执行仲裁裁决、判决的安排（《内地与香港特别行政区相互执行仲裁裁决的安排》等）；依专门安排办理。" },
  ];
  var DEFAULT_NODES = [
    { id: "n1", label: "关注仲裁协议/管辖", date: dateStr(now()), done: true, note: "核对仲裁条款效力、仲裁机构与规则。" },
    { id: "n2", label: "提交仲裁通知/申请", date: dateStr(new Date(now().getTime() + 3 * 86400000)), done: false, note: "按机构规则提交仲裁申请材料。" },
    { id: "n3", label: "组庭/指定仲裁员", date: dateStr(new Date(now().getTime() + 10 * 86400000)), done: false, note: "核对仲裁员资格与回避情形。" },
    { id: "n4", label: "证据交换/听证", date: dateStr(new Date(now().getTime() + 30 * 86400000)), done: false, note: "涉外证据/证人/翻译准备。" },
    { id: "n5", label: "庭审", date: dateStr(new Date(now().getTime() + 45 * 86400000)), done: false, note: "涉外庭审语言与程序安排。" },
    { id: "n6", label: "裁决/后续执行", date: dateStr(new Date(now().getTime() + 75 * 86400000)), done: false, note: "裁决作出后评估承认与执行。" },
  ];
  var state = { tab: "institutions" };
  function load(k, def) { try { var l = localStorage.getItem(k); var a = l ? JSON.parse(l) : def; return Array.isArray(a) ? a : []; } catch (e) { return def; } }
  function save(k, a) { try { localStorage.setItem(k, JSON.stringify(a)); } catch (e) { } }
  var loadCases = function () { return load(LS.cases, []); };
  var saveCases = function (a) { save(LS.cases, a); };
  var loadNodes = function () { var a = load(LS.nodes, []); if (!a.length) save(LS.nodes, DEFAULT_NODES.map(function (x) { return Object.assign({}, x); })); return a.length ? a : DEFAULT_NODES; };
  var saveNodes = function (a) { save(LS.nodes, a); };
  function aiArb(obj) {
    try { return (window.__callAI && window.__callAI("intl-arbitration", obj)) || "<p>（AI 桥未接）</p>"; }
    catch (e) { return "<p>AI 生成失败。</p>"; }
  }
  function aiEnforce(obj) {
    try { return (window.__callAI && window.__callAI("foreign-judgment-enforcement", obj)) || "<p>（AI 桥未接）</p>"; }
    catch (e) { return "<p>AI 生成失败。</p>"; }
  }

  function render(container, title, sub) {
    var cases = loadCases(), nodes = loadNodes().slice();
    var html =
      "<style>.intl-chip{background:rgba(127,127,127,.09);border-radius:999px;padding:4px 12px;font-size:12px;border:1px solid transparent;cursor:pointer}.intl-chip.on{background:linear-gradient(135deg,#4f8cff,#7aa8ff);color:#fff}.intl-note{font-size:12px;opacity:.62}.intl-sec{display:none}.intl-sec.on{display:block}.intl-note{font-size:12px;opacity:.62}.intl-arb{padding:10px 0;border-bottom:1px solid rgba(127,127,127,.12);font-size:13px}</style>"
      + '<div class="page-head"><div><h1>' + esc(title) + "</h1><div class='sub'>" + esc(sub) + "</div></div></div>"
      + '<div class="tabs" style="margin-bottom:14px">'
      + [["institutions", "仲裁机构对比"], ["clause", "争议解决条款"], ["node", "程序节点"], ["enforce", "承认与执行"], ["cases", "涉案登记(" + cases.length + ")"]]
        .map(function (t) { return '<button class="' + (state.tab === t[0] ? "active" : "") + '" data-tab="' + t[0] + '">' + t[1] + "</button>"; }).join("")
      + "</div>";

    // 机构
    html += '<div class="intl-sec' + (state.tab === "institutions" ? " on" : "") + '" data-sec="institutions"><div class="card glow"><div class="card-head"><h2>国际仲裁机构对比</h2><span class="badge badge-info">参考 · 需按个案评估</span></div>'
      + '<table class="table"><thead><tr><th>机构</th><th>常用仲裁地</th><th>语言</th><th>特点</th></tr></thead><tbody>'
      + INSTITUTIONS.map(function (i) { return "<tr><td><b>" + esc(i.n) + "</b></td><td>" + esc(i.place) + "</td><td>" + esc(i.lang) + "</td><td>" + esc(i.d) + "</td></tr>"; }).join("") +
      "</tbody></table>"
      + '<div class="card-head" style="margin-top:14px"><h2>AI 选型建议</h2></div><div class="ai-box">' + aiArb({ type: "机构选型", target: "国际仲裁" }) + "</div></div></div>";

    // 条款
    html += '<div class="intl-sec' + (state.tab === "clause" ? " on" : "") + '" data-sec="clause"><div class="card glow"><div class="card-head"><h2> 争议解决条款助手</h2><span class="badge badge-info">双语生成</span></div>'
      + '<div class="doc-meta">'
      + '<div class="mi"><b>仲裁机构</b><span><select id="cInst" class="intl-input" style="width:100%">' + INSTITUTIONS.map(function (i) { return '<option value="' + esc(i.n) + '">' + esc(i.n) + "</option>"; }).join("") + "</select></span></div>"
      + '<div class="mi"><b>仲裁地</b><span><input id="cPlace" class="intl-input" style="width:100%" placeholder="如：香港 / 新加坡 / 上海"></span></div>'
      + '<div class="mi"><b>仲裁语言</b><span><input id="cLang" class="intl-input" style="width:100%" placeholder="如：英文 / 中文"></span></div>'
      + '<div class="mi"><b>仲裁庭</b><span><select id="cTribe" class="intl-input" style="width:100%"><option value="1">独任仲裁员</option><option value="3">三名仲裁员</option></select></span></div>'
      + '<div class="mi"><b>费用承担</b><span><select id="cCost" class="intl-input" style="width:100%"><option value="败诉方/依规则">败诉方承担 / 依规则</option><option value="各自承担">各自承担</option></select></span></div></div>'
      + '<button class="btn btn-primary glow" id="cGen"> 生成条款</button><div id="cOut" style="margin-top:12px"></div></div></div>';

    // 程序节点
    html += '<div class="intl-sec' + (state.tab === "node" ? " on" : "") + '" data-sec="node"><div class="card glow"><div class="card-head"><h2> 仲裁程序节点</h2><span class="badge badge-info">涉外 · 期限预警</span></div>'
      + '<div class="doc-meta"><div class="mi"><b>节点</b><span><input id="ndLabel" class="intl-input" style="width:100%" placeholder="如：提交仲裁申请"></span></div>'
      + '<div class="mi"><b>日期</b><span><input id="ndDate" type="date" class="intl-input" style="width:100%"></span></div>'
      + '<div class="mi"><b>备注</b><span><input id="ndNote" class="intl-input" style="width:100%" placeholder="可选"></span></div></div>'
      + '<button class="btn btn-sm btn-primary" id="ndAdd">＋ 添加节点</button>'
      + '<div id="ndList" style="margin-top:14px"></div></div></div>';

    // 执行
    html += '<div class="intl-sec' + (state.tab === "enforce" ? " on" : "") + '" data-sec="enforce"><div class="card glow"><div class="card-head"><h2> 承认与执行指引</h2><span class="badge badge-info">纽约公约 · 外判 · 港澳台</span></div>'
      + ENFORCE.map(function (e) { return '<div style="padding:12px 0;border-bottom:1px solid rgba(127,127,127,.1)"><b>' + esc(e.t) + "</b><p style='margin:6px 0 0;font-size:13px;opacity:.8'>" + esc(e.d) + "</p></div>"; }).join("") +
      '<div class="card-head" style="margin-top:14px"><h2>AI 执行可行性初判</h2></div><div class="ai-box">' + aiEnforce({ type: "执行初判", target: "涉外裁决/判决" }) + "</div></div></div>";

    // 涉案登记
    html += '<div class="intl-sec' + (state.tab === "cases" ? " on" : "") + '" data-sec="cases"><div class="card glow"><div class="card-head"><h2> 涉案登记</h2><span class="badge badge-info">本地留档</span></div>'
      + '<div class="doc-meta"><div class="mi"><b>案由/事项</b><span><input id="arTitle" class="intl-input" style="width:100%" placeholder="如：国际货物买卖争议"></span></div>'
      + '<div class="mi"><b>仲裁机构</b><span><input id="arInst" class="intl-input" style="width:100%" placeholder="机构"></span></div>'
      + '<div class="mi"><b>标的额</b><span><input id="arAmount" class="intl-input" style="width:100%" placeholder="如：USD 1,000,000"></span></div>'
      + '<div class="mi"><b>状态</b><span><select id="arStatus" class="intl-input" style="width:100%"><option value="准备中">准备中</option><option value="仲裁中">仲裁中</option><option value="已裁决">已裁决</option><option value="执行中">执行中</option></select></span></div></div>'
      + '<button class="btn btn-primary glow" id="arAdd">＋ 登记案件</button>'
      + '<div id="arList" style="margin-top:14px"></div></div></div>';

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
    var cg = byId("cGen"); if (cg) cg.addEventListener("click", function () { genClause(); });
    var na = byId("ndAdd"); if (na) na.addEventListener("click", function () { addNode(container); });
    var aa = byId("arAdd"); if (aa) aa.addEventListener("click", function () { addCase(container); });
    renderNodes(container); renderCases(container);
  }

  function genClause() {
    var inst = byId("cInst") ? byId("cInst").value : "", place = (byId("cPlace") ? byId("cPlace").value : "").trim(), lang = (byId("cLang") ? byId("cLang").value : "").trim(), tribe = byId("cTribe") ? byId("cTribe").value : "1", cost = byId("cCost") ? byId("cCost").value : "";
    var cn = "凡因本协议引起或与之有关的任何争议，均应提交" + (inst || "____仲裁机构") + "，按照申请仲裁时该会现行有效的仲裁规则进行仲裁。仲裁地为" + (place || "____") + "，仲裁语言为" + (lang || "____") + "。仲裁庭由" + (tribe === "3" ? "三名" : "一名") + "仲裁员组成。仲裁裁决为终局裁决，对双方均有约束力。仲裁费由" + (cost || "败诉方") + "承担。";
    var en = "Any dispute arising out of or in connection with this Agreement shall be submitted to " + (inst || "____") + " for arbitration in accordance with its arbitration rules in effect at the time of filing. The seat of arbitration shall be " + (place || "____") + ", and the language of the arbitration shall be " + (lang || "____") + ". The tribunal shall consist of " + (tribe === "3" ? "three" : "one") + " arbitrator(s). The award shall be final and binding on both parties. The arbitration costs shall be borne by " + (cost || "the losing party") + ".";
    var out = byId("cOut");
    if (out) out.innerHTML = '<div class="ai-box"><b>中文</b><p style="margin:6px 0">' + esc(cn) + '</p><hr style="border:none;border-top:1px solid rgba(127,127,127,.15)"><b>English</b><p style="margin:6px 0">' + esc(en) + "</p><br><button class='btn btn-sm btn-ghost' id='cCopy'> 复制条款</button></div>";
    var cc = byId("cCopy"); if (cc) cc.addEventListener("click", function () { try { navigator.clipboard.writeText(cn + "\n\n" + en); } catch (e) { } if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已复制", "success"); });
  }
  function addNode(container) {
    var label = (byId("ndLabel") ? byId("ndLabel").value : "").trim(), date = (byId("ndDate") ? byId("ndDate").value : "").trim(), note = (byId("ndNote") ? byId("ndNote").value : "").trim();
    if (!label) { alert("请填写节点"); return; }
    var a = loadNodes(); a.push({ id: "n" + Date.now(), label: label, date: date || dateStr(), note: note, done: false }); saveNodes(a); renderNodes(container);
  }
  function renderNodes(container) {
    var el = byId("ndList"); if (!el) return;
    var a = loadNodes().slice().sort(function (x, y) { return new Date(x.date) - new Date(y.date); });
    el.innerHTML = a.map(function (x) {
      var dl = daysLeft(x.date);
      var badge = dl < 0 ? '<span class="badge badge-success">已到期/逾期</span>' : (dl <= 3 ? '<span class="badge badge-warning">' + dl + " 天</span>" : '<span class="badge badge-info">' + dl + " 天</span>");
      return '<div class="intl-arb"><span style="' + (x.done ? "text-decoration:line-through;opacity:.6" : "") + '">' + esc(x.label) + "</span>" +
        '<span style="font-size:12px;opacity:.7;margin-left:10px">' + esc(x.date) + "</span> " + badge +
        (x.note ? '<div style="font-size:12px;opacity:.65">' + esc(x.note) + "</div>" : "") +
        '<button class="btn btn-sm btn-ghost" data-ndone="' + x.id + '" style="float:right">' + (x.done ? "" : "") + "</button>" +
        '<button class="btn btn-sm btn-ghost" data-ndel="' + x.id + '" style="float:right">删</button></div>';
    }).join("");
    el.querySelectorAll("[data-ndone]").forEach(function (b) { b.addEventListener("click", function () { var id = b.getAttribute("data-ndone"); var a2 = loadNodes().map(function (x) { return x.id === id ? Object.assign({}, x, { done: !x.done }) : x; }); saveNodes(a2); renderNodes(container); }); });
    el.querySelectorAll("[data-ndel]").forEach(function (b) { b.addEventListener("click", function () { var id = b.getAttribute("data-ndel"); if (!confirm("删除该节点？")) return; saveNodes(loadNodes().filter(function (x) { return x.id !== id; })); renderNodes(container); }); });
  }
  function addCase(container) {
    var title = (byId("arTitle") ? byId("arTitle").value : "").trim(), inst = (byId("arInst") ? byId("arInst").value : "").trim(), amt = (byId("arAmount") ? byId("arAmount").value : "").trim(), st = byId("arStatus") ? byId("arStatus").value : "准备中";
    if (!title) { alert("请填写案由"); return; }
    var a = loadCases(); a.unshift({ id: "a" + Date.now(), title: title, inst: inst, amount: amt, status: st, date: dateStr() }); saveCases(a); renderCases(container); if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已登记", "success");
  }
  function renderCases(container) {
    var el = byId("arList"); if (!el) return;
    var a = loadCases();
    if (!a.length) { el.innerHTML = "<div class='empty'>暂无涉案登记。</div>"; return; }
    el.innerHTML = a.map(function (x) {
      return '<div class="intl-arb"><b>' + esc(x.title) + "</b>" + (x.inst ? " · " + esc(x.inst) : "") + (x.amount ? " · " + esc(x.amount) : "") +
        ' <span class="badge badge-info">' + esc(x.status) + "</span>" +
        '<span style="font-size:11px;opacity:.55;margin-left:8px">' + esc(x.date) + "</span>" +
        '<button class="btn btn-sm btn-ghost" data-adel="' + x.id + '" style="float:right">删</button></div>';
    }).join("");
    el.querySelectorAll("[data-adel]").forEach(function (b) { b.addEventListener("click", function () { var id = b.getAttribute("data-adel"); if (!confirm("删除该登记？")) return; saveCases(loadCases().filter(function (x) { return x.id !== id; })); renderCases(container); }); });
  }

  window.IntlArb = { render: render, INSTITUTIONS: INSTITUTIONS, ENFORCE: ENFORCE };
})();
