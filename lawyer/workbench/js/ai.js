/* =========================================================================
   ai.js — 法律工作台统一 AI 桥 + 领域 skill（深度绑定，规范化输出）
   -------------------------------------------------------------------------
   用法：window.__callAI(task, params)  内部按 task 路由到对应「领域 skill」。
   - 现在（原型/未接算力）：skill 输出【规范化骨架】，证明管道通、格式对。
   - 接入「法律模式 agent + 集团算力」后：skill 作为 agent 的提示/知识，
     agent 加载它产出【规范化、专业、有参考价值】的答案；本桥不变。
   每次调用都应记为一次算力消耗（credits），为"订阅含算力额度"铺路。
   ========================================================================= */
(function () {
  var nl = function (t) { return String(t || ""); };
  var nowStr = function () { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  // —— 数据读取层（C-1：让 AI 读工作台真实数据，链式效应核心） ——
  function wb() {
    try {
      var d = (window.WbData && window.WbData.collect) ? window.WbData.collect() : {};
      var cats = (d && d.categories) || {};
      function parse(key, cat) { try { var v = (cats[cat] || {})[key]; return v ? JSON.parse(v) : []; } catch (e) { return []; } }
      return {
        clients: parse("legal-mode.clients", "clients"),
        contracts: parse("legal-mode.contracts", "contracts"),
        calendar: parse("legal-mode.calendar", "calendar"),
        evidence: parse("legal-mode.evidence", "evidence"),
        documents: parse("legal-mode.documents", "documents"),
        approvals: parse("legal-mode.approvals", "approvals")
      };
    } catch (e) { return {}; }
  }
  var daysLeft = function (date) { var diff = Math.ceil((new Date(date) - new Date(new Date().toDateString())) / 86400000); return diff; };

  // —— 领域 skill 注册表：一个 AI 任务 = 一个 skill（深度绑定） ——
  var SKILLS = {
    transcribe: {
      name: "录音转写规范化",
      run: function (ev) {
        ev = ev || {};
        return "[录音转写 · " + (ev.name || "未命名") + "]\n" +
          "时间：" + nowStr() + "　时长：" + (ev.size ? fmt(ev.size) : "—") + "　上传人：" + (ev.uploader || "—") + "\n" +
          "—— 转写正文 ——\n" +
          "（0:00）【律师】你好，今天我们就本案的……进行沟通。\n" +
          "（0:12）【当事人】好的，关于……\n" +
          "（0:35）【律师】这里需要说明的是，对方的主张……\n" +
          "（1:20）【当事人】我同意，但……\n" +
          "……（接入 ASR 后为真实识别文本）……\n" +
          "—— 转写要点 ——\n" +
          "1. 当事人对……的事实无异议；\n" +
          "2. 争议焦点：……；\n" +
          "3. 律师建议：……。\n\n" +
          "（本稿由「深鲸律师端」AI 按转写规范生成，供参考）";
        function fmt(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB"; }
      }
    },
    "case-summary": {
      name: "案情摘要与风险",
      run: function (c) {
        c = c || {};
        var W = wb();
        var evid = (W.evidence || []).filter(function (e) { var k = (e.caseNo || e.caseRef || e.caseTitle || ""); return k.indexOf(c.no || "x") >= 0 || (e.caseTitle || "").indexOf(c.title || "x") >= 0 || (e.title || "").indexOf(c.title || "x") >= 0; }).length;
        var next = (W.calendar || []).filter(function (s) { return !s.completed; }).slice(0, 3);
        return "<dl class='ai-sum'>" +
          "<dt>案件要点</dt><dd>" + nl(c.party) + " 与对方就 " + nl(c.title || "案涉事项") + " 发生争议（案号：" + nl(c.no) + "，关联证据 " + evid + " 项）。</dd>" +
          "<dt>争议焦点</dt><dd>1) ……；2) ……（据卷宗归纳）。</dd>" +
          "<dt>初步风险</dt><dd>1) 证据方面……；2) 时效方面……；3) 管辖……。</dd>" +
          "<dt>建议方向</dt><dd>1) 补强证据……；2) 检索类案……；3) 明确诉讼请求……。</dd>" +
          (next.length ? "<dt>近期关键节点</dt><dd>" + next.map(function (s) { return nl(s.title) + "（" + nl(s.date) + "）"; }).join("；") + "</dd>" : "") +
          "</dl>";
      }
    },
    "contract-review": {
      name: "合同审查（风险条款）",
      run: function (ct) {
        ct = ct || {};
        var W = wb(); var list = W.contracts || [];
        return "<dl class='ai-sum'>" +
          "<dt>合同名称</dt><dd>" + nl(ct.title || "（未命名合同）") + "（库内合同共 " + list.length + " 份）</dd>" +
          "<dt>审查意见</dt><dd>1) 【违约责任】条款对己方不利，建议……；2) 【付款】条款……；3) 【争议解决】……；</dd>" +
          "<dt>修改建议</dt><dd>—— 建议将 X 条修改为……；—— 建议新增……条款。</dd>" +
          (list.length ? "<dt>在库合同</dt><dd>" + list.slice(0, 5).map(function (x) { return nl(x.name || x.type || "合同"); }).join("；") + "</dd>" : "") +
          "</dl>";
      }
    },
    deadline: {
      name: "期限预警与时效",
      run: function (evt) {
        evt = evt || {};
        var items = (wb().calendar || []).filter(function (s) { return !s.completed && s.date; });
        items.sort(function (a, b) { return daysLeft(a.date) - daysLeft(b.date); });
        var near = items.slice(0, 4);
        var h = "<div class='ai-deadline'>";
        if (evt.title) h += "<p><b>" + nl(evt.title) + "</b>：到期 " + nl(evt.date || "—") + "　距 <b>" + nl(evt.days !== undefined ? evt.days : daysLeft(evt.date)) + "</b> 天</p>";
        h += "<p><b>近期关键节点（来自你的日历看板）：</b></p><p>";
        if (near.length) h += near.map(function (s) { var dl = daysLeft(s.date); return "• " + nl(s.title) + "（" + nl(s.date) + "，" + (dl <= 0 ? "已到/逾期" : dl + " 天") + "）"; }).join("<br>");
        else h += "（暂无未完成节点）";
        h += "</p><p style='opacity:.7'>优先办理以上事项（依据法定期限/审限/举证期限）。</p></div>";
        return h;
      }
    },
    "intl-knowledge": {
      name: "涉外知识条目摘要（规范）",
      run: function (k) {
        k = k || {};
        return "<dl class='ai-sum'>" +
          "<dt>条目</dt><dd>" + nl(k.title || "（未命名）") + "</dd>" +
          "<dt>领域</dt><dd>" + nl(k.domain || "—") + "</dd>" +
          "<dt>要点</dt><dd>" + nl(k.summary || "—") + "</dd>" +
          "<dt>对办案的价值</dt><dd>1) 可能影响……；2) 建议关注……；3) 需结合具体事实核实。——（接 agent 算力后为真实规范化结论，此处为骨架）</dd>" +
          "</dl>";
      }
    },
    "intl-brief": {
      name: "今日涉外动态辑要",
      run: function (ev) {
        ev = ev || {};
        return "<div class='ai-deadline'>" +
          "<p><b>今日涉外法务动态</b>（" + nl(ev.date || "—") + "）</p>" +
          "<p>1) ……（涉外政策/立法）；2) ……（合规/制裁动态）；3) ……（仲裁/争议解决）。</p>" +
          "<p style='opacity:.7'>—— AI 依据本地知识库归并生成，须律师核实。</p></div>";
      }
    },
    "cross-border-compliance": {
      name: "涉外合规筛查备忘录",
      run: function (obj) {
        obj = obj || {};
        return "<div class='ai-deadline'>" +
          "<p><b>筛查对象</b>：" + nl(obj.type || "主体") + "：" + nl(obj.target || "—") + "</p>" +
          "<p><b>命中/风险</b>：" + nl(obj.risk || "待评估") + (obj.matched ? "　" + nl(obj.matched) : "") + "</p>" +
          "<p style='opacity:.7'><b>建议</b>：1) 结合官方实时清单复核；2) 补充最终用户/最终用途审查；3) 必要时做专项合规尽调并用人工结论定稿。</p>" +
          "<p style='opacity:.6'>—— AI 依据本地清单+规则初筛生成，须律师核实。</p></div>";
      }
    },
    "legal-translation": {
      name: "法律翻译（中英对照）",
      run: function (tr) {
        tr = tr || {};
        var src = nl(tr.text || "（待翻译文本）");
        var dir = tr.dir === "en-cn" ? "英中" : "中英";
        return "<div class='ai-deadline'>" +
          "<p><b>方向</b>：" + dir + "</p>" +
          "<p><b>译文（骨架）</b>：" + (dir === "英中" ? "（英译中示例：）" + src.slice(0, 80) : "（中译英示例：）" + src.slice(0, 80) + " …") + "</p>" +
          "<p style='opacity:.7'>—— 术语一致性见模块术语表；接 LLM 后为真实规范译文，此处为骨架。</p></div>";
      }
    },
    "legal-polish": {
      name: "法律文书润色 / 校对",
      run: function (t) {
        t = t || {};
        return "<div class='ai-deadline'>" +
          "<p><b>润色/校对（骨架）</b>：1) 术语规范；2) 逻辑与表述；3) 格式与落款。”—— 原文：" + nl(String(t.text || "").slice(0, 60)) + " …</p>" +
          "<p style='opacity:.6'>—— 接 LLM 后为真实润色结果，需律师复核定稿。</p></div>";
      }
    },
    "gba-lawyer": {
      name: "粤港澳大湾区专项目指引",
      run: function (g) {
        g = g || {};
        return "<div class='ai-deadline'>" +
          "<p><b>事项</b>：" + nl(g.type || "大湾区") + "：" + nl(g.target || "—") + "</p>" +
          "<p>1) 相关资质/执业范围以司法部规定为准；2) 结合港澳律师执业与内地法律衔接；3) 关注合作区（前海/横琴/南沙）便利化政策。</p>" +
          "<p style='opacity:.6'>—— AI 依据本地资料归纳，须律师核实。</p></div>";
      }
    },
    "intl-arbitration": {
      name: "国际仲裁选型与程序指引",
      run: function (a) {
        a = a || {};
        return "<div class='ai-deadline'>" +
          "<p><b>对象</b>：" + nl(a.type || "国际仲裁") + "：" + nl(a.target || "—") + "</p>" +
          "<p>考虑：1) 仲裁机构/规则；2) 仲裁地与语言；3) 仲裁庭组成；4) 费用与效率；5) 裁决执行地与《纽约公约》便利性。</p>" +
          "<p style='opacity:.6'>—— AI 依据本地机构资料归纳，须结合个案与律师判断。</p></div>";
      }
    },
    "foreign-judgment-enforcement": {
      name: "涉外裁决/判决执行可行性初判",
      run: function (e) {
        e = e || {};
        return "<div class='ai-deadline'>" +
          "<p><b>对象</b>：" + nl(e.type || "执行") + "：" + nl(e.target || "—") + "</p>" +
          "<p>要点：1) 是否适用《纽约公约》/国际条约或互惠；2) 程序与材料（裁决/判决正本、翻译、执行申请）；3) 正当程序与公共政策审查风险。</p>" +
          "<p style='opacity:.6'>—— 初判供参考，须由律师结合具体裁决/判决与执行地法律定稿。</p></div>";
      }
    }
  ,
    briefing: {
      name: "今日办案简报（顺案干活）",
      run: function (o) {
        o = o || {};
        var W = wb();
        var cases = o.cases || [];
        var up = (W.calendar || []).filter(function (s) { return !s.completed && s.date; })
          .sort(function (a, b) { return daysLeft(a.date) - daysLeft(b.date); });
        function urg(dl) { return dl <= 0 ? "badge-danger" : (dl <= 3 ? "badge-warning" : "badge-info"); }
        var overdue = up.filter(function (s) { return daysLeft(s.date) <= 0; });
        var near = up.filter(function (s) { var dl = daysLeft(s.date); return dl > 0 && dl <= 3; });
        if (!up.length && !cases.length) return "<div class='empty'>工作台暂无在办事项。</div>";
        var h = "<div class='card glow' style='margin-bottom:14px'><div class='card-head'><h2>重点提示</h2></div>" +
          "<div style='font-size:13px;line-height:1.8'>" +
          (overdue.length ? "<div style='color:var(--danger)'>有 <b>" + overdue.length + "</b> 个节点已到/逾期，请立即处理。</div>" : "") +
          (near.length ? "<div style='color:var(--warning)'>另有 <b>" + near.length + "</b> 个节点 3 天内临近。</div>" : "") +
          "当前在办案件 <b>" + cases.length + "</b> 条；库内合同 <b>" + (W.contracts || []).length + "</b> 份、证据 <b>" + (W.evidence || []).length + "</b> 项。</div></div>";
        if (up.length) {
          h += "<div class='card glow' style='margin-bottom:14px'><div class='card-head'><h2>近期必办</h2><span class='badge badge-info'>日历看板</span></div>" +
            "<div style='display:grid;grid-template-columns:1fr 1fr;gap:8px'>" +
            up.slice(0, 6).map(function (s) { var dl = daysLeft(s.date); var tip = dl <= 0 ? "已到期，建议立即办理并及时告知当事人。" : (dl <= 3 ? "临近，建议本周内处理并备好材料。" : "时间较充裕，建议提前准备、留足余量。"); return "<div style='padding:9px 12px;border:1px solid rgba(127,127,127,.14);border-radius:10px;background:rgba(127,127,127,.04)'><div style='display:flex;align-items:center;justify-content:space-between;gap:8px'><span>" + nl(s.title || "节点") + "</span><span class='badge " + urg(dl) + "'>" + (dl <= 0 ? "已到" : dl + " 天") + "</span></div><div style='font-size:12px;opacity:.7;margin-top:5px'>" + tip + "</div></div>"; }).join("") +
            "</div></div>";
        }
        if (cases.length) {
          h += "<div class='card glow'><div class='card-head'><h2>在办案件</h2></div><div style='display:flex;gap:8px;flex-wrap:wrap'>" +
            cases.slice(0, 8).map(function (c) { return "<span class='badge badge-info'>" + nl(c.title || c.no || c.party || "案") + "</span>"; }).join("") + "</div></div>";
        }
        return h;
      }
    }
  };

  // —— 统一 AI 桥 ——
  function run(task, params) {
    try {
      var sk = SKILLS[task];
      if (!sk) return "<p>（该项目暂未绑定 skill）</p>";
      return sk.run ? sk.run(params) : ("<p>[" + sk.name + "]</p>");
    } catch (e) {
      return "<p>AI 生成失败，请重试。</p>";
    }
  }

  window.__callAI = function (task, params) { return run(task, params); };

  // ====================================================================
  // 真实算力桥（桌面端/网页端）：读工作台真实数据 → 构造 prompt → 调 __llmChat
  // 无算力（window.__llmChat 不存在）或失败时回退到上面的同步骨架。
  // ====================================================================
  var MODEL_DEFAULT = "deepseek-v4-flash";

  // 按 task 生成 system+user prompt。params 里带真实数据。
  function buildPrompt(task, params) {
    var W = wb();
    var d = { clients: W.clients || [], contracts: W.contracts || [], calendar: W.calendar || [], evidence: W.evidence || [], documents: W.documents || [], approvals: W.approvals || [] };
    var sys = "你是「深鲸·律师端」的法律 AI，中国执业律师的智能助手。输出专业、严谨、合规、可直接使用的法律内容，用中文。客户个人信息（姓名、证件号、电话、地址等）严格保密，回答问题以法律法规和本机工作台数据为依据。";
    var L = {
      briefing: function () {
        var c = params.cases || [];
        var up = d.calendar.filter(function (s) { return !s.completed && s.date; }).sort(function (a, b) { return daysLeft(a.date) - daysLeft(b.date); });
        var lines = up.slice(0, 12).map(function (s) { return "- " + (s.title || "节点") + "（" + s.date + "，距今" + daysLeft(s.date) + "天）"; }).join("\n");
        return { system: sys, user: "你是律师工作台的办案助理。请基于以下【真实工作台数据】生成一份「今日办案简报」，分三块：\n1) 重点提示：已到期/临近的关键节点；\n2) 近期必办：按时间排序的待办清单，每条给一句处理建议；\n3) 在办案件概览。\n\n【在办案件】" + JSON.stringify(c) + "\n【日历/期限】\n" + (lines || "（暂无）") + "\n【库内统计】合同 " + d.contracts.length + " 份、证据 " + d.evidence.length + " 项、客户 " + d.clients.length + " 位。\n请只输出简报正文（用小标题+要点列表）。" };
      },
      "case-summary": function () {
        var c = params || {};
        var matching = d.evidence.filter(function (e) { return (e.caseNo || e.caseTitle || e.title || "").indexOf(c.no || c.title || "") >= 0; });
        return { system: sys, user: "请为该案件生成「案情摘要与风险分析」：\n【案件】" + JSON.stringify(c) + "\n【关联证据】" + JSON.stringify(matching.slice(0, 8)) + "\n请输出：1)案件要点；2)争议焦点；3)初步风险（证据/时效/管辖）；4)建议方向。只输出正文。" };
      },
      "contract-review": function () {
        var ct = params || {};
        var list = d.contracts;
        return { system: sys, user: "请审查以下合同并给出【风险条款审查意见】：\n【本合同】" + JSON.stringify(ct) + "\n【库内其他合同参考】" + JSON.stringify(list.slice(0, 5)) + "\n输出：1)审查意见（违约责任/付款/争议解决等）；2)修改建议（具体条款）。只输出正文。" };
      },
      deadline: function () {
        var evt = params || {};
        var items = d.calendar.filter(function (s) { return !s.completed && s.date; }).sort(function (a, b) { return daysLeft(a.date) - daysLeft(b.date); });
        return { system: sys, user: "请基于以下期限数据生成「期限预警与时效提示」，优先办理：\n【当前事项】" + JSON.stringify(evt) + "\n【近期节点】" + JSON.stringify(items.slice(0, 8)) + "\n输出：每条节点的处理优先级与建议（依据法定期限/审限/举证期限）。只输出正文。" };
      },
      transcribe: function () {
        var ev = params || {};
        return { system: sys, user: "请对以下【录音转写】内容做规范化整理，生成谈话要点：\n【文件】" + (ev.name || "未命名") + "，时长 " + (ev.size || "—") + "\n【原文】" + (ev.raw || ev.text || "（请在下方粘贴或上传转写原文）") + "\n输出：1)对话要点；2)争议焦点；3)对案件有价值的待办事项。" };
      },
      "intl-knowledge": function () {
        var k = params || {};
        return { system: sys, user: "请对下列【涉外法律知识条目】做摘要与实务提示：\n【条目】" + JSON.stringify(k) + "\n输出：1)条目要点；2)对跨境/涉外办案的价值；3)需律师进一步核实的事项。" };
      },
      "intl-brief": function () {
        return { system: sys, user: "请生成一份「今日涉外法务动态辑要」，覆盖：1)涉外政策/立法；2)合规/制裁动态；3)仲裁/争议解决。若信息不足请说明并提示律师关注官方网站核实。只输出正文。" };
      },
      "cross-border-compliance": function () {
        var o = params || {};
        return { system: sys, user: "请对下列【涉外主体】做合规筛查备忘录：\n【对象】" + JSON.stringify(o) + "\n输出：1)命中/风险；2)建议（结合官方实时清单复核、最终用户/最终用途审查、专项尽调）。只输出正文。" };
      },
      "legal-translation": function () {
        var tr = params || {};
        var dir = tr.dir === "en-cn" ? "英译中" : "中译英";
        return { system: sys, user: "请做以下" + dir + "（法律文本，术语规范、专业、忠实原文）：\n【原文】" + (tr.text || "") + "\n只输出译文正文。" };
      },
      "legal-polish": function () {
        var t = params || {};
        return { system: sys, user: "请润色/校对以下法律文书，要求：术语规范、逻辑清楚、表述严谨、格式符合法律文书惯例：\n【原文】" + (t.text || "") + "\n只输出润色后的全文。" };
      },
      "gba-lawyer": function () {
        var g = params || {};
        return { system: sys, user: "请针对下列【粤港澳大湾区】事项给出执业指引：\n【事项】" + JSON.stringify(g) + "\n输出：1)资质/执业范围；2)内地与港澳法律衔接；3)合作区（前海/横琴/南沙）便利化政策。只输出正文。" };
      },
      "intl-arbitration": function () {
        var a = params || {};
        return { system: sys, user: "请针对下列【国际仲裁】事项给出选型与程序指引：\n【对象】" + JSON.stringify(a) + "\n输出：1)仲裁机构/规则选型；2)仲裁地与语言；3)仲裁庭组成；4)费用与效率；5)裁决执行与《纽约公约》便利性。只输出正文。" };
      },
      "foreign-judgment-enforcement": function () {
        var e = params || {};
        return { system: sys, user: "请针对下列【涉外裁决/判决执行】做可行性初判：\n【对象】" + JSON.stringify(e) + "\n输出：1)是否适用《纽约公约》/国际条约或互惠；2)程序与材料（正本/翻译/执行申请）；3)正当程序与公共政策风险。只输出正文。" };
      }
    };
    var builder = L[task];
    if (!builder) { return null; }
    try { return builder(); } catch (e) { return null; }
  }

  // 异步：读真实数据 → LLM → 返回 HTML；失败回退骨架
  function runLLM(task, params) {
    if (typeof window.__llmChat !== "function") {
      // 无算力：回退同步骨架
      return Promise.resolve({ content: run(task, params), llm: false });
    }
    var pr = buildPrompt(task, params);
    if (!pr || !pr.system || !pr.user) {
      return Promise.resolve({ content: run(task, params), llm: false });
    }
    var model = (window.__AI_MODEL__) || MODEL_DEFAULT;
    var opts = { model: model, messages: [{ role: "system", content: pr.system }, { role: "user", content: pr.user }], maxTokens: 2200 };
    // 算力路由：一律走「用户自备 DeepSeek Key」（A款/公益免费版均自备，不提供集团算力）
    // 优先经 window.KeyMgr 读取（支持按端 key / 联动共用）；无 KeyMgr 则回退读旧 legal-mode.llm
    var apiKey = "";
    var baseURL = "";
    if (window.KeyMgr && window.KeyMgr.getKey) {
      apiKey = window.KeyMgr.getKey("legal");
      baseURL = window.KeyMgr.getBase("legal");
    } else {
      try { var c = JSON.parse(localStorage.getItem("legal-mode.llm") || "null"); if (c && c.apiKey) { apiKey = c.apiKey; baseURL = c.baseURL || ""; } } catch (e) {}
    }
    if (!apiKey) {
      // 未配置 key：不把提示当内容显示，而是引导用户去配置
      if (window.onNeedKey) { window.onNeedKey(); }
      return Promise.resolve({ content: "", llm: false, needKey: true, silent: true });
    }
    opts.key = apiKey; opts.baseURL = baseURL || undefined;
    return window.__llmChat(opts).then(function (r) {
      if (r && r.ok && r.content) {
        // r.content 已是渲染好的富 HTML（含卡片等），直接输出，避免二次转义导致标签裸出
        return { content: "<div class='ai-sum' style='white-space:pre-line;line-height:1.8'>" + r.content + "</div>", llm: true };
      }
      // LLM 失败：回退骨架，并附提示
      return { content: "<div class='ai-sum' style='white-space:pre-line;line-height:1.8'>" + run(task, params) + "</div><div style='margin-top:8px;font-size:12px;opacity:.6'>（本次未走真实算力：" + esc(r && r.msg || "已回退本地模板") + "）</div>", llm: false };
    }).catch(function (e) {
      return { content: run(task, params), llm: false };
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // 统一暴露：__callAIAsync(task, params) -> Promise<{content, llm}>
  window.__callAIAsync = function (task, params) {
    return runLLM(task, params);
  };
  window.__AI_SKILLS__ = SKILLS;
})();
