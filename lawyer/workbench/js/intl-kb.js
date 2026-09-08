/* =========================================================================
   intl-kb.js — 涉外法律知识库：抓取工具 + 直连本地存储 的模块引擎
   -------------------------------------------------------------------------
   目标（用户口径）：在律师工作台内嵌「涉外法律知识库」小模块——
   · 内置「抓取工具」：按 每日/每周+时间节点 抓取涉外法律知识并**存本地**；
   · 数据本地持久化（localStorage），读取**直连本地**，断网可用；
   · 领域特征：多法域 / 多语言 / 涉外合规与政策动态（对应新《律师法》第七条）。
   说明（原型）：浏览器无法直接跨域抓取 gov 站点，故用「公开 CORS 代理」best-effort；
   生产应由**后端爬虫**抓取权威源 + 本地/云端入库。此处先跑通「任务抓取去重入库直连」闭环。
   ========================================================================= */
(function () {
  var LS = { items: "legal-kb.intl.items", meta: "legal-kb.intl.meta", cfg: "legal-kb.intl.cfg" };
  var now = function () { return new Date(); };
  var dateStr = function (d) { d = d || now(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  var fmtDate = function (d) { return dateStr(new Date(d)); };
  var hashId = function (s) { var h = 5381; s = String(s || ""); for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; } return "k" + (h >>> 0).toString(36); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); };
  var byId = function (id) { return document.getElementById(id); };

  // —— 内置种子数据（示例·要点整理，供离线体验；正式内容以官方原文/后端库为准） ——
  var SEEDS = [
    { source: "全国人民代表大会常务委员会", url: "http://www.npc.gov.cn/npc/c2/c30834/202608/t20260828_457233.html", title: "关于修改《中华人民共和国律师法》的决定", date: "2026-08-28", jurisdiction: "中国", domain: "立法动态", topic: "律师法 / 涉外法律服务", importance: "high", tags: ["新法", "涉外", "律师法"],
      summary: "全国人大常委会关于修改《律师法》的决定，自2026年9月1日起施行。新增【第七条】国家积极发展涉外法律服务业、加强涉外律师人才培养、支持律师事务所提升涉外法律服务能力水平、鼓励行业加强国际交流合作，服务高质量发展和高水平对外开放。新增【第六十二条】港澳法律执业者/执业律师通过粤港澳大湾区律师执业考试，取得内地资质后可在深圳、广州、珠海、佛山、惠州、东莞、中山、江门、肇庆九市从事规定范围法律业务。" },
    { source: "联合国贸易法委员会 UNCITRAL", url: "https://uncitral.un.org/zh/texts/arbitration/conventions/foreign_arbitral_awards", title: "《承认及执行外国仲裁裁决公约》（《纽约公约》）", date: "1958-06-10", jurisdiction: "国际", domain: "仲裁/争议解决", topic: "国际仲裁 · 承认与执行", importance: "high", tags: ["国际条约", "仲裁", "执行"],
      summary: "《纽约公约》为外国仲裁裁决在中国及180多个缔约国的承认与执行提供框架。涉外仲裁裁决申请执行需经法院审查，重点核验仲裁协议有效性、正当程序、公共政策等。中国法院适用《最高人民法院关于执行我国加入的〈承认及执行外国仲裁裁决公约〉的通知》及司法解释。" },
    { source: "联合国国际贸易法委员会", url: "https://uncitral.un.org/zh/texts/salegoods", title: "《联合国国际货物销售合同公约》(CISG)", date: "1980", jurisdiction: "国际", domain: "国际贸易", topic: "货物买卖 · 准据法", importance: "medium", tags: ["国际条约", "买卖合同"],
      summary: "CISG 适用于营业地在不同缔约国之间的货物买卖合同，中国为缔约国。涉外买卖合同可约定排除适用。律师需注意公约与国内法（《民法典》合同编）在违约责任、要约承诺等方面的差异。" },
    { source: "海牙国际私法会议 HCCH", url: "https://www.hcch.net/zh/instruments/conventions", title: "海牙《民商事案件域外送达公约》与《域外取证公约》", date: "1965/1970", jurisdiction: "国际", domain: "跨境程序", topic: "涉外送达 · 域外取证", importance: "medium", tags: ["国际条约", "送达", "取证"],
      summary: "海牙送达与取证公约为跨境民商事案件的域外送达与取证提供中央机关协作通道。中国大陆适用《关于执行〈海牙送达公约〉有关问题的通知》等。涉外诉讼中送达与取证合规直接影响程序合法性。" },
    { source: "国家互联网信息办公室", url: "https://www.cac.gov.cn/", title: "《数据出境安全评估办法》与数据出境合规要点", date: "2022-09-01", jurisdiction: "中国", domain: "数据合规", topic: "数据出境 · PIPL", importance: "high", tags: ["数据出境", "PIPL", "合规"],
      summary: "处理境内个人信息/数据向境外提供的，应依《个人信息保护法》及《数据出境安全评估办法》进行安全评估、标准合同或认证路径。涉外业务涉数据出境为高风险合规点，需前置评估。" },
    { source: "商务部 / 美国财政部OFAC", url: "https://www.mofcom.gov.cn/", title: "出口管制与制裁合规（示例：实体清单/OFAC筛查）", date: "（动态）", jurisdiction: "跨境", domain: "合规/制裁", topic: "出口管制 · 制裁", importance: "high", tags: ["制裁", "出口管制", "合规"],
      summary: "涉外交易需筛查交易对手是否列入出口管制清单/制裁清单（如美国OFAC、欧盟、实体清单），并评估物项是否受出口管制。此为涉外商事/贸易合规的必做动作。具体清单以官方实时发布为准。" },
    { source: "广东省司法厅 / 大湾区", url: "https://sft.gd.gov.cn/", title: "粤港澳大湾区律师执业考试与九市执业范围", date: "（动态）", jurisdiction: "中国·大湾区", domain: "港澳大湾区", topic: "港澳律师 · 湾区执业", importance: "high", tags: ["大湾区", "港澳律师", "九市"],
      summary: "依据新《律师法》第六十二条，港澳法律执业者/执业律师通过粤港澳大湾区律师执业考试取得内地资质后，可在广州、深圳、珠海、佛山、惠州、东莞、中山、江门、肇庆九市从事规定范围法律业务。报名条件与执业范围由司法部规定。" },
    { source: "中国国际经济贸易仲裁委员会 CIETAC", url: "https://www.cietac.org/", title: "国际仲裁机构对比与仲裁地/语言选择", date: "（动态）", jurisdiction: "国际", domain: "仲裁/争议解决", topic: "国际仲裁 · 机构", importance: "medium", tags: ["仲裁", "争议解决", "机构"],
      summary: "涉外商事争议可选 CIETAC / 上海、深圳国际仲裁院 / HKIAC / SIAC / ICC / LCIA 等。选择仲裁机构需考量仲裁地、仲裁语言、费用、程序效率与裁决执行便利（如新加坡/香港便利执行）。" },
  ];

  // —— 抓取源注册表（权威候选；best-effort 抓取，生产改后端爬虫） ——
  var SOURCES = [
    { name: "全国人大·法律动态", tag: "立法动态", url: "http://www.npc.gov.cn/npc/c2/c30834/202608/t20260828_457233.html" },
    { name: "中国律师协会·行业动态", tag: "行业动态", url: "https://www.acla.org.cn/" },
    { name: "司法部", tag: "政策", url: "https://www.moj.gov.cn/" },
    { name: "商务部·贸易合规", tag: "合规/制裁", url: "https://www.mofcom.gov.cn/" },
    { name: "国家网信办·数据合规", tag: "数据合规", url: "https://www.cac.gov.cn/" },
    { name: "CIETAC·仲裁", tag: "仲裁", url: "https://www.cietac.org/" },
    { name: "广东省司法厅·大湾区", tag: "粤港澳大湾区", url: "https://sft.gd.gov.cn/" },
  ];

  // —— CORS 代理（浏览器跨域 best-effort；失败则回退/提示） ——
  var PROXIES = [
    function (u) { return "https://api.allorigins.win/get?url=" + encodeURIComponent(u); },
    function (u) { return "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u); },
  ];
  var proxied = function (u) { return PROXIES[0](u); };

  // —— 本地存取 ——
  function loadItems() { try { var a = localStorage.getItem(LS.items); var arr = a ? JSON.parse(a) : []; return Array.isArray(arr) ? arr : []; } catch (e) { return []; } }
  function saveItems(items) { try { localStorage.setItem(LS.items, JSON.stringify(items)); } catch (e) { } }
  function loadMeta() { try { var m = localStorage.getItem(LS.meta); return m ? JSON.parse(m) : {}; } catch (e) { return {}; } }
  function saveMeta(m) { try { localStorage.setItem(LS.meta, JSON.stringify(m)); } catch (e) { } }
  function loadCfg() { try { var c = localStorage.getItem(LS.cfg); return c ? JSON.parse(c) : null; } catch (e) { return null; } }
  function saveCfg(c) { try { localStorage.setItem(LS.cfg, JSON.stringify(c)); } catch (e) { } }

  function seedOnce() {
    var items = loadItems();
    SEEDS.forEach(function (s) {
      var key = hashId(s.title + "|" + s.source);
      if (!items.some(function (x) { return x.id === key; })) {
        items.push({ id: key, source: s.source, url: s.url, title: s.title, date: s.date, jurisdiction: s.jurisdiction, domain: s.domain, topic: s.topic, importance: s.importance, tags: s.tags, summary: s.summary, content: s.summary, capturedAt: Date.now(), provenance: "seed" });
      }
    });
    saveItems(items);
  }

  // —— 抓取（文字抽取 + 去重） ——
  function stripHtml(html) {
    return String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  function extractTitle(txt) {
    if (!txt) return "";
    var m = txt.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m) return stripHtml(m[1]).slice(0, 120);
    var h = txt.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || txt.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (h) return stripHtml(h[1]).slice(0, 120);
    return stripHtml(txt).slice(0, 120);
  }
  function makeItemFromFetched(src, html) {
    var txt = stripHtml(html);
    var title = extractTitle(html) || src.name;
    var summary = txt.slice(0, 200) || "（未抽取到正文，请打开原文查看）";
    var url = src.url;
    return {
      id: hashId(url + "|" + title), source: src.name, url: url, title: title, date: dateStr(),
      jurisdiction: "中国", domain: src.tag, topic: src.tag, importance: "medium", tags: [src.tag],
      summary: summary, content: txt.slice(0, 1200), capturedAt: Date.now(), provenance: "fetch"
    };
  }
  // 抓取单个源；返回成功/失败
  async function fetchOne(src) {
    var got = null, lastErr = null;
    for (var i = 0; i < PROXIES.length; i++) {
      try {
        var res = await fetch(PROXIES[i](src.url));
        if (!res.ok) { lastErr = new Error("HTTP " + res.status); continue; }
        var text = await res.text();
        // allorigins 返回 {contents: ...}
        try {
          var j = JSON.parse(text);
          if (j && j.contents) text = j.contents;
        } catch (e) { /* 非 JSON，直接当作网页正文 */ }
        got = text; break;
      } catch (e) { lastErr = e; }
    }
    if (!got) { return { ok: false, src: src, err: lastErr && lastErr.message }; }
    return { ok: true, src: src, item: makeItemFromFetched(src, got) };
  }
  // 一键抓取全部源
  async function captureNow() {
    var meta = loadMeta(), items = loadItems();
    var results = [];
    for (var i = 0; i < SOURCES.length; i++) {
      var r = await fetchOne(SOURCES[i]);
      if (r.ok && r.item) {
        if (!items.some(function (x) { return x.id === r.item.id; })) { items.unshift(r.item); }
        results.push({ name: SOURCES[i].name, ok: true });
      } else {
        results.push({ name: SOURCES[i].name, ok: false });
      }
    }
    saveItems(items);
    meta.lastRun = Date.now(); meta.lastResult = results; meta.total = items.length;
    saveMeta(meta);
    return { items: items, results: results, meta: meta };
  }

  // —— 调度（每日/每周 + 时间节点） ——
  function isDue(cfg, nowDate, lastRun) {
    if (!cfg || !cfg.enabled) return false;
    if (!lastRun || lastRun < cfg.createdAt - 1) return true; // 首次
    var fromToday = new Date(lastRun);
    var sameDay = dateStr(fromToday) === dateStr(nowDate);
    var pastTime = nowDate.getHours() * 60 + nowDate.getMinutes() >= cfg.hour * 60 + cfg.minute;
    if (!pastTime) return false;
    if (cfg.freq === "daily") return !sameDay || (sameDay && dateStr(fromToday) === dateStr(nowDate) && false);
    if (cfg.freq === "weekly") { var dd = (nowDate.getDay() + 6) % 7; return dd === ((cfg.weekday || 1) % 7) && !sameDay; }
    return false;
  }
  function tick() {
    var cfg = loadCfg(); var meta = loadMeta();
    if (isDue(cfg, now(), meta.lastRun)) { captureNow().then(function (r) { if (window.IntlKB && window.IntlKB.onCaptured) window.IntlKB.onCaptured(r); }); }
  }
  function startScheduler() { setInterval(tick, 60 * 1000); }

  // —— AI 摘要（调用统一桥；未接算力时输出骨架） ——
  function aiSummary(item) {
    try { return (window.__callAI && window.__callAI("intl-knowledge", { title: item.title, domain: item.domain, summary: item.summary })) || ".ai-box 未接 AI 桥"; }
    catch (e) { return "AI 生成失败。"; }
  }

  // —— 渲染模块（直连本地） ——
  var state = { q: "", jurisdiction: "全部", domain: "全部", importance: "全部", sort: "date-desc", expanded: null, capturing: false };
  function filtered(items) {
    return items.filter(function (x) {
      if (state.q && !((x.title + x.summary + x.topic + x.tags.join(" ")).toLowerCase().indexOf(state.q.toLowerCase()) >= 0)) return false;
      if (state.jurisdiction !== "全部" && x.jurisdiction !== state.jurisdiction) return false;
      if (state.domain !== "全部" && x.domain !== state.domain) return false;
      if (state.importance !== "全部" && x.importance !== state.importance) return false;
      return true;
    }).sort(function (a, b) {
      if (state.sort === "importance") return (IMPORT_ORDER[b.importance] || 0) - (IMPORT_ORDER[a.importance] || 0);
      if (state.sort === "date-desc") return (new Date(b.date) - new Date(a.date)) || (b.capturedAt - a.capturedAt);
      return (new Date(a.date) - new Date(b.date));
    });
  }
  var IMPORT_ORDER = { high: 3, medium: 2, low: 1 };

  function chip(label, active, attr) {
    return '<button class="intl-chip' + (active ? " on" : "") + '" ' + attr + '>' + esc(label) + "</button>";
  }
  function importanceBadge(v) {
    var m = { high: "high", medium: "mid", low: "low" };
    return '<span class="intl-badge ' + (m[v] || "mid") + '">' + ({ high: "高", medium: "中", low: "低" }[v] || "中") + "</span>";
  }

  function render(container, title, sub) {
    seedOnce();
    var items = loadItems();
    var meta = loadMeta();
    var list = filtered(items);

    var jurisdictions = ["全部"].concat(Object.keys(items.reduce(function (a, x) { a[x.jurisdiction] = 1; return a; }, {})).sort());
    var domains = ["全部"].concat(Object.keys(items.reduce(function (a, x) { a[x.domain] = 1; return a; }, {})).sort());
    var importanceOptions = [["全部", "全部"], ["high", "高"], ["medium", "中"], ["low", "低"]];

    var html =
      "<style>"
      + ".intl-chip{background:rgba(127,127,127,.09);border:1px solid transparent;border-radius:999px;padding:4px 12px;font-size:12px;color:inherit;cursor:pointer;transition:.18s}"
      + ".intl-chip:hover{border-color:var(--accent,#4f8cff)}.intl-chip.on{background:linear-gradient(135deg,var(--accent,#4f8cff),#7aa8ff);color:#fff;border-color:transparent}"
      + ".intl-badge{padding:2px 8px;border-radius:999px;font-size:11px}.intl-badge.high{background:rgba(220,60,60,.14);color:#e05555}.intl-badge.mid{background:rgba(230,150,40,.16);color:#d7882c}.intl-badge.low{background:rgba(90,170,90,.16);color:#3f9b5c}"
      + ".intl-item{cursor:pointer}.intl-item.done .intl-sum{display:none}"
      + ".intl-box{margin-top:8px}.intl-note{font-size:12px;color:inherit;opacity:.62;margin-top:6px}"
      + ".intl-box .ai-box{padding:10px 13px;border-radius:10px;background:rgba(79,140,255,.08);border:1px solid rgba(79,140,255,.22);font-size:13px;line-height:1.75;color:inherit}"
      + ".intl-box .ai-sum dt{font-weight:600;color:var(--accent,#4f8cff);margin-top:6px}"
      + ".intl-box .ai-sum dd{margin-left:0;margin-bottom:2px;opacity:.9}"
      + "</style>"
      + '<div class="page-head"><div><h1>' + esc(title) + "</h1><div class='sub'>" + esc(sub) + "</div></div>"
      + '<div style="display:flex;gap:8px;align-items:center">'
      + '<button class="btn btn-ghost btn-sm" id="intlAddBtn">＋ 新增</button>'
      + '<button class="btn btn-ghost btn-sm" id="intlIoBtn">导出/导入</button>'
      + '<button class="btn btn-primary glow" id="intlFetchBtn"> 立即抓取</button></div></div>'

      + '<div class="grid cols-4" style="margin-bottom:14px">'
      + '<div class="stat-card glow"><div class="stat-label">知识条目</div><div class="stat-value">' + items.length + '</div></div>'
      + '<div class="stat-card glow"><div class="stat-label">涉外·新法/政策</div><div class="stat-value">' + items.filter(function (x) { return x.importance === "high"; }).length + '</div><div class="stat-foot"><span class="up"> 高价值</span></div></div>'
      + '<div class="stat-card glow"><div class="stat-label">抓取源</div><div class="stat-value">' + SOURCES.length + '</div></div>'
      + '<div class="stat-card glow"><div class="stat-label">上次抓取</div><div class="stat-value" style="font-size:15px">' + (meta.lastRun ? fmtDate(meta.lastRun) : "未抓取") + '</div></div>'
      + "</div>"

      + '<div class="card glow" style="margin-bottom:14px"><div class="card-head"><h2> 检索 / 过滤</h2><span style="font-size:12px;opacity:.6">直连本地 · 断网可用</span></div>'
      + '<input id="intlSearch" class="intl-input" placeholder="搜索标题 / 摘要 / 主题 / 标签…" value="' + esc(state.q) + '" style="width:100%;padding:9px 12px;border-radius:10px;border:1px solid rgba(127,127,127,.25);background:rgba(127,127,127,.06);color:inherit;font-family:inherit;margin-bottom:10px" />'
      + '<div class="row" style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">'
      + '<span style="font-size:12px;opacity:.6">法域</span>' + jurisdictions.map(function (j) { return chip(j, state.jurisdiction === j, 'data-j="' + esc(j) + '"'); }).join("")
      + "</div><div class=\"row\" style=\"align-items:center;flex-wrap:wrap;gap:6px;margin-top:6px\">"
      + '<span style="font-size:12px;opacity:.6">领域</span>' + domains.map(function (d) { return chip(d, state.domain === d, 'data-d="' + esc(d) + '"'); }).join("")
      + "</div><div class=\"row\" style=\"align-items:center;flex-wrap:wrap;gap:6px;margin-top:6px\">"
      + '<span style="font-size:12px;opacity:.6">重要</span>' + importanceOptions.map(function (o) { return chip(o[1], state.importance === o[0], "data-i='" + o[0] + "'"); }).join("")
      + '<span style="margin-left:auto;font-size:12px;opacity:.6">排序</span>'
      + '<select id="intlSort" style="padding:6px;border-radius:8px;border:1px solid rgba(127,127,127,.25);background:transparent;color:inherit;font-family:inherit">'
      + '<option value="date-desc"' + (state.sort === "date-desc" ? " selected" : "") + '>最新优先</option>'
      + '<option value="importance"' + (state.sort === "importance" ? " selected" : "") + '>重要优先</option>'
      + '<option value="date-asc"' + (state.sort === "date-asc" ? " selected" : "") + '>最早优先</option>'
      + "</select></div></div>"

      + '<div class="card glow" id="intlCapturePanel" style="margin-bottom:14px;display:none">'
      + '<div class="card-head"><h2> 抓取工具</h2><span class="badge badge-info">best-effort · 生产改后端爬虫</span></div>'
      + '<div id="intlFetchStatus" style="font-size:12px;opacity:.75">点击按钮配置抓取节奏，或「立即抓取」。</div>'
      + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px">'
      + '<button class="btn btn-sm btn-ghost" id="intlCfgBtn"> 抓取节奏</button>'
      + '<span class="intl-note">每日 / 每周 + 时间节点自动抓取；数据存本机。</span></div></div>'

      + '<div class="card glow"><div class="card-head"><h2>知识条目（' + list.length + '/' + items.length + '）</h2>'
      + '<span class="badge badge-info">直连本地 · 新《律师法》第七条</span></div>'
      + (list.length ? list.map(function (x) { return itemRow(x); }).join("") : '<div class="empty">当前筛选下无条目</div>')
      + "</div>";

    container.innerHTML = html;
    bind(container, items, meta);
  }

  function itemRow(x) {
    var tags = (x.tags || []).map(function (t) { return '<span class="intl-chip" style="cursor:default;background:rgba(127,127,127,.12)">' + esc(t) + "</span>"; }).join("");
    return '<div class="intl-item" data-id="' + x.id + '" style="padding:14px 0;border-bottom:1px solid rgba(127,127,127,.12)">'
      + '<div class="row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' + importanceBadge(x.importance)
      + '<span class="link" data-openx="' + x.id + '" style="font-weight:600">' + esc(x.title) + "</span>"
      + '<span style="font-size:11px;opacity:.55">' + esc(x.jurisdiction) + " · " + esc(x.domain) + "</span>"
      + '<span style="margin-left:auto;font-size:11px;opacity:.55">' + esc(x.date) + "</span></div>"
      + '<div class="tl-meta" style="margin-top:4px">来源：' + esc(x.source) + (x.url ? ' <a href="' + esc(x.url) + '" target="_blank" rel="noopener">原文</a>' : "") + "</div>"
      + '<div class="intl-sum" style="margin-top:6px;font-size:13px;opacity:.85">' + esc(x.summary) + "</div>"
      + '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px">' + tags
      + '<div style="margin-left:auto;display:flex;gap:8px">'
      + '<button class="btn btn-sm btn-ghost" data-ai="' + x.id + '">AI 摘要</button>'
      + '<button class="btn btn-sm btn-ghost" data-del="' + x.id + '">删除</button></div></div>'
      + '<div class="intl-box" data-box="' + x.id + '" style="display:none"></div></div>';
  }

  function bind(container, items, meta) {
    var search = byId("intlSearch");
    if (search) search.addEventListener("input", function () { state.q = search.value; render(container); });
    container.querySelectorAll("[data-j]").forEach(function (b) { b.addEventListener("click", function () { state.jurisdiction = b.getAttribute("data-j"); render(container); }); });
    container.querySelectorAll("[data-d]").forEach(function (b) { b.addEventListener("click", function () { state.domain = b.getAttribute("data-d"); render(container); }); });
    container.querySelectorAll("[data-i]").forEach(function (b) { b.addEventListener("click", function () { state.importance = b.getAttribute("data-i"); render(container); }); });
    var sort = byId("intlSort"); if (sort) sort.addEventListener("change", function () { state.sort = sort.value; render(container); });

    var addBtn = byId("intlAddBtn"); if (addBtn) addBtn.addEventListener("click", function () { openAddModal(); });
    var ioBtn = byId("intlIoBtn"); if (ioBtn) ioBtn.addEventListener("click", function () { openIoModal(); });
    var fetchBtn = byId("intlFetchBtn"); if (fetchBtn) fetchBtn.addEventListener("click", function () { doFetch(container); });
    var cfgBtn = byId("intlCfgBtn"); if (cfgBtn) cfgBtn.addEventListener("click", function () { openCfgModal(container); });

    container.querySelectorAll("[data-openx]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-openx"); var box = container.querySelector('[data-box="' + id + '"]');
        if (box) box.style.display = box.style.display === "none" ? "block" : "none";
      });
    });
    container.querySelectorAll("[data-ai]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-ai"); var item = items.find(function (x) { return x.id === id; });
        var box = container.querySelector('[data-box="' + id + '"]');
        if (box) { box.style.display = "block"; box.innerHTML = '<div class="ai-box">' + aiSummary(item || {}) + "</div>"; }
      });
    });
    container.querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-del");
        if (!confirm("删除该知识条目？")) return;
        var its = loadItems().filter(function (x) { return x.id !== id; }); saveItems(its); render(container);
        if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已删除", "success");
      });
    });
  }

  function doFetch(container) {
    var btn = byId("intlFetchBtn");
    if (btn) { btn.disabled = true; btn.textContent = "…抓取中"; }
    var panel = byId("intlCapturePanel"); var st = byId("intlFetchStatus");
    if (panel) panel.style.display = "block";
    if (st) st.textContent = "正在抓取 " + SOURCES.length + " 个源…";
    captureNow().then(function (r) {
      if (st) {
        var okc = r.results.filter(function (x) { return x.ok; }).length, bad = r.results.filter(function (x) { return !x.ok; }).length;
        st.innerHTML = "本次抓取：成功 <b>" + okc + "</b> 源，失败 <b>" + bad + "</b> 源（跨域受限，生产改后端爬虫）。<br>"
          + r.results.map(function (x) { return '<span style="opacity:.7">' + esc(x.name) + "：" + (x.ok ? "" : "") + "</span>"; }).join(" · ");
      }
      render(container);
      if (window.Workbench && window.Workbench.toast) window.Workbench.toast("抓取完成（含种子数据）", "success");
      var b2 = byId("intlFetchBtn"); if (b2) { b2.disabled = false; b2.textContent = " 立即抓取"; }
    });
  }

  // 新增 / 导出导入 / 节奏 三个弹窗
  function openAddModal() {
    var m = document.createElement("div"); m.className = "modal-overlay show";
    m.innerHTML = '<div class="modal glow" style="width:620px"><div class="card-head"><h3>＋ 新增涉外知识</h3></div>'
      + '<div class="doc-meta"><div class="mi"><b>标题*</b><span><input id="nT" style="width:100%" placeholder="标题"></span></div>'
      + '<div class="mi"><b>主题</b><span><input id="nTopic" style="width:100%" placeholder="如：律师法 / 数据出境"></span></div>'
      + '<div class="mi"><b>法域</b><span><input id="nJ" style="width:100%" placeholder="中国 / 国际 / 大湾区"></span></div>'
      + '<div class="mi"><b>来源</b><span><input id="nS" style="width:100%" placeholder="来源 / 链接"></span></div>'
      + '<div class="mi"><b>摘要/要点</b><span><textarea id="nSum" rows="5" style="width:100%;resize:vertical" placeholder="粘贴或输入要点"></textarea></span></div></div>'
      + '<div class="modal-actions"><button class="btn btn-primary" id="nSave">保存</button><button class="btn btn-ghost" data-close>取消</button></div></div>';
    document.body.appendChild(m);
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.id === "nSave") {
        var title = byId("nT").value.trim(); if (!title) { alert("请填写标题"); return; }
        var item = { id: hashId(title + Date.now()), source: byId("nS").value.trim() || "手动录入", url: "", title: title, date: dateStr(), jurisdiction: byId("nJ").value.trim() || "中国", domain: "手动", topic: byId("nTopic").value.trim() || "—", importance: "medium", tags: ["手动"], summary: byId("nSum").value.trim() || "（无摘要）", content: byId("nSum").value, capturedAt: Date.now(), provenance: "manual" };
        var its = loadItems(); its.unshift(item); saveItems(its); m.remove();
        location.reload();
      }
    });
  }
  function openIoModal() {
    var m = document.createElement("div"); m.className = "modal-overlay show";
    m.innerHTML = '<div class="modal glow" style="width:560px"><div class="card-head"><h3>导出 / 导入（本地 JSON）</h3></div>'
      + '<div class="doc-meta"><div class="mi"><b>导出</b><span><button class="btn btn-sm btn-primary" id="ioExport">下载 JSON 备份</button></span></div>'
      + '<div class="mi"><b>导入</b><span><input id="ioFile" type="file" accept="application/json" style="width:100%"><button class="btn btn-sm btn-ghost" id="ioImport">导入覆盖</button></span></div></div>'
      + '<div class="modal-actions"><button class="btn btn-ghost" data-close>关闭</button></div></div>';
    document.body.appendChild(m);
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.id === "ioExport") {
        var blob = new Blob([JSON.stringify(loadItems(), null, 2)], { type: "application/json" });
        var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "intl-kb-" + dateStr() + ".json"; a.click();
      }
      if (e.target.id === "ioImport") {
        var f = byId("ioFile").files[0]; if (!f) { alert("请选择文件"); return; }
        var rd = new FileReader(); rd.onload = function () { try { var arr = JSON.parse(rd.result); if (Array.isArray(arr)) { saveItems(arr); m.remove(); location.reload(); } else { alert("格式不正确"); } } catch (e2) { alert("解析失败"); } }; rd.readAsText(f);
      }
    });
  }
  function openCfgModal(container) {
    var cfg = loadCfg() || { enabled: true, freq: "daily", hour: 8, minute: 30, weekday: 1, createdAt: Date.now() };
    var m = document.createElement("div"); m.className = "modal-overlay show";
    m.innerHTML = '<div class="modal glow" style="width:520px"><div class="card-head"><h3> 抓取节奏</h3></div>'
      + '<div class="doc-meta"><div class="mi"><b>状态</b><span><label><input type="checkbox" id="cOn"' + (cfg.enabled ? " checked" : "") + '> 启用自动抓取</label></span></div>'
      + '<div class="mi"><b>频率</b><span><select id="cFreq" style="padding:6px;border-radius:8px"><option value="daily"' + (cfg.freq === "daily" ? " selected" : "") + '>每天</option><option value="weekly"' + (cfg.freq === "weekly" ? " selected" : "") + '>每周</option></select></span></div>'
      + '<div class="mi"><b>时间</b><span><input id="cHour" type="number" min="0" max="23" value="' + cfg.hour + '" style="width:70px"> : <input id="cMin" type="number" min="0" max="59" value="' + cfg.minute + '" style="width:70px">（时:分）</span></div>'
      + '<div class="mi" id="cWeekRow" style="' + (cfg.freq === "weekly" ? "" : "display:none") + '"><b>星期</b><span><select id="cWeek" style="padding:6px;border-radius:8px">' + ["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map(function (w, i) { return '<option value="' + (i + 1) + '"' + ((cfg.weekday || 1) === (i + 1) ? " selected" : "") + '>' + w + "</option>"; }).join("") + "</select></span></div>"
      + '<div class="mi"><b>说明</b><span class="intl-note">浏览器打开工作台时按此节奏抓取；数据存本机。</span></div></div>'
      + '<div class="modal-actions"><button class="btn btn-primary" id="cSave">保存</button><button class="btn btn-ghost" data-close>取消</button></div></div>';
    document.body.appendChild(m);
    var freq = byId("cFreq");
    freq.addEventListener("change", function () { var w = byId("cWeekRow"); if (w) w.style.display = freq.value === "weekly" ? "" : "none"; });
    m.addEventListener("click", function (e) {
      if (e.target === m || (e.target.hasAttribute && e.target.hasAttribute("data-close"))) { m.remove(); return; }
      if (e.target.id === "cSave") {
        var c = { enabled: byId("cOn").checked, freq: byId("cFreq").value, hour: Number(byId("cHour").value) || 8, minute: Number(byId("cMin").value) || 30, weekday: Number(byId("cWeek").value) || 1, createdAt: cfg.createdAt || Date.now() };
        saveCfg(c); m.remove(); toast("已保存抓取节奏", "success"); render(container);
      }
    });
  }

  // 供外部（workbench.js）调用
  window.IntlKB = {
    render: render,
    captureNow: captureNow,
    onCaptured: function () { /* 调度触发后回到模块视图：由 workbench 监听刷新 */ },
    data: { SEEDS: SEEDS, SOURCES: SOURCES }
  };

  // 启动解码：种子一次 + 调度器
  startScheduler();
  document.addEventListener("DOMContentLoaded", seedOnce);
})();
