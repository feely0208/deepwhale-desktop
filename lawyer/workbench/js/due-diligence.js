/* =========================================================================
   due-diligence.js — 尽调工作台（半自动 · 留痕式）
   -------------------------------------------------------------------------
   与鸿蒙版 DueDiligenceView 对齐（2026-10 新增，桌面端原本缺失该模块）。

   产品定位（改动前先读）：
   · **半自动工作台，不是自动抓取器**。官方站（信用中国 / 执行信息公开网 /
     裁判文书网 / 国家企业信用信息公示系统）均有图形验证码与反爬机制，且频繁
     抓取政府网站存在合规风险 —— 因此**本文件不包含任何爬虫/抓取代码，一个 HTTP
     请求都不发**。所有事实性内容一律由律师本人在官方页面检索后填写。
   · 核心价值 = 「查得全、记得住、写得规范」：把三个尽调能力
     （due-diligence / company-due-diligence / person-background-check）
     变成可操作的核查清单。
   · **AI 只做「组织与规范化」，不提供事实**：喂给 AI 的只有律师已填写
     并已标注来源/查询日期的内容。

   三套章节：
     企业     → 一~七（主体概况 / 股权与控制 / 司法风险 / 经营合规 / 知识产权 /
                舆情与经营 / 结论与风险提示）
     境外投资 → 一~七（投资主体与交易结构 / 东道国市场准入 / 外汇与资金跨境 /
                劳动与用工 / 税务与常设机构 / 数据跨境与出口管制 / 争议解决与投资保护）
     自然人   → 一~六（同名识别 / 任职投资 / 被执行失信限高 / 裁判文书公告 /
                风险结论 / 合规声明与建议）

   官方权威源（2026-10）：司法部「法通」网与浙江律协「浙商涉外」平台是国家/省级
   已建成的公益性涉外法律服务平台。本模块只**跳转引用**，不抓取、不复制其内容。
   ========================================================================= */
