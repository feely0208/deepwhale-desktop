/* =========================================================================
   workbench.js — 工作台：模拟数据 / 侧边导航切换 / 仪表盘 / 启动自动切换
   ========================================================================= */
(function () {
  // —— 统一 AI 渲染：优先真实算力(__callAIAsync)，无则回退同步骨架(__callAI) ——
  // renderAIContent(el, task, params, loadingText)：先在 el 里显示 loading，再异步填入结果。
  function renderAIContent(el, task, params, loadingText) {
    if (!el) return;
    el.innerHTML = "<div class='ai-box'><span class='ev-empty'>" + (loadingText || "正在调用法律模式生成…") + "</span></div>";
    if (window.__callAIAsync && typeof window.__callAIAsync === "function") {
      window.__callAIAsync(task, params).then(function (res) {
        var html = (res && res.content) || "";
        el.innerHTML = html || "<span class='ev-empty'>（未生成内容）</span>";
      }).catch(function () {
        el.innerHTML = (window.__callAI ? window.__callAI(task, params) : "（AI 生成失败）");
      });
    } else if (window.__callAI) {
      el.innerHTML = window.__callAI(task, params);
    } else {
      el.innerHTML = "（未接 AI 桥）";
    }
  }
  window.__renderAIContent = renderAIContent;

  // —— 模拟业务数据（参考"律师案件管理系统"领域模型） ——
  const mock = {
    stats: [
      { label: "进行中案件", value: "12", icon: "briefcase", foot: "<span class='up'> 8%</span> 较上月" },
      { label: "本月新收", value: "5", icon: "chart", foot: "<span class='up'> 2</span> 件" },
      { label: "待收费用", value: "¥86.4万", icon: "wallet", foot: "<span class='up'> 12%</span> 回款率" },
      { label: "本周开庭", value: "3", icon: "calendar", foot: "<span class='down'> 1</span> 场" },
    ],
    cases: [
      { no: "（2026）沪0104民初3291号", title: "林某某与某某公司劳动争议案", type: "民事", party: "林某某", court: "上海市徐汇区人民法院", status: "审理中", priority: "高", progress: 72, lawyer: "张冬宝", date: "2026-08-12" },
      { no: "（2026）京02刑初88号", title: "王某涉嫌帮助信息网络犯罪活动案", type: "刑事", party: "王某", court: "北京市第二中级人民法院", status: "已立案", priority: "中", progress: 45, lawyer: "李慧敏", date: "2026-08-05" },
      { no: "（2026）浙民终512号", title: "甲公司诉乙公司买卖合同纠纷", type: "民事", party: "甲公司", court: "浙江省高级人民法院", status: "等待开庭", priority: "高", progress: 88, lawyer: "张冬宝", date: "2026-07-28" },
      { no: "（2026）粤0106行初34号", title: "陈某不服行政处罚决定案", type: "行政", party: "陈某", court: "广州市天河区人民法院", status: "举证中", priority: "低", progress: 30, lawyer: "王建国", date: "2026-08-20" },
      { no: "（2026）苏05执127号", title: "某银行与某贸易公司执行案", type: "执行", party: "某银行", court: "苏州市中级人民法院", status: "执行中", priority: "中", progress: 55, lawyer: "李慧敏", date: "2026-08-18" },
      { no: "（2026）川01民初776号", title: "周某与某保险公司保险合同纠纷", type: "民事", party: "周某", court: "成都市中级人民法院", status: "待立案", priority: "低", progress: 12, lawyer: "王建国", date: "2026-08-22" },
    ],
    progress: [
      { name: "林某某与某某公司劳动争议案", pct: 72 },
      { name: "甲公司诉乙公司买卖合同纠纷", pct: 88 },
      { name: "某银行与某贸易公司执行案", pct: 55 },
      { name: "王某涉嫌帮助信息网络犯罪活动案", pct: 45 },
    ],
    schedule: [
      { title: "林某某劳动争议案 一审开庭", time: "今日 09:30", meta: "上海市徐汇区人民法院 · 第12法庭", done: false },
      { title: "会见当事人 王某", time: "今日 15:00", meta: "律所 · 会客室B", done: false },
      { title: "甲公司买卖合同案 提交代理词", time: "明日 17:00 前", meta: "浙江省高级人民法院 送达平台", done: true },
      { title: "陈某行政处罚案 举证期限届满", time: "08-28", meta: "距届满 5 天", done: false },
    ],
  };

  const NAV = [
    { key: "dashboard", label: "仪表盘", icon: "grid" },
    { label: "业务", kind: "label" },
    { key: "cases", label: "案件管理", icon: "briefcase" },
    { key: "approval", label: "授权签批", icon: "badge" },
    { key: "board", label: "系统看板", icon: "chart" },
    { key: "clients", label: "客户管理", icon: "users" },
    { key: "contracts", label: "合同管理", icon: "file" },
    { key: "finance", label: "财务管理", icon: "wallet" },
    { key: "schedule", label: "日历看板", icon: "calendar" },
    { key: "documents", label: "文书管理", icon: "folder" },
    { key: "evidence", label: "证据材料", icon: "folder" },
    { key: "intlkb", label: "涉外法律知识库", icon: "globe" },
    { key: "intlcomp", label: "跨境合规筛查", icon: "shield" },
    { key: "intldocs", label: "涉外双语文书", icon: "lang" },
    { key: "intlgba", label: "港澳大湾区", icon: "bridge" },
    { key: "intlarb", label: "国际仲裁", icon: "gavel" },
    { key: "reports", label: "报表中心", icon: "chart" },
    { label: "团队", kind: "label" },
    { key: "settings", label: "系统设置", icon: "settings" },
    { key: "profile", label: "个人中心", icon: "user" },
  ];

  const ICONS = {
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    briefcase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16.5" cy="14" r="1"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/></svg>',
    badge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="9" r="5"/><path d="M9 13.5 7 21l5-3 5 3-2-7.5"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 15-5-5-9 9"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 16V4M6 10l6-6 6 6"/><path d="M5 20h14"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 3v6c0 4-2.5 7-7 9-4.5-2-7-5-7-9V6z"/><path d="m9 12 2 2 4-4"/></svg>',
    lang: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8l-3 3v-3H5a1 1 0 0 1-1-1z"/><path d="M15 9h3a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-1v2l-2-2h-2"/></svg>',
    bridge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17c5-8 13-8 18 0M6 17V9M12 17V7M18 17V9M2 19h20"/></svg>',
    gavel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m13 6 5 5-1.5 1.5-5-5zM11 8l5 5M3 21l9-5M4 20l4 2M8 17l4 2M6 4l3 3"/></svg>',
  };

  const STATUS_BADGE = {
    "审理中": "badge-info", "已立案": "badge-success", "等待开庭": "badge-warning",
    "举证中": "badge-warning", "执行中": "badge-info", "待立案": "badge-danger",
  };
  const PRIORITY_BADGE = { "高": "badge-danger", "中": "badge-warning", "低": "badge-success" };

  const el = {
    boot: document.getElementById("boot"),
    app: document.getElementById("app"),
    nav: document.getElementById("nav"),
    content: document.getElementById("content"),
    themeBtn: document.getElementById("themeBtn"),
    wallBtn: document.getElementById("wallBtn"),
    wallPanel: document.getElementById("wallPanel"),
    wpGrid: document.getElementById("wpGrid"),
  };

  let active = "dashboard";
  let curTitle = "";
  let curSub = "";

  // —— 渲染导航 ——
  function renderNav() {
    el.nav.innerHTML = NAV.map(function (n) {
      if (n.kind === "label") return '<div class="nav-label">' + n.label + "</div>";
      const icon = ICONS[n.icon] || "";
      const count = n.key === "cases" ? mock.cases.length : "";
      return (
        '<button class="nav-item glow' + (n.key === active ? " active" : "") + '" data-key="' + n.key + '">' +
        '<span class="ico">' + icon + "</span><span>" + n.label + "</span>" +
        (count ? '<span class="count">' + count + "</span>" : "") +
        "</button>"
      );
    }).join("");
    el.nav.querySelectorAll("[data-key]").forEach(function (b) {
      b.addEventListener("click", function () { switchTo(b.getAttribute("data-key")); });
    });
  }

  // —— 导航历史 / 返回 ——
  const TITLES = {
    dashboard: "仪表盘", cases: "案件管理", approval: "授权签批", board: "系统看板", clients: "客户管理", contracts: "合同管理",
    finance: "财务管理", schedule: "日历看板", documents: "文书管理", evidence: "证据材料",
    intlkb: "涉外法律知识库",
    intlcomp: "跨境合规筛查",
    intldocs: "涉外双语文书",
    intlgba: "港澳大湾区",
    intlarb: "国际仲裁",
    reports: "报表中心", settings: "系统设置", profile: "个人中心",
  };
  const navStack = [];

  function updateCrumb() {
    const path = document.getElementById("crumbPath");
    const backBtn = document.getElementById("backBtn");
    // 仪表盘页：面包屑不显示"法律工作台"（与页面大标题重复，突兀）；仅显示当前模块路径
    if (path) path.innerHTML = (active === "dashboard") ? "" : "法律工作台 <span>/</span> <b>" + (TITLES[active] || active) + "</b>";
    if (backBtn) backBtn.classList.toggle("hidden", navStack.length === 0 || active === "dashboard");
  }

  function switchTo(key) {
    if (active !== key) navStack.push(active);
    renderView(key);
  }
  function back() {
    if (!navStack.length) return;
    renderView(navStack.pop());
  }

  function renderView(key) {
    active = key;
    renderNav();
    const def = {
      dashboard: ["仪表盘", "欢迎回到律师工作台，今日 3 场庭审、1 项待办"],
      cases: ["案件管理", "共 " + mock.cases.length + " 件案件，支持按状态/类型/优先级检索"],
      approval: ["授权签批", "案号+核心内容导出 PDF  授权人电子签  双方留档"],
      board: ["系统看板", "案件阶段甘特图 · 状态/类型环形图 · 期限临近 · 律师负荷"],
      clients: ["客户管理", "当事人与委托人档案"],
      contracts: ["合同管理", "委托合同与法律顾问合同"],
      finance: ["财务管理", "收入 / 支出 / 待收费用统计"],
      schedule: ["日历看板", "每日/未来节点安排 · 期限预警与倒计时"],
      documents: ["文书管理", "起诉状、代理词、证据目录等"],
      evidence: ["证据材料", "视频 / 录音证据的元数据、转写与随时调看"],
      intlkb: ["涉外法律知识库", "抓取并直连本地的涉外法律知识 · 新《律师法》第七条"],
      intlcomp: ["跨境合规筛查", "清单筛查 · 物项定级 · 交易体检 · 数据出境评估"],
      intldocs: ["涉外双语文书", "中英模板 · 生成/编辑 · 法律翻译 · 公证/海牙认证指引"],
      intlgba: ["港澳大湾区", "九市执业 · 港澳律师资质 · 合作区政策 · 跨境协作登记"],
      intlarb: ["国际仲裁", "机构对比 · 争议解决条款 · 程序节点 · 承认与执行 · 涉案登记"],
      reports: ["报表中心", "案件量与创收分析报表"],
      settings: ["系统设置", "工作台外观与壁纸偏好"],
      profile: ["个人中心", "当前律师账号信息"],
    }[key] || ["", ""];
    curTitle = def[0];
    curSub = def[1];

    if (key === "dashboard") renderDashboard();
    else if (key === "cases") renderCases();
    else if (key === "approval") renderApprovalView();
    else if (key === "board") renderBoard();
    else if (key === "schedule") renderCalendar();
    else if (key === "evidence") renderEvidenceView();
    else if (key === "documents") renderDocuments();
    else if (key === "intlkb" && window.IntlKB) IntlKB.render(el.content, curTitle, curSub);
    else if (key === "intlcomp" && window.IntlCompliance) IntlCompliance.render(el.content, curTitle, curSub);
    else if (key === "intldocs" && window.IntlDocs) IntlDocs.render(el.content, curTitle, curSub);
    else if (key === "intlgba" && window.IntlGba) IntlGba.render(el.content, curTitle, curSub);
    else if (key === "intlarb" && window.IntlArb) IntlArb.render(el.content, curTitle, curSub);
    else renderModuleStub(key, def[0]);

    updateCrumb();
    el.content.scrollTop = 0;
  }

  // —— 仪表盘 ——
  function renderDashboard() {
    const statCards = mock.stats.map(function (s) {
      return (
        '<div class="stat-card glow">' +
        '<div class="stat-icon">' + (ICONS[s.icon] || s.icon) + "</div>" +
        '<div class="stat-label">' + s.label + '</div><div class="stat-value">' + s.value + "</div>" +
        '<div class="stat-foot">' + s.foot + "</div></div>"
      );
    }).join("");

    const progress = mock.progress.map(function (p) {
      return (
        '<div class="case-progress-item">' +
        '<div class="row"><span class="name link" data-switch="cases" title="前往案件">' + p.name + '</span><span class="pct">' + p.pct + "%</span></div>" +
        '<div class="progress"><div class="progress-bar progress-bar--gradient" style="width:' + p.pct + '%"></div></div>' +
        "</div>"
      );
    }).join("");

    const tl = mock.schedule.map(function (s) {
      return (
        '<div class="tl-item' + (s.done ? " done" : "") + '">' +
        '<div class="tl-dot"><i></i></div>' +
        '<div class="tl-body"><div class="tl-title">' + s.title + '</div>' +
        '<div class="tl-meta">' + s.meta + " · " + s.time + "</div></div></div>"
      );
    }).join("");

    const rows = mock.cases.slice(0, 6).map(function (c) {
      return (
        "<tr data-link><td><strong><span class='link' data-switch='cases' title='前往案件'>" + c.title + "</span></strong><div class='tl-meta'>" + c.no + "</div></td>" +
        "<td>" + c.type + "</td><td>" + c.court + "</td>" +
        "<td><span class='badge " + (STATUS_BADGE[c.status] || "badge-info") + "'><i class='badge-dot'></i>" + c.status + "</span></td>" +
        "<td>" + c.lawyer + "</td>" +
        "<td><span class='badge " + (PRIORITY_BADGE[c.priority] || "badge-info") + "'>" + c.priority + "</span></td>" +
        "<td><div class='progress' style='min-width:80px'><div class='progress-bar' style='width:" + c.progress + "%'></div></div></td>" +
        "</tr>"
      );
    }).join("");

    el.content.innerHTML =
      '<div class="page-head"><div><h1>' + curTitle + "</h1><div class='sub'>" + curSub + "</div></div>" +
      '<div style="display:flex;gap:10px;align-items:center"><button class="btn btn-ghost glow" id="dashAiBtn">AI 简报</button><button class="btn btn-primary glow" id="newCaseBtn">＋ 新建案件</button></div></div>' +
      '<div class="grid cols-4">' + statCards + "</div>" +
      '<div id="dashAiPanel" style="margin-top:18px"></div>' +
      '<div class="grid" style="grid-template-columns: 1.4fr 1fr;margin-top:18px">' +
        '<div class="card glow"><div class="card-head"><h2>案件进度</h2><span class="link" data-switch="cases">查看全部</span></div>' +
          '<div class="case-progress-list">' + progress + "</div></div>" +
        '<div class="card glow"><div class="card-head"><h2>今日 / 待办日程</h2><span class="link" data-switch="schedule">日程管理</span></div>' +
          '<div class="timeline">' + tl + "</div></div>" +
      "</div>" +
      '<div class="card glow" style="margin-top:18px"><div class="card-head"><h2>最新案件</h2>' +
        '<span class="link" data-switch="cases">全部案件</span></div>' +
        '<table class="table"><thead><tr><th>案件</th><th>类型</th><th>法院</th><th>状态</th><th>承办律师</th><th>优先级</th><th>进度</th></tr></thead><tbody>' +
        rows + "</tbody></table></div>";

    const nb = document.getElementById("newCaseBtn");
    if (nb) nb.addEventListener("click", openNewCaseModal);
    const di = document.getElementById("dashAiBtn");
    if (di) di.addEventListener("click", function () {
      const panel = document.getElementById("dashAiPanel");
      if (!panel) return;
      panel.innerHTML = "<div class='ai-box'><span class='ev-empty'>正在生成今日办案简报（读取工作台数据）…</span></div>";
      const out = (window.__callAIAsync ? window.__callAIAsync("briefing", { cases: mock.cases }) : Promise.resolve({ content: (window.__callAI ? window.__callAI("briefing", { cases: mock.cases }) : "<p>（未接 AI 桥）</p>") }));
      out.then(function (res) { panel.innerHTML = "<div class='card-head' style='margin-bottom:12px'><h2>今日办案简报</h2><span class='badge badge-info'>基于你的工作台数据</span></div>" + ((res && res.content) || ""); })
        .catch(function () { panel.innerHTML = "<div class='card-head' style='margin-bottom:12px'><h2>今日办案简报</h2></div><p>（生成失败）</p>"; });
    });
    el.content.querySelectorAll("[data-switch]").forEach(function (b) {
      b.addEventListener("click", function () { switchTo(b.getAttribute("data-switch")); });
    });
  }

  // —— 案件管理（列表页示例） ——
  let caseFilter = "all";
  const CASE_KEY = "legal-mode.cases";
  function getCases() {
    try { var v = localStorage.getItem(CASE_KEY); var a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function saveCases(arr) { try { localStorage.setItem(CASE_KEY, JSON.stringify(arr)); } catch (e) {} }
  function renderCases() {
    const groups = {
      ongoing: ["审理中", "等待开庭", "已立案"],
      todo: ["待立案", "举证中"],
      closed: ["执行中"],
    };
    const userCases = getCases();
    const list = (userCases.length ? userCases : mock.cases).filter(function (c) {
      if (caseFilter === "all") return true;
      return (groups[caseFilter] || []).indexOf(c.status) >= 0;
    });
    const tabs = [["all", "全部"], ["ongoing", "进行中"], ["todo", "待办"], ["closed", "已结"]].map(function (t) {
      return "<button class='" + (caseFilter === t[0] ? "active" : "") + "' data-cf='" + t[0] + "'>" + t[1] + "</button>";
    }).join("");
    const rows = list.map(function (c) {
      return (
        "<tr data-link><td><strong><span class='link' data-open='" + c.no + "' title='打开案件详情'>" + c.title + "</span></strong><div class='tl-meta'>" + c.no + "</div></td>" +
        "<td>" + c.type + "</td><td>" + c.party + "</td><td>" + c.court + "</td>" +
        "<td><span class='badge " + (STATUS_BADGE[c.status] || "badge-info") + "'><i class='badge-dot'></i>" + c.status + "</span></td>" +
        "<td>" + c.lawyer + "</td><td>" + c.date + "</td>" +
        "<td><span class='badge " + (PRIORITY_BADGE[c.priority] || "badge-info") + "'>" + c.priority + "</span></td>" +
        "<td><button class='btn btn-sm btn-primary' data-open='" + c.no + "'>详情</button></td></tr>"
      );
    }).join("");

    el.content.innerHTML =
      '<div class="page-head"><div><h1>' + curTitle + "</h1><div class='sub'>" + curSub + "</div></div>" +
      '<div style="display:flex;gap:10px;align-items:center">' +
      '<div class="tabs">' + tabs + "</div>" +
      '<button class="btn btn-ghost glow" onclick="window.DataImport && window.DataImport.open(\'cases\')"> 导入(Excel/CSV)</button>' +
      '<button class="btn btn-primary glow" id="newCaseBtn">＋ 新建案件</button></div></div>' +
      '<div class="card glow"><div class="card-head"><h2>案件列表（' + list.length + '）</h2>' +
      '<span class="badge badge-info">点击案件标题查看详情</span></div>' +
      '<table class="table"><thead><tr><th>案件</th><th>类型</th><th>当事人</th><th>法院</th><th>状态</th><th>承办律师</th><th>立案日期</th><th>优先级</th><th></th></tr></thead><tbody>' +
      (rows || "<tr><td colspan='9'><div class='empty'>该状态下暂无案件</div></td></tr>") + "</tbody></table></div>";

    el.content.querySelectorAll("[data-cf]").forEach(function (b) {
      b.addEventListener("click", function () { caseFilter = b.getAttribute("data-cf"); renderCases(); });
    });
    el.content.querySelectorAll("[data-open]").forEach(function (b) {
      b.addEventListener("click", function () {
        const src = getCases().length ? getCases() : mock.cases;
        const c = src.find(function (x) { return x.no === b.getAttribute("data-open"); });
        if (c) openCaseDetail(c);
      });
    });
    const nb = document.getElementById("newCaseBtn");
    if (nb) nb.addEventListener("click", openNewCaseModal);
  }

  function openCaseDetail(c) {
    const m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML = "<div class='modal glow' style='width:640px'>" +
      "<div class='card-head'><h3>" + c.title + "</h3><span class='badge " + (STATUS_BADGE[c.status] || "badge-info") + "'>" + c.status + "</span></div>" +
      "<div class='doc-meta'>" +
      "<div class='mi'><b>案号</b><span>" + c.no + "</span></div><div class='mi'><b>类型</b><span>" + c.type + "</span></div>" +
      "<div class='mi'><b>当事人</b><span>" + c.party + "</span></div><div class='mi'><b>法院</b><span>" + c.court + "</span></div>" +
      "<div class='mi'><b>承办人</b><span>" + c.lawyer + "</span></div><div class='mi'><b>优先级</b><span>" + c.priority + "</span></div>" +
      "<div class='mi'><b>立案日期</b><span>" + c.date + "</span></div><div class='mi'><b>进度</b><span>" + c.progress + "%</span></div>" +
      "</div>" +
      "<div class='card-head' style='margin-top:16px'><h2>关联操作 · 直达源头</h2></div>" +
      "<div style='display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px'>" +
      "<button class='btn btn-ghost btn-sm' data-go='documents'> 文书生成</button>" +
      "<button class='btn btn-ghost btn-sm' data-go='evidence'> 证据材料</button>" +
      "<button class='btn btn-ghost btn-sm' data-go='contracts'> 合同</button>" +
      "<button class='btn btn-ghost btn-sm' data-go='schedule'> 日程/日历</button>" +
      "<button class='btn btn-ghost btn-sm' data-go='approval'> 授权签批</button>" +
      "</div>" +
      "<div class='card-head' style='margin-top:14px'><h2>AI 智能摘要</h2></div>" +
      "<div id='case-ai' class='ai-box' style='margin-bottom:14px'><span class='ev-empty'>点击「AI 摘要」由法律模式生成（规范化·参考）</span></div>" +
      "<div class='modal-actions'><button class='btn btn-primary' id='caseAIBtn'>AI 摘要</button><button class='btn btn-ghost' data-close>关闭</button></div></div>";
    document.body.appendChild(m);
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target && e.target.id === "caseAIBtn") { renderAIContent(document.getElementById("case-ai"), "case-summary", c, "正在生成案情摘要…"); return; }
      if (e.target.hasAttribute && e.target.hasAttribute("data-go")) { m.remove(); switchTo(e.target.getAttribute("data-go")); }
    });
  }

  // —— 其它模块：占位框架 ——
  // —— 空白模块填充（第5条配套）：虚拟数据 + 直达源头链接 ——
  function renderModuleStub(key, title) {
    const row = function (tds, links) {
      const linkHtml = links.map(function (l) {
        return "<span class='link' data-switch='" + l.k + "' title='前往" + l.t + "'>" + l.t + " </span>";
      }).join(" ");
      return "<tr><td><div style='display:flex;flex-wrap:wrap;gap:8px'>" + tds.join("</div></td><td><div>") +
        "</div></td><td><div style='display:flex;gap:8px;flex-direction:column'>" + linkHtml + "</div></td></tr>";
    };
    const table = function (ths, rowsHtml) {
      return "<table class='table'><thead><tr>" + ths.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "<th>直达</th></tr></thead><tbody>" + rowsHtml + "</tbody></table>";
    };
    const head = function (sub, btn) {
      return '<div class="page-head"><div><h1>' + title + "</h1><div class='sub'>" + sub + "</div></div>" + (btn || "") + "</div>";
    };
    const go = function (k, t) { return "<span class='link' data-switch='" + k + "' title='前往" + t + "'>" + t + " </span>"; };

    let html = "";
    if (key === "clients") {
      // 优先显示用户数据(clientsStore)，无则 demo 兜底
      const storeNames = Object.keys(clientsStore);
      const d = storeNames.length
        ? storeNames.map(function (n) { const c = clientsStore[n] || {}; return [n, c.type || "当事人", c.phone || "", (c.notes || "")]; })
        : [
            ["林某某", "当事人", "138****1234", "林某某与某某公司劳动争议案"],
            ["甲公司", "企业客户", "0571****888", "甲公司诉乙公司买卖合同纠纷"],
            ["陈某", "当事人", "139****5678", "陈某不服行政处罚决定案"],
            ["李慧敏", "合作律师", "137****4444", "王某涉嫌帮助信息网络犯罪活动案"],
          ];
      const total = storeNames.length || 4;
      html = head("当事人、委托人、合作律师档案", "<button class='btn btn-ghost glow' onclick='window.DataImport && window.DataImport.open(\"clients\")'> 导入(Excel/CSV)</button><button class='btn btn-primary glow' onclick='window.openClientNew()'>＋ 新增客户</button>") +
        "<div class='fin-hero'>" +
        "<div class='fh-card main'><div class='fh-label'> 客户总数</div><div class='fh-val'>" + total + "</div><div class='fh-sub'>在办关联 6 件</div></div>" +
        "<div class='fh-card amber'><div class='fh-label'> 企业客户</div><div class='fh-val'>1</div><div class='fh-sub'>常年顾问</div></div>" +
        "<div class='fh-card green'><div class='fh-label'> 在办关联案件</div><div class='fh-val'>6</div><div class='fh-sub'>含 3 件在办</div></div>" +
        "<div class='fh-card red'><div class='fh-label'> 本月新增</div><div class='fh-val'>2</div><div class='fh-sub'>较上月 +1</div></div>" +
        "</div>" +
        "<div class='card glow' style='margin-top:18px'><div class='card-head'><h2>客户列表（点击姓名查看详情 / 编辑）</h2></div>" +
        "<table class='table'><thead><tr><th>姓名</th><th>类型</th><th>联系电话</th><th>关联案件</th><th>直达</th></tr></thead><tbody>" +
        d.map(function (r) {
          return "<tr><td><button class='link client-name' data-client='" + r[0] + "'>" + r[0] + "</button></td>" +
            "<td>" + r[1] + "</td><td>" + r[2] + "</td><td>" + r[3] + "</td>" +
            "<td><span class='link' data-switch='cases'>案件 </span></td></tr>";
        }).join("") + "</tbody></table></div>";
    } else if (key === "contracts") {
      // 优先显示用户数据(legal-mode.contracts)，无则用 demo samples 兜底
      let userContracts = [];
      try { userContracts = JSON.parse(localStorage.getItem("legal-mode.contracts") || "[]"); if (!Array.isArray(userContracts)) userContracts = []; } catch (e) { userContracts = []; }
      const stored = (userContracts.length ? userContracts : contracts).map(function (c) {
        return { no: c.no || (c.id || "").slice(-6).toUpperCase(), name: c.name, type: c.type, party: c.party || c.caseTitle, amount: c.amount, status: c.status, expiry: c.expiry || c.date, caseTitle: c.caseTitle, url: c.url };
      });
      const samples = [
        { no: "HT-2026-001", name: "林某某劳动争议案 委托代理合同", type: "委托代理", party: "林某某", amount: "¥30,000", status: "履行中", expiry: "2026-12-31", caseTitle: "林某某与某某公司劳动争议案", url: null },
        { no: "HT-2026-002", name: "甲公司 常年法律顾问合同", type: "常年顾问", party: "甲公司", amount: "¥120,000/年", status: "履行中", expiry: "2027-03-31", caseTitle: "甲公司诉乙公司买卖合同纠纷", url: null },
      ];
      const all = stored.length ? stored : samples;
      const rows = all.map(function (r) {
        const elec = r.url
          ? "<span class='link' data-contract='" + r.no + "' title='打开电子版'> 电子版</span>"
          : "<span class='badge badge-info' title='未上传电子版'>电子版</span>";
        return row(["<span class='link' data-contract='" + r.no + "' title='查看电子版合同'>" + r.no + "</span>", r.name, r.type, r.party, r.amount, "<span class='badge " + (r.status === "待续签" ? "badge-warning" : "badge-success") + "'>" + r.status + "</span>", r.expiry, elec], [{ k: "cases", t: "关联案件" }]);
      }).join("");
      html = head("委托代理、常年法律顾问合同；与案件建档上传的电子版互链",
          "<button class='btn btn-ghost' data-ai-contract>AI 审查</button><button class='btn btn-ghost glow' onclick='window.DataImport && window.DataImport.open(\"contracts\")'> 导入(Excel/CSV)</button><button class='btn btn-primary glow' onclick='window.openNewContract()'>＋ 新增合同</button>") +
        "<div class='card glow'><div class='card-head'><h2>合同列表（" + all.length + "）</h2>" +
        "<span class='badge badge-info'>电子版与「新建案件」上传的合同互链</span></div>" +
        table(["编号", "合同名称", "类型", "相对方", "金额", "状态", "到期/建档日", "电子版"], rows) + "</div>" +
        "<div id='contract-ai' class='ai-box' style='margin-top:12px'><span class='ev-empty'>点击「AI 审查」由法律模式出具审查意见（规范化·参考）</span></div>";
    } else if (key === "finance") {
      const d = [
        ["2026-08-20", "收入", "林某某案 委托费一期", "¥30,000", "林某某与某某公司劳动争议案"],
        ["2026-08-18", "收入", "甲公司 顾问费", "¥120,000", "甲公司诉乙公司买卖合同纠纷"],
        ["2026-08-15", "支出", "诉讼费/保全费", "¥8,600", "甲公司诉乙公司买卖合同纠纷"],
        ["2026-08-12", "待收", "陈某案 进展费", "¥20,000", "陈某不服行政处罚决定案"],
      ];
      html = head("收入/支出/待收、开票回款与律师业绩分配", "<button class='btn btn-primary glow' data-add-fee>＋ 记一笔</button>") +
        "<div class='fin-hero'>" +
        "<div class='fh-card main'><div class='fh-label'> 本月收入</div><div class='fh-val'>¥15.0万</div><div class='fh-sub'>较上月 +12%</div></div>" +
        "<div class='fh-card red'><div class='fh-label'> 本月支出</div><div class='fh-val'>¥0.86万</div><div class='fh-sub'>占比 5.7%</div></div>" +
        "<div class='fh-card amber'><div class='fh-label'> 待收</div><div class='fh-val'>¥2.0万</div><div class='fh-sub'>2 笔待回款</div></div>" +
        "<div class='fh-card green'><div class='fh-label'> 回款率</div><div class='fh-val'>92%</div><div class='fh-sub'>较上月 +6%</div></div>" +
        "</div>" +
        "<div class='card glow' style='margin-top:18px'><div class='card-head'><h2>费用流水</h2></div>" +
        table(["日期", "类型", "说明", "金额", "关联案件"], d.concat(fees).map(function (r) {
          const type = r[1] || r.type, desc = r[2] || r.desc, amount = r[3] || r.amount, date = r[0] || r.date, caseT = r[4] || r.caseTitle || "";
          return row([date, "<span class='badge " + (type === "收入" ? "badge-success" : type === "支出" ? "badge-danger" : "badge-warning") + "'>" + type + "</span>", desc, amount, caseT], [{ k: "cases", t: "案件" }]);
        }).join("")) + "</div>";
    } else if (key === "documents") {
      const d = [
        ["民事起诉状", "起诉状", "林某某与某某公司劳动争议案", "已生成", "2026-08-10"],
        ["代理词", "代理词", "甲公司诉乙公司买卖合同纠纷", "已生成", "2026-08-12"],
        ["证据目录", "证据目录", "王某涉嫌帮助信息网络犯罪活动案", "草稿", "2026-08-15"],
        ["质证意见", "质证意见", "陈某不服行政处罚决定案", "草稿", "2026-08-18"],
      ];
      html = head("起诉状、代理词、证据目录、法律意见书等案卷文书", "<button class='btn btn-primary glow'>＋ 新建文书</button>") +
        "<div class='card glow'><div class='card-head'><h2>文书列表</h2></div>" +
        table(["文书名称", "类型", "所属案件", "状态", "日期"], d.map(function (r) {
          return row([r[0], "<span class='badge badge-info'>" + r[1] + "</span>", r[2], "<span class='badge " + (r[3] === "已生成" ? "badge-success" : "badge-warning") + "'>" + r[3] + "</span>", r[4]], [{ k: "evidence", t: "证据/文书" }, { k: "cases", t: "案件" }]);
        }).join("")) + "</div>";
    } else if (key === "lawyers") {
      const d = [
        ["张冬宝", "主任律师", "12", "劳动/合同", "3"],
        ["李慧敏", "合伙人", "8", "刑事", "1"],
        ["王建国", "主办律师", "5", "行政/执行", "2"],
      ];
      html = head("团队执业信息、擅长领域、执业年限与协作分工", "<button class='btn btn-primary glow'>＋ 添加律师</button>") +
        "<div class='grid cols-4'>" + [["律师人数", "3"], ["执业年限和", "25 年"], ["承办案件", "6"], ["擅长领域", "5类"]].map(function (s) {
          return "<div class='stat-card glow'><div class='stat-label'>" + s[0] + "</div><div class='stat-value'>" + s[1] + "</div></div>";
        }).join("") + "</div>" +
        "<div class='card glow' style='margin-top:18px'><div class='card-head'><h2>律师团队</h2></div>" +
        table(["姓名", "职称", "执业年限", "擅长领域", "承办案件"], d.map(function (r) {
          return row([r[0], r[1], r[2] + " 年", r[3], r[4] + " 件"], [{ k: "cases", t: "承办案件" }]);
        }).join("")) + "</div>";
    } else if (key === "reports") {
      const st = {}; const ty = {};
      mock.cases.forEach(function (c) { st[c.status] = (st[c.status] || 0) + 1; ty[c.type] = (ty[c.type] || 0) + 1; });
      const mkD = function (o, col) { return Object.keys(o).map(function (k) { return { name: k, value: o[k], color: col[k] || "#8899aa" }; }); };
      const sSegs = mkD(st, { "审理中": "#4f8cff", "已立案": "#35d39a", "等待开庭": "#ffb83d", "举证中": "#ff8a3d", "执行中": "#7b5bff", "待立案": "#f43f8e" });
      const tSegs = mkD(ty, { "民事": "#4f8cff", "刑事": "#f43f8e", "行政": "#ffb83d", "执行": "#7b5bff" });
      const leg = function (segs) { return segs.map(function (s) { return "<div class='donut-legend-item'><i style='background:" + s.color + "'></i>" + s.name + "<span class='dv'>" + s.value + "</span></div>"; }).join(""); };
      const inProgress = mock.cases.filter(function (c) { return c.status !== "执行中"; }).length;
      const hero =
        "<div class='report-hero'>" +
        "<div class='rh-card'><div class='rh-label'>案件总数</div><div class='rh-val'>" + mock.cases.length + "</div><div class='rh-sub'>在办 " + inProgress + " 件</div></div>" +
        "<div class='rh-card low'><div class='rh-label'>本月创收</div><div class='rh-val'>¥15.0万</div><div class='rh-sub'>人均 ¥5.0万</div></div>" +
        "<div class='rh-card muted'><div class='rh-label'>胜诉率</div><div class='rh-val'>78%</div><div class='rh-sub'>较上月 +6%</div></div>" +
        "</div>";
      html = head("案件量、成功率、创收、律师绩效等统计报表", go("board", "前往系统看板")) +
        hero +
        "<div class='grid cols-2'>" +
        "<div class='card glow'><div class='card-head'><h2>案件状态分布</h2></div><div class='donut-wrap'>" + donutSVG(sSegs, 140, mock.cases.length) + "<div class='donut-legend'>" + leg(sSegs) + "</div></div></div>" +
        "<div class='card glow'><div class='card-head'><h2>案件类型分布</h2></div><div class='donut-wrap'>" + donutSVG(tSegs, 140, mock.cases.length) + "<div class='donut-legend'>" + leg(tSegs) + "</div></div></div>" +
        "</div><div class='card glow' style='margin-top:18px'><div class='card-head'><h2>统计摘要</h2></div>" +
        "<table class='table'><thead><tr><th>指标</th><th>数值</th></tr></thead><tbody>" +
        [["案件总数", mock.cases.length], ["在办案件", inProgress], ["已结案", "2"], ["胜诉率", "78%"], ["本月创收", "¥15.0万"], ["人均创收", "¥5.0万"]].map(function (r) { return "<tr><td>" + r[0] + "</td><td><strong>" + r[1] + "</strong></td></tr>"; }).join("") +
        "</tbody></table></div>";
    } else if (key === "settings") {
      // 系统设置：只体现本人，不做团队（团队互通下一版涉及云端/数据安全）；律所与个人中心同步
      const lic = localStorage.getItem("legal-mode.license") || "——";
      const cur = loadLawyer();
      const role = (cur && cur.role) || "执业律师";
      const setCard = function (ico, color, title, bodyHtml) {
        return "<div class='set-card glow' style='--acc:" + color + "'>" +
          "<div class='set-head'><span class='set-ico'>" + ico + "</span><strong>" + title + "</strong></div>" +
          "<div class='set-body'>" + bodyHtml + "</div></div>";
      };
      html = head("工作台外观（主题/壁纸）与数据偏好", "") +
        "<div class='set-grid'>" +
        setCard("", "#4f8cff", "主题",
          "<div style='display:flex;gap:8px;flex-wrap:wrap'>" +
          ["system|跟随系统", "light|浅色", "dark|深色"].map(function (s) { return s.split("|"); }).map(function (s) {
            return "<button class='btn btn-ghost' data-theme='" + s[0] + "'>" + s[1] + "</button>";
          }).join("") + "</div>") +
        setCard("", "#7b5bff", "壁纸", "<button class='btn btn-ghost' data-wall>打开壁纸面板</button>") +
        setCard("", "#f43f8e", "数据", "<div style='display:flex;gap:8px;flex-wrap:wrap'><button class='btn btn-primary btn-sm' data-open-lic>注册 / 激活</button><button class='btn btn-primary btn-sm' data-open-data>管理数据(.swj)</button><button class='btn btn-ghost btn-sm' data-open-key>算力与 Key</button><button class='btn btn-ghost btn-sm' data-reset>清空本地数据</button></div>") +
        setCard("ℹ", "#12b5a5", "关于", "<div class='tl-meta' style='line-height:1.8'>法律模式 · 律师工作台（前置代理模块）<br>数据仅本地保存</div>") +
        "</div>";
    } else if (key === "profile") {
      const name = meName();
      const lic = localStorage.getItem("legal-mode.license") || "131012020****";
      const curLawyer = loadLawyer();
      const firm = (curLawyer && curLawyer.firm) || "靖之霖律师事务所";
      const role = (curLawyer && curLawyer.role) || "执业律师";
      const info = loadProfileInfo(); // {firm, specialty, years}
      html = head("当前律师账号、头像、执业证号与所属律所", "<button class='btn btn-primary glow' id='ppEdit'> 编辑个人信息</button>") +
        "<div class='grid cols-2' style='align-items:stretch;gap:18px'><div class='card glow profile-card'>" +
        "<div class='profile-hero'><div class='p-av' style='background:linear-gradient(135deg,var(--accent),var(--accent-2))'>" + name.charAt(0) + "</div>" +
        "<div style='flex:1'><div class='p-name'>" + name + " <span class='badge badge-info'>" + role + "</span></div>" +
        "<div class='p-sub'>" + info.firm + " · 执业 " + info.years + " 年</div>" +
        "<div class='p-tags'><span class='badge badge-warning'>执业证号 " + lic + "</span><span class='badge badge-info'>" + info.specialty + "</span></div></div></div>" +
        "</div>" +
        "<div class='card glow profile-card'><div class='card-head'><h2>快捷入口</h2></div>" +
        "<div class='profile-links'>" +
        "<div class='plink' data-switch='approval'><div class='pl-ico'></div><div class='pl-txt'>授权签批</div></div>" +
        "<div class='plink' data-switch='board'><div class='pl-ico'></div><div class='pl-txt'>系统看板</div></div>" +
        "<div class='plink' data-switch='cases'><div class='pl-ico'></div><div class='pl-txt'>我的案件</div></div>" +
        "<div class='plink' data-switch='schedule'><div class='pl-ico'></div><div class='pl-txt'>日历看板</div></div>" +
        "<div class='plink' data-switch='documents'><div class='pl-ico'></div><div class='pl-txt'>文书生成</div></div>" +
        "<div class='plink' data-switch='evidence'><div class='pl-ico'></div><div class='pl-txt'>证据材料</div></div>" +
        "</div></div></div>";
    } else {
      html = "<div class='empty'>模块</div>";
    }

    el.content.innerHTML = html;
    // 绑定通用链接
    el.content.querySelectorAll("[data-switch]").forEach(function (b) {
      b.addEventListener("click", function () { switchTo(b.getAttribute("data-switch")); });
    });
    // 设置：主题/壁纸/重置
    el.content.querySelectorAll("[data-theme]").forEach(function (b) {
      b.addEventListener("click", function () { Theme.set(b.getAttribute("data-theme")); toast("主题已切换", "success"); });
    });
    const wall = el.content.querySelector("[data-wall]");
    if (wall) wall.addEventListener("click", function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      var wp = document.getElementById("wallPanel"), grid = document.getElementById("wpGrid");
      if (wp) wp.style.display = "block";
      if (window.Wallpapers && grid) Wallpapers.buildThumbs(grid, null);
    });
    const rst = el.content.querySelector("[data-reset]");
    if (rst) rst.addEventListener("click", function () {
      if (confirm("确认清空所有本地数据？")) { localStorage.clear(); location.reload(); }
    });
    const dm = el.content.querySelector("[data-open-data]");
    if (dm) dm.addEventListener("click", function () { if (window.WbData && window.WbData.openDataManager) window.WbData.openDataManager(); });
    const lic = el.content.querySelector("[data-open-lic]");
    if (lic) lic.addEventListener("click", function () { if (window.License && window.License.open) window.License.open(); else if (window.toast) window.toast("激活模块未就绪", "error"); });
    const kk = el.content.querySelector("[data-open-key]");
    if (kk) kk.addEventListener("click", function () { if (window.KeyMgr && window.KeyMgr.open) window.KeyMgr.open(); else { if (window.toast) window.toast("算力模块未就绪", "error"); } });
    const pp = el.content.querySelector("#ppOpen");
    if (pp) pp.addEventListener("click", function () { if (window.Profile) Profile.open(); });
    const ppEdit = el.content.querySelector("#ppEdit");
    if (ppEdit) ppEdit.addEventListener("click", openProfileEdit);
    el.content.querySelectorAll("[data-client]").forEach(function (b) {
      b.addEventListener("click", function () { openClientDetail(b.getAttribute("data-client")); });
    });
    el.content.querySelectorAll("[data-contract]").forEach(function (b) {
      b.addEventListener("click", function () { openContract(b.getAttribute("data-contract")); });
    });
    const aiCt = el.content.querySelector("[data-ai-contract]");
    if (aiCt) aiCt.addEventListener("click", function () {
      const box = document.getElementById("contract-ai");
      if (box) renderAIContent(box, "contract-review", { title: (contracts[0] && contracts[0].name) || "委托代理合同" }, "正在审查合同风险…");
    });
    const addFee = el.content.querySelector("[data-add-fee]");
    if (addFee) addFee.addEventListener("click", openFeeModal);
  }

  // 财务记一笔
  const FEE_KEY = "legal-mode.fees";
  function loadFees() { try { return JSON.parse(localStorage.getItem(FEE_KEY) || "[]"); } catch (e) { return []; } }
  function saveFees() { localStorage.setItem(FEE_KEY, JSON.stringify(fees)); }
  let fees = loadFees();
  function openFeeModal() {
    const m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML = "<div class='modal glow'>" +
      "<h3>记一笔</h3>" +
      "<div class='form-row'><div class='form-group'><label>类型</label><select id='feeType'><option value='income'>收入</option><option value='expense'>支出</option><option value='receivable'>待收</option></select></div>" +
      "<div class='form-group'><label>金额</label><input type='number' id='feeAmount' placeholder='0.00'></div></div>" +
      "<div class='form-group'><label>说明</label><input id='feeDesc' placeholder='如：林某某案 委托费二期'></div>" +
      "<div class='form-group'><label>关联案件</label><select id='feeCase'><option value=''>—</option>" + mock.cases.map(function (c) { return "<option>" + c.title + "</option>"; }).join("") + "</select></div>" +
      "<div class='modal-actions'><button class='btn btn-ghost' data-close>取消</button><button class='btn btn-primary' data-save>保存</button></div></div>";
    document.body.appendChild(m);
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.hasAttribute && e.target.hasAttribute("data-save")) {
        const rec = {
          id: uid(), date: nowStr().slice(0, 10),
          type: m.querySelector("#feeType").value,
          amount: "¥" + (m.querySelector("#feeAmount").value || "0"),
          desc: m.querySelector("#feeDesc").value || "费用",
          caseTitle: m.querySelector("#feeCase").value,
        };
        fees = loadFees(); fees.unshift(rec); saveFees();
        m.remove(); renderModuleStub("finance", "财务管理"); toast("已记一笔", "success");
      }
    });
  }

  // 编辑个人信息（所属律所 / 擅长领域 / 执业年限）
  function openProfileEdit() {
    const info = loadProfileInfo();
    const m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML = "<div class='modal glow'>" +
      "<h3>编辑个人信息</h3>" +
      "<div class='form-group'><label>所属律所</label><input id='peFirm' value='" + info.firm + "'></div>" +
      "<div class='form-group'><label>擅长领域</label><input id='peSpecialty' value='" + info.specialty + "'></div>" +
      "<div class='form-group'><label>执业年限</label><input id='peYears' value='" + info.years + "'></div>" +
      "<div class='modal-actions'><button class='btn btn-ghost' data-close>取消</button><button class='btn btn-primary' data-save>保存</button></div></div>";
    document.body.appendChild(m);
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.hasAttribute && e.target.hasAttribute("data-save")) {
        const firm = m.querySelector("#peFirm").value.trim();
        saveProfileInfo({ firm: firm, specialty: m.querySelector("#peSpecialty").value.trim(), years: m.querySelector("#peYears").value.trim() });
        // 同步登录档案，转所后需重新编辑
        const l = loadLawyer();
        if (l) { l.firm = firm; saveLawyer(l); }
        m.remove(); renderModuleStub("profile", "个人中心"); toast("个人信息已保存并同步", "success");
      }
    });
  }

  // 打开合同电子版（案件建档上传的合同文件）
  // 合同类型 → 类型码
  const CONTRACT_TYPES = [
    { code: "WT", label: "委托代理", value: "委托代理" },
    { code: "GW", label: "常年顾问", value: "常年顾问" },
    { code: "ZX", label: "其他/咨询", value: "其他服务" },
  ];
  function contractTypeCode(v) {
    var t = String(v || "").trim();
    for (var i = 0; i < CONTRACT_TYPES.length; i++) { if (CONTRACT_TYPES[i].value === t || CONTRACT_TYPES[i].code === t) return CONTRACT_TYPES[i].code; }
    return "ZX";
  }
  // 自动生成合同编号：HT-<类型码>-<年><月日>-<序号>（按类型+日期每天从001递增）
  function genContractNo(typeCode) {
    code = typeCode || "ZX";
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    var datePart = y + "" + m + day; // 例如 20260911
    // 读已有合同，统计今天+该类型已有的最大序号
    var arr = []; try { arr = JSON.parse(localStorage.getItem("legal-mode.contracts") || "[]"); if (!Array.isArray(arr)) arr = []; } catch (x) { arr = []; }
    var prefix = "HT-" + code + "-" + datePart + "-";
    var maxSeq = 0;
    arr.forEach(function (c) {
      var no = String(c.no || "");
      if (no.indexOf(prefix) === 0) {
        var seq = parseInt(no.slice(prefix.length), 10);
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
    });
    return prefix + String(maxSeq + 1).padStart(3, "0");
  }

  function openNewContract() {
    const m = document.createElement("div");
    m.className = "modal-overlay show";
    const typeOpts = CONTRACT_TYPES.map(function (t) { return "<option value='" + t.value + "'>" + t.label + "（" + t.code + "）</option>"; }).join("");
    m.innerHTML = "<div class='modal glow' style='width:560px'>" +
      "<h3>新增合同</h3>" +
      '<div class="form-group"><label>合同名称 *</label><input id="kName" placeholder="合同名称"></div>' +
      '<div class="form-group"><label>合同类型 *</label><select id="kType">' + typeOpts + "</select></div>" +
      '<div class="form-group"><label>合同编号 <span style="color:#8ea3c2;font-weight:400">（自动生成，可手动覆盖）</span></label><input id="kNo" placeholder="自动生成，留空即可"></div>' +
      '<div style="font-size:11px;color:#7aa8ff;margin:-6px 0 10px">编号自动按 <b>HT-类型码-年月日-序号</b> 生成（如 HT-WT-20260911-001）；如需沿用你习惯的编号，可手动修改覆盖。</div>' +
      '<div class="form-group"><label>相对方</label><input id="kParty" placeholder="对方当事人/单位"></div>' +
      '<div class="form-group"><label>金额</label><input id="kAmount" placeholder="如 ¥30,000"></div>' +
      '<div class="form-group"><label>状态</label><input id="kStatus" placeholder="履行中 / 待续签" value="履行中"></div>' +
      '<div class="form-group"><label>到期日</label><input id="kExpiry" placeholder="如 2026-12-31"></div>' +
      '<div class="form-group"><label>关联案件</label><input id="kCase" placeholder="案件标题"></div>' +
      "<div class='modal-actions'><button class='btn btn-ghost' data-close>取消</button>" +
      "<button class='btn btn-primary' data-save>保存</button></div></div>";
    document.body.appendChild(m);
    const get = function (id) { var e = m.querySelector("#" + id); return e ? e.value.trim() : ""; };
    // 类型变化 → 实时刷新编号预览
    const kType = m.querySelector("#kType"), kNo = m.querySelector("#kNo");
    function refreshNo() { if (kNo) kNo.placeholder = genContractNo(contractTypeCode(kType ? kType.value : "")); }
    if (kType) kType.addEventListener("change", refreshNo);
    refreshNo();
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.hasAttribute && e.target.hasAttribute("data-save")) {
        const name = get("kName");
        if (!name) { toast("请填写合同名称", "error"); return; }
        let arr = []; try { arr = JSON.parse(localStorage.getItem("legal-mode.contracts") || "[]"); if (!Array.isArray(arr)) arr = []; } catch (x) { arr = []; }
        const typeCode = contractTypeCode(get("kType"));
        const no = get("kNo") || genContractNo(typeCode); // 手动覆盖优先，留空自动
        arr.push({ no: no, name: name, type: get("kType"), party: get("kParty"), amount: get("kAmount"), status: get("kStatus") || "履行中", expiry: get("kExpiry"), caseTitle: get("kCase"), url: null });
        try { localStorage.setItem("legal-mode.contracts", JSON.stringify(arr)); } catch (x) {}
        m.remove(); renderModuleStub("contracts", "合同管理"); toast("合同已新增，" + no, "success");
      }
    });
  }

  function openContract(no) {
    let c = contracts.find(function (x) { return (x.id || "").slice(-6).toUpperCase() === no; });
    if (!c) { toast("该合同未上传电子版", "error"); return; }
    const v = document.createElement("div");
    v.className = "modal-overlay show";
    const isImg = /^image\//.test(c.fileType || ""), isVid = /^video\//.test(c.fileType || ""), isAud = /^audio\//.test(c.fileType || ""), isPdf = /pdf/.test(c.fileType || "");
    let media = "";
    if (isImg || isPdf) media = "<object data='" + c.url + "' type='application/pdf' style='width:100%;height:60vh'>合同电子版</object>";
    else if (isVid) media = "<video src='" + c.url + "' controls autoplay style='width:100%;max-height:60vh'></video>";
    else if (isAud) media = "<audio src='" + c.url + "' controls style='width:100%'></audio>";
    else media = "<div class='ev-empty'>该类型无法在线预览，请下载</div>";
    v.innerHTML = "<div class='modal glow' style='width:680px'>" +
      "<h3>" + c.name + "</h3>" +
      "<div style='width:100%;background:#fff;border-radius:10px;overflow:hidden'>" + media + "</div>" +
      "<div class='modal-actions'><a class='btn btn-ghost' href='" + c.url + "' download='" + c.name + "'> 下载</a>" +
      "<button class='btn' data-vclose>关闭</button></div></div>";
    v.addEventListener("click", function (e) {
      if (e.target === v || e.target.getAttribute("data-vclose")) v.remove();
    });
    document.body.appendChild(v);
  }

  // —— 客户详情 / 编辑（姓名可点击 -> 详情面板，含编辑选项） ——
  const CLIENT_KEY = "legal-mode.clients";
  // 兼容两种存储格式：旧"对象{name:info}" 和 新导入/新建"数组[{name,...}]" → 统一转成对象(以 name 为 key)
  function loadClients() {
    try {
      const v = JSON.parse(localStorage.getItem(CLIENT_KEY) || "{}");
      if (Array.isArray(v)) {
        const o = {};
        v.forEach(function (it, i) { if (it && it.name) o[it.name] = it; });
        return o;
      }
      return (v && typeof v === "object") ? v : {};
    } catch (e) { return {}; }
  }
  function saveClients() { localStorage.setItem(CLIENT_KEY, JSON.stringify(clientsStore)); }
  let clientsStore = loadClients();
  function openClientDetail(name) {
    const info = clientsStore[name] || { name: name, type: "当事人", phone: "____________", email: "____________", idCard: "____________", address: "____________", notes: "" };
    const caseOf = mock.cases.filter(function (c) { return c.title.indexOf(name) >= 0 || c.party === name; });
    const m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML = "<div class='modal glow' style='width:560px'>" +
      "<div class='client-hero'><div class='c-av'>" + (info.name || "?").charAt(0) + "</div>" +
      "<div style='flex:1'><div class='c-name'>" + name + "</div><div class='c-type'>" + info.type + " · 可点击「编辑」修改资料</div>" +
      "<div class='c-badges'><span class='badge badge-warning'> 在办关联案件 " + caseOf.length + "</span></div></div></div>" +
      "<div class='grid' style='grid-template-columns:1fr 1fr;gap:10px'>" +
      "<div class='c-info'><div class='ci-label'> 电话</div><div class='ci-val'>" + info.phone + "</div></div>" +
      "<div class='c-info'><div class='ci-label'> 邮箱</div><div class='ci-val'>" + info.email + "</div></div>" +
      "<div class='c-info'><div class='ci-label'> 证件号</div><div class='ci-val'>" + info.idCard + "</div></div>" +
      "<div class='c-info'><div class='ci-label'> 地址</div><div class='ci-val'>" + info.address + "</div></div>" +
      "</div>" +
      "<div class='c-note'><div class='ci-label'> 备注</div><div>" + (info.notes || "—") + "</div></div>" +
      "<div class='card-head' style='margin-top:16px'><h2>关联案件</h2></div>" +
      (caseOf.length ? "<table class='table'><thead><tr><th>案号</th><th>案件</th><th>状态</th></tr></thead><tbody>" +
        caseOf.map(function (c) { return "<tr><td>" + c.no + "</td><td><span class='link' data-switch='cases'>" + c.title + "</span></td><td><span class='badge badge-warning'>" + c.status + "</span></td></tr>"; }).join("") +
        "</tbody></table>" : "<div class='ev-empty'>暂无关联案件</div>") +
      "<div class='modal-actions'><button class='btn btn-ghost' data-close>关闭</button>" +
      "<button class='btn btn-primary' data-edit> 编辑客户信息</button></div></div>";
    document.body.appendChild(m);
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.hasAttribute && e.target.hasAttribute("data-edit")) { m.remove(); openClientEdit(name); }
    });
  }
  function openClientEdit(name) {
    const info = clientsStore[name] || { name: name, type: "当事人", phone: "", email: "", idCard: "", address: "", notes: "" };
    const fields = [["type", "类型"], ["phone", "电话"], ["email", "邮箱"], ["idCard", "证件号"], ["address", "地址"], ["notes", "备注"]];
    const m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML = "<div class='modal glow' style='width:560px'>" +
      "<h3>编辑客户 · " + name + "</h3>" +
      '<div class="form-group"><label>姓名</label><input id="cName" value="' + info.name + '"></div>' +
      fields.map(function (f) {
        return "<div class='form-group'><label>" + f[1] + "</label><textarea rows='1' id='c" + f[0] + "'>" + (info[f[0]] || "") + "</textarea></div>";
      }).join("") +
      "<div class='modal-actions'><button class='btn btn-ghost' data-close>取消</button>" +
      "<button class='btn btn-primary' data-save>保存</button></div></div>";
    document.body.appendChild(m);
    const get = function (id) { var e = m.querySelector("#" + id); return e ? e.value : ""; };
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.hasAttribute && e.target.hasAttribute("data-save")) {
        clientsStore[name] = { name: get("cName") || name, type: get("ctype"), phone: get("cphone"), email: get("cemail"), idCard: get("cidCard"), address: get("caddress"), notes: get("cnotes") };
        saveClients(); m.remove(); renderModuleStub("clients", "客户管理"); toast("客户信息已保存", "success");
      }
    });
  }

  // 新增客户（空白表单，保存到 clientsStore）
  function openClientNew() {
    const fields = [["type", "类型", "当事人"], ["phone", "电话", ""], ["email", "邮箱", ""], ["idCard", "证件号", ""], ["address", "地址", ""], ["notes", "备注", ""]];
    const m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML = "<div class='modal glow' style='width:560px'>" +
      "<h3>新增客户</h3>" +
      '<div class="form-group"><label>姓名/名称</label><input id="cName" placeholder="客户姓名或单位名称"></div>' +
      fields.map(function (f) { return "<div class='form-group'><label>" + f[1] + "</label><textarea rows='1' id='c" + f[0] + "'>" + (f[2] || "") + "</textarea></div>"; }).join("") +
      "<div class='modal-actions'><button class='btn btn-ghost' data-close>取消</button>" +
      "<button class='btn btn-primary' data-save>保存</button></div></div>";
    document.body.appendChild(m);
    const get = function (id) { var e = m.querySelector("#" + id); return e ? e.value : ""; };
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.hasAttribute && e.target.hasAttribute("data-save")) {
        const name = get("cName").trim();
        if (!name) { toast("请填写姓名/名称", "error"); return; }
        clientsStore[name] = { name: name, type: get("ctype"), phone: get("cphone"), email: get("cemail"), idCard: get("cidCard"), address: get("caddress"), notes: get("cnotes") };
        saveClients(); m.remove(); renderModuleStub("clients", "客户管理"); toast("客户已新增", "success");
      }
    });
  }

  // —— 日历看板（第5条）：每日/未来节点 + 期限预警倒计时 + 完成管理 ——
  const CAL_KEY = "legal-mode.calendar";
  function fmtD(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function datestr(off) { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return fmtD(d); }
  function loadCal() { try { return JSON.parse(localStorage.getItem(CAL_KEY) || "[]"); } catch (e) { return []; } }
  function saveCal() { localStorage.setItem(CAL_KEY, JSON.stringify(calEvents)); }
  let calEvents = loadCal();
  let calView = { y: new Date().getFullYear(), m: new Date().getMonth(), sel: datestr(0) };
  const CAL_TYPES = ["开庭", "会见", "期限", "其他"];
  const CAL_COLOR = { "开庭": "#f43f8e", "会见": "#4f8cff", "期限": "#ffb83d", "其他": "#35d39a" };
  if (!calEvents.length) {
    calEvents = [
      { id: uid(), date: datestr(0), time: "09:30", title: "林某某劳动争议案 一审开庭", type: "开庭", completed: false, caseRef: "林某某与某某公司劳动争议案" },
      { id: uid(), date: datestr(0), time: "15:00", title: "会见当事人 王某", type: "会见", completed: false, caseRef: "王某涉嫌帮助信息网络犯罪活动案" },
      { id: uid(), date: datestr(1), time: "17:00", title: "提交代理词", type: "期限", completed: false, caseRef: "甲公司诉乙公司买卖合同纠纷" },
      { id: uid(), date: datestr(3), time: "10:00", title: "判决宣判", type: "开庭", completed: false, caseRef: "甲公司诉乙公司买卖合同纠纷" },
      { id: uid(), date: datestr(5), time: "18:00", title: "举证期限届满", type: "期限", completed: false, caseRef: "陈某不服行政处罚决定案" },
      { id: uid(), date: datestr(-2), time: "14:00", title: "执行和解会议", type: "其他", completed: true, caseRef: "某银行与某贸易公司执行案" },
    ];
    saveCal();
  }
  function calWeekHead() { return ["一", "二", "三", "四", "五", "六", "日"].map(function (d) { return "<div class='cal-dow'>" + d + "</div>"; }).join(""); }

  function renderCalendar() {
    const y = calView.y, mon = calView.m;
    const first = new Date(y, mon, 1);
    const startDow = (first.getDay() + 6) % 7;
    const dim = new Date(y, mon + 1, 0).getDate();
    const pdim = new Date(y, mon, 0).getDate();
    const todayStr = datestr(0);
    let cells = "";
    for (let i = 0; i < startDow; i++) cells += "<div class='cal-cell out'>" + (pdim - startDow + 1 + i) + "</div>";
    for (let d = 1; d <= dim; d++) {
      const date = fmtD(new Date(y, mon, d));
      const evs = calEvents.filter(function (e) { return e.date === date; });
      const dots = evs.map(function (e) { return "<i class='cal-dot' style='background:" + CAL_COLOR[e.type] + "'></i>"; }).join("");
      const sel = date === calView.sel ? " sel" : "";
      const today = date === todayStr ? " today" : "";
      cells += "<div class='cal-cell" + sel + today + "' data-date='" + date + "'><span class='cal-num'>" + d + "</span><span class='cal-dots'>" + dots + "</span></div>";
    }
    let total = startDow + dim; while (total % 7 !== 0) { total++; cells += "<div class='cal-cell out'></div>"; }

    const selEvs = calEvents.filter(function (e) { return e.date === calView.sel; }).sort(function (a, b) { return a.time < b.time ? -1 : 1; });
    const dayList = selEvs.length ? selEvs.map(function (e) {
      return "<div class='cal-ev" + (e.completed ? " done" : "") + "'>" +
        "<span class='cal-ev-time'>" + e.time + "</span>" +
        "<i class='cal-dot' style='background:" + CAL_COLOR[e.type] + "'></i>" +
        "<span class='cal-ev-title'>" + e.title + "</span>" +
        "<span class='badge badge-info'>" + e.type + "</span>" +
        "<span class='cal-ev-acts'>" +
        "<button class='btn btn-sm btn-ghost' data-toggle='" + e.id + "'>" + (e.completed ? "重开" : "完成") + "</button>" +
        "<button class='btn btn-sm btn-ghost' data-edit='" + e.id + "'>编辑</button>" +
        "<button class='btn btn-sm btn-danger' data-dele='" + e.id + "'>删</button>" +
        "</span>" +
        (e.caseRef ? "<span class='link case-link' data-switch='cases' title='前往关联案件'>" + e.caseRef + " </span>" : "") +
        "</div>";
    }).join("") : "<div class='empty'>当日暂无安排</div>";

    const upcoming = calEvents.filter(function (e) { return !e.completed && e.date >= todayStr; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; }).slice(0, 8);
    const countdown = upcoming.length ? upcoming.map(function (e) {
      const days = Math.round((new Date(e.date + "T00:00:00") - new Date(todayStr + "T00:00:00")) / 86400000);
      const cls = days === 0 ? "badge-danger" : days < 3 ? "badge-warning" : "badge-info";
      const label = days === 0 ? "今天" : days === 1 ? "明天" : days + " 天";
      return "<div class='cd-item'><span class='cd-days'><b>" + label + "</b></span><span class='cd-title'>" + e.title + "</span><span class='badge " + cls + "'>" + e.type + "</span></div>";
    }).join("") : "<div class='empty'>暂无待办期限</div>";

    const selDay = calView.sel.split("-");
    const dayLabel = calView.sel === todayStr ? "今天" : parseInt(selDay[2], 10) + " 日";

    el.content.innerHTML =
      '<div class="page-head"><div><h1>' + curTitle + "</h1><div class='sub'>" + curSub + "</div></div>" +
      "<div style='display:flex;gap:8px;flex-wrap:wrap;align-items:center'>" +
      "<button class='btn btn-ghost' data-prev></button>" +
      "<button class='btn btn-ghost' data-today>今天</button>" +
      "<button class='btn btn-ghost' data-next></button>" +
      "</div></div>" +
      "<div class='grid' style='grid-template-columns:1.55fr 1fr'>" +
      "<div class='card glow'><div class='card-head'><h2>" +
      "<button class='cal-title' data-ympick>" + y + " 年 " + (mon + 1) + " 月</button>" +
      "</h2><span class='link' data-ympick>选择年月</span></div>" +
      "<div class='cal-grid'>" + calWeekHead() + cells + "</div></div>" +
      "<div class='card glow'><div class='card-head'><h2>" + dayLabel + " 安排</h2><button class='btn btn-sm btn-primary' data-add>＋ 新增日程</button></div>" +
      "<div class='cal-day-list'>" + dayList + "</div>" +
      "<div class='card-head' style='margin-top:18px'><h2>临近节点 · 倒计时</h2><button class='btn btn-sm btn-ghost' data-ai-deadline>AI 预警</button></div>" +
      "<div class='cd-list'>" + countdown + "</div>" +
      "<div id='cal-ai' class='ai-box'></div></div>" +
      "</div>";

    bindCalendarEvents();
  }

  // 手机日历式：年/月选择器（点标题弹出）
  function openYmPicker() {
    const m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML = "<div class='modal glow' style='width:380px'>" +
      "<div class='ym-head'><button class='btn btn-ghost' data-ymprev></button>" +
      "<span class='ym-year' id='ymYear'>" + calView.y + " 年</span>" +
      "<button class='btn btn-ghost' data-ymnext></button></div>" +
      "<div class='ym-grid'>" + Array.from({ length: 12 }).map(function (_, i) {
        return "<button class='ym-m" + (i === calView.m ? " active" : "") + "' data-ym='" + (i + 1) + "'>" + (i + 1) + " 月</button>";
      }).join("") + "</div>" +
      "<div class='modal-actions'><button class='btn btn-ghost' data-ymtoday>回到今天</button>" +
      "<button class='btn' data-close>关闭</button></div></div>";
    document.body.appendChild(m);
    let pickYear = calView.y;
    const yearEl = m.querySelector("#ymYear");
    m.querySelector("[data-ymprev]").addEventListener("click", function () { pickYear--; yearEl.textContent = pickYear + " 年"; });
    m.querySelector("[data-ymnext]").addEventListener("click", function () { pickYear++; yearEl.textContent = pickYear + " 年"; });
    m.querySelectorAll("[data-ym]").forEach(function (b) {
      b.addEventListener("click", function () {
        calView.y = pickYear; calView.m = parseInt(b.getAttribute("data-ym"), 10) - 1;
        calView.sel = calView.y + "-" + ("0" + (calView.m + 1)).slice(-2) + "-01";
        m.remove(); renderCalendar();
      });
    });
    m.querySelector("[data-ymtoday]").addEventListener("click", function () { calView.y = new Date().getFullYear(); calView.m = new Date().getMonth(); calView.sel = datestr(0); m.remove(); renderCalendar(); });
    m.addEventListener("click", function (e) { if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) m.remove(); });
  }

  function bindCalendarEvents() {
    el.content.querySelectorAll("[data-date]").forEach(function (c) {
      c.addEventListener("click", function () {
        calView.sel = c.getAttribute("data-date");
        const parts = calView.sel.split("-");
        calView.y = parseInt(parts[0], 10); calView.m = parseInt(parts[1], 10) - 1;
        renderCalendar();
      });
    });
    const prev = el.content.querySelector("[data-prev]");
    if (prev) prev.addEventListener("click", function () { calView.m--; if (calView.m < 0) { calView.m = 11; calView.y--; } renderCalendar(); });
    const next = el.content.querySelector("[data-next]");
    if (next) next.addEventListener("click", function () { calView.m++; if (calView.m > 11) { calView.m = 0; calView.y++; } renderCalendar(); });
    el.content.querySelectorAll("[data-ympick]").forEach(function (b) {
      b.addEventListener("click", openYmPicker);
    });
    const today = el.content.querySelector("[data-today]");
    if (today) today.addEventListener("click", function () { calView.y = new Date().getFullYear(); calView.m = new Date().getMonth(); calView.sel = datestr(0); renderCalendar(); });
    const aiDl = el.content.querySelector("[data-ai-deadline]");
    if (aiDl) aiDl.addEventListener("click", function () {
      const evt = (calEvents || []).find(function (x) { return x.type === "期限" && !x.completed; });
      const d = evt ? { title: evt.title, date: evt.date, days: Math.max(0, Math.ceil((new Date(evt.date).getTime() - Date.now()) / 86400000)) } : { title: "节点期限" };
      const box = document.getElementById("cal-ai");
      if (box) renderAIContent(box, "deadline", d, "正在生成期限预警…");
    });
    const add = el.content.querySelector("[data-add]");
    if (add) add.addEventListener("click", function () { openCalendarEventModal(null); });
    el.content.querySelectorAll("[data-toggle]").forEach(function (b) {
      b.addEventListener("click", function () {
        const ev = calEvents.find(function (x) { return x.id === b.getAttribute("data-toggle"); });
        if (ev) { ev.completed = !ev.completed; saveCal(); renderCalendar(); }
      });
    });
    el.content.querySelectorAll("[data-edit]").forEach(function (b) {
      b.addEventListener("click", function () {
        const ev = calEvents.find(function (x) { return x.id === b.getAttribute("data-edit"); });
        if (ev) openCalendarEventModal(ev);
      });
    });
    el.content.querySelectorAll("[data-dele]").forEach(function (b) {
      b.addEventListener("click", function () {
        const id = b.getAttribute("data-dele");
        calEvents = calEvents.filter(function (x) { return x.id !== id; });
        saveCal(); renderCalendar();
      });
    });
    el.content.querySelectorAll("[data-switch]").forEach(function (b) {
      b.addEventListener("click", function () { switchTo(b.getAttribute("data-switch")); });
    });
  }

  function openCalendarEventModal(ev) {
    const m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML = "<div class='modal glow'>" +
      "<h3>" + (ev ? "编辑日程" : "新增日程") + "</h3>" +
      "<div class='form-group'><label>日期</label><input type='date' id='ceDate' value='" + (ev ? ev.date : calView.sel) + "'></div>" +
      "<div class='form-row'><div class='form-group'><label>时间</label><input type='time' id='ceTime' value='" + (ev ? ev.time : "09:00") + "'></div>" +
      "<div class='form-group'><label>类型</label><select id='ceType'>" + CAL_TYPES.map(function (t) { return "<option" + (ev && ev.type === t ? " selected" : "") + ">" + t + "</option>"; }).join("") + "</select></div></div>" +
      "<div class='form-group'><label>标题</label><input id='ceTitle' value='" + (ev ? ev.title : "") + "'></div>" +
      "<div class='form-group'><label>关联案件（直达源头）</label><select id='ceCase'><option value=''>—</option>" + mock.cases.map(function (c) { return "<option" + (ev && ev.caseRef === c.title ? " selected" : "") + ">" + c.title + "</option>"; }).join("") + "</select></div>" +
      "<div class='modal-actions'><button class='btn btn-ghost' data-close>取消</button><button class='btn btn-primary' data-save>保存</button></div></div>";
    document.body.appendChild(m);
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.hasAttribute && e.target.hasAttribute("data-save")) {
        const rec = {
          id: ev ? ev.id : uid(),
          date: m.querySelector("#ceDate").value || calView.sel,
          time: m.querySelector("#ceTime").value || "09:00",
          type: m.querySelector("#ceType").value,
          title: m.querySelector("#ceTitle").value || "未命名日程",
          completed: ev ? ev.completed : false,
          caseRef: m.querySelector("#ceCase").value,
        };
        if (ev) { const i = calEvents.findIndex(function (x) { return x.id === ev.id; }); if (i >= 0) calEvents[i] = rec; }
        else calEvents.push(rec);
        saveCal(); m.remove(); renderCalendar();
      }
    });
  }

  // —— 文书管理（重组）：案件建档  生成文书  继续编辑  一键打印（集成机内模板格式） ——
  const DOC_KEY = "legal-mode.documents";
  function loadDocs() { try { return JSON.parse(localStorage.getItem(DOC_KEY) || "[]"); } catch (e) { return []; } }
  function saveDocs() { localStorage.setItem(DOC_KEY, JSON.stringify(docs)); }
  let docs = loadDocs();
  let docGenMode = "template"; // template | harness
  const DOCTPL_KEY = "legal-mode.docTemplates";
  function loadDocTpls() { try { return JSON.parse(localStorage.getItem(DOCTPL_KEY) || "{}"); } catch (e) { return {}; } }
  function saveDocTpls() { localStorage.setItem(DOCTPL_KEY, JSON.stringify(docTpls)); }
  let docTpls = loadDocTpls();
  // DeepSeek Harness 界面地址（生产可改为 DSH 前端页面；原型此处打开本机 DSH GUI）
  const HARNESS_URL = "http://127.0.0.1:3080";
  // 用律师上传的自有模板 + 案件变量填充
  function fillCustomTemplate(tpl, c) {
    const vars = { "{{案由}}": c.type, "{{当事人}}": c.party, "{{法院}}": c.court || "________人民法院", "{{案号}}": c.no, "{{案件}}": c.title, "{{姓名}}": meName(), "{{证号}}": myLicense(), "{{日期}}": dToday() };
    let out = tpl;
    Object.keys(vars).forEach(function (k) { out = out.split(k).join(vars[k]); });
    return out;
  }
  const DOC_TYPES = ["民事起诉状", "民事答辩状", "质证意见", "授权委托书", "民事反诉状", "民事上诉状", "刑事辩护词", "代理意见"];

  function myLicense() { return localStorage.getItem("legal-mode.license") || "____________"; }
  function dToday() { return nowStr().slice(0, 10); }

  // 各文书模板（按机内 Legal-KB 文书规范生成内容骨架；机里可跑 chinese-doc-formatter 输出 docx/pdf）
  const DOC_TEMPLATES = {
    "民事起诉状": function (c, me) {
      return "<div class='doc-h'>民事起诉状</div>" +
        "<p class='doc-line'><b>原告：</b>" + c.party + "</p><p class='doc-line'><b>被告：</b>________</p>" +
        "<p class='doc-h2'>诉讼请求</p><ol><li>一、判令被告支付款项________元；</li><li>二、本案诉讼费用由被告承担。</li></ol>" +
        "<p class='doc-h2'>事实与理由</p><p>" + c.party + "与被告因" + c.title + "发生争议（案由：" + c.type + "）。依据《中华人民共和国民法典》相关规定，请求人民法院依法裁判。</p>" +
        "<p class='doc-sign'>此致</p><p class='doc-line'>" + (c.court || "________人民法院") + "</p>" +
        "<p class='doc-sign'>具状人：" + c.party + "</p><p class='doc-line'>" + dToday() + "</p>";
    },
    "民事答辩状": function (c, me) {
      return "<div class='doc-h'>民事答辩状</div>" +
        "<p class='doc-line'><b>答辩人：</b>" + c.party + "</p>" +
        "<p class='doc-h2'>答辩理由</p><p>答辩人就" + c.title + "一案，提出如下答辩意见：……（请补充）</p>" +
        "<p class='doc-sign'>此致</p><p class='doc-line'>" + (c.court || "________人民法院") + "</p>" +
        "<p class='doc-sign'>答辩人：" + c.party + "</p><p class='doc-line'>" + dToday() + "</p>";
    },
    "质证意见": function (c, me) {
      return "<div class='doc-h'>质证意见</div>" +
        "<p class='doc-line'>案件：" + c.title + "（" + c.no + "）</p>" +
        "<p class='doc-h2'>质证意见</p>" +
        "<ol><li>对证据一的真实性、合法性、关联性：……（请补充）；</li><li>对证据二：……（请补充）。</li></ol>" +
        "<p class='doc-sign'>质证人：" + me + "</p><p class='doc-line'>" + dToday() + "</p>";
    },
    "授权委托书": function (c, me) {
      return "<div class='doc-h'>授权委托书</div>" +
        "<p class='doc-line'>委托人：" + c.party + "</p>" +
        "<p class='doc-line'>受托人：" + me + "（执业证号：" + myLicense() + "）</p>" +
        "<p class='doc-h2'>委托事项</p><p>现委托" + me + "律师在" + c.title + "一案中担任委托人的诉讼代理人，权限包括代为承认、放弃、变更诉讼请求等。</p>" +
        "<p class='doc-sign'>委托人（签字）：" + c.party + "</p><p class='doc-line'>" + dToday() + "</p>";
    },
    "民事反诉状": function (c, me) {
      return "<div class='doc-h'>民事反诉状</div>" +
        "<p class='doc-line'><b>反诉原告（本诉被告）：</b>" + c.party + "</p>" +
        "<p class='doc-h2'>反诉请求</p><p>一、……（请补充）。</p>" +
        "<p class='doc-h2'>事实与理由</p><p>……（请补充反诉事实与法律依据）。</p>" +
        "<p class='doc-sign'>此致</p><p class='doc-line'>" + (c.court || "________人民法院") + "</p>" +
        "<p class='doc-sign'>反诉人：" + c.party + "</p><p class='doc-line'>" + dToday() + "</p>";
    },
    "民事上诉状": function (c, me) {
      return "<div class='doc-h'>民事上诉状</div>" +
        "<p class='doc-line'><b>上诉人：</b>" + c.party + "</p>" +
        "<p class='doc-h2'>上诉请求</p><p>一、请求撤销一审判决；二、依法改判……（请补充）。</p>" +
        "<p class='doc-h2'>事实与理由</p><p>一审判决认定事实不清、适用法律错误……（请补充）。</p>" +
        "<p class='doc-sign'>此致</p><p class='doc-line'>________人民法院</p>" +
        "<p class='doc-sign'>上诉人：" + c.party + "</p><p class='doc-line'>" + dToday() + "</p>";
    },
    "刑事辩护词": function (c, me) {
      return "<div class='doc-h'>辩护词</div>" +
        "<p class='doc-line'>尊敬的审判长、审判员：</p>" +
        "<p class='doc-line'>" + me + "律师接受委托，担任被告人" + c.party + "（" + c.title + "）的辩护人，现发表如下辩护意见：</p>" +
        "<ol><li>一、关于事实：……（请补充）；</li><li>二、关于量刑：……（请补充）。</li></ol>" +
        "<p class='doc-sign'>辩护人：" + me + "</p><p class='doc-line'>" + dToday() + "</p>";
    },
    "代理意见": function (c, me) {
      return "<div class='doc-h'>代理意见</div>" +
        "<p class='doc-line'>尊敬的审判长、审判员：</p>" +
        "<p class='doc-line'>" + me + "律师作为" + c.party + "的委托诉讼代理人，就" + c.title + "一案发表如下代理意见：</p>" +
        "<ol><li>一、……（请补充）；</li><li>二、……（请补充）。</li></ol>" +
        "<p class='doc-sign'>代理人：" + me + "</p><p class='doc-line'>" + dToday() + "</p>";
    },
  };

  function generateDoc(caseObj, type) {
    const isH = docGenMode === "harness";
    let raw;
    if (isH) {
      // Harness 生成：调用外部桌面端 agent（window.__callHarness），并打开 DeepSeek Harness 界面；无外部则本地生成
      if (window.__callHarness && typeof window.__callHarness === "function") raw = window.__callHarness(type, caseObj, meName());
      else raw = harnessContent(type, caseObj, meName());
      // 桌面端已内置 AI，不再弹外部浏览器；仅在网页端(未嵌入)且用户选择 Harness 时尝试打开 DSH
      if (!window.__HARNESS_EMBEDDED__ && window.top === window.self) { /* 桌面端：由内置 AI 生成，不弹窗 */ }
    } else {
      const custom = docTpls[type];
      raw = custom ? fillCustomTemplate(custom, caseObj) : ((DOC_TEMPLATES[type] || function (c, me) { return ""; })(caseObj, meName()));
    }
    const rec = {
      id: uid(), type: type, caseNo: caseObj.no, caseTitle: caseObj.title,
      title: caseObj.title + " · " + type,
      content: raw,
      date: nowStr(), status: isH ? "已生成(Harness)" : "草稿",
      generator: isH ? "harness" : "template",
    };
    docs.unshift(rec); saveDocs();
    renderDocuments();
    openDocEditor(rec);
  }

  // Harness 生成：按本机 legal-skills 文书规范，结合案件事实生成更完整文档（生产由 AI/agent 执行）
  function harnessContent(type, c, me) {
    const date = dToday();
    const base = "<p>案件：" + c.title + "（" + c.no + "）</p>";
    const common = function (body) {
      return body +
        "<p style='margin-top:22px' class='doc-sign'>此致</p>" +
        "<p class='doc-line'>" + (c.court || "________人民法院") + "</p>" +
        "<p class='doc-sign'>" + me + "（" + myLicense() + "）</p>" +
        "<p class='doc-line'>" + date + "</p>";
    };
    if (type === "民事起诉状") {
      return "<div class='doc-h'>民事起诉状</div>" + base +
        "<p class='doc-h2'>诉讼请求</p><ol><li>一、请求判令被告向原告支付款项共计人民币________元；</li><li>二、请求判令被告承担本案全部诉讼费用。</li></ol>" +
        "<p class='doc-h2'>事实与理由</p><p>原告" + c.party + "与被告因" + c.title + "发生纠纷，案由为" + c.type + "。经多次协商未果，原告为维护自身合法权益，依据《中华人民共和国民法典》第____条、《中华人民共和国民事诉讼法》第____条之规定，特向贵院提起诉讼。</p>" +
        "<p class='doc-h2'>法律依据</p><p>《民法典》合同编/侵权责任编相关条款；《民事诉讼法》有关管辖与起诉的规定。</p>" +
        "<p class='doc-h2'>证据清单</p><p>1. 身份证明；2. 合同/协议；3. 转账凭证；4. 往来函件；</p>" + common("");
    }
    if (type === "民事答辩状") {
      return "<div class='doc-h'>民事答辩状</div>" + base +
        "<p class='doc-h2'>答辩理由</p><p>答辩人就" + c.title + "一案，针对原告的诉讼请求，发表答辩意见如下：一、原告所主张的事实与实际情况不符；二、原告的诉讼请求缺乏事实与法律依据；三、恳请法院依法驳回原告全部诉讼请求。</p>" + common("");
    }
    if (type === "质证意见") {
      return "<div class='doc-h'>质证意见</div>" + base +
        "<p class='doc-h2'>质证意见</p><p>对原告提交的证据，发表如下质证意见：对证据一，对其真实性无异议，但对其证明目的有异议；对证据二，对其真实性、合法性、关联性均有异议……综上，请法院依法审查。</p>" + common("");
    }
    if (type === "授权委托书") {
      return "<div class='doc-h'>授权委托书</div>" +
        "<p class='doc-line'>委托人：" + c.party + "</p><p class='doc-line'>受托人：" + me + "（执业证号：" + myLicense() + "）</p>" +
        "<p class='doc-h2'>委托权限</p><p>受托人在" + c.title + "一案中，有权代为承认、放弃、变更诉讼请求，进行和解，提起反诉或上诉等。</p>" +
        "<p class='doc-sign'>委托人（签名）：" + c.party + "</p><p class='doc-line'>" + date + "</p>";
    }
    if (type === "民事反诉状") {
      return "<div class='doc-h'>民事反诉状</div>" + base +
        "<p class='doc-h2'>反诉请求</p><p>一、请求判令本诉原告向反诉原告承担责任；二、本案诉讼费用由本诉原告承担。</p>" +
        "<p class='doc-h2'>事实与理由</p><p>反诉原告因本诉原告的违约/侵权行为造成损失，依据《民法典》相关规定，特此提起反诉。</p>" + common("");
    }
    if (type === "民事上诉状") {
      return "<div class='doc-h'>民事上诉状</div>" + base +
        "<p class='doc-h2'>上诉请求</p><p>一、请求撤销一审判决，依法改判；二、本案一二审诉讼费用由被上诉人承担。</p>" +
        "<p class='doc-h2'>事实与理由</p><p>一审判决认定事实不清、适用法律错误，程序违法。依据《民事诉讼法》第____条，特提出上诉。</p>" + common("");
    }
    if (type === "刑事辩护词") {
      return "<div class='doc-h'>辩护词</div>" + base +
        "<p class='doc-line'>尊敬的审判长、审判员：</p>" +
        "<p class='doc-line'>" + me + "律师依法接受委托，担任被告人" + c.party + "的辩护人。通过阅卷、会见，现发表如下辩护意见：</p>" +
        "<p class='doc-h2'>一、关于事实</p><p>本案指控被告人" + c.party + "犯罪的事实不清、证据不足；</p>" +
        "<p class='doc-h2'>二、关于量刑</p><p>被告人具有法定/酌定从轻、减轻情节，恳请法院依法从轻处罚。</p>" +
        "<p class='doc-sign'>辩护人：" + me + "</p><p class='doc-line'>" + date + "</p>";
    }
    if (type === "代理意见") {
      return "<div class='doc-h'>代理意见</div>" + base +
        "<p class='doc-line'>尊敬的审判长、审判员：</p>" +
        "<p class='doc-line'>" + me + "律师作为" + c.party + "的委托诉讼代理人，就" + c.title + "一案，发表如下代理意见：</p>" +
        "<p class='doc-h2'>一、事实层面</p><p>……</p><p class='doc-h2'>二、法律适用</p><p>……</p><p class='doc-h2'>三、结论</p><p>恳请法院依法支持我方主张。</p>" + common("");
    }
    return common("<div class='doc-h'>" + type + "</div>" + base + "<p class='doc-h2'>正文</p><p>……</p>");
  }

  function renderDocuments() {
    const caseRows = mock.cases.map(function (c) {
      const chips = DOC_TYPES.map(function (t) {
        return "<button class='doc-chip' data-gen='" + c.no + "' data-type='" + t + "'>" + t + "</button>";
      }).join("");
      return "<div class='case-doc-row'><div class='cd-head'><strong>" + c.no + "</strong><span>" + c.title + "</span></div>" +
        "<div class='cd-chips'>" + chips + "</div></div>";
    }).join("");

    let docRows;
    if (!docs.length) {
      docRows = "<div class='empty'>还没有生成文书<br>在上方「案件建档」选择文书类型即可生成</div>";
    } else {
      docRows = "<table class='table'><thead><tr><th>文书名称</th><th>类型</th><th>所属案件</th><th>生成方式</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>" +
        docs.map(function (d) {
          const gen = d.generator === "harness" ? "<span class='badge badge-warning'>Harness</span>" : "<span class='badge badge-info'>模板</span>";
          return "<tr><td><strong>" + d.title + "</strong></td><td><span class='badge badge-info'>" + d.type + "</span></td>" +
            "<td>" + d.caseTitle + "</td><td>" + gen + "</td><td><span class='badge badge-warning'>" + d.status + "</span></td>" +
            "<td>" + d.date + "</td>" +
            "<td><div style='display:flex;gap:6px'>" +
            "<button class='btn btn-sm btn-ghost' data-edit='" + d.id + "'>编辑</button>" +
            "<button class='btn btn-sm btn-primary' data-print='" + d.id + "'>打印</button>" +
            "<button class='btn btn-sm btn-danger' data-del='" + d.id + "'>删</button></div></td></tr>";
        }).join("") + "</tbody></table>";
    }

    el.content.innerHTML =
      '<div class="page-head"><div><h1>' + curTitle + "</h1><div class='sub'>" + curSub + "</div></div></div>" +
      "<div class='card glow'><div class='card-head'><h2>案件建档（选择案件生成对应文书）</h2>" +
      "<div style='display:flex;gap:8px;align-items:center;flex-wrap:wrap'>" +
      "<div class='tabs' data-genmode>" +
      "<button class='" + (docGenMode === "template" ? "active" : "") + "' data-gm='template'>模板生成</button>" +
      "<button class='" + (docGenMode === "harness" ? "active" : "") + "' data-gm='harness'>Harness 生成</button>" +
      "</div>" +
      (docGenMode === "template" ? "<button class='btn btn-ghost btn-sm' data-upload-tpl> 上传模板</button>" : "") +
      "</div></div>" +
      "<div class='case-doc-list'>" + caseRows + "</div></div>" +
      "<div class='card glow' style='margin-top:18px'><div class='card-head'><h2>已生成文书</h2>" +
      "<span class='badge badge-info'>共 " + docs.length + " 份</span></div>" + docRows + "</div>";

    bindDocEvents();
  }

  function bindDocEvents() {
    el.content.querySelectorAll("[data-upload-tpl]").forEach(function (b) {
      b.addEventListener("click", openDocTemplateUpload);
    });
    el.content.querySelectorAll("[data-gm]").forEach(function (b) {
      b.addEventListener("click", function () {
        docGenMode = b.getAttribute("data-gm");
        renderDocuments();
      });
    });
    el.content.querySelectorAll("[data-gen]").forEach(function (b) {
      b.addEventListener("click", function () {
        const c = mock.cases.find(function (x) { return x.no === b.getAttribute("data-gen"); });
        if (c) generateDoc(c, b.getAttribute("data-type"));
      });
    });
    el.content.querySelectorAll("[data-edit]").forEach(function (b) {
      b.addEventListener("click", function () {
        const d = docs.find(function (x) { return x.id === b.getAttribute("data-edit"); });
        if (d) openDocEditor(d);
      });
    });
    el.content.querySelectorAll("[data-print]").forEach(function (b) {
      b.addEventListener("click", function () {
        const d = docs.find(function (x) { return x.id === b.getAttribute("data-print"); });
        if (d) printDoc(d);
      });
    });
    el.content.querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", function () {
        docs = docs.filter(function (x) { return x.id !== b.getAttribute("data-del"); });
        saveDocs(); renderDocuments();
      });
    });
  }

  // 上传自有模板（用占位符替换案件变量）
  function openDocTemplateUpload() {
    const existing = Object.keys(docTpls).map(function (k) { return "<div class='supp-item'> " + k + "：已上传自有模板</div>"; }).join("");
    const m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML = "<div class='modal glow' style='width:560px'>" +
      "<h3>上传文书模板</h3>" +
      "<div class='form-group'><label>对应文书类型</label><select id='dttType'>" + DOC_TYPES.map(function (t) { return "<option>" + t + "</option>"; }).join("") + "</select></div>" +
      "<div class='form-group'><label>模板文件（.txt / .md / .html，用 {{案由}} {{当事人}} {{法院}} {{案号}} {{案件}} {{姓名}} {{证号}} {{日期}} 作变量）</label>" +
      "<label class='btn btn-ghost btn-sm' style='cursor:pointer'> 选择模板文件<input type='file' id='dttFile' accept='.txt,.md,.html' style='display:none'></label></div>" +
      "<div class='supp-list'>" + (existing || "<span class='ev-empty'>暂未上传模板</span>") + "</div>" +
      "<div class='modal-actions'><button class='btn btn-ghost' data-close>取消</button><button class='btn btn-primary' data-save>保存模板</button></div></div>";
    document.body.appendChild(m);
    let pending = null;
    m.querySelector("#dttFile").addEventListener("change", function () {
      const f = this.files && this.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = function (e) { pending = e.target.result; };
      r.readAsText(f);
    });
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.hasAttribute && e.target.hasAttribute("data-save")) {
        if (!pending) { toast("请先选择模板文件", "error"); return; }
        const t = m.querySelector("#dttType").value;
        docTpls[t] = pending; saveDocTpls(); m.remove(); toast("模板已保存：" + t, "success");
      }
    });
  }

  function openDocEditor(rec) {
    const m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML = "<div class='modal glow doc-modal'><div class='card-head'><h3>" + rec.title + "</h3>" +
      "<span class='badge badge-info'>" + rec.type + "</span></div>" +
      "<div class='doc-editor' contenteditable='false'>" + rec.content + "</div>" +
      "<div class='modal-actions approval-no-print'>" +
      "<button class='btn btn-ghost' data-edittoggle> 编辑</button>" +
      "<button class='btn' data-exportpdf> 导出 PDF</button>" +
      "<button class='btn' data-exportdocx> 导出 DOCX</button>" +
      "<button class='btn btn-ghost' data-print> 一键打印</button>" +
      "<button class='btn btn-primary' data-save>保存</button>" +
      "<button class='btn btn-ghost' data-close>关闭</button></div></div>";
    document.body.appendChild(m);
    const editor = m.querySelector(".doc-editor");
    m.addEventListener("click", function (e) {
      const t = e.target;
      if (t === m || (t.hasAttribute && t.hasAttribute("data-close"))) { m.remove(); return; }
      if (t.hasAttribute && t.hasAttribute("data-edittoggle")) {
        const on = editor.getAttribute("contenteditable") !== "true";
        editor.setAttribute("contenteditable", on ? "true" : "false");
        editor.classList.toggle("editing", on);
        t.textContent = on ? " 完成编辑" : " 编辑";
      }
      if (t.hasAttribute && t.hasAttribute("data-save")) {
        rec.content = editor.innerHTML;
        rec.status = "已生成"; rec.date = nowStr();
        saveDocs(); m.remove(); renderDocuments();
        toast("文书已保存", "success");
      }
      if (t.hasAttribute && t.hasAttribute("data-exportpdf")) {
        rec.content = editor.innerHTML; rec.status = "已生成"; rec.date = nowStr(); saveDocs();
        m.remove(); printDoc(rec);
      }
      if (t.hasAttribute && t.hasAttribute("data-exportdocx")) {
        rec.content = editor.innerHTML; rec.status = "已生成"; rec.date = nowStr(); saveDocs();
        exportDocx(rec);
      }
      if (t.hasAttribute && t.hasAttribute("data-print")) {
        rec.content = editor.innerHTML; rec.status = "已生成"; rec.date = nowStr(); saveDocs();
        m.remove(); printDoc(rec);
      }
    });
  }

  // 导出 DOCX（Word 兼容 HTML  .doc，Word 打开可另存为 .docx）
  function exportDocx(rec) {
    const html = "<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'>" +
      "<style>body{font-family:FangSong_GB2312,FangSong,SimSun,serif;font-size:14pt;line-height:28pt;color:#000;} .doc-h{font-size:22pt;font-weight:bold;text-align:center;letter-spacing:4px;} .doc-h2{font-size:16pt;font-weight:bold;} .doc-sign{text-align:right;margin-top:16pt;} td,th,li,p{font-size:14pt;}</style></head><body>" + rec.content + "</body></html>";
    const blob = new Blob(["\ufeff" + html], { type: "application/msword" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (rec.title || "文书") + ".doc";
    a.click();
    toast("已导出 Word 文档（.doc，可另存为 .docx）", "success");
  }

  function printDoc(rec) {
    const ov = document.createElement("div");
    ov.className = "modal-overlay show";
    ov.id = "docPrint";
    ov.innerHTML = "<div class='modal doc-print-shell'>" +
      "<div class='doc-print'>&nbsp;</div>" +
      "<div class='modal-actions approval-no-print'><button class='btn btn-ghost' data-close>关闭</button>" +
      "<button class='btn btn-primary' data-doprint> 一键打印</button></div></div>";
    document.body.appendChild(ov);
    ov.querySelector(".doc-print").innerHTML = rec.content;
    ov.querySelector("[data-close]").addEventListener("click", function () { ov.remove(); });
    ov.querySelector("[data-doprint]").addEventListener("click", function () { window.print(); });
  }

  // —— 授权签批（第4条）：PDF 导出 + 电子签 + 双方留档 ——
  const APPROV_KEY = "legal-mode.approvals";
  function loadApprovals() { try { return JSON.parse(localStorage.getItem(APPROV_KEY) || "[]"); } catch (e) { return []; } }
  function saveApprovals() { localStorage.setItem(APPROV_KEY, JSON.stringify(approvals)); }
  let approvals = loadApprovals();
  // 一次性清理早期测试污染数据（file:// localStorage 共享导致）
  try {
    if (!localStorage.getItem("legal-mode.ap-clean-v1")) {
      localStorage.removeItem("legal-mode.approvals");
      localStorage.setItem("legal-mode.ap-clean-v1", "1");
      approvals = [];
    }
  } catch (e) {}
  const APPROV_ITEMS = ["委托代理", "合作办案", "费用审批", "权限设置"];
  const APPROV_STATUS = { pending: ["待签批", "badge-warning"], signed: ["已签批", "badge-success"], rejected: ["已拒绝", "badge-danger"] };
  const SIGN_METHOD = { electronic: "电子签", paper: "纸质签" };

  function addHistory(rec, action, note) {
    rec.history = rec.history || [];
    rec.history.push({ action: action, time: nowStr(), note: note || "" });
  }

  // 删除保护：开发者特权可删任意；否则仅"从未进入签批流程、无任何签批结果/反馈"的申请可删除
  function isApprovalDeletable(a) {
    const l = loadLawyer();
    if (l && l.dev) return true;
    return a.status === "pending" && !a.signMethod && !a.rejectReason && (a.history || []).length <= 1;
  }

  function confirmDeleteApproval(a) {
    const m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML = "<div class='modal glow' style='width:440px'>" +
      "<h3>删除授权申请</h3>" +
      "<p style='font-size:13.5px;color:var(--text-soft);line-height:1.8'>确认删除该申请？此操作不可撤销。<br>" +
      "案号：<b>" + a.caseNo + "</b><br>案件：" + a.caseTitle + "</p>" +
      "<div class='modal-actions'><button class='btn btn-ghost' data-close>取消</button>" +
      "<button class='btn btn-danger' data-ok>确认删除</button></div></div>";
    document.body.appendChild(m);
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.hasAttribute && e.target.hasAttribute("data-ok")) {
        approvals = approvals.filter(function (x) { return x.id !== a.id; });
        saveApprovals(); m.remove(); renderApprovalView();
        toast("已删除该授权申请", "success");
      }
    });
  }

  function renderApprovalView() {
    const pending = approvals.filter(function (a) { return a.status === "pending"; }).length;
    const signed = approvals.filter(function (a) { return a.status === "signed"; }).length;
    const rejected = approvals.filter(function (a) { return a.status === "rejected"; }).length;

    const stat = "<div class='grid cols-4'>" +
      "<div class='stat-card glow'><div class='stat-icon'></div><div class='stat-label'>授权申请</div><div class='stat-value'>" + approvals.length + "</div></div>" +
      "<div class='stat-card glow'><div class='stat-icon'></div><div class='stat-label'>待签批</div><div class='stat-value'>" + pending + "</div></div>" +
      "<div class='stat-card glow'><div class='stat-icon'></div><div class='stat-label'>已签批</div><div class='stat-value'>" + signed + "</div></div>" +
      "<div class='stat-card glow'><div class='stat-icon'></div><div class='stat-label'>已拒绝</div><div class='stat-value'>" + rejected + "</div></div></div>";

    let list;
    if (!approvals.length) {
      list = "<div class='card glow'><div class='empty'>暂无授权申请<br>点击「新建授权申请」，从案件生成审批单</div></div>";
    } else {
      const rows = approvals.map(function (a) {
        const st = APPROV_STATUS[a.status] || APPROV_STATUS.pending;
        const methodBadge = a.signMethod ? "<span class='badge badge-info'>" + SIGN_METHOD[a.signMethod] + "</span> " : "";
        const rejectInfo = (a.status === "rejected" && a.rejectReason)
          ? "<div class='tl-meta' style='color:var(--danger)'>拒签原因：" + a.rejectReason + "</div>" : "";
        const suppNote = (a.supplementary && a.supplementary.length)
          ? "<div class='tl-meta'>补充材料 " + a.supplementary.length + " 份</div>" : "";
        let actionHtml;
        if (a.status === "pending") actionHtml = "<button class='btn btn-sm btn-primary' data-view='" + a.id + "'>审批/签</button>";
        else if (a.status === "rejected") actionHtml = "<button class='btn btn-sm btn-ghost' data-reapply='" + a.id + "'>补充并重发起</button> <button class='btn btn-sm btn-ghost' data-view='" + a.id + "'>查看</button>";
        else actionHtml = "<button class='btn btn-sm btn-ghost' data-view='" + a.id + "'>查看</button>";
        // 开发者特权可删任意记录（含已签/已拒）
        if (isApprovalDeletable(a)) actionHtml += " <button class='btn btn-sm btn-danger' data-del='" + a.id + "'>删除</button>";
        const delLock = (!isApprovalDeletable(a)) ? "<span title='已进入签批流程/有签批反馈，不可删除' style='color:var(--text-dim);font-size:11px'></span>" : "";
        return "<tr><td><strong>" + a.caseNo + "</strong><div class='tl-meta'>" + a.caseTitle + "</div>" + rejectInfo + suppNote + "</td>" +
          "<td>" + a.item + "</td><td>" + a.applicant + "</td><td>" + a.authorizer + "</td>" +
          "<td><span class='badge " + st[1] + "'><i class='badge-dot'></i>" + st[0] + "</span> " + methodBadge + "</td>" +
          "<td>" + a.date + "</td>" +
          "<td><div style='display:flex;gap:6px;flex-wrap:wrap'>" + actionHtml + delLock + "</div></td></tr>";
      }).join("");
      list = "<div class='card glow'><div class='card-head'><h2>授权申请列表</h2></div>" +
        "<table class='table'><thead><tr><th>案号 / 案件</th><th>申请事项</th><th>申请人(被授权人)</th><th>授权人</th><th>状态/签批方式</th><th>申请日期</th><th>操作</th></tr></thead><tbody>" +
        rows + "</tbody></table></div>";
    }

    el.content.innerHTML =
      '<div class="page-head"><div><h1>' + curTitle + "</h1><div class='sub'>" + curSub + "</div></div>" +
      '<button class="btn btn-primary glow" id="newApprov">＋ 新建授权申请</button></div>' +
      stat + "<div style='margin-top:18px'>" + list + "</div>";

    const n = document.getElementById("newApprov");
    if (n) n.addEventListener("click", openApprovalForm);
    el.content.querySelectorAll("[data-view]").forEach(function (b) {
      b.addEventListener("click", function () {
        const a = approvals.find(function (x) { return x.id === b.getAttribute("data-view"); });
        if (a) openApprovalDoc(a);
      });
    });
    el.content.querySelectorAll("[data-reapply]").forEach(function (b) {
      b.addEventListener("click", function () {
        const a = approvals.find(function (x) { return x.id === b.getAttribute("data-reapply"); });
        if (a) openSupplementModal(a);
      });
    });
    el.content.querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", function () {
        const a = approvals.find(function (x) { return x.id === b.getAttribute("data-del"); });
        if (a) {
          if (isApprovalDeletable(a)) confirmDeleteApproval(a);
          else toast("该申请已进入签批流程/有签批反馈，不可删除", "error");
        }
      });
    });
  }

  // 新建授权申请（选案件 + 申请事项 + 授权人）
  function openApprovalForm() {
    const caseOpts = mock.cases.map(function (c, i) {
      return "<option value='" + i + "'>" + c.no + " — " + c.title + "</option>";
    }).join("");
    const authorizerOpts = ["张冬宝", "李慧敏", "王建国"].map(function (n) {
      return "<option>" + n + "</option>";
    }).join("");
    const itemOpts = APPROV_ITEMS.map(function (it) {
      return "<option>" + it + "</option>";
    }).join("");
    const m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML = "<div class='modal glow'>" +
      "<h3>新建授权申请</h3>" +
      '<div class="form-group"><label>选择案件</label><select id="apCase">' + caseOpts + "</select></div>" +
      '<div class="form-row"><div class="form-group"><label>申请事项</label><select id="apItem">' + itemOpts + "</select></div>" +
      '<div class="form-group"><label>授权人</label><select id="apAuthorizer">' + authorizerOpts + "</select></div></div>" +
      '<div class="form-group"><label>核心内容 / 申请说明</label><textarea id="apContent" rows="3" placeholder="如：因案件进入关键阶段，申请授权对外签署和解协议……"></textarea></div>' +
      '<div class="form-group"><label>建议签批方式</label><select id="apMethod"><option value="electronic">电子签（手写板）</option><option value="paper">纸质签批（打印签署后扫描上传）</option></select></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-close>取消</button>' +
      '<button class="btn btn-primary" data-gen>生成审批单</button></div></div>';
    document.body.appendChild(m);
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.hasAttribute && e.target.hasAttribute("data-gen")) {
        const c = mock.cases[parseInt(m.querySelector("#apCase").value, 10)];
        const rec = {
          id: uid(), caseNo: c.no, caseTitle: c.title, type: c.type, party: c.party, court: c.court,
          applicant: meName(), authorizer: m.querySelector("#apAuthorizer").value,
          item: m.querySelector("#apItem").value,
          preferredMethod: m.querySelector("#apMethod").value,
          content: m.querySelector("#apContent").value.trim() ||
            "兹有" + c.party + "与" + c.type + "案件（" + c.no + "），因" + c.title + "，需" + m.querySelector("#apAuthorizer").value + "授权，以推进后续程序。",
          status: "pending", date: nowStr(), signer: "", signDate: "", signature: "",
          signMethod: "", rejectReason: "", supplementary: [], history: [],
        };
        addHistory(rec, "发起", "创建授权申请，建议签批方式：" + SIGN_METHOD[rec.preferredMethod]);
        approvals.push(rec); saveApprovals();
        m.remove(); renderApprovalView(); openApprovalDoc(rec);
      }
    });
  }

  // 审批单（PDF 页面） + 电子签 / 纸质签 双模式
  function openApprovalDoc(rec) {
    const st = APPROV_STATUS[rec.status] || APPROV_STATUS.pending;
    const isPending = rec.status === "pending";

    const meta =
      "<div class='doc-meta'>" +
      "<div class='mi'><b>案号</b><span>" + rec.caseNo + "</span></div>" +
      "<div class='mi'><b>案由类型</b><span>" + rec.type + "</span></div>" +
      "<div class='mi'><b>当事人</b><span>" + rec.party + "</span></div>" +
      "<div class='mi'><b>受托法院</b><span>" + (rec.court || "-") + "</span></div>" +
      "<div class='mi'><b>申请事项</b><span>" + rec.item + "</span></div>" +
      "<div class='mi'><b>申请人(被授权人)</b><span>" + rec.applicant + "</span></div>" +
      "<div class='mi'><b>授权人</b><span>" + rec.authorizer + "</span></div>" +
      "<div class='mi'><b>申请日期</b><span>" + rec.date + "</span></div>" +
      "</div>";

    // 签批区（按状态渲染）
    let signArea = "";
    if (rec.status === "signed") {
      signArea = "<div class='sign-box'><div class='sign-label'>授权人签字（" + SIGN_METHOD[rec.signMethod] + "）</div>" +
        (rec.signature ? "<img class='sign-img' src='" + rec.signature + "' alt='signature'>" : "<span class='ev-empty'>纸质签批扫描件已留存</span>") +
        "<div class='sign-line'>" + rec.signer + " · " + rec.signDate + "</div></div>";
    } else if (rec.status === "rejected") {
      signArea = "<div class='reject-box'><div class='sign-label'>审批结果</div>" +
        "<div style='color:var(--danger);font-size:13px;line-height:1.7'>已拒绝：" + (rec.rejectReason || "未填写原因") + "</div></div>";
    } else {
      // pending：双模式 + 拒签原因
      const preferred = rec.preferredMethod || "electronic";
      signArea =
        "<div class='sign-modes'>" +
          "<button data-modesel='electronic' class='" + (preferred === "paper" ? "" : "active") + "'> 电子签</button>" +
          "<button data-modesel='paper' class='" + (preferred === "paper" ? "active" : "") + "'> 纸质签批</button>" +
        "</div>" +
        "<div id='electronicPanel'" + (preferred === "paper" ? " style='display:none'" : "") + ">" +
          "<div class='sign-box'><div class='sign-label'>授权人签字（手写电子签）</div>" +
          "<canvas class='sign-canvas' id='signCanvas' width='320' height='110'></canvas>" +
          "<div class='sign-line'>签字人：" + rec.authorizer + "</div>" +
          "<div style='margin-top:6px'><button class='btn btn-sm btn-ghost' id='signClear'>清除</button></div></div>" +
        "</div>" +
        "<div id='paperPanel'" + (preferred === "paper" ? "" : " style='display:none'") + ">" +
          "<div class='paper-note'>打印本审批单  授权人<b>纸质签字</b>  拍照/扫描上传回档（以此规避模仿/盗签风险）。</div>" +
          "<div style='display:flex;gap:8px;margin-top:10px;align-items:center'>" +
            "<button class='btn btn-ghost btn-sm' data-export> 打印审批单</button>" +
            "<label class='btn btn-ghost btn-sm' style='cursor:pointer'> 上传签字扫描件<input type='file' id='paperScan' accept='image/*,application/pdf' style='display:none'></label>" +
            "<span class='ev-empty' id='paperState'>未上传</span>" +
          "</div>" +
        "</div>" +
        "<div class='reject-box' style='margin-top:12px'><div class='sign-label'>拒签原因（如前置条件不满足）</div>" +
          "<textarea id='rejectReason' rows='2' placeholder='填写后点「拒绝」将记录原因，申请人可补充材料后重新发起'></textarea>" +
        "</div>" +
        (rec.history && rec.history.length ? historyHTML(rec) : "");
    }

    const ov = document.createElement("div");
    ov.className = "modal-overlay show";
    ov.id = "approvalDoc";
    ov.innerHTML = "<div class='modal' style='width:760px'>" +
      "<div class='aprov-doc'>" +
      "<div class='doc-head'><h2>案件授权 / 签批申请单</h2><div class='doc-no'>编号：" + rec.id + " · 状态：" + st[0] + "</div></div>" +
      meta +
      "<div class='doc-content'><b>核心内容：</b>" + rec.content + "</div>" +
      "<div class='doc-sign'>" + signArea + "</div>" +
      "</div>" +
      "<div class='aprov-actions approval-no-print'>" +
      (isPending
        ? "<button class='btn btn-ghost' data-reject>拒绝</button>" +
          "<button class='btn' data-export> 导出 PDF</button>" +
          "<button class='btn btn-primary' data-sign>确认签批</button>"
        : "<button class='btn' data-export> 导出 PDF</button>") +
      "<button class='btn btn-ghost' data-close>关闭</button>" +
      "</div></div>";
    document.body.appendChild(ov);

    if (isPending) {
      let mode = (rec.preferredMethod === "paper") ? "paper" : "electronic";
      let paperSigned = null; // {sig, name} 纸质签扫描件

      // 双模式切换
      ov.querySelectorAll("[data-modesel]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          mode = btn.getAttribute("data-modesel");
          ov.querySelectorAll("[data-modesel]").forEach(function (b) { b.classList.toggle("active", b === btn); });
          ov.querySelector("#electronicPanel").style.display = mode === "electronic" ? "" : "none";
          ov.querySelector("#paperPanel").style.display = mode === "paper" ? "" : "none";
        });
      });
      // 纸质签上传
      const scan = ov.querySelector("#paperScan");
      if (scan) scan.addEventListener("change", function () {
        const f = this.files && this.files[0];
        if (!f) return;
        paperSigned = { sig: "", name: f.name };
        const reader = new FileReader();
        reader.onload = function (e) {
          if (f.type && f.type.indexOf("image/") === 0) paperSigned.sig = e.target.result;
          ov.querySelector("#paperState").textContent = "已上传：" + f.name;
        };
        reader.readAsDataURL(f);
      });

      setupSignature(ov.querySelector("#signCanvas"));
      const clear = ov.querySelector("#signClear");
      if (clear) clear.addEventListener("click", function () { const c = ov.querySelector("#signCanvas"); if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height); });

      // 拒绝
      const rej = ov.querySelector("[data-reject]");
      if (rej) rej.addEventListener("click", function () {
        rec.rejectReason = (ov.querySelector("#rejectReason") || {}).value || "未填写原因";
        rec.status = "rejected"; rec.signer = rec.authorizer; rec.signDate = nowStr();
        addHistory(rec, "拒绝", rec.rejectReason);
        saveApprovals(); ov.remove(); renderApprovalView();
        toast("已拒绝：申请人可补充材料后重新发起", "error");
      });

      // 确认签批
      const sign = ov.querySelector("[data-sign]");
      if (sign) sign.addEventListener("click", function () {
        if (mode === "electronic") {
          const c = ov.querySelector("#signCanvas");
          if (!c || !c.getContext("2d").getImageData(0, 0, c.width, c.height).data.some(function (v) { return v !== 0; })) {
            toast("请先完成手写电子签", "error"); return;
          }
          rec.signature = c.toDataURL("image/png"); rec.signMethod = "electronic";
        } else {
          if (!paperSigned) { toast("请先上传纸质签批扫描件", "error"); return; }
          rec.signature = paperSigned.sig; rec.signMethod = "paper";
          if (!rec.signature) rec.signature = ""; // pdf：仅记录，不嵌图
        }
        rec.signer = rec.authorizer; rec.signDate = nowStr(); rec.status = "signed";
        addHistory(rec, "签批", SIGN_METHOD[rec.signMethod] + " 通过");
        saveApprovals(); ov.remove(); renderApprovalView();
        toast("已签批，记录分别留存授权人与被授权人工作台", "success");
      });
    }

    ov.querySelector("[data-close]").addEventListener("click", function () { ov.remove(); });
    const exp = ov.querySelector("[data-export]");
    if (exp) exp.addEventListener("click", function () { exportApprovPDF(); });
  }

  function historyHTML(rec) {
    return "<div class='history-box'><div class='sign-label'>流转记录</div>" +
      rec.history.map(function (h) {
        return "<div class='history-item'><b>" + h.action + "</b><span>" + h.time + "</span><span>" + (h.note || "") + "</span></div>";
      }).join("") + "</div>";
  }

  // 拒签后：补充相关材料并重新发起签批
  function openSupplementModal(rec) {
    const supp = rec.supplementary || [];
    const m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML = "<div class='modal glow' style='width:560px'>" +
      "<h3>补充材料并重新发起签批</h3>" +
      "<div class='reject-box'><div class='sign-label'>拒签原因</div>" +
      "<div style='color:var(--danger);font-size:13px'>" + (rec.rejectReason || "未填写原因") + "</div></div>" +
      '<div class="form-group" style="margin-top:14px"><label>案件</label><div style="font-size:13px">' + rec.caseNo + " · " + rec.caseTitle + "</div></div>" +
      '<div class="form-group"><label>补充材料（图片 / PDF / 视频 / 录音）</label>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<label class="btn btn-ghost btn-sm" style="cursor:pointer"> 上传补充材料<input type="file" id="suppFile" multiple style="display:none"></label>' +
        "</div>" +
        '<div class="supp-list" id="suppList">' + (supp.length ? supp.map(function (s) { return "<div class='supp-item'> " + s.name + "</div>"; }).join("") : "<span class='ev-empty'>暂未补充材料</span>") + "</div>" +
      "</div>" +
      '<div class="form-group"><label>补充说明</label><textarea id="suppNote" rows="2" placeholder="说明已补充/更正的内容，以满足签批前置条件"></textarea></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-close>取消</button>' +
      '<button class="btn btn-primary" data-submit>重新发起签批</button></div></div>';
    document.body.appendChild(m);

    let pendingFiles = [];
    const fileInput = m.querySelector("#suppFile");
    fileInput.addEventListener("change", function () {
      Array.from(this.files || []).forEach(function (f) {
        pendingFiles.push(f.name);
        rec.supplementary = rec.supplementary || [];
        rec.supplementary.push({ name: f.name, size: f.size, time: nowStr() });
      });
      m.querySelector("#suppList").innerHTML = rec.supplementary.map(function (s) { return "<div class='supp-item'> " + s.name + "</div>"; }).join("");
      this.value = "";
    });

    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.hasAttribute && e.target.hasAttribute("data-submit")) {
        const note = (m.querySelector("#suppNote") || {}).value || "";
        rec.status = "pending"; rec.signDate = ""; rec.signature = ""; rec.signMethod = "";
        addHistory(rec, "补充并重新发起", note || "已补充相关材料" + (rec.supplementary.length ? "（" + rec.supplementary.length + " 份）" : ""));
        saveApprovals(); m.remove(); renderApprovalView();
        toast("已重新发起，等待授权人签批", "success");
      }
    });
  }

  function setupSignature(canvas) {
    const ctx = canvas.getContext("2d");
    ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#1b2b4a";
    let drawing = false;
    function pos(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    canvas.addEventListener("pointerdown", function (e) { drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
    canvas.addEventListener("pointermove", function (e) { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
    window.addEventListener("pointerup", function () { drawing = false; });
  }

  function exportApprovPDF() {
    window.print();
  }

  // —— 系统看板（第3条）：甘特图 / 环形图 / 期限临近 / 律师负荷 ——
  const PHASES = [
    { name: "委托立案", frac: 0.08, color: "#4f8cff" },
    { name: "举证期", frac: 0.30, color: "#ff9d3d" },
    { name: "庭前/开庭", frac: 0.16, color: "#7b5bff" },
    { name: "判决", frac: 0.22, color: "#f43f8e" },
    { name: "执行", frac: 0.24, color: "#12b5a5" },
  ];
  const STATUS_COLOR = {
    "审理中": "#4f8cff", "已立案": "#35d39a", "等待开庭": "#ffb83d",
    "举证中": "#ff8a3d", "执行中": "#7b5bff", "待立案": "#f43f8e",
  };
  const TYPE_COLOR = { "民事": "#4f8cff", "刑事": "#f43f8e", "行政": "#ffb83d", "执行": "#7b5bff", "非诉": "#12b5a5" };

  function donutSVG(segs, size, label) {
    size = size || 150; const stroke = 22; const r = (size - stroke) / 2, c = 2 * Math.PI * r;
    const cx = size / 2, cy = size / 2;
    const total = segs.reduce(function (s, x) { return s + x.value; }, 0) || 1;
    let acc = 0;
    const arcs = segs.map(function (seg) {
      const frac = seg.value / total;
      const dash = Math.max(frac * c - 3, 0);
      const off = -acc * c;
      acc += frac;
      return "<circle cx='" + cx + "' cy='" + cy + "' r='" + r + "' fill='none' stroke='" + seg.color +
        "' stroke-width='" + stroke + "' stroke-dasharray='" + dash + " " + (c - dash) +
        "' stroke-dashoffset='" + off + "' transform='rotate(-90 " + cx + " " + cy + ")'/>";
    }).join("");
    return "<svg width='" + size + "' height='" + size + "' viewBox='0 0 " + size + " " + size + "'>" + arcs +
      "<text x='" + cx + "' y='" + cy + "' text-anchor='middle' dominant-baseline='central' class='donut-center-label'>" + label + "</text></svg>";
  }

  function renderBoard() {
    // 状态 / 类型分布
    const statusCount = {};
    const typeCount = {};
    mock.cases.forEach(function (c) {
      statusCount[c.status] = (statusCount[c.status] || 0) + 1;
      typeCount[c.type] = (typeCount[c.type] || 0) + 1;
    });
    const statusSegs = Object.keys(statusCount).map(function (k) { return { name: k, value: statusCount[k], color: STATUS_COLOR[k] || "#8899aa" }; });
    const typeSegs = Object.keys(typeCount).map(function (k) { return { name: k, value: typeCount[k], color: TYPE_COLOR[k] || "#8899aa" }; });

    function legend(segs) {
      return segs.map(function (s) {
        return "<div class='donut-legend-item'><i style='background:" + s.color + "'></i>" +
          "<span class='link' data-switch='cases' title='前往案件'>" + s.name + "</span>" +
          "<span class='dv'>" + s.value + " 件</span></div>";
      }).join("");
    }
    const donutHTML =
      "<div class='board-donuts'>" +
      "<div class='card glow'><div class='card-head'><h2>案件状态分布</h2></div><div class='donut-wrap'>" +
        donutSVG(statusSegs, 150, mock.cases.length) + "<div class='donut-legend'>" + legend(statusSegs) + "</div></div></div>" +
      "<div class='card glow'><div class='card-head'><h2>案件类型分布</h2></div><div class='donut-wrap'>" +
        donutSVG(typeSegs, 150, mock.cases.length) + "<div class='donut-legend'>" + legend(typeSegs) + "</div></div></div>" +
      "<div class='card glow'><div class='card-head'><h2>律师负荷（承办案件数）</h2></div>" + lawyerLoadHTML() + "</div>" +
      "</div>";

    el.content.innerHTML =
      '<div class="page-head"><div><h1>' + curTitle + "</h1><div class='sub'>" + curSub + "</div></div>" +
      '<button class="btn btn-ghost" id="boardRefresh"> 刷新</button></div>' +
      donutHTML +
      '<div class="card glow" style="margin-top:18px"><div class="card-head"><h2>案件阶段甘特图</h2>' +
      '<span class="badge badge-info">按案件进度着色</span></div>' + ganttHTML() + "</div>" +
      '<div class="card glow" style="margin-top:18px"><div class="card-head"><h2>期限临近</h2></div>' + deadlineHTML() + "</div>";

    const r = document.getElementById("boardRefresh");
    if (r) r.addEventListener("click", function () { renderBoard(); });
    el.content.querySelectorAll("[data-switch]").forEach(function (b) {
      b.addEventListener("click", function () { switchTo(b.getAttribute("data-switch")); });
    });
  }

  function lawyerLoadHTML() {
    const byLawyer = {};
    mock.cases.forEach(function (c) { byLawyer[c.lawyer] = (byLawyer[c.lawyer] || 0) + 1; });
    const max = Math.max.apply(null, Object.values(byLawyer).concat([1]));
    return Object.keys(byLawyer).map(function (n) {
      const v = byLawyer[n];
      return "<div class='loadbar'><span class='lb-name'>" + n + "</span>" +
        "<div class='lb-track'><div class='lb-fill' style='width:" + (v / max * 100) + "%'></div></div>" +
        "<span class='lb-val'>" + v + " 件</span></div>";
    }).join("");
  }

  function deadlineHTML() {
    const items = mock.schedule.filter(function (s) { return !s.done; }).slice(0, 6);
    return "<table class='table'><thead><tr><th>事项</th><th>案件/类型</th><th>节点</th><th>状态</th></tr></thead><tbody>" +
      items.map(function (s) {
        const near = /今日|明日|天内/.test(s.time);
        return "<tr><td><strong>" + s.title + "</strong></td><td>" + s.meta + "</td><td>" + s.time + "</td>" +
          "<td><span class='badge " + (near ? "badge-danger" : "badge-warning") + "'><i class='badge-dot'></i>" + (near ? "紧急" : "待办") + "</span></td></tr>";
      }).join("") + "</tbody></table>";
  }

  function ganttHTML() {
    const RANGE = 90 * 86400000; // 90 天
    const today = Date.now();
    const rangeStart = today - 45 * 86400000;
    const rangeEnd = today + 75 * 86400000;
    const span = rangeEnd - rangeStart;

    // 顶部日期刻度（每两周）
    let ticks = "";
    for (let t = rangeStart; t <= rangeEnd; t += 14 * 86400000) {
      const d = new Date(t);
      const pct = ((t - rangeStart) / span) * 100;
      ticks += "<div class='gantt-tick' style='left:" + pct + "%'>" + (d.getMonth() + 1) + "/" + d.getDate() + "</div>";
    }
    const todayPct = ((today - rangeStart) / span) * 100;

    const head =
      "<div class='gantt'><div class='gantt-head'>" +
      "<div class='gantt-title-col head'>案件</div>" +
      "<div class='gantt-axis-col'><div class='gantt-axis'>" + ticks + "</div></div></div>";

    const rows = mock.cases.slice(0, 6).map(function (c) {
      const start = new Date(c.date + "T00:00:00").getTime();
      const p = c.progress / 100;
      const progDate = start + RANGE * p;
      let acc = start;
      const cells = PHASES.map(function (ph) {
        const s = acc, e = s + RANGE * ph.frac;
        acc = e;
        let state = "pending";
        if (e <= progDate) state = "done";
        else if (s <= progDate) state = "current";
        const lp = Math.max(((s - rangeStart) / span) * 100, 0);
        const w = Math.min(((e - s) / span) * 100, 100 - lp);
        return "<div class='gantt-phase " + state + "' style='left:" + lp + "%;width:" + w + "%;background:" + ph.color + "' title='" + ph.name + " · " + stateLabel(state) + "'></div>";
      }).join("");
      return "<div class='gantt-row' data-link><div class='gantt-title-col'><span class='link' data-switch='cases' title='前往案件'>" + c.title.slice(0, 12) + "</span></div>" +
        "<div class='grow'><div class='lane'>" + cells + "</div>" +
        "<div class='gantt-today' style='left:" + todayPct + "%'></div></div></div>";
    }).join("");

    return head + "<div class='gantt-body' style='position:relative'>" + rows + "</div></div>" +
      "<div class='gantt-legend' style='margin-top:12px;display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--text-dim)'>" +
      PHASES.map(function (p) { return "<span style='display:inline-flex;align-items:center;gap:6px'><i style='width:10px;height:10px;border-radius:3px;background:" + p.color + ";display:inline-block'></i>" + p.name + "</span>"; }).join("") +
      "<span style='display:inline-flex;align-items:center;gap:6px'><i style='width:2px;height:14px;background:var(--accent);display:inline-block'></i>今天</span>" +
      "</div>";
  }
  function stateLabel(s) { return s === "done" ? "已完成" : s === "current" ? "进行中" : "未开始"; }

  // —— 新建案件弹窗 + 证据材料（第2条：元数据 / 录音转写 / 转码提示 / 持久化） ——
  let modalEl = null;

  // 证据持久化（本地 localStorage）
  const EVID_KEY = "legal-mode.evidence";
  function loadEvidence() {
    try { return JSON.parse(localStorage.getItem(EVID_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function saveEvidence() { localStorage.setItem(EVID_KEY, JSON.stringify(evidenceStore)); }
  let evidenceStore = loadEvidence();
  // 演示数据：仅首次无证据时预置一次，便于查看 编辑/删除/更新 等操作
  if (!evidenceStore.length && !localStorage.getItem("legal-mode.evidence-seeded")) {
    evidenceStore = [
      { id: uid(), kind: "video", name: "庭审录像_示例.mp4", size: 12345678, time: nowStr(), uploader: meName(), source: "当事人提供", notarized: false, note: "", url: "", data: null, requiresReupload: false, transcript: "" },
      { id: uid(), kind: "audio", name: "会见录音_示例.wav", size: 345678, time: nowStr(), uploader: meName(), source: "原始介质", notarized: true, note: "", url: "", data: null, requiresReupload: false, transcript: "" },
    ];
    saveEvidence();
    try { localStorage.setItem("legal-mode.evidence-seeded", "1"); } catch (e) {}
  }
  const SMALL_LIMIT = 2 * 1024 * 1024; // 小于 2MB 才持久化媒体字节，否则会话级

  function fmtSize(bytes) {
    if (!bytes) return "-";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }
  function nowStr() {
    const d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2) +
      " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  function uid() { return Date.now() + "_" + Math.random().toString(36).slice(2, 6); }
  function videoPlayable(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    return ["mp4", "webm", "ogv", "mov", "m4v"].indexOf(ext) >= 0;
  }
  const EVID_SOURCES = ["当事人提供", "原始介质", "拍照/翻录", "检方/对方移交", "法院调取", "其他"];

  // 添加证据（含元数据；小文件持久化字节，大文件会话级）
  function addEvidence(files, kind) {
    files.forEach(function (f) {
      const rec = {
        id: uid(), kind: kind, name: f.name, size: f.size,
        time: nowStr(),
        uploader: (window.Profile && Profile.get && Profile.get().name) || "张冬宝",
        source: "当事人提供", notarized: false, note: "",
        url: URL.createObjectURL(f),
        data: null,             // 小文件保存 base64
        requiresReupload: f.size >= SMALL_LIMIT,
        transcript: "",
      };
      evidenceStore.push(rec);
      saveEvidence();
      renderEvidence();
      if (rec.requiresReupload) toast("大文件仅会话级保存（刷新后需重新上传）", "success");
      else persistMedia(rec, f);
    });
  }
  function persistMedia(rec, file) {
    const reader = new FileReader();
    reader.onload = function (e) {
      rec.data = e.target.result;
      rec.requiresReupload = false;
      saveEvidence();
      renderEvidence();
    };
    reader.readAsDataURL(file);
  }

  // 单个证据行 + 详情（元数据 / 转写区）
  function evidenceRowHTML(ev, open) {
    const playable = ev.kind === "audio" || videoPlayable(ev.name);
    const badge = ev.kind === "video"
      ? "<span class='badge badge-info'>视频</span>"
      : "<span class='badge badge-info'>录音</span>";
    const notBadge = ev.notarized ? "<span class='badge badge-warning'>已公证</span>" : "";
    const warn = (ev.kind === "video" && !playable)
      ? "<span class='badge badge-danger'>格式可能不可预览</span>" : "";
    const meta = fmtSize(ev.size) + " · " + ev.time + " · " + ev.uploader;
    let row = "<div class='ev-item ev-row' data-id='" + ev.id + "'>" +
      "<span class='ev-icon'>" + (ev.kind === "video" ? "" : "") + "</span>" +
      "<span class='ev-name'>" + ev.name + "</span>" + badge + notBadge + warn +
      "<span class='ev-meta'>" + meta + "</span>" +
      "<span class='ev-act'>" +
      (playable ? "<button class='btn btn-sm btn-ghost' data-play='" + ev.id + "'> 调看</button>" : "") +
      (ev.kind === "audio" ? "<button class='btn btn-sm btn-ghost' data-transcribe='" + ev.id + "'>转写</button>" : "") +
      "<button class='btn btn-sm btn-ghost' data-update='" + ev.id + "'>更新</button>" +
      "<button class='btn btn-sm btn-ghost' data-detail='" + ev.id + "'>" + (open ? "收起" : "编辑") + "</button>" +
      "<button class='btn btn-sm btn-danger' data-del='" + ev.id + "'>删除</button>" +
      "</span></div>";

    if (!open) return row;
    // 详情：元数据 + 备注 + 转写结果
    row += "<div class='ev-detail'>" +
      "<div class='ev-meta-grid'>" +
      "<div class='form-group'><label>来源</label><select data-field='source' data-id='" + ev.id + "'>" +
        EVID_SOURCES.map(function (s) { return "<option" + (ev.source === s ? " selected" : "") + ">" + s + "</option>"; }).join("") +
      "</select></div>" +
      "<div class='form-group'><label>上传人</label><input value='" + ev.uploader + "' readonly></div>" +
      "<div class='form-group'><label>上传时间</label><input value='" + ev.time + "' readonly></div>" +
      "<div class='form-group'><label>是否公证</label>" +
        "<label class='chk'><input type='checkbox' data-field='notarized' data-id='" + ev.id + "' " + (ev.notarized ? "checked" : "") + "> 原始介质已公证</label></div>" +
      "</div>" +
      "<div class='form-group'><label>备注</label><textarea rows='2' data-field='note' data-id='" + ev.id + "'>" + (ev.note || "") + "</textarea></div>" +
      (ev.kind === "audio"
        ? "<div class='form-group'><label>录音转写</label>" +
          "<div class='transcript-box'>" + (ev.transcript ? ev.transcript : "<span class='ev-empty'>尚未转写，点击「转写」生成文稿</span>") + "</div></div>"
        : "") +
      "</div>";
    return row;
  }

  function renderEvidence() {
    const list = modalEl && modalEl.querySelector("[data-evlist]");
    if (!list) return;
    if (!evidenceStore.length) { list.innerHTML = '<div class="ev-empty">暂未添加证据（支持视频 / 录音）</div>'; return; }
    list.innerHTML = evidenceStore.map(function (ev) { return evidenceRowHTML(ev, ev._open); }).join("");
  }

  // 绑证据区事件（详情展开/元数据编辑/转写/调看/删除）——惰性绑定
  // 更换证据（更新材料文件，律师抉择）
  function updateEvidence(ev) {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ev.kind === "video" ? "video/*" : "audio/*";
    inp.onchange = function () {
      const f = this.files && this.files[0];
      if (!f) return;
      ev.name = f.name; ev.size = f.size; ev.url = URL.createObjectURL(f);
      ev.time = nowStr(); ev.data = null; ev.requiresReupload = f.size >= SMALL_LIMIT;
      saveEvidence();
      if (!ev.requiresReupload) persistMedia(ev, f);
      refreshEvidenceUI();
      toast("证据已更新：" + f.name, "success");
    };
    inp.click();
  }

  function bindEvidenceEventsAfterRender() {
    const wrap = modalEl;
    if (!wrap) return;
    wrap.querySelectorAll("[data-update]").forEach(function (b) {
      b.addEventListener("click", function () {
        const ev = findEv(b.getAttribute("data-update"));
        if (ev) updateEvidence(ev);
      });
    });
    wrap.querySelectorAll("[data-detail]").forEach(function (b) {
      b.addEventListener("click", function () {
        const ev = findEv(b.getAttribute("data-detail"));
        if (ev) { ev._open = !ev._open; renderEvidence(); bindEvidenceEventsAfterRender(); }
      });
    });
    wrap.querySelectorAll("[data-play]").forEach(function (b) {
      b.addEventListener("click", function () {
        const ev = findEv(b.getAttribute("data-play"));
        if (ev) openEvidenceViewer(ev);
      });
    });
    wrap.querySelectorAll("[data-transcribe]").forEach(function (b) {
      b.addEventListener("click", function () {
        const ev = findEv(b.getAttribute("data-transcribe"));
        if (ev) transcribeEvidence(ev);
      });
    });
    wrap.querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", function () {
        const id = b.getAttribute("data-del");
        evidenceStore = evidenceStore.filter(function (x) { return x.id !== id; });
        saveEvidence(); renderEvidence(); bindEvidenceEventsAfterRender();
      });
    });
    wrap.querySelectorAll("[data-field]").forEach(function (el) {
      el.addEventListener("change", function () {
        const ev = findEv(el.getAttribute("data-id"));
        if (!ev) return;
        const f = el.getAttribute("data-field");
        if (f === "notarized") ev.notarized = el.checked;
        else if (f === "source") ev.source = el.value;
        else if (f === "note") ev.note = el.value;
        saveEvidence(); renderEvidence(); bindEvidenceEventsAfterRender();
      });
    });
  }
  function findEv(id) { return evidenceStore.find(function (x) { return x.id === id; }); }

  // 调看（不可预览时给出提示并可下载原文件）
  function openEvidenceViewer(ev) {
    const playable = ev.kind === "audio" || videoPlayable(ev.name);
    const v = document.createElement("div");
    v.className = "modal-overlay show";
    const media = playable
      ? (ev.kind === "video"
          ? "<video src='" + ev.url + "' controls autoplay style='width:100%;max-height:62vh'></video>"
          : "<audio src='" + ev.url + "' controls autoplay style='width:100%;min-height:50px'></audio>")
      : "<div class='ev-empty'>该格式（" + (ev.name.split(".").pop() || "") + "）可能无法在线预览<br>建议转码为 mp4/webm 后调看，或下载原文件</div>";
    v.innerHTML = "<div class='modal glow' style='width:640px'>" +
      "<h3>" + ev.name + "</h3>" +
      "<div style='width:100%;background:#000;border-radius:10px;overflow:hidden'>" + media + "</div>" +
      "<div class='modal-actions'>" +
      "<a class='btn btn-ghost' href='" + ev.url + "' download='" + ev.name + "'> 下载原文件</a>" +
      "<button class='btn' data-vclose>关闭</button></div></div>";
    v.addEventListener("click", function (e) {
      if (e.target === v || e.target.getAttribute("data-vclose")) v.remove();
    });
    document.body.appendChild(v);
  }

  // 录音转写（原型：生成示例文稿；生产接入 ASR 服务，如讯飞/Whisper）
  function transcribeEvidence(ev) {
    // 统一 AI 桥：按「录音转写规范化」skill 生成（现为 skill 规范化骨架；接 agent 后为真实识别）
    ev.transcript = (window.__callAI ? window.__callAI("transcribe", ev) : "（未接入 AI 桥）");
    saveEvidence();
    refreshEvidenceUI();
    toast("已按转写规范生成（生产接 ASR/agent 为真实识别）", "success");
  }

  // 刷新当前证据 UI（弹窗 or 模块视图）
  function refreshEvidenceUI() {
    if (modalEl) { renderEvidence(); bindEvidenceEventsAfterRender(); }
    else if (active === "evidence") renderEvidenceView();
  }

  // —— 证据材料 模块视图（随时调看 / 检索） ——
  function renderEvidenceView() {
    const kind = "all"; // 简化：全部
    const list = evidenceStore;
    const vids = list.filter(function (x) { return x.kind === "video"; }).length;
    const auds = list.filter(function (x) { return x.kind === "audio"; }).length;
    const nots = list.filter(function (x) { return x.notarized; }).length;

    const sum = "<div class='fin-hero'>" +
      "<div class='fh-card main'><div class='fh-label'> 证据总数</div><div class='fh-val'>" + list.length + "</div><div class='fh-sub'>在库证据</div></div>" +
      "<div class='fh-card red'><div class='fh-label'> 视频</div><div class='fh-val'>" + vids + "</div><div class='fh-sub'>条视频</div></div>" +
      "<div class='fh-card amber'><div class='fh-label'> 录音</div><div class='fh-val'>" + auds + "</div><div class='fh-sub'>条录音</div></div>" +
      "<div class='fh-card green'><div class='fh-label'> 已公证</div><div class='fh-val'>" + nots + "</div><div class='fh-sub'>原始介质</div></div></div>";

    let body;
    if (!list.length) {
      body = "<div class='card glow'><div class='empty'>暂无证据材料<br>在「新建案件」或「案件详情」上传视频 / 录音</div></div>";
    } else {
      body = "<div class='card glow'><div class='card-head'><h2>证据列表</h2>" +
        "<span class='badge badge-info'>每份证据可 删除 / 更新，由律师自主抉择</span></div>" +
        "<div class='evidence-list'>" + list.map(function (ev) { return evidenceRowHTML(ev, ev._open); }).join("") + "</div></div>";
    }

    el.content.innerHTML =
      '<div class="page-head"><div><h1>' + curTitle + "</h1><div class='sub'>" + curSub + "</div></div>" +
      '<div class="tools" style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<label class="btn btn-ghost btn-sm" style="cursor:pointer"> 上传视频<input type="file" data-ev="video" accept="video/*" multiple style="display:none"></label>' +
      '<label class="btn btn-ghost btn-sm" style="cursor:pointer"> 上传录音<input type="file" data-ev="audio" accept="audio/*" multiple style="display:none"></label>' +
      '<button class="btn btn-primary glow" id="evToggleOpen">展开全部详情</button></div></div>' +
      sum + "<div style='margin-top:18px'>" + body + "</div>";

    // 展开全部
    const t = document.getElementById("evToggleOpen");
    if (t) t.addEventListener("click", function () {
      evidenceStore.forEach(function (ev) { ev._open = true; });
      renderEvidenceView();
    });
    // 模块内直接上传证据
    el.content.querySelectorAll("[data-ev]").forEach(function (input) {
      input.addEventListener("change", function () {
        const files = Array.from(this.files || []);
        addEvidence(files, input.getAttribute("data-ev"));
        this.value = "";
      });
    });
    // 复用证据区交互（详情/调看/转写/删除/更新）
    bindEvidenceEventsOn(el.content);
  }

  function bindEvidenceEventsOn(root) {
    root.querySelectorAll("[data-update]").forEach(function (b) {
      b.addEventListener("click", function () {
        const ev = findEv(b.getAttribute("data-update"));
        if (ev) updateEvidence(ev);
      });
    });
    root.querySelectorAll("[data-detail]").forEach(function (b) {
      b.addEventListener("click", function () {
        const ev = findEv(b.getAttribute("data-detail"));
        if (ev) { ev._open = !ev._open; renderEvidenceView(); }
      });
    });
    root.querySelectorAll("[data-play]").forEach(function (b) {
      b.addEventListener("click", function () {
        const ev = findEv(b.getAttribute("data-play"));
        if (ev) openEvidenceViewer(ev);
      });
    });
    root.querySelectorAll("[data-transcribe]").forEach(function (b) {
      b.addEventListener("click", function () {
        const ev = findEv(b.getAttribute("data-transcribe"));
        if (ev) transcribeEvidence(ev);
      });
    });
    root.querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", function () {
        const id = b.getAttribute("data-del");
        evidenceStore = evidenceStore.filter(function (x) { return x.id !== id; });
        saveEvidence(); renderEvidenceView();
      });
    });
    root.querySelectorAll("[data-field]").forEach(function (el) {
      el.addEventListener("change", function () {
        const ev = findEv(el.getAttribute("data-id"));
        if (!ev) return;
        const f = el.getAttribute("data-field");
        if (f === "notarized") ev.notarized = el.checked;
        else if (f === "source") ev.source = el.value;
        else if (f === "note") ev.note = el.value;
        saveEvidence(); renderEvidenceView();
      });
    });
  }

  // 合同（与案件建档时上传的合同电子版互链）
  const CONTRACT_KEY = "legal-mode.contracts";
  function loadContracts() { try { return JSON.parse(localStorage.getItem(CONTRACT_KEY) || "[]"); } catch (e) { return []; } }
  function saveContracts() { localStorage.setItem(CONTRACT_KEY, JSON.stringify(contracts)); }
  let contracts = loadContracts();

  function openNewCaseModal() {
    const pendingContracts = [];
    modalEl = document.createElement("div");
    modalEl.className = "modal-overlay show";
    modalEl.innerHTML =
      '<div class="modal glow">' +
      "<h3>新建案件</h3>" +
      '<div class="form-row"><div class="form-group"><label>案件类型 *</label><select id="ncType"><option>民事</option><option>刑事</option><option>行政</option><option>非诉</option></select></div>' +
      '<div class="form-group"><label>优先级</label><select id="ncPri"><option>高</option><option>中</option><option>低</option></select></div></div>' +
      '<div class="form-group"><label>案件名称 *</label><input id="ncTitle" placeholder="如：林某某劳动争议案"></div>' +
      '<div class="form-group"><label>当事人</label><input id="ncParty" placeholder="原告 / 委托人"></div>' +
      '<div class="form-row"><div class="form-group"><label>受托法院</label><input id="ncCourt" placeholder="法院"></div>' +
      '<div class="form-group"><label>承办人（本人）</label><input value="' + meName() + '" readonly></div></div>' +
      '<div class="form-group"><label>证据材料（视频 / 录音，含元数据、转写）</label>' +
        '<div style="display:flex;gap:8px">' +
          '<label class="btn btn-ghost btn-sm" style="cursor:pointer"> 上传视频<input type="file" data-ev="video" accept="video/*" multiple style="display:none"></label>' +
          '<label class="btn btn-ghost btn-sm" style="cursor:pointer"> 上传录音<input type="file" data-ev="audio" accept="audio/*" multiple style="display:none"></label>' +
          '<button class="btn btn-ghost btn-sm" data-goto-evidence>查看证据库</button>' +
        "</div>" +
        '<div class="evidence-list" data-evlist><div class="ev-empty">暂未添加证据（支持视频 / 录音）</div></div>' +
      "</div>" +
      '<div class="form-group"><label>合同（可上传委托/顾问合同电子版，供合同管理互链）</label>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<input id="ncContractName" placeholder="合同名称" style="flex:1">' +
          '<label class="btn btn-ghost btn-sm" style="cursor:pointer"> 上传合同<input type="file" id="ncContractFile" accept="image/*,application/pdf,video/*,audio/*" style="display:none"></label>' +
        "</div>" +
        '<div class="supp-list" id="ncContractList"><span class="ev-empty">未上传合同</span></div>' +
      "</div>" +
      '<div class="modal-actions"><button class="btn btn-ghost" data-close>取消</button>' +
      '<button class="btn btn-primary" data-save>保存</button></div></div>';
    document.body.appendChild(modalEl);

    // 上传视频/录音
    modalEl.querySelectorAll("[data-ev]").forEach(function (input) {
      input.addEventListener("change", function () {
        const files = Array.from(this.files || []);
        addEvidence(files, input.getAttribute("data-ev"));
        this.value = "";
      });
    });
    // 上传合同
    const cfink = modalEl.querySelector("#ncContractFile");
    if (cfink) cfink.addEventListener("change", function () {
      const f = this.files && this.files[0];
      if (!f) return;
      const name = (modalEl.querySelector("#ncContractName") || {}).value || ("合同_" + f.name);
      pendingContracts.push({ name: name, file: f, url: URL.createObjectURL(f) });
      modalEl.querySelector("#ncContractList").innerHTML = pendingContracts.map(function (pc) { return "<div class='supp-item'> " + pc.name + "</div>"; }).join("");
      this.value = "";
    });
    modalEl.addEventListener("click", function (e) {
      const t = e.target;
      if (t === modalEl || (t.hasAttribute && t.hasAttribute("data-close"))) { closeModal(); return; }
      if (t.hasAttribute && t.hasAttribute("data-goto-evidence")) { closeModal(); switchTo("evidence"); return; }
      if (t.hasAttribute && t.hasAttribute("data-save")) {
        const gv = function (id) { var el = modalEl.querySelector("#" + id); return el ? el.value.trim() : ""; };
        const caseTitle = gv("ncTitle");
        if (!caseTitle) { toast("请填写案件名称", "error"); return; }
        const caseObj = {
          no: gv("ncNo") || ("（" + new Date().getFullYear() + "）模拟-" + Date.now().toString().slice(-6)),
          title: caseTitle,
          type: gv("ncType") || "民事",
          party: gv("ncParty") || "",
          court: gv("ncCourt") || "",
          status: "待立案",
          priority: gv("ncPri") || "中",
          progress: 0,
          lawyer: meName(),
          date: nowStr(),
        };
        // 案件本体落库（真实存储，列表可见）
        let cs = getCases(); cs.unshift(caseObj); saveCases(cs);
        // 关联合同电子版（若上传）
        pendingContracts.forEach(function (pc) {
          contracts.unshift({ id: uid(), name: pc.name, type: "委托/顾问", caseTitle: caseTitle, url: pc.url, fileType: (pc.file.type || "file"), amount: "——", status: "履行中", date: nowStr(), source: "案件建档" });
        });
        saveContracts();
        if (window.Cases && window.Cases.onChanged) try { window.Cases.onChanged(); } catch (e) {}
        closeModal();
        if (active === "cases") renderCases();
        toast("案件已创建：" + caseTitle + (evidenceStore.length ? "，已关联 " + evidenceStore.length + " 份证据" : "") + (pendingContracts.length ? "，含 " + pendingContracts.length + " 份合同" : ""), "success");
      }
    });
    renderEvidence();
    bindEvidenceEventsAfterRender();
  }
  function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } }

  function toast(msg, type) {
    let t = document.getElementById("toast");
    if (!t) { t = document.createElement("div"); t.className = "toast"; t.id = "toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = "toast show toast-" + (type || "success");
    setTimeout(function () { t.classList.remove("show"); }, 2400);
  }

  // —— 顶栏交互：主题（三项下拉）/ 壁纸面板 / 消息通知 ——
  function buildNotifyMenu() {
    const NOTIFS = [
      { icon: "", title: "今日 09:30 开庭", kind: "开庭", meta: "林某某劳动争议案 · 徐汇法院第12法庭", time: "10 分钟前", go: "schedule" },
      { icon: "", title: "举证期限届满提醒", kind: "期限", meta: "陈某行政处罚案 · 距截止 5 天", time: "2 小时前", go: "schedule" },
      { icon: "", title: "新证据已上传", kind: "证据", meta: "甲公司买卖合同案 · 视频 1 份", time: "昨天 18:20", go: "documents" },
      { icon: "", title: "文书待审阅", kind: "文书", meta: "代理词草稿 · 承办：张冬宝", time: "昨天 09:05", go: "documents" },
    ];
    const m = document.createElement("div");
    m.className = "menu-pop notify-pop";
    m.id = "notifyMenu";
    m.style.display = "none";
    const items = NOTIFS.map(function (n) {
      return "<div class='notify-item unread' data-go='" + n.go + "' title='点击前往 " + n.kind + "'>" +
        "<span class='notify-ic'>" + n.icon + "</span>" +
        "<div class='notify-body'>" +
        "<div class='notify-title'>" + n.title + "<span class='badge badge-info'>" + n.kind + "</span></div>" +
        "<div class='notify-meta'>" + n.meta + "</div>" +
        "<div class='notify-time'>" + n.time + "</div>" +
        "</div></div>";
    }).join("");
    m.innerHTML = "<div class='pop-head'><b>消息通知</b><button class='btn btn-sm btn-ghost' id='markAll'>全部已读</button></div>" +
      "<div class='notify-list'>" + items + "</div>";
    // 点击某条：标记已读 + 关闭 + 跳转到对应模块
    m.querySelectorAll(".notify-item").forEach(function (it) {
      it.addEventListener("click", function () {
        it.classList.remove("unread");
        m.style.display = "none";
        var go = it.getAttribute("data-go");
        if (go) switchTo(go);
      });
    });
    document.body.appendChild(m);
    return m;
  }

  function renderThemeMenuActive() {
    const menu = document.getElementById("themeMenu");
    if (!menu) return;
    const cur = Theme.get();
    menu.querySelectorAll("[data-mode]").forEach(function (row) {
      row.classList.toggle("active", row.getAttribute("data-mode") === cur);
    });
  }
  function bindTopbar() {
    // 主题下拉：跟随系统 / 浅色 / 深色
    const menu = document.createElement("div");
    menu.className = "menu-pop";
    menu.id = "themeMenu";
    menu.style.display = "none";
    const modes = [["system", "跟随系统", "auto"], ["light", "浅色", "sun"], ["dark", "深色", "moon"]];
    menu.innerHTML = '<div class="menu-pop-label">主题</div>' + modes.map(function (m) {
      return "<div class='menu-pop-row' data-mode='" + m[0] + "'>" +
        "<span class='m-ico'>" + ICONS[m[2]] + "</span><span>" + m[1] + "</span>" +
        "<span class='m-check'></span></div>";
    }).join("");
    el.tools = document.querySelector(".topbar .tools");
    document.body.appendChild(menu); // 追加到 body，避免被顶栏堆叠上下文裁切

    el.themeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      const show = menu.style.display !== "block";
      menu.style.display = show ? "block" : "none";
      if (show) renderThemeMenuActive();
    });
    menu.addEventListener("click", function (e) {
      e.stopPropagation();
      const row = e.target.closest("[data-mode]");
      if (row) {
        Theme.set(row.getAttribute("data-mode"));
        updateThemeIcon();
        renderThemeMenuActive();
        menu.style.display = "none";
      }
    });
    document.addEventListener("click", function (e) {
      if (menu.style.display === "block" && !menu.contains(e.target) && e.target !== el.themeBtn) {
        menu.style.display = "none";
      }
    });

    // 壁纸面板
    el.wallBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      const show = el.wallPanel.style.display !== "block";
      el.wallPanel.style.display = show ? "block" : "none";
      if (show) Wallpapers.buildThumbs(el.wpGrid, null);
    });
    document.addEventListener("click", function (e) {
      if (el.wallPanel.style.display === "block" && !el.wallPanel.contains(e.target) && e.target !== el.wallBtn) {
        el.wallPanel.style.display = "none";
      }
    });

    // 消息通知
    el.notifyBtn = document.getElementById("notifyBtn");
    const notifyMenu = buildNotifyMenu();
    el.notifyBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      const show = notifyMenu.style.display !== "block";
      notifyMenu.style.display = show ? "block" : "none";
      // 打开即视为已读，清掉红点
      if (show) el.notifyBtn.classList.remove("badge-dot-holder");
    });
    document.addEventListener("click", function (e) {
      if (notifyMenu.style.display === "block" && !notifyMenu.contains(e.target) && e.target !== el.notifyBtn) {
        notifyMenu.style.display = "none";
      }
    });
    var markAll = notifyMenu.querySelector("#markAll");
    if (markAll) markAll.addEventListener("click", function () {
      notifyMenu.querySelectorAll(".notify-item.unread").forEach(function (it) { it.classList.remove("unread"); });
      el.notifyBtn.classList.remove("badge-dot-holder");
    });
    document.getElementById("wpUpload").addEventListener("change", function () {
      Wallpapers.pickFromFile(this);
    });
    // 备份数据(.swj)：一键唤起数据管理（导出加密备份 / 导入迁移）
    const backupBtn = document.getElementById("backupBtn");
    if (backupBtn) backupBtn.addEventListener("click", function () {
      if (window.WbData && window.WbData.openDataManager) window.WbData.openDataManager();
      else if (window.toastToast) window.toastToast("数据管理未就绪", "error");
    });
    // 反馈意见 / Bug
    const feedbackBtn = document.getElementById("feedbackBtn");
    if (feedbackBtn) feedbackBtn.addEventListener("click", function () {
      if (window.Feedback && window.Feedback.open) window.Feedback.open();
      else if (window.toastToast) window.toastToast("反馈模块未就绪", "error");
    });
    if (window.Feedback && window.Feedback.startPoll) window.Feedback.startPoll();
  }
  function updateThemeIcon() {
    const mode = Theme.get();
    el.themeBtn.innerHTML = ICONS[mode === "light" ? "sun" : mode === "dark" ? "moon" : "auto"];
    el.themeBtn.title = "主题：" + (mode === "system" ? "跟随系统" : mode === "light" ? "浅色" : "深色");
  }

  // —— 启动自动切换：法律模式 -> 律师工作台 ——
  function boot() {
    const state = document.getElementById("bootState");
    const bar = document.getElementById("bootBar");
    const steps = [
      ["正在加载法律模式模块…", 25],
      ["已加载，启动律师工作台…", 60],
      ["正在切换至 律师工作台…", 88],
      ["就绪", 100],
    ];
    Wallpapers.init();
    let i = 0;
    function next() {
      if (i >= steps.length) {
        setTimeout(function () {
          el.boot.classList.add("done");
          el.app.classList.add("ready");
        }, 300);
        return;
      }
      state.textContent = steps[i][0];
      bar.style.width = steps[i][1] + "%";
      i++;
      setTimeout(next, 620);
    }
    setTimeout(next, 400);
  }

  // —— 全局"跟手光源"：鼠标移动时更新 .glow 的光源坐标 ——
  function initGlow() {
    document.addEventListener("mousemove", function (e) {
      const t = e.target.closest ? e.target.closest(".glow") : null;
      if (t) {
        const r = t.getBoundingClientRect();
        t.style.setProperty("--mx", (e.clientX - r.left) + "px");
        t.style.setProperty("--my", (e.clientY - r.top) + "px");
      }
    });
  }

  // —— 初始化 ——
  // —— 首次启动律师建档（专属工作台）：仅姓名 + 执业证号 ——
  const LAWYER_KEY = "legal-mode.lawyer";
  function loadLawyer() { try { return JSON.parse(localStorage.getItem(LAWYER_KEY)) || null; } catch (e) { return null; } }
  function saveLawyer(l) { localStorage.setItem(LAWYER_KEY, JSON.stringify(l)); }
  function meName() {
    const l = loadLawyer();
    if (l && l.name) return l.name;
    return (window.Profile && Profile.get && Profile.get().name) || "张冬宝";
  }
  const TEAM_KEY = "legal-mode.team";
  function loadTeam() {
    let t = [];
    try { t = JSON.parse(localStorage.getItem(TEAM_KEY) || "[]"); } catch (e) {}
    if (!t.length) return [{ name: meName(), role: "执业律师", fixed: true }];
    return t;
  }
  function saveTeam(t) { localStorage.setItem(TEAM_KEY, JSON.stringify(t)); }
  const PROFILE_INFO_KEY = "legal-mode.profileInfo";
  function loadProfileInfo() {
    const cur = loadLawyer();
    const def = { firm: (cur && cur.firm) || "靖之霖律师事务所", specialty: "劳动/合同/民商", years: "12" };
    try {
      const s = JSON.parse(localStorage.getItem(PROFILE_INFO_KEY) || "{}");
      if (s.firm || s.specialty || s.years) return Object.assign(def, s);
    } catch (e) {}
    return def;
  }
  function saveProfileInfo(s) { localStorage.setItem(PROFILE_INFO_KEY, JSON.stringify(s)); }
  function applyLawyer(lawyer) {
    if (lawyer) {
      if (window.Profile) Profile.setName(lawyer.name);
      if (lawyer.license) {
        // 供文书落款/个人中心展示
        try { localStorage.setItem("legal-mode.license", lawyer.license); } catch (e) {}
      }
    }
  }

  function init() {
    renderNav();
    bindTopbar();
    updateThemeIcon();
    initGlow();
    var backBtn = document.getElementById("backBtn");
    if (backBtn) backBtn.addEventListener("click", back);
    // 深鲸AI：唤回深鲸桌面端窗口（系统命令，不改 DSH）
    var dshBtn = document.getElementById("dshAiBtn");
    if (dshBtn) dshBtn.addEventListener("click", function () {
      if (window.__focusDSH && typeof window.__focusDSH === "function") {
        window.__focusDSH().then(function (r) {
          if (!r || !r.ok) { toast(r && r.msg || "唤回深鲸桌面端失败，请手动切换窗口", "error"); }
        });
      } else { toast("当前环境不支持唤回深鲸桌面端", "error"); }
    });
    // AI 需要自备算力但未配置 key 时：自动弹出配置引导
    window.onNeedKey = function () {
      if (window.toast) window.toast("请先配置您的 DeepSeek API Key，以便正常使用 AI 功能。", "error");
      if (window.KeyMgr && window.KeyMgr.open) window.KeyMgr.open();
    };
    switchTo("dashboard"); // 初始渲染仪表盘
    document.addEventListener("theme:change", function () { updateThemeIcon(); });

    // 首次建档：无档案则先建档，再进入工作台
    const lawyer = loadLawyer();
    if (!lawyer) { showSetup(); }
    else { applyLawyer(lawyer); boot(); }
  }

  // 生产环境：这里调用后台 —— 国家律师查询系统 + 律所登记核对。此处为前端演示校验。
  const COMPLIANCE = {
    lawyers: {
      "张冬宝": { license: "13101202011231234", firm: "靖之霖律师事务所" },
      "李慧敏": { license: "13101202109876543", firm: "靖之霖律师事务所" },
      "王建国": { license: "13101202211223344", firm: "靖之霖律师事务所" },
    },
  };
  // 开发者特权：name=(feely|张冬宝) 且相关证号为任意 17 位数字  直接登录（免律所）
  function isDevAuth(name, mode, d) {
    if (name !== "feely" && name !== "张冬宝") return false;
    const fields = mode === "lawyer" ? [d.license] : [d.ilicense, d.authLicense];
    return fields.some(function (f) { return /^\d{17}$/.test((f || "").trim()); });
  }
  // 授权律师是否为开发者（张冬宝/feely，且授权证号为 17 位） 开发者可授权实习律师
  function isDevAuthorizer(mode, d) {
    if (mode !== "intern") return false;
    const an = (d.authName || "").trim();
    if (an !== "feely" && an !== "张冬宝") return false;
    return /^\d{17}$/.test((d.authLicense || "").trim());
  }
  function verifyLawyerIdentity(mode, d) {
    const name = (d.name || "").trim();
    if (!name) return { ok: false, msg: "请输入姓名" };
    if (mode === "lawyer") {
      const license = (d.license || "").trim(), firm = (d.firm || "").trim();
      if (!license) return { ok: false, msg: "请输入执业证号" };
      // 开发者特权：张冬宝/feely + 17 位执业证号  直接登录（无需律所）
      if (isDevAuth(name, mode, d)) return { ok: true, dev: true };
      if (!firm) return { ok: false, msg: "请输入所属律所" };
      const rec = COMPLIANCE.lawyers[name];
      if (rec && rec.license === license && rec.firm === firm) return { ok: true };
      if (rec && rec.license === license && rec.firm !== firm) return { ok: false, msg: "该律师所属律所与登记不符，请核实" };
      return { ok: false, msg: "姓名与执业证号不匹配，未能在国家律师查询系统核对到，不能登录" };
    }
    // 实习律师
    const il = (d.ilicense || "").trim(), firm = (d.firm || "").trim(), an = (d.authName || "").trim(), al = (d.authLicense || "").trim();
    if (!il) return { ok: false, msg: "请输入实习证号" };
    // 开发者特权：登录人 或 授权律师为 张冬宝/feely  免律所/直接授权
    if (isDevAuth(name, mode, d)) return { ok: true, dev: true };
    if (isDevAuthorizer(mode, d)) return { ok: true, dev: true };
    if (!firm) return { ok: false, msg: "请输入所属律所" };
    if (!an) return { ok: false, msg: "请输入授权执业律师姓名" };
    if (!al) return { ok: false, msg: "请输入授权执业律师执业证号" };
    const authRec = COMPLIANCE.lawyers[an];
    if (authRec && authRec.license === al && authRec.firm === firm) return { ok: true };
    if (authRec && authRec.license === al && authRec.firm !== firm) return { ok: false, msg: "实习律师所属律所与授权律师不一致" };
    return { ok: false, msg: "授权执业律师信息不匹配，实习律师无法登录" };
  }

  function showSetup() {
    const setup = document.getElementById("setup");
    const bootEl = document.getElementById("boot");
    if (setup) setup.classList.remove("done");
    if (bootEl) bootEl.classList.add("done"); // 隐藏启动页，展示建档/校验页
    let mode = "lawyer";
    function val(id) { const e = document.getElementById(id); return e ? e.value : ""; }
    function setStatus(msg, cls) { const s = document.getElementById("suStatus"); if (s) { s.textContent = msg || ""; s.className = "su-status " + (cls || ""); } }

    // 执业 / 实习 切换
    document.querySelectorAll(".su-modes [data-mode]").forEach(function (b) {
      b.addEventListener("click", function () {
        mode = b.getAttribute("data-mode");
        document.querySelectorAll(".su-modes [data-mode]").forEach(function (x) { x.classList.toggle("active", x === b); });
        document.getElementById("suLawyer").style.display = mode === "lawyer" ? "" : "none";
        document.getElementById("suIntern").style.display = mode === "intern" ? "" : "none";
        setStatus("");
      });
    });

    const go = document.getElementById("suGo");
    if (go) go.addEventListener("click", function () {
      const data = mode === "lawyer"
        ? { name: val("suName"), license: val("suLicense"), firm: val("suFirm") }
        : { name: val("suIName"), ilicense: val("suILicense"), firm: val("suIFirm"), authName: val("suAuthName"), authLicense: val("suAuthLicense") };
      // 开发者特权：张冬宝/feely + 17 位证号 → 直接登录（免律所、免核验），方便测试
      const dv = verifyLawyerIdentity(mode, data);
      if (dv.ok && dv.dev) {
        const lawyer = mode === "lawyer"
          ? { name: data.name.trim(), license: data.license.trim(), firm: data.firm.trim() || "（开发者）", role: "执业律师", dev: true, date: nowStr() }
          : { name: data.name.trim(), license: data.ilicense.trim(), firm: data.firm.trim() || "（开发者）", role: "实习律师", authName: data.authName.trim(), authLicense: data.authLicense.trim(), dev: true, date: nowStr() };
        saveLawyer(lawyer); applyLawyer(lawyer);
        const setup = document.getElementById("setup");
        if (setup) setup.classList.add("done");
        setStatus("开发者特权登录 · " + lawyer.name + "（" + lawyer.role + "）", "ok");
        toast("开发者特权登录 · " + lawyer.name + " 律师（" + lawyer.role + "）工作台已就绪", "success");
        boot();
        return;
      }
      // 基本必填校验
      if (!data.name || (!data.license && !data.ilicense)) { setStatus("请填写姓名与证件号", "err"); toast("请填写姓名与证件号", "error"); return; }
      if (!data.firm) { setStatus("请填写所属律所", "err"); toast("请填写所属律所", "error"); return; }
      const machine = (window.__licenseGetMachine && window.__licenseGetMachine()) || "";
      const rec = { name: data.name.trim(), license: data.license.trim(), firm: data.firm.trim(), mode: mode, machine: machine, at: Date.now() };
      // 提交到后台人工核验
      if (window.__lawyerSubmit && typeof window.__lawyerSubmit === "function") {
        window.__lawyerSubmit(rec).then(function (r) {
          if (r && r.ok) {
            setStatus("信息已提交，执业信息将由我们核验（可在 credit.acla.org.cn 官网查证）；核验通过后即可登录。", "ok");
            toast("已提交律师实名核验，核验通过后自动登录", "success");
            // 启动核验结果轮询
            startLawyerPoll(machine);
          } else {
            setStatus("提交失败：" + ((r && r.msg) || "请重试"), "err");
          }
        }).catch(function () { setStatus("提交失败，请重试", "err"); });
      } else {
        setStatus("当前环境不支持核验提交", "err");
      }
    });
  }

  // 轮询律师实名核验结果：通过后建档进工作台
  function startLawyerPoll(machine) {
    setInterval(function () {
      if (!window.__lawyerCheck) return;
      window.__lawyerCheck(machine).then(function (r) {
        if (r && r.found && r.status === "approved") {
          const lawyer = { name: r.name, license: "", firm: "", role: "执业律师", dev: false, date: nowStr() };
          saveLawyer(lawyer);
          applyLawyer(lawyer);
          const setup = document.getElementById("setup");
          if (setup) setup.classList.add("done");
          const status = document.getElementById("suStatus");
          if (status) status.textContent = "核验通过：" + r.name + "（执业律师）";
          boot();
        } else if (r && r.found && r.status === "rejected") {
          const status = document.getElementById("suStatus");
          if (status) status.textContent = "核验未通过：" + (r.reason || "执业信息不符，请核实");
        }
      }).catch(function () {});
    }, 8000);
  }

  window.Workbench = { switchTo: switchTo, back: back, active: function(){ return active; }, toast: toast, mock: mock, openNewCase: openNewCaseModal };
  window.openClientNew = openClientNew;
  window.openNewContract = openNewContract;
  document.addEventListener("DOMContentLoaded", init);
})();
