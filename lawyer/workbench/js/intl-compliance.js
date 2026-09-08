/* =========================================================================
   intl-compliance.js — 涉外合规筛查：清单筛查 + 物项筛查 + 交易体检 + 数据出境评估
   -------------------------------------------------------------------------
   对应新《律师法》第七条「涉外法律服务业」；商业化定位=P0 刚需/卖点。
   原型策略：浏览器无法直连官方清单 API（OFAC/商务部管控名单等），故前端用
   【示例筛查库 + 规则匹配】跑通「筛查-风险-建议-AI 备忘录」闭环；并支持导入本地清单
   与留存筛查记录（localStorage）。生产应由后端接官方实时清单/API 并做合规库。
   ========================================================================= */
(function () {
  var LS = { log: "intl-compliance.log", list: "intl-compliance.list" };

  var now = function () { return new Date(); };
  var dateStr = function (d) { d = d || now(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  var fmt = function (d) { return dateStr(new Date(d)); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); };
  var byId = function (id) { return document.getElementById(id); };

  // —— 示例筛查清单（需替换为官方实时清单 API：OFAC/出口管制/不可靠实体/数据出境白名单等） ——
  var SCREENING_DB = [
    { name: "示例·XX国际贸易公司", country: "某国", list: "出口管制管控名单（示例）", reason: "涉及军民两用物项出口（示例）", risk: "high" },
    { name: "示例·YY科技", country: "某国", list: "受制裁主体（示例）", reason: "列入某国制裁清单（示例）", risk: "high" },
    { name: "示例·ZZ供应链", country: "某国", list: "实体清单（示例）", reason: "涉敏感技术（示例）", risk: "medium" },
  ];
  // 规则匹配（本地、best-effort；用于无清单命中时的信号提示）
  var RULE_HIGH = /导弹|核|军事|军品|军民两用|化学武器|生物武器|加密算法|涉密|间谍|武器/;
  var RULE_MEDIUM = /制裁|受制裁|出口管制|实体清单|两用物项|敏感技术|受限制|管制清单/;
  // 物项/ECCN 规则
  var ITEM_RULES = [
    { label: "军民两用物项", kw: /集成电路|芯片|半导体|数控|无人机|监控|雷达|通信设备|量子|密码|加密|传感器|复合材料|特种金属/, risk: "high", note: "疑为两用物项，需核对《两用物项出口管制条例》及清单；建议办理两用物项出口许可证" },
    { label: "军品/大规模杀伤性", kw: /导弹|核|化学|生物|军事|武器|弹头/, risk: "high", note: "涉军品/大规模杀伤性相关，严格管制，需专项许可与合规审查" },
    { label: "高风险技术", kw: /人工智能|大数据|基因|生物医药|航空航天|船舶|发动机/, risk: "medium", note: "涉敏感/新兴技术，建议核对该国出口管制规定与物项编码(ECCN/HS)" },
    { label: "一般货物", kw: /^(?!.*两用|.*军品).*$/, risk: "low", note: "未命中高风险物项关键词，按一般货物继续（仍建议核对 HS 编码与最终用户）" },
  ];
  // 交易合规体检（checklist）
  var CHECKLIST = [
    { k: "sanctions", label: "交易对手/最终用户是否受制裁或列入管制清单？" },
    { k: "export", label: "货物/技术是否属于两用物项或受出口管制？" },
    { k: "data", label: "是否涉及个人/重要/商业数据向境外提供（数据出境）？" },
    { k: "fx", label: "是否涉及外汇/跨境担保/资本项目合规？" },
    { k: "aml", label: "是否需反洗钱/KYC 尽调（客户身份、资金来源）？" },
    { k: "anticorruption", label: "是否涉及境外政府/国企交易（反腐败/FCPA）？" },
    { k: "customs", label: "是否涉及海关/原产地/税率合规？" },
    { k: "investment", label: "是否涉及对外投资/返程投资/负面清单限制行业？" },
  ];
  var state = { tab: "party" };
  var IMPORT_ORDER = { high: 3, medium: 2, low: 1 };

  function loadLog() { try { var l = localStorage.getItem(LS.log); var a = l ? JSON.parse(l) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function saveLog(a) { try { localStorage.setItem(LS.log, JSON.stringify(a)); } catch (e) { } }
  function loadList() { try { var l = localStorage.getItem(LS.list); var a = l ? JSON.parse(l) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function saveList(a) { try { localStorage.setItem(LS.list, JSON.stringify(a)); } catch (e) { } }

  function riskBadge(v) {
    var m = { high: "badge-danger", medium: "badge-warning", low: "badge-success" };
    var label = { high: "高风险", medium: "需关注", low: "低风险" }[v] || "需关注";
    return '<span class="badge ' + (m[v] || "badge-warning") + '">' + label + "</span>";
  }
  function chip(label, active, attr) {
    return '<button class="intl-chip' + (active ? " on" : "") + '" ' + attr + '>' + esc(label) + "</button>";
  }
  function pushLog(entry) {
    var a = loadLog(); a.unshift(entry); if (a.length > 200) a.length = 200; saveLog(a);
  }
  function aiMemo(obj) {
    try { return (window.__callAI && window.__callAI("cross-border-compliance", obj)) || "<p>（AI 桥未接）</p>"; }
    catch (e) { return "<p>AI 生成失败。</p>"; }
  }

  // —— 主体/清单筛查 ——
  function runPartyScreen(container) {
    var name = (byId("pcName") ? byId("pcName").value : "").trim();
    var country = (byId("pcCountry") ? byId("pcCountry").value : "").trim();
    var idno = (byId("pcId") ? byId("pcId").value : "").trim();
    var out = byId("pcResult"); if (!out) { render(container); return; }
    if (!name) { out.innerHTML = "<div class='empty'>请输入主体名称</div>"; return; }

    var hits = [], db = loadList().concat(SCREENING_DB);
    db.forEach(function (r) {
      if (r.name && (name.indexOf(r.name) >= 0 || r.name.indexOf(name) >= 0)) hits.push({ list: r.list, reason: r.reason, risk: r.risk, hit: r.name });
    });
    var rule = null;
    if (!hits.length) {
      if (RULE_HIGH.test(name)) { rule = { list: "高危信号(规则匹配)", reason: "名称含高风险敏感词：制裁/军品/管制等", risk: "high" }; }
      else if (RULE_MEDIUM.test(name)) { rule = { list: "需关注(规则匹配)", reason: "名称含敏感词：出口管制/实体清单等", risk: "medium" }; }
    }
    var risk = hits.length ? (hits.some(function (h) { return h.risk === "high"; }) ? "high" : (hits.some(function (h) { return h.risk === "medium"; }) ? "medium" : "low")) : (rule ? rule.risk : "low");
    var matched = hits.map(function (h) { return "清单：「" + esc(h.list) + "」命中 · 原因：" + esc(h.reason); }).join("<br>");
    var memoObj = { target: name, country: country, id: idno, risk: risk, matched: matched || (rule ? rule.reason : "未命中本地示例清单") };
    out.innerHTML = '<div class="card glow" style="margin-bottom:0">' +
      '<div class="card-head"><h2>筛查结果</h2>' + riskBadge(risk) + "</div>" +
      '<div class="doc-meta"><div class="mi"><b>主体</b><span>' + esc(name) + "</span></div>" +
      (country ? '<div class="mi"><b>国别</b><span>' + esc(country) + "</span></div>" : "") +
      (idno ? '<div class="mi"><b>证件</b><span>' + esc(idno) + "</span></div>" : "") + "</div>" +
      '<div style="font-size:13px;line-height:1.8">' + (matched || "未命中") + "</div>" +
      '<div class="card-head" style="margin-top:12px"><h2>AI 合规初筛</h2></div>' +
      '<div class="ai-box">' + aiMemo(memoObj) + "</div>" +
      '<div class="intl-note" style="margin-top:8px">说明：本地为<b>示例清单+规则</b>匹配；生产应接官方实时清单 API（OFAC/商务部管控名单等）并人工复核。</div>' +
      "</div>";
    pushLog({ type: "主体筛查", target: name, meta: (country || "") + (idno ? " · " + idno : ""), risk: risk, date: Date.now() });
    renderLog(container);
  }

  // —— 物项/ECCN 筛查 ——
  function runItemScreen(container) {
    var desc = (byId("itDesc") ? byId("itDesc").value : "").trim();
    var hs = (byId("itHs") ? byId("itHs").value : "").trim();
    var out = byId("itResult"); if (!out) { render(container); return; }
    if (!desc) { out.innerHTML = "<div class='empty'>请输入物项/技术描述</div>"; return; }
    var hit = null;
    for (var i = 0; i < ITEM_RULES.length; i++) {
      if (ITEM_RULES[i].kw.test(desc)) { hit = ITEM_RULES[i]; break; }
    }
    if (!hit) { hit = ITEM_RULES[ITEM_RULES.length - 1]; }
    out.innerHTML = '<div class="card glow" style="margin-bottom:0"><div class="card-head"><h2>物项定级</h2>' + riskBadge(hit.risk) + "</div>" +
      '<div class="doc-meta"><div class="mi"><b>描述</b><span>' + esc(desc) + "</span></div>" +
      (hs ? '<div class="mi"><b>HS/编码</b><span>' + esc(hs) + "</span></div>" : "") + "</div>" +
      '<div style="font-size:13px;line-height:1.8"><b>类别</b>：' + esc(hit.label) + "<br><b>建议</b>：" + esc(hit.note) + "</div>" +
      '<div class="card-head" style="margin-top:12px"><h2>AI 合规初筛</h2></div>' +
      '<div class="ai-box">' + aiMemo({ type: "物项筛查", target: desc, meta: hs, risk: hit.risk }) + "</div></div>";
    pushLog({ type: "物项筛查", target: desc, meta: hs, risk: hit.risk, date: Date.now() });
    renderLog(container);
  }

  // —— 交易合规体检 ——
  function runChecklist(container) {
    var checked = CHECKLIST.filter(function (c) { var el = byId("chk_" + c.k); return el && el.checked; });
    var count = checked.length, risk = count >= 5 ? "high" : (count >= 2 ? "medium" : "low");
    var out = byId("chkResult");
    var html = '<div class="card glow" style="margin-bottom:0"><div class="card-head"><h2>合规体检结果</h2>' + riskBadge(risk) + "</div>";
    if (!count) { html += "<div class='empty'>未勾选任何风险点，暂按<低风险>处理（仍需结合具体交易判断）。</div>"; }
    else {
      html += "<div style='font-size:13px;line-height:1.8'><b>命中 " + count + " 项合规关注：</b><br>" +
        checked.map(function (c) { return "• " + esc(c.label); }).join("<br>") +
        "<br><br><b>建议</b>：逐项排查并留痕；需人工复核，AI 仅作初筛提示。</div>";
    }
    html += '<div class="card-head" style="margin-top:12px"><h2>AI 综合提示</h2></div><div class="ai-box">' + aiMemo({ type: "交易合规体检", target: "交易", meta: count + " 项", risk: risk }) + "</div>" +
      '<button class="btn btn-sm btn-primary" id="chkSave" style="margin-top:10px"> 保存为合规记录</button></div>';
    out.innerHTML = html;
    var save = byId("chkSave"); if (save) save.addEventListener("click", function () {
      pushLog({ type: "交易合规体检", target: "交易合规", meta: count + " 项", risk: risk, date: Date.now() });
      renderLog(container); if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已保存合规记录", "success");
    });
  }

  // —— 数据出境评估 ——
  function runDataScreen(container) {
    var dType = (byId("dtType") ? byId("dtType").value : "");
    var scale = (byId("dtScale") ? byId("dtScale").value : "");
    var recv = (byId("dtRecv") ? byId("dtRecv").value : "");
    var crossB = byId("dtCross") ? byId("dtCross").checked : false;
    var cii = byId("dtCii") ? byId("dtCii").checked : false;
    var out = byId("dtResult");
    var risk = "low", path = [], note = "";
    if (dType === "important") { risk = "high"; path.push("《数据出境安全评估办法》安全评估"); note = "重要数据出境原则上应申报数据出境安全评估。"; }
    else if (dType === "personal") { risk = scale === "large" ? "medium" : "medium"; path.push(scale === "large" ? "数据出境安全评估" : "标准合同或个人信息保护认证"); note = "个人信息出境按规模与敏感性选择：出境安全评估 / 标准合同 / 认证。"; }
    else if (dType === "business") { risk = "low"; path.push("依合同与内部合规流程"); note = "一般经营数据出境，建议按合同与合规制度执行并留痕。"; }
    if (crossB) { /* 境外接收信号已在上面体现 */ }
    if (cii) { risk = "high"; path.push("关键信息基础设施运营者数据出境  安全评估（强制）"); note = "CII 运营者向境外提供数据应进行出境安全评估。"; }
    if (recv && /境外|foreign|overseas|海外/i.test(recv) && dType === "personal") { risk = "high"; path.push("向境外接收方提供个人信息  安全评估/标准合同/认证"); note = "重点核查境外接收方所在国数据保护水平与履约能力。"; }
    out.innerHTML = '<div class="card glow" style="margin-bottom:0"><div class="card-head"><h2>数据出境评估</h2>' + riskBadge(risk) + "</div>" +
      '<div class="doc-meta"><div class="mi"><b>数据类型</b><span>' + esc({ personal: "个人信息", important: "重要数据", business: "一般经营数据" }[dType] || "—") + "</span></div>" +
      '<div class="mi"><b>规模</b><span>' + esc({ small: "少量", medium: "中等", large: "大规模" }[scale] || "—") + "</span></div>" +
      (recv ? '<div class="mi"><b>接收方</b><span>' + esc(recv) + "</span></div>" : "") + "</div>" +
      '<div style="font-size:13px;line-height:1.8"><b>结论</b>：' + riskBadge(risk) + "<br><b>建议路径</b>：" + (path.length ? path.join(" / ") : "暂无强制评估路径，建议按合规流程执行") + "<br><b>说明</b>：" + ((note || "") + " 涉及数据出境应审慎，具体以《数据安全法》《个人信息保护法》及主管部门要求为准。") + "</div>" +
      '<button class="btn btn-sm btn-primary" id="dtSave" style="margin-top:10px"> 保存为合规记录</button></div>';
    var save = byId("dtSave"); if (save) save.addEventListener("click", function () {
      pushLog({ type: "数据出境评估", target: ({ personal: "个人信息", important: "重要数据", business: "一般经营数据" }[dType] || "—") + (recv ? "" + recv : ""), meta: path.join(" / "), risk: risk, date: Date.now() });
      renderLog(container); if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已保存合规记录", "success");
    });
  }

  // —— 记录 ——
  function renderLog(container) {
    var logEl = byId("compLog"); if (!logEl) return;
    var a = loadLog();
    var byRisk = { high: 0, medium: 0, low: 0 };
    a.forEach(function (x) { byRisk[x.risk] = (byRisk[x.risk] || 0) + 1; });
    var head = document.getElementById("compStatHigh");
    var low = document.getElementById("compStatLow");
    if (head) head.textContent = byRisk.high || 0;
    if (low) low.textContent = a.length;
    if (!a.length) { logEl.innerHTML = "<div class='empty'>暂无筛查记录。先在上方做一次筛查。</div>"; return; }
    logEl.innerHTML = a.slice(0, 40).map(function (x) {
      return '<div class="intl-item" style="padding:10px 0;border-bottom:1px solid rgba(127,127,127,.12)"><div class="row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        riskBadge(x.risk) + '<span style="font-weight:600">' + esc(x.type) + "</span>" +
        '<span style="font-size:12px;opacity:.7">' + esc(x.target) + "</span>" +
        '<span style="margin-left:auto;font-size:11px;opacity:.55">' + fmt(x.date) + "</span>" +
        '<button class="btn btn-sm btn-ghost" data-clog="' + x.date + '">删</button></div>' +
        (x.meta ? '<div class="tl-meta" style="margin-top:4px;font-size:12px;opacity:.7">' + esc(x.meta) + "</div>" : "") + "</div>";
    }).join("");
    logEl.querySelectorAll("[data-clog]").forEach(function (b) {
      b.addEventListener("click", function () { var d = Number(b.getAttribute("data-clog")); var a2 = loadLog().filter(function (x) { return x.date !== d; }); saveLog(a2); renderLog(container); });
    });
  }

  // —— 渲染 ——
  function render(container, title, sub) {
    var a = loadLog();
    var byRisk = { high: 0, medium: 0, low: 0 }; a.forEach(function (x) { byRisk[x.risk] = (byRisk[x.risk] || 0) + 1; });
    var tabs = [["party", "主体/清单筛查"], ["item", "物项筛查"], ["check", "交易体检"], ["data", "数据出境"], ["log", "筛查记录"]];
    var html =
      "<style>.intl-chip{background:rgba(127,127,127,.09);border-radius:999px;padding:4px 12px;font-size:12px;border:1px solid transparent;cursor:pointer}.intl-chip.on{background:linear-gradient(135deg,#4f8cff,#7aa8ff);color:#fff}.intl-note{font-size:12px;opacity:.62;margin-top:6px}.intl-input{width:100%;padding:8px 11px;border-radius:9px;border:1px solid rgba(127,127,127,.25);background:rgba(127,127,127,.06);color:inherit;font-family:inherit;margin-bottom:8px}.intl-sec{display:none}.intl-sec.on{display:block}.intl-tab .tabs button.active{color:var(--accent,#4f8cff)}</style>"
      + '<div class="page-head"><div><h1>' + esc(title) + "</h1><div class='sub'>" + esc(sub) + "</div></div>"
      + '<button class="btn btn-ghost btn-sm" id="compImport"> 导入清单</button></div>'
      + '<div class="grid cols-4" style="margin-bottom:14px">'
      + '<div class="stat-card glow"><div class="stat-label">近筛查记录</div><div class="stat-value" id="compStatLow">' + a.length + '</div></div>'
      + '<div class="stat-card glow"><div class="stat-label">命中高风险</div><div class="stat-value" id="compStatHigh">' + (byRisk.high || 0) + '</div></div>'
      + '<div class="stat-card glow"><div class="stat-label">示例清单</div><div class="stat-value">' + SCREENING_DB.length + '</div><div class="stat-foot"><span class="up"> 需替换官方</span></div></div>'
      + '<div class="stat-card glow"><div class="stat-label">体检项</div><div class="stat-value">' + CHECKLIST.length + '</div></div>'
      + "</div>"
      + '<div class="tabs intl-tab" style="margin-bottom:14px">' + tabs.map(function (t) { return '<button class="' + (state.tab === t[0] ? "active" : "") + '" data-tab="' + t[0] + '">' + t[1] + "</button>"; }).join("") + "</div>";

    html += '<div class="intl-sec' + (state.tab === "party" ? " on" : "") + '" data-sec="party"><div class="card glow"><div class="card-head"><h2> 主体 / 清单筛查</h2><span class="badge badge-info">本地示例 + 规则</span></div>'
      + '<div class="doc-meta"><div class="mi"><b>主体名称*</b><span><input id="pcName" class="intl-input" placeholder="中/英文主体名称"></span></div>'
      + '<div class="mi"><b>国别</b><span><input id="pcCountry" class="intl-input" placeholder="如：某国"></span></div>'
      + '<div class="mi"><b>证件号(可选)</b><span><input id="pcId" class="intl-input" placeholder="统一社会信用代码/护照号等"></span></div></div>'
      + '<button class="btn btn-primary glow" id="pcGo"> 开始筛查</button><div id="pcResult" style="margin-top:12px"></div></div></div>';

    html += '<div class="intl-sec' + (state.tab === "item" ? " on" : "") + '" data-sec="item"><div class="card glow"><div class="card-head"><h2> 物项 / ECCN 筛查</h2></div>'
      + '<div class="doc-meta"><div class="mi"><b>物项/技术描述*</b><span><input id="itDesc" class="intl-input" placeholder="如：集成电路 / 无人机 / 数控机床"></span></div>'
      + '<div class="mi"><b>HS/编码(可选)</b><span><input id="itHs" class="intl-input" placeholder="如：8542 / ECCN 5A002"></span></div></div>'
      + '<button class="btn btn-primary glow" id="itGo"> 物项定级</button><div id="itResult" style="margin-top:12px"></div></div></div>';

    html += '<div class="intl-sec' + (state.tab === "check" ? " on" : "") + '" data-sec="check"><div class="card glow"><div class="card-head"><h2> 交易合规体检</h2><span class="badge badge-info">勾选命中  生成风险报告</span></div>'
      + CHECKLIST.map(function (c) { return '<label style="display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-bottom:1px solid rgba(127,127,127,.08);font-size:13px"><input type="checkbox" id="chk_' + c.k + '" style="margin-top:3px"> <span>' + esc(c.label) + "</span></label>"; }).join("")
      + '<button class="btn btn-primary glow" id="chkGo" style="margin-top:12px"> 生成体检报告</button><div id="chkResult" style="margin-top:12px"></div></div></div>';

    html += '<div class="intl-sec' + (state.tab === "data" ? " on" : "") + '" data-sec="data"><div class="card glow"><div class="card-head"><h2> 数据出境评估</h2><span class="badge badge-info">PIPL / 数据出境安全评估</span></div>'
      + '<div class="doc-meta"><div class="mi"><b>数据类型</b><span><select id="dtType" class="intl-input"><option value="">请选择</option><option value="personal">个人信息</option><option value="important">重要数据</option><option value="business">一般经营数据</option></select></span></div>'
      + '<div class="mi"><b>数据规模</b><span><select id="dtScale" class="intl-input"><option value="">请选择</option><option value="small">少量</option><option value="medium">中等</option><option value="large">大规模</option></select></span></div>'
      + '<div class="mi"><b>接收方</b><span><input id="dtRecv" class="intl-input" placeholder="如：某境外公司 / 某国分支机构"></span></div>'
      + '<div class="mi"><b>其他</b><span style="display:flex;gap:18px;flex-wrap:wrap"><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="dtCross"> 向境外提供</label><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="dtCii"> 关键信息基础设施</label></span></div></div>'
      + '<button class="btn btn-primary glow" id="dtGo"> 评估</button><div id="dtResult" style="margin-top:12px"></div></div></div>';

    html += '<div class="intl-sec' + (state.tab === "log" ? " on" : "") + '" data-sec="log"><div class="card glow"><div class="card-head"><h2> 筛查记录</h2><span class="badge badge-info">本地留存 · 导入官方清单可升级</span></div>'
      + '<div id="compLog"></div></div></div>';

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
    var pc = byId("pcGo"); if (pc) pc.addEventListener("click", function () { runPartyScreen(container); });
    var it = byId("itGo"); if (it) it.addEventListener("click", function () { runItemScreen(container); });
    var chk = byId("chkGo"); if (chk) chk.addEventListener("click", function () { runChecklist(container); });
    var dt = byId("dtGo"); if (dt) dt.addEventListener("click", function () { runDataScreen(container); });
    var imp = byId("compImport"); if (imp) imp.addEventListener("click", function () { openImportModal(container); });
    renderLog(container);
  }

  function openImportModal(container) {
    var m = document.createElement("div"); m.className = "modal-overlay show";
    m.innerHTML = '<div class="modal glow" style="width:560px"><div class="card-head"><h3> 导入筛查清单</h3></div>'
      + '<div class="card-head"><h2>官方清单（生产路径）</h2></div>'
      + '<div style="font-size:13px;line-height:1.8;opacity:.85;margin-bottom:10px">将官方实时清单（如 OFAC Consolidated、商务部不可靠实体清单、出口管制管控名单、两用物项清单等）导出为 CSV/JSON 导入，替换本模块的<b>示例清单</b>。字段：name,list,reason,risk。</div>'
      + '<div class="doc-meta"><div class="mi"><b>选择文件</b><span><input id="listFile" type="file" accept=".json,.csv" style="width:100%"></span></div></div>'
      + '<div class="modal-actions"><button class="btn btn-primary" id="listImport">导入</button><button class="btn btn-ghost" data-close>关闭</button></div></div>';
    document.body.appendChild(m);
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.id === "listImport") {
        var f = byId("listFile").files[0]; if (!f) { alert("请选择文件"); return; }
        var rd = new FileReader(); rd.onload = function () {
          try { var arr = JSON.parse(rd.result); if (Array.isArray(arr)) { saveList(arr); m.remove(); render(container); if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已导入 " + arr.length + " 条清单", "success"); } else { alert("格式不正确：应为数组"); } }
          catch (e2) { alert("解析失败（请用 JSON 数组）"); }
        }; rd.readAsText(f);
      }
    });
  }

  window.IntlCompliance = { render: render, SEED: { SCREENING_DB: SCREENING_DB, ITEM_RULES: ITEM_RULES, CHECKLIST: CHECKLIST } };
})();