(function () {
  var LS = { reports: "dd.reports" };
  var now = function () { return new Date(); };
  var dateStr = function (d) { d = d || now(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); };
  var byId = function (id) { return document.getElementById(id); };
  var uid = function () { return "d" + Date.now() + Math.floor(Math.random() * 1000); };

  // ── 官方信源登记表 ─────────────────────────────────────────────────────
  // prefill=true 表示该站已核对支持在 URL 中预填检索关键词；其余只跳入口页。
  var SRC = {
    gsxt: { name: "国家企业信用信息公示系统", url: "https://www.gsxt.gov.cn/", prefill: false, param: "", tail: "" },
    credit: { name: "信用中国", url: "https://www.creditchina.gov.cn/xinyongxinxi/", prefill: true, param: "keyword", tail: "&scenesVal=default&tableName=credit_xyzx_tyshxydm" },
    zxgk: { name: "中国执行信息公开网", url: "http://zxgk.court.gov.cn/", prefill: false, param: "", tail: "" },
    wenshu: { name: "中国裁判文书网", url: "https://wenshu.court.gov.cn/", prefill: false, param: "", tail: "" },
    rmfygg: { name: "人民法院公告网", url: "https://rmfygg.court.gov.cn/", prefill: false, param: "", tail: "" },
    cnipa: { name: "国家知识产权局", url: "https://www.cnipa.gov.cn/", prefill: false, param: "", tail: "" },
    lexcom: { name: "法通网（司法部·全国性涉外法律服务平台）", url: "https://lexcom.12348.gov.cn/homepage", prefill: false, param: "", tail: "" },
    zw: { name: "浙商涉外法律服务（浙江省律师协会）", url: "https://shewai.zjbar.com/site/", prefill: false, param: "", tail: "" },
  };
  var ALL_SRC = [SRC.gsxt, SRC.credit, SRC.zxgk, SRC.wenshu, SRC.rmfygg, SRC.cnipa, SRC.lexcom, SRC.zw];

  var CAUTION_PERSON = "个人信息仅限与本次尽调目的相关的公开司法与行政记录；通讯方式、社交账号、家庭成员、住址、身份证号等隐私与敏感个人信息一律不采集、不记载。";

  // ── 企业章节（对齐 DD_DIMENSIONS 一~七 + DD_COMPANY_OUTPUT）────────────
  var SEC_ENTERPRISE = [
    { id: "e1", no: "一", title: "主体概况",
      hint: "企业全称｜统一社会信用代码｜企业类型｜成立日期｜登记状态（存续/在业/吊销/注销/迁出）｜法定代表人｜注册资本/实缴资本｜注册地址｜登记机关｜经营范围｜营业期限｜资质与行政许可",
      src: ["gsxt", "credit"] },
    { id: "e2", no: "二", title: "股权与控制关系",
      hint: "股东名称｜股东类型｜认缴出资额｜实缴出资额｜持股比例｜出资方式｜出资时间｜股权状态（正常/质押/冻结）；股权穿透至自然人／国资／外资终止点；实际控制人认定与认定依据",
      src: ["gsxt", "credit"] },
    { id: "e3", no: "三", title: "司法风险",
      hint: "涉诉案件｜被执行人｜失信被执行人｜限制高消费｜终本案件｜股权冻结与司法拍卖：案号或执行案号｜案由｜法院｜立案日期｜标的额或未履行金额｜当前状态",
      src: ["zxgk", "wenshu", "rmfygg"] },
    { id: "e4", no: "四", title: "经营合规",
      hint: "经营异常名录｜严重违法失信名单｜行政处罚｜欠税公告｜信用中国红黑名单：文号｜事由｜金额｜日期｜作出机关｜状态",
      src: ["credit", "gsxt"] },
    { id: "e5", no: "五", title: "知识产权",
      hint: "商标（注册号｜类别｜状态）｜专利（申请号或专利号｜类型｜法律状态）｜著作权与软件著作权｜知识产权质押与无效、撤销程序",
      src: ["cnipa"] },
    { id: "e6", no: "六", title: "舆情与经营状况",
      hint: "公开新闻报道｜招投标与中标｜融资与股权变动｜破产重整或清算信息｜官网公示与实际经营是否相符（逐条标注来源与日期）",
      src: ["rmfygg", "gsxt"] },
    { id: "e7", no: "七", title: "结论与风险提示",
      hint: "整体风险评级（高/中/低/信息不足）｜已核实的关键事实｜重大风险点（依据哪条记录、影响什么交易安排、建议采取什么措施）｜未能核实事项及已检索范围｜针对调查目的的可操作建议",
      src: ["gsxt", "credit"] },
  ];

  // ── 跨境投资章节（2026-10 新增）────────────────────────────────────────
  // 为什么单列：涉外尽调的核查对象不只是「标的公司」，还包括**东道国法律环境**。
  // 这些是境内七章覆盖不到、而官方平台「只给资料、不做清单」的部分。
  var SEC_CROSSBORDER = [
    { id: "x1", no: "一", title: "投资主体与交易结构",
      hint: "投资方主体（全称｜统一社会信用代码｜存续状态）｜拟设或拟并购境外主体（注册地｜法律形式）｜持股路径与层级｜投资金额与出资方式｜是否涉及境外投资（ODI）备案或核准",
      src: ["gsxt", "credit"] },
    { id: "x2", no: "二", title: "东道国市场准入与外资限制",
      hint: "外资准入负面清单或限制类行业｜是否要求与本地股东合资｜持股比例上下限｜行业许可与牌照（主管机关｜申请条件｜办理周期）｜是否需要设立本地实体或代表处",
      src: ["lexcom", "zw"] },
    { id: "x3", no: "三", title: "外汇与资金跨境",
      hint: "东道国外汇管制程度｜资本金汇入与利润汇出的限制｜是否需外汇登记或审批｜利润、特许权使用费、服务费汇出的预提税与手续｜撤资与清算资金汇回路径",
      src: ["lexcom", "zw"] },
    { id: "x4", no: "四", title: "劳动与用工合规",
      hint: "劳动合同形式与必备条款｜试用期与解雇限制｜最低工资与法定福利｜社保与用工配额｜外籍员工工作许可与签证｜工会与集体协商要求｜劳资争议处理机制",
      src: ["lexcom", "zw"] },
    { id: "x5", no: "五", title: "税务与常设机构风险",
      hint: "企业所得税与预提税率｜流转税及类似税种｜常设机构认定风险｜税收协定与优惠适用条件｜转让定价与关联交易合规｜税务登记与申报义务",
      src: ["lexcom", "zw"] },
    { id: "x6", no: "六", title: "数据跨境与出口管制",
      hint: "东道国数据本地化与出境限制｜个人数据保护立法与合规义务｜跨境传输的合法性基础与安全评估｜出口管制与经济制裁清单筛查｜行业特殊监管（金融／医疗／电信等）",
      src: ["lexcom", "zw"] },
    { id: "x7", no: "七", title: "争议解决与投资保护",
      hint: "争议解决方式（当地法院／仲裁机构／第三地仲裁）｜裁决的承认与执行（《纽约公约》适用）｜是否与我国缔结双边投资保护协定｜征收与国有化补偿标准｜政治风险保险或担保安排｜整体风险评级与可操作建议",
      src: ["lexcom", "zw"] },
  ];

  // ── 个人章节（对齐 DD_PERSON_OUTPUT 一~六）────────────────────────────
  var SEC_PERSON = [
    { id: "p1", no: "一", title: "同名识别与调查说明",
      hint: "姓名｜已知限定条件（任职单位／所在地区／出生年份／关联案件）｜同名识别结论（已完成身份同一性确认 / 存在同名可能，未完成身份同一性确认）｜调查目的｜检索范围",
      src: ["gsxt", "rmfygg"], caution: CAUTION_PERSON },
    { id: "p2", no: "二", title: "公开任职与对外投资",
      hint: "主体名称｜担任职务或持股情况｜公示来源｜查询日期；无记录时写「经检索未发现公开任职或投资公示记录（检索日期 …）」",
      src: ["gsxt"], caution: CAUTION_PERSON },
    { id: "p3", no: "三", title: "被执行 / 失信 / 限制高消费",
      hint: "执行案号｜执行法院｜立案日期｜执行标的｜未履行金额｜失信情形｜限高措施｜当前状态",
      src: ["zxgk"], caution: CAUTION_PERSON },
    { id: "p4", no: "四", title: "裁判文书与公告",
      hint: "案号｜案由｜法院｜裁判日期｜当事人地位｜裁判结果要点｜是否与本次调查对象为同一人（同名甄别依据）",
      src: ["wenshu", "rmfygg"], caution: CAUTION_PERSON },
    { id: "p5", no: "五", title: "风险结论",
      hint: "整体风险评级（高/中/低/信息不足）｜已核实的负面记录｜同名可能导致的误判提示｜对本次调查目的的影响判断",
      src: ["zxgk", "wenshu"], caution: CAUTION_PERSON },
    { id: "p6", no: "六", title: "合规声明与建议",
      hint: "检索范围与时间｜未能核实事项｜信息使用限制（仅限本次尽调目的）｜后续建议（如需进一步核实的公开渠道）",
      src: ["gsxt", "credit"], caution: CAUTION_PERSON },
  ];

  var KINDS = ["企业", "个体工商户", "事业单位", "社会组织", "境外投资", "自然人"];
  var PURPOSES = ["交易前审查", "诉讼前尽调", "投资尽调", "跨境投资尽调", "一般了解"];

  function sectionsFor(kind) {
    if (kind === "自然人") { return SEC_PERSON; }
    if (kind === "境外投资") { return SEC_CROSSBORDER; }
    return SEC_ENTERPRISE;
  }

  var state = { tab: "check", kind: "企业", purpose: "交易前审查", built: false, sections: [], entries: [], objName: "", task: "company-due-diligence" };

  function loadReports() { try { var l = localStorage.getItem(LS.reports); var a = l ? JSON.parse(l) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function saveReports(a) { try { localStorage.setItem(LS.reports, JSON.stringify(a)); } catch (e) { } }
  function toast(msg, type) { if (window.Workbench && window.Workbench.toast) { window.Workbench.toast(msg, type || "success"); } }

  /** 组装跳转 URL：仅对已核对支持预填的信源追加关键词 */
  function srcUrl(s, kw) {
    if (!s.prefill || !kw) { return s.url; }
    return s.url + (s.url.indexOf("?") >= 0 ? "&" : "?") + s.param + "=" + encodeURIComponent(kw) + (s.tail || "");
  }
  function openSrc(s, kw) {
    var u = srcUrl(s, kw);
    window.open(u, "_blank", "noopener");
    toast(s.prefill && kw ? ("已打开「" + s.name + "」并预填名称") : ("已打开「" + s.name + "」，该站检索框不接受预填，请复制名称后粘贴搜索"), "success");
  }

  // ── 生成核查清单 ───────────────────────────────────────────────────────
  function generate(container) {
    var name = (byId("ddName") ? byId("ddName").value : "").trim();
    if (!name) { alert("请先填写调查对象名称（企业填工商登记全称，个人填姓名）"); return; }
    var secs = sectionsFor(state.kind);
    state.sections = secs;
    state.objName = name;
    state.entries = secs.map(function (s) { return { id: s.id, content: "", source: "", date: "" }; });
    state.task = state.kind === "自然人" ? "person-background-check" : "company-due-diligence";
    state.built = true;
    state.tab = "check";
    render(container);
    toast("已生成 " + secs.length + " 个核查章节（" + state.kind + " · " + state.purpose + "）：请逐项到官方信源核查，并填写每条的来源与查询日期");
  }

  function entryOf(id) { return state.entries.filter(function (e) { return e.id === id; })[0] || null; }

  function reportText() {
    var l = [];
    l.push("尽调核查清单（半自动工作台 · 留痕式）");
    l.push("");
    l.push("对象名称：" + state.objName);
    l.push("对象类型：" + state.kind + "　　调查目的：" + state.purpose);
    l.push("生成日期：" + dateStr());
    l.push("");
    l.push("说明：本报告全部事实性内容由承办律师检索官方信源后如实填写；本工具不抓取任何数据。");
    l.push("");
    state.sections.forEach(function (s) {
      var e = entryOf(s.id) || { content: "", source: "", date: "" };
      l.push(s.no + "、" + s.title);
      l.push("　应核查：" + s.hint);
      l.push("　核查结论：" + (e.content || "（未填写）"));
      l.push("　来源：" + (e.source || "（未填写）") + "　查询日期：" + (e.date || "（未填写）"));
      l.push("　官方入口：" + s.src.map(function (k) { return SRC[k] ? SRC[k].name : k; }).join("、"));
      l.push("");
    });
    return l.join("\n");
  }

  // ── 渲染 ───────────────────────────────────────────────────────────────
  function render(container, title, sub) {
    var reports = loadReports();
    var html =
      "<style>"
      + ".dd-chip{background:rgba(127,127,127,.09);border:1px solid transparent;border-radius:999px;padding:4px 12px;font-size:12px;cursor:pointer}"
      + ".dd-chip.on{background:linear-gradient(135deg,#4f8cff,#7aa8ff);color:#fff;border-color:transparent}"
      + ".dd-note{font-size:12px;opacity:.62;margin-top:6px}"
      + ".dd-sec{display:none}.dd-sec.on{display:block}"
      + ".dd-sec-item{padding:14px 0;border-bottom:1px solid rgba(127,127,127,.12)}"
      + ".dd-hint{font-size:12.5px;opacity:.72;line-height:1.7;margin:6px 0}"
      + ".dd-input{width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.25);background:rgba(127,127,127,.06);color:inherit;font-family:inherit;font-size:12.5px}"
      + ".dd-rep{padding:12px 0;border-bottom:1px solid rgba(127,127,127,.12)}"
      + "</style>"
      + '<div class="page-head"><div><h1>' + esc(title || "尽调工作台") + '</h1><div class="sub">' + esc(sub || "半自动 · 留痕式 · 不抓取任何数据") + "</div></div></div>"
      + '<div class="tabs" style="margin-bottom:14px">'
      + [["check", "核查清单"], ["reports", "已存报告(" + reports.length + ")"]]
        .map(function (t) { return '<button class="' + (state.tab === t[0] ? "active" : "") + '" data-ddtab="' + t[0] + '">' + t[1] + "</button>"; }).join("")
      + "</div>";

    // —— 核查清单 ——
    html += '<div class="dd-sec' + (state.tab === "check" ? " on" : "") + '" data-ddsec="check">';

    html += '<div class="card glow" style="margin-bottom:14px"><div class="card-head"><h2>尽调设置</h2><span class="badge badge-info">半自动 · 不抓取</span></div>'
      + '<div class="dd-note" style="margin-bottom:8px">官方站均有验证码与反爬机制，且频繁抓取政府网站存在合规风险 —— <b>本工具一个 HTTP 请求都不发</b>，全部事实由你检索官方信源后填写。</div>'
      + '<input id="ddName" class="dd-input" placeholder="调查对象名称（企业填工商登记全称 / 个人填姓名）" value="' + esc(state.objName) + '" style="margin-bottom:10px" />'
      + '<div style="font-size:12px;opacity:.62;margin-bottom:6px">对象类型</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:8px">'
      + KINDS.map(function (k) { return '<span class="dd-chip' + (state.kind === k ? " on" : "") + '" data-ddkind="' + esc(k) + '">' + esc(k) + "</span>"; }).join("")
      + "</div>"
      + '<div style="font-size:12px;opacity:.62;margin:12px 0 6px">调查目的</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:8px">'
      + PURPOSES.map(function (p) { return '<span class="dd-chip' + (state.purpose === p ? " on" : "") + '" data-ddpurpose="' + esc(p) + '">' + esc(p) + "</span>"; }).join("")
      + "</div>"
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">'
      + '<button class="btn btn-primary glow" id="ddGen">生成核查清单</button>'
      + (state.built ? '<button class="btn btn-ghost" id="ddPrint">打印/导出报告</button><button class="btn btn-ghost" id="ddSave">保存报告</button>' : "")
      + "</div></div>";

    if (!state.built) {
      html += '<div class="card glow"><div class="empty">填写调查对象并选择类型后，点「生成核查清单」。<br/>企业 / 个体工商户 / 事业单位 / 社会组织 → 七章；境外投资 → 东道国法律环境七章；自然人 → 六章。</div></div>';
    } else {
      html += '<div class="card glow"><div class="card-head"><h2>' + esc(state.objName) + " · 核查清单（" + state.sections.length + " 章）</h2><span class=\"badge badge-info\">" + esc(state.kind) + " · " + esc(state.purpose) + "</span></div>";
      state.sections.forEach(function (s) {
        var e = entryOf(s.id) || { content: "", source: "", date: "" };
        html += '<div class="dd-sec-item">'
          + "<b>" + s.no + "、" + esc(s.title) + "</b>"
          + '<div class="dd-hint">' + esc(s.hint) + "</div>"
          + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">'
          + s.src.map(function (k, i) {
            return SRC[k] ? '<button class="btn btn-sm btn-ghost" data-ddsrc="' + k + '">查 ' + esc(SRC[k].name) + "</button>" : "";
          }).join("")
          + "</div>"
          + '<textarea class="dd-input" data-ddcontent="' + s.id + '" rows="3" placeholder="核查结论（逐条写：查到了什么 / 没查到什么，均需注明来源与日期）">' + esc(e.content) + "</textarea>"
          + '<div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">'
          + '<input class="dd-input" style="flex:1;min-width:200px" data-ddsource="' + s.id + '" placeholder="来源（必填，如：国家企业信用信息公示系统）" value="' + esc(e.source) + '" />'
          + '<input class="dd-input" style="width:150px" data-dddate="' + s.id + '" type="date" value="' + esc(e.date) + '" />'
          + "</div>"
          + (s.caution ? '<div class="dd-note">⚠ ' + esc(s.caution) + "</div>" : "")
          + "</div>";
      });
      html += '<div class="dd-note">报告导出前，请确认每章的「来源」与「查询日期」都已填写 —— 这是本工作台的立足点：有据可查。</div></div>';
    }
    html += "</div>";

    // —— 已存报告 ——
    html += '<div class="dd-sec' + (state.tab === "reports" ? " on" : "") + '" data-ddsec="reports"><div class="card glow"><div class="card-head"><h2>已存尽调报告（' + reports.length + "）</h2><span class=\"badge badge-info\">本地留档</span></div>"
      + (reports.length ? reports.map(function (r) {
        return '<div class="dd-rep"><b>' + esc(r.objName) + "</b>"
          + '<span style="font-size:11px;opacity:.6;margin-left:8px">' + esc(r.kind) + " · " + esc(r.date) + "</span>"
          + '<button class="btn btn-sm btn-ghost" data-ddrdel="' + r.id + '" style="float:right">删</button>'
          + '<div style="margin-top:6px"><button class="btn btn-sm btn-ghost" data-ddrview="' + r.id + '">预览</button> <button class="btn btn-sm btn-ghost" data-ddrcopy="' + r.id + '">复制全文</button></div>'
          + '<div class="dd-box" data-ddrb="' + r.id + '" style="display:none;margin-top:8px;white-space:pre-wrap;font-size:12.5px;line-height:1.8;opacity:.85"></div></div>';
      }).join("") : '<div class="empty">尚未保存尽调报告。</div>')
      + "</div></div>";

    container.innerHTML = html;
    bind(container);
  }

  function bind(container) {
    container.querySelectorAll("[data-ddtab]").forEach(function (b) {
      b.addEventListener("click", function () { state.tab = b.getAttribute("data-ddtab"); render(container); });
    });
    container.querySelectorAll("[data-ddkind]").forEach(function (b) {
      b.addEventListener("click", function () { state.kind = b.getAttribute("data-ddkind"); render(container); });
    });
    container.querySelectorAll("[data-ddpurpose]").forEach(function (b) {
      b.addEventListener("click", function () { state.purpose = b.getAttribute("data-ddpurpose"); render(container); });
    });
    var gen = byId("ddGen"); if (gen) gen.addEventListener("click", function () { generate(container); });

    // 输入回写（切页/刷新不丢）
    container.querySelectorAll("[data-ddcontent]").forEach(function (el) {
      el.addEventListener("input", function () { var e = entryOf(el.getAttribute("data-ddcontent")); if (e) { e.content = el.value; } });
    });
    container.querySelectorAll("[data-ddsource]").forEach(function (el) {
      el.addEventListener("input", function () { var e = entryOf(el.getAttribute("data-ddsource")); if (e) { e.source = el.value; } });
    });
    container.querySelectorAll("[data-dddate]").forEach(function (el) {
      el.addEventListener("change", function () { var e = entryOf(el.getAttribute("data-dddate")); if (e) { e.date = el.value; } });
    });

    // 官方入口跳转
    container.querySelectorAll("[data-ddsrc]").forEach(function (b) {
      b.addEventListener("click", function () {
        var s = SRC[b.getAttribute("data-ddsrc")];
        if (s) { openSrc(s, state.objName); }
      });
    });

    var pr = byId("ddPrint"); if (pr) pr.addEventListener("click", function () { printReport(); });
    var sv = byId("ddSave"); if (sv) sv.addEventListener("click", function () {
      var missing = state.entries.filter(function (e) { return !e.source || !e.date; }).length;
      if (missing > 0 && !confirm("还有 " + missing + " 个章节未填「来源」或「查询日期」。仍要保存？")) { return; }
      var a = loadReports();
      a.unshift({ id: uid(), objName: state.objName, kind: state.kind, purpose: state.purpose, date: dateStr(), text: reportText() });
      saveReports(a);
      state.tab = "reports";
      render(container);
      toast("报告已保存到本机");
    });

    container.querySelectorAll("[data-ddrview]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-ddrview");
        var box = container.querySelector('[data-ddrb="' + id + '"]');
        var r = loadReports().filter(function (x) { return x.id === id; })[0];
        if (box && r) { box.style.display = box.style.display === "none" ? "block" : "none"; box.textContent = r.text; }
      });
    });
    container.querySelectorAll("[data-ddrcopy]").forEach(function (b) {
      b.addEventListener("click", function () {
        var r = loadReports().filter(function (x) { return x.id === b.getAttribute("data-ddrcopy"); })[0];
        if (!r) { return; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(r.text).then(function () { toast("报告全文已复制"); }, function () { alert("复制失败，请手动选择文本"); });
        } else { alert("当前环境不支持自动复制，请用「预览」后手动选择文本"); }
      });
    });
    container.querySelectorAll("[data-ddrdel]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!confirm("删除该尽调报告？")) { return; }
        var id = b.getAttribute("data-ddrdel");
        saveReports(loadReports().filter(function (x) { return x.id !== id; }));
        render(container);
        toast("已删除");
      });
    });
  }

  function printReport() {
    var w = window.open("", "_blank");
    if (!w) { alert("浏览器拦截了新窗口，请允许弹窗后重试"); return; }
    w.document.write("<html><head><meta charset='utf-8'><title>尽调报告 - " + esc(state.objName) + "</title>"
      + "<style>body{font-family:-apple-system,'PingFang SC',sans-serif;padding:32px;line-height:1.9;font-size:14px;white-space:pre-wrap}</style></head><body>"
      + esc(reportText()) + "</body></html>");
    w.document.close();
    w.focus();
    w.print();
  }

  window.DueDiligence = {
    render: render,
    SEC_ENTERPRISE: SEC_ENTERPRISE,
    SEC_CROSSBORDER: SEC_CROSSBORDER,
    SEC_PERSON: SEC_PERSON,
    SRC: SRC
  };
})();
