/* 深鲸·律师端 · 授权 / 激活（A款-订阅token版 / B款-自备API key版 · ¥399/年）
 * 授权：手机号 + 短信验证码（本地模拟，留 sendSmS 真接口）+ 机器指纹离线授权（Ed25519）
 * 状态存 localStorage：
 *   legal-mode.sku        'A' | 'B'     用户选择的款型
 *   legal-mode.activate   { phone, smsAt(验证码校验时间戳), machine, plan, exp, lic }
 *   legal-mode.llm        { mode:'A'|'B', apiKey?, baseURL? }  B款自填 DeepSeek key
 */
(function () {
  var KEY = {
    sku: "legal-mode.sku",
    activate: "legal-mode.activate",
    llm: "legal-mode.llm",
    phoneCache: "legal-mode.phoneCache", // 已校验手机号（输一次持久化）
    trialStart: "legal-mode.trialStart", // 试用开始时间（首次进入记录）
    trialExtends: "legal-mode.trialExtends", // 反馈/Bug 采纳后奖励的试用延长天数
    graceStart: "legal-mode.graceStart",   // 到期后首次打开的时间（犹豫期起算）
    freeApply: "legal-mode.freeApply",   // 免费申请提交状态 { status:'pending'|'approved'|'rejected', ... }
  };
  var PRICE = "¥399/年";
  // ── 律师执业证号校验（与鸿蒙端、服务端同一套规则）──
  // 依据：司法部《律师和律师事务所执业证号编制办法》（2009-10-01 启用）
  // 17 位：1(证书种类) + 2-3(省级区划) + 4-5(市级区划) + 6-9(首次执业年度)
  //        + 10(执业类别) + 11(性别) + 12-17(序列号)
  // ⚠ 司法部明确「自 2010-01-01 起原律师执业证书停止使用」，
  //   2009 年底前已全部换发，故不存在旧证号，可按 17 位硬校验。
  var PROVINCE_CODES = ['11','12','13','14','15','21','22','23','31','32','33','34','35','36','37',
    '41','42','43','44','45','46','50','51','52','53','54','61','62','63','64','65'];

  /** 公益计划允许的执业类别码：1 专职律师、8 法律援助律师 */
  var PUBLIC_SERVICE_CATS = ['1', '8'];

  /** 逐位校验执业证号；返回空串表示通过，否则返回具体原因 */
  function checkLawyerLicense(raw) {
    var v = String(raw || '').trim();
    if (!v) { return '请填写执业证号'; }
    if (!/^\d+$/.test(v)) { return '执业证号应全部为数字'; }
    if (v.length !== 17) { return '执业证号应为 17 位（司法部标准），当前为 ' + v.length + ' 位'; }
    if (v.charAt(0) !== '1') { return '执业证号第 1 位应为 1（律师执业证 / 律师工作证）'; }
    var prov = v.substring(1, 3);
    if (PROVINCE_CODES.indexOf(prov) < 0) {
      return '执业证号第 2–3 位「' + prov + '」不是合法的省级行政区划代码（如 11 北京 / 33 浙江 / 44 广东）';
    }
    var year = Number(v.substring(5, 9));
    if (!isFinite(year) || year < 1980 || year > new Date().getFullYear()) {
      return '执业证号第 6–9 位不是合理的首次批准执业年度';
    }
    var cat = v.charAt(9);
    if (cat < '1' || cat > '9') {
      return '执业证号第 10 位应为执业类别代码（1 专职 / 8 法律援助 等）';
    }
    var sex = v.charAt(10);
    if (sex !== '0' && sex !== '1') {
      return '执业证号第 11 位应为性别代码（男 0 / 女 1）';
    }
    return '';
  }

  var TRIAL_MS = 60 * 24 * 3600 * 1000; // 试用期 60 天（试用期内免激活码，直接进工作台）

  function read(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function isRealDesktop() { return typeof window !== "undefined" && typeof window.__licenseVerify === "function"; }
  function realMachine() { try { return (window.__licenseGetMachine && window.__licenseGetMachine()) || ""; } catch (e) { return ""; } }
  function realVerify(key) { try { return window.__licenseVerify ? window.__licenseVerify(key) : null; } catch (e) { return { ok: false, msg: "校验失败" }; } }

  // —— 模拟短信验证码（本地生成；真服务时改 sendSms）——
  var _smsCache = { phone: null, code: null, exp: 0 };
  function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
  var SEND_COOLDOWN_MS = 60000;
  var lastSendAt = 0;
  function sendSms(phone) {
    // 有真实短信桥（preload `__sendSms`）：交给 main 进程走 sms-config.json 真实发送
    if (typeof window.__sendSms === "function") {
      return window.__sendSms({ phone: phone }).then(function (r) {
        // r = { ok, simulated?, code?, msg? }
        return { ok: !!r.ok, code: r.code, msg: r.msg, simulated: !!r.simulated };
      }).catch(function () { return { ok: false, msg: "短信服务异常" }; });
    }
    // 无桥：本地模拟（浏览器/未接真服务时）
    return Promise.resolve({ ok: true, code: genCode(), simulated: true });
  }

  function state() {
    var sku = read(KEY.sku, null);
    var act = read(KEY.activate, null);
    var phoneCache = read(KEY.phoneCache, null);
    // 试用：首次进入记录开始时间；之后不变
    var start = read(KEY.trialStart, null);
    if (!start) { start = Date.now(); write(KEY.trialStart, start); }
    var ext = read(KEY.trialExtends, 0) || 0; // 反馈奖励延长天数
    var remainMs = (start + TRIAL_MS + ext * 24 * 3600 * 1000) - Date.now();
    return { sku: sku, activate: act, phoneCache: phoneCache, trialStart: start, trialExtends: ext, trialRemainMs: remainMs };
  }

  // ══════════════════════════════════════════════════════════════
  // 授权到期后的「犹豫期 → 只读」
  //
  // 对外承诺（官网 support.html 与桌面端激活面板「授权与服务说明」）：
  //   到期当天   → 仅提示，不做任何功能限制
  //   犹豫期 7 天 → 自用户【下次打开应用】时起算，全功能
  //   犹豫期后   → 只读：可查看与导出，不能新增/编辑/使用 AI/导入
  //
  // 起算点取「到期后首次打开」而非「到期日 +7 天」：后者在用户出差、
  // 休假期间会静默走完，回来已被锁，属无声剥夺。
  // ══════════════════════════════════════════════════════════════
  var GRACE_DAYS = 7;

  /** 授权是否已过期（不含试用） */
  function licenseExpired() {
    var s = state();
    if (!s.activate || !s.activate.exp) { return false; }
    var t = new Date(s.activate.exp + "T23:59:59").getTime();
    return isFinite(t) && Date.now() > t;
  }

  /** 记录犹豫期起算时间：仅在「已到期且尚未记录过」时写入一次 */
  function markGraceStartIfNeeded() {
    if (!licenseExpired()) { return; }
    if (read(KEY.graceStart, 0)) { return; }
    write(KEY.graceStart, Date.now());
  }

  /** 犹豫期是否仍在（未到期则视为 true） */
  function isInGrace() {
    if (!licenseExpired()) { return true; }
    var gs = read(KEY.graceStart, 0) || 0;
    if (!gs) { return true; }               // 尚未记录起点 → 还没打开过
    return Date.now() < gs + GRACE_DAYS * 86400000;
  }

  /** 犹豫期剩余天数；未到期时返回 -1 */
  function graceDaysLeft() {
    if (!licenseExpired()) { return -1; }
    var gs = read(KEY.graceStart, 0) || 0;
    if (!gs) { return GRACE_DAYS; }
    var left = gs + GRACE_DAYS * 86400000 - Date.now();
    return left > 0 ? Math.ceil(left / 86400000) : 0;
  }

  /** 当前是否处于只读状态（到期 + 犹豫期已过） */
  function isReadOnly() {
    return licenseExpired() && !isInGrace();
  }

  /**
   * 写入/AI 前的统一门禁。允许返回 true；只读时提示并返回 false。
   * 提示节流 4 秒，避免连续点击刷屏。
   */
  var lastToastAt = 0;
  function guardWritable(action) {
    if (!isReadOnly()) { return true; }
    var now = Date.now();
    if (now - lastToastAt > 4000) {
      lastToastAt = now;
      if (window.Log) { window.Log.act('授权', '只读拦截：' + action); }
      if (window.__dlToast) {
        window.__dlToast("授权已到期，当前为只读模式，无法" + action + "。续费后立即恢复，数据不受影响。");
      }
    }
    return false;
  }

  // 试用是否有效（未激活且在试用期内）
  function isTrialActive() {
    var s = state();
    if (isActivated()) return false;
    return s.trialRemainMs > 0;
  }

  // 反馈/Bug 采纳后：增加试用延长天数（同时延长已激活用户的到期日，未激活的延长试用剩余）
  function extendTrial(days) {
    days = Math.max(1, parseInt(days, 10) || 0);
    if (days <= 0) return { ok: false, msg: "天数无效" };
    var cur = read(KEY.trialExtends, 0) || 0;
    write(KEY.trialExtends, cur + days);
    // 已激活(含付费/免费)：延长到期日
    var act = read(KEY.activate, null);
    if (act && act.exp) {
      var exp = new Date(String(act.exp) + "T23:59:59");
      if (!isNaN(exp.getTime())) { exp.setDate(exp.getDate() + days); act.exp = exp.toISOString().slice(0, 10); write(KEY.activate, act); }
    } else if (act && !act.exp) {
      // 无到期日(长期/免费)：记录奖励天数，将来到期时叠加
    }
    updateBadgeText();
    return { ok: true, days: days };
  }

  // 是否可用：已激活 或 试用期内
  function canUse() {
    return isActivated() || isTrialActive();
  }

  function trialDays() {
    var s = state();
    return s.trialRemainMs > 0 ? Math.ceil(s.trialRemainMs / (24 * 3600 * 1000)) : 0;
  }

  // 是否已激活（含有效手机号校验；含后台已批的免费授权 grant='free'）
  function isActivated() {
    var s = state();
    if (!s.activate || !s.activate.phone) return false;
    if (!s.activate.machine) return false;
    if (s.activate.exp) {
      var exp = new Date(String(s.activate.exp) + "T23:59:59").getTime();
      if (isFinite(exp) && Date.now() > exp) return false;
    }
    return true;
  }

  // 是否为免费授权（公益律师，后台已通过）
  function isFree() {
    var s = state();
    return !!(s.activate && s.activate.grant === "free");
  }

  // 免费申请状态 pending/approved/rejected/null
  function freeApplyStatus() {
    var fa = read(KEY.freeApply, null);
    return fa ? (fa.status || "pending") : null;
  }

  function skuInfo() {
    var s = state();
    if (isFree()) return "公益免费版（自备 AI Key）";
    return (s.sku === "B") ? "B款 · 订阅算力" : "A款 · 自备 API Key";
  }

  function badgeText() {
    // 到期后的两个阶段优先判断，文案必须如实反映当前可用性
    if (isReadOnly()) { return "只读模式 · 点此续费"; }
    if (licenseExpired() && graceDaysLeft() >= 0) {
      return "已到期 · 犹豫期剩余 " + graceDaysLeft() + " 天 · 点此续费";
    }
    var s = state();
    if (isActivated()) {
      return "已激活 · " + skuInfo() + (s.activate.exp ? (" · 至 " + s.activate.exp) : "");
    }
    if (isTrialActive()) {
      return "试用剩余 " + trialDays() + " 天 · 点此激活";
    }
    return "试用已结束 · 请激活";
  }

  // —— 激活弹窗 ——
  function openModal() {
    var existing = document.getElementById("legal-license-modal");
    if (existing) { existing.remove(); }
    var m = document.createElement("div");
    m.id = "legal-license-modal";
    m.className = "modal-overlay show";
    m.style.cssText = "position:fixed;inset:0;z-index:2147483645;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);";
    var s = state();
    m.innerHTML =
      "<div class='modal glow' style='width:800px;max-height:92vh;overflow:auto;'>" +
      // —— 主标题行 + 机器绑定两行（放右上角，与主标题呼应）——
      "<div style='display:flex;align-items:flex-start;justify-content:space-between;gap:14px'>" +
      "<div><div style='display:flex;align-items:center;gap:10px'>" +
      "<h2 style='margin:0;color:#eef4f7'>深鲸·律师端 · 激活</h2><span class='badge badge-info lic-sku-badge'>" + skuInfo() + "</span></div>" +
      "<div id='lic-status' style='color:#8ea3c2;margin-top:4px'>当前：" + badgeText() + "</div></div>" +
      "<div style='text-align:right;flex-shrink:0'>" +
      "<div style='font-size:14px;font-weight:700;color:#eef4f7'>机器绑定（离线授权）</div>" +
      "<div id='lic-machine' style='font-size:12px;color:#7aa8ff;margin-top:4px;text-align:right;word-break:break-all'></div>" +
      "</div></div>" +

      // —— 选款型：A/B 各占一半，横排铺满整行 ——
      "<div class='sec-title'>选择你的版本</div>" +
      "<div id='lic-sku' style='display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:10px'>" +
      // —— 选款型：A款=自备API Key(现在可用,放前)  B款=订阅算力(即将推出,放后) ——
      skuCard("A", "A款 · 自备 API Key", "填入你自己的 DeepSeek API Key，数据只走你填的接口；我们不代你承担算力", s.sku, PRICE) +
      skuCard("B", "B款 · 订阅算力", "订阅含集团算力，由我们统一下发/校验 token（即将推出，敬请期待）", s.sku, PRICE) +
      "</div>" +

      // —— 第2步：手机号 + 短信验证码 ——
      "<div class='sec-title'>手机号验证（一次即可）</div>" +
      "<div style='display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px'>" +
      "<input id='lic-phone' placeholder='输入手机号' value='" + (s.phoneCache || "") + "' style='width:200px;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +
      "<button class='btn btn-primary' id='lic-send'>发送验证码</button>" +
      "<input id='lic-code' placeholder='短信验证码' style='width:150px;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +
      "</div>" +
      "<div id='lic-sms-msg' style='font-size:12px;color:#7aa8ff;margin-bottom:10px'></div>" +

      // —— 授权码 + 激活 + 关闭（保持原样，在手机号验证之后）——
      "<div style='display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px'>" +
      "<input id='lic-key' placeholder='输入授权码（通过手机号激活后获取）' style='width:46%;min-width:180px;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +
      "<button class='btn btn-primary' id='lic-activate'>激 活</button>" +
      "<button class='btn btn-primary' data-close>关闭</button></div>" +

      // —— A款(自备API Key)专属：self DeepSeek Key ——
      "<div id='lic-b' style='margin-top:16px;border-top:1px solid rgba(255,255,255,.1);padding-top:12px;display:none'>" +
      "<div class='sec-title'>配置你的 DeepSeek API Key（A款）</div>" +
      "<div style='display:flex;gap:8px;flex-wrap:wrap'>" +
      // 已保存的 Key 摘要：让用户确认「填的是哪一把」，但不明文显示
      "<div id='lic-api-cur' style='font-size:12px;color:#7ddb8a;margin-bottom:6px'></div>" +
      "<div style='display:flex;gap:8px;flex-wrap:wrap'>" +
      "<input id='lic-api' placeholder='sk-…（DeepSeek API Key）' type='password' autocomplete='off' style='flex:1;min-width:240px;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +
      "<button class='btn btn-primary' id='lic-savekey'>保存 Key</button>" +
      // 清除入口：此前只能覆盖、不能删除，用户换账号或想停用 AI 时无路可走
      "<button class='btn btn-ghost' id='lic-clear' style='display:none'>清除 Key</button></div>" +
      "<div id='lic-api-msg' style='font-size:12px;color:#7aa8ff;margin-top:6px'></div></div>" +

      // —— 公益律师 免费申请（仅 A款·自备算力 显示；公益律师=自备 key，等同A款）——
      "<div id='lic-free' style='margin-top:16px;border-top:1px solid rgba(255,255,255,.1);padding-top:12px;display:none'>" +
      "<div class='sec-title'>公益 / 半公益律师 · 申请（自备算力款）</div>" +
      // —— 申请类型：公益（免费） / 半公益（授权费减半）——
      // 半公益只在桌面端受理，不进鸿蒙端 —— 鸿蒙端越简单越好。
      "<div style='font-size:12px;color:#8ea3c2;margin:6px 0 4px'>申请类型 *</div>" +
      "<div style='display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px'>" +
      "<button class='btn btn-ghost active' id='lic-ftype-free' data-ftype='free' style='flex:1;min-width:170px'>公益律师 · 免费使用</button>" +
      "<button class='btn btn-ghost' id='lic-ftype-half' data-ftype='half' style='flex:1;min-width:170px'>半公益律师 · 授权费减半</button>" +
      "</div>" +
      "<div id='lic-ftypecap' style='display:none;font-size:11.5px;color:#8ea3c2;line-height:1.8;margin-bottom:8px;padding:10px 12px;border-radius:9px;background:rgba(224,160,112,.08);border:1px solid rgba(224,160,112,.32)'>" +
      "半公益适用于：因执业安排只能<b>偶尔</b>承办法律援助案件的商业律师。" +
      "审核通过后，授权费按标准价<b>减半</b>；AI 算力仍需自备 DeepSeek API Key（同 A 款）。" +
      "严格意义上，仅偶尔承办法援案件属《法律援助法》第十六条规定的法定义务，" +
      "本档位为我们主动提供的优惠，不构成对公益身份的认定。</div>" +
      "<div style='font-size:12px;color:#8ea3c2;margin-bottom:8px'>" +
      "适用对象：<b>以为经济困难当事人提供法律保障为主要工作</b>的律师。<br>" +
      "① 法律援助律师（执业证号第 10 位为 8）；<br>" +
      "② 以公益法律服务为主要工作的专职律师（第 10 位为 1），如民政注册公益法律服务机构成员、「1+1」中国法律援助志愿者。<br>" +
      "<span style='color:#e07070'>不适用</span>：律所内部设立的公益部门（属律所为自身声誉组建的内部机构，无社会公信力认定）；" +
      "仅偶尔承办援助案件的商业律师（依《法律援助法》第十六条为法定义务）。<br>" +
      "<span id='lic-fbenefit'>审核通过后<b>工作台免费使用</b>；</span><b>AI 算力需自备 DeepSeek API Key</b>（同 A 款），我们不承担算力消耗。</div>" +
      "<div style='display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px'>" +
      "<input id='lic-fname' placeholder='姓名 *' style='padding:9px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +
      "<input id='lic-fno' placeholder='执业证号 *（17 位）' style='padding:9px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +
      "<input id='lic-forg' placeholder='公益机构 / 律所 *（全称）' style='padding:9px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +

      "</div>" +
      // —— 手机号 + 两个操作按钮 同一行（手机号占左，按钮靠右，避免下方再拉长）——
      "<div style='display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px'>" +
      "<input id='lic-fphone' placeholder='手机号 *' style='flex:1;min-width:160px;padding:9px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +
      "</div>" +

      // ── 公益身份证明（证书）── 与鸿蒙端一致：必传，或走「暂无证书」通道
      "<div style='font-size:12px;color:#8ea3c2;margin:8px 0 4px'>公益身份证明 *</div>" +
      "<div style='font-size:11px;color:#8ea3c2;margin-bottom:6px'>法律援助律师工作证、「1+1」中国法律援助志愿者服务证书、民政注册公益法律服务机构聘书等，任选其一。<br>" +
      "注：我国没有「公益律师」这一法定身份，故无统一的公益律师证书；以上证件均可通过全国律师执业诚信信息公示平台核验。</div>" +
      "<input id='lic-fcert' type='file' accept='.pdf,.jpg,.jpeg,.png,.webp,.heic' style='display:none'>" +
      "<div style='display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px'>" +
      "<button class='btn btn-primary' id='lic-fcertpick'>上传证书 *</button>" +
      "<button class='btn btn-ghost' id='lic-fcertnone'>暂无证书</button>" +
      "<span id='lic-fcertname' style='font-size:12px;color:#7aa8ff'>未选择文件</span>" +
      "</div>" +
      "<div id='lic-fcertbox' style='display:none;margin-bottom:8px'>" +
      "<input id='lic-fcertexp' placeholder='无证书的原因 *（如：单位未及补发 / 仅有电子版）' style='width:100%;padding:9px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8;margin-bottom:6px'>" +
      "<input id='lic-fcertsite' placeholder='可核验的网站 *（如：浙江法律援助网 / 省律师协会官网）' style='width:100%;padding:9px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +
      "<div style='font-size:11px;color:#8ea3c2;margin-top:4px'>请填写我们能自行查证您公益律师身份的网站名称 —— 这样即使手上没有证书，我们也能完成核验。</div>" +
      "</div>" +

      // ── 所在单位盖章证明 ──
      "<div style='font-size:12px;color:#8ea3c2;margin:8px 0 4px'>所在单位盖章证明 *</div>" +
      "<div style='font-size:11px;color:#8ea3c2;margin-bottom:6px'>须为律所或公益机构出具并加盖公章的公益法律服务证明，内容应包含您的姓名、执业证号及在册/从事公益法律服务的情况。可用扫描件或清晰照片。</div>" +
      "<input id='lic-ffile' type='file' accept='.pdf,.jpg,.jpeg,.png,.webp,.heic' style='display:none'>" +
      "<div style='display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px'>" +
      "<button class='btn btn-primary' id='lic-fpick'>上传单位证明 *</button>" +
      "<span id='lic-fname2' style='font-size:12px;color:#7aa8ff'>未选择文件</span>" +
      "</div>" +

      // ── 真实性承诺（未勾选不予提交）──
      "<label style='display:flex;gap:8px;align-items:flex-start;font-size:11px;line-height:1.7;color:#8ea3c2;margin-bottom:8px'>" +
      "<input type='checkbox' id='lic-fagree' style='margin-top:3px'>" +
      "<span>本人承诺：以上所填信息及所提交的证明文件均真实、有效，且已取得出具单位的同意。如经查证存在虚假，愿承担由此产生的全部责任，并接受取消公益免费资格的处理。<br>" +
      "公益免费名额由深鲸·律师端运营方审核发放，<b>解释权归运营方所有</b>；授权有效期 12 个月，期间每 6 个月复审一次（重新提交单位盖章证明即可，无需付费），未按期提交将转为只读状态。所提交材料将予留档，仅用于资格审核与争议处理。</span></label>" +

      "<div style='display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px'>" +
      "<button class='btn btn-primary' id='lic-fsubmit'>提交免费申请</button>" +
      "<span id='lic-fstatus' style='font-size:12px;color:#8ea3c2'></span>" +
      "</div>" +
      "</div>" +
      "<div style='font-size:11px;color:#8ea3c2'>标 * 为必填。执业证号需为 17 位（司法部编码规则），机构须填全称，并上传所在单位加盖公章的证明文件。两份材料用于核验公益资质，仅作审核用，不公开。机器码随申请单一起提交，换机需重新申请。</div>" +
      "</div>" +

      // —— 授权与服务说明（与官网 support.html 一致；App 内必须能看到同样条款）——
      "<div style='margin-top:16px;border-top:1px solid rgba(255,255,255,.1);padding-top:12px'>" +
      "<div class='sec-title'>授权与服务说明</div>" +
      "<div style='font-size:11.5px;line-height:1.9;color:#8ea3c2'>" +
      "<b style='color:#cfe6ea'>一、授权期内（12 个月，自激活之日起算）</b><br>" +
      "期间发布的全部版本更新与新功能，均可免费升级，不额外收费。<br><br>" +
      "<b style='color:#cfe6ea'>二、授权到期之后</b><br>" +
      "1. 到期当天：仅顶部提示，不做任何功能限制。<br>" +
      "2. 犹豫期 7 天：自你<b>下次打开应用</b>时起算，全功能照常使用，方便导出数据与续费。<br>" +
      "3. 犹豫期后：转为只读 —— 已录入数据仍可查看与导出，不能新增、编辑、使用 AI 与导入数据；续费后立即恢复，数据不受影响。<br><br>" +
      "<b style='color:#cfe6ea'>三、发票</b><br>" +
      "所有商品均可开票，需你主动申请。订单支付之日起 90 天内可自助申请；超过 90 天仍可申请，转人工办理。个人开具增值税普通发票；律所或企业可开增值税专用发票（需提供单位名称与纳税人识别号）。申请请邮件至 service@deepwhale.org，附订单号与支付凭证。<br><br>" +
      "<b style='color:#cfe6ea'>四、退款</b><br>" +
      "本产品提供 60 天免费试用，请在试用满意后再购买（试用期内提前购买并激活也不支持退款）。数字化商品，一经激活不支持退款。若付款后尚未激活，或遇到重复扣款、支付异常，请邮件至 service@deepwhale.org 核实处理。<br><br>" +
      "<b style='color:#cfe6ea'>五、技术支持</b><br>" +
      "仅邮件渠道：service@deepwhale.org。2 个工作日内响应（休息日与法定节假日不计入）。服务时段为工作日 9:00–18:00。仅限本应用本身（安装、激活、功能使用、故障排查、数据导入导出、发票申请）；不含具体案件的实体法律意见、诉讼策略与文书代写等专业服务。" +
      "</div></div>" +
      "<div id='lic-msg' style='margin-top:14px;color:#7ddb8a;font-size:13px'></div>" +
      "</div>";
    document.body.appendChild(m);

    // 机器码显示
    m.querySelector("#lic-machine").textContent = isRealDesktop() ? ("本机机器码：" + realMachine()) : "（浏览器环境无法取得机器码，请在深鲸·律师端桌面端激活）";

    // 款型选择
    m.querySelectorAll("#lic-sku [data-sku]").forEach(function (el) {
      el.addEventListener("click", function () {
        var v = el.getAttribute("data-sku");
        write(KEY.sku, v);
        setSkuUI(m, v);
        // 同步更新顶部标题 badge 与状态
        var bd = m.querySelector(".lic-sku-badge");
        if (bd) bd.textContent = skuInfo();
        var st = m.querySelector("#lic-status");
        if (st) st.textContent = "当前：" + badgeText();
      });
    });
    setSkuUI(m, "A"); // 默认选中 A款(自备API Key，现在可用) —— B款(订阅)未实现

    // 发送验证码
    m.querySelector("#lic-send").addEventListener("click", function () {
      var btn = this;
      btn.classList.remove("btn-press"); void btn.offsetWidth; btn.classList.add("btn-press");
      setTimeout(function () { btn.classList.remove("btn-press"); }, 300);
      var ph = m.querySelector("#lic-phone").value.trim();
      if (!/^1\d{10}$/.test(ph)) { smsMsg(m, "请填写11位手机号"); return; }
      var now = Date.now();
      if (now - lastSendAt < SEND_COOLDOWN_MS) { smsMsg(m, "请稍后再试（60秒）"); return; }
      lastSendAt = now;
      smsMsg(m, "正在发送…");
      sendSms(ph).then(function (r) {
        if (!r || !r.ok) { smsMsg(m, "发送失败：" + (r && r.msg || "请重试")); return; }
        _smsCache.phone = ph; _smsCache.code = String(r.code).slice(0, 6); _smsCache.exp = Date.now() + 5 * 60000;
        if (r.simulated) {
          smsMsg(m, "验证码已发送（本地模拟：" + _smsCache.code + "），5分钟内有效。正式接入短信服务后为真实下发。");
        } else {
          smsMsg(m, "验证码已发送至手机 " + ph.slice(0, 3) + "****" + ph.slice(-4) + "，5分钟内有效。");
        }
      });
    });

    // 激活
    m.querySelector("#lic-activate").addEventListener("click", function () {
      var ph = m.querySelector("#lic-phone").value.trim();
      var code = m.querySelector("#lic-code").value.trim();
      var keyIn = m.querySelector("#lic-key").value.trim();
      if (!/^1\d{10}$/.test(ph)) { msg(m, "请填写手机号", "#e07070"); return; }
      if (!code || _smsCache.phone !== ph || Date.now() > _smsCache.exp) { msg(m, "验证码无效或已过期，请重新发送", "#e07070"); return; }
      function finish(fetchedLic) {
        if (!isRealDesktop()) { msg(m, "请在深鲸·律师端桌面端完成离线激活（本浏览器无法取得机器指纹）", "#e07070"); return; }
        // 优先用服务器返回的授权码；没有则用手动输入的
        var useLic = fetchedLic || keyIn;
        // 机器指纹授权：校验授权码
        var r = realVerify(useLic);
        if (!r.ok) { msg(m, "授权码无效：" + (r.msg || "请核对机器码/到期"), "#e07070"); return; }
        write(KEY.activate, { phone: ph, smsAt: Date.now(), machine: realMachine(), plan: "std", exp: r.exp || null, lic: useLic.toUpperCase() });
        if (window.Log) { window.Log.i('授权', '激活成功', '到期 ' + (r.exp || '—') + ' / 机器码 ' + window.Log.maskMachine(realMachine())); }
        write(KEY.phoneCache, ph);
        msg(m, "已激活（手机号 + 机器绑定）" + (r.exp ? (" 至 " + r.exp) : "") + "。数据仅本地保存。", "#7ddb8a");
        m.querySelector("#lic-status").textContent = "当前：" + badgeText();
        updateBadgeText();
        ensureBadge();
      }
      function autoActivate() {
        var machine = realMachine();
        if (machine && typeof window.__licenseRegister === "function") { window.__licenseRegister({ phone: ph, machine: machine }); }
        if (machine && typeof window.__licenseFetch === "function") {
          window.__licenseFetch({ phone: ph, machine: machine }).then(function (v) {
            finish((v && v.found && v.license) || null);
          }).catch(function () { finish(null); });
          return;
        }
        finish(null);
      }
      // 服务端校验验证码（密钥/校验都在华为云服务器，App 不含密钥）
      if (typeof window.__verifySms === "function") {
        window.__verifySms({ phone: ph, code: code }).then(function (v) {
          if (!v || !v.valid) { msg(m, "验证码不正确，请核对", "#e07070"); return; }
          autoActivate();
        }).catch(function () { msg(m, "短信校验服务异常，请重试", "#e07070"); });
        return;
      }
      // 无桥：本地回退校验
      if (String(code).slice(0, 6) !== String(_smsCache.code).slice(0, 6)) { msg(m, "验证码不正确，请核对", "#e07070"); return; }
      autoActivate();
    });

    // 清除 Key：此前只能覆盖、不能删除，用户换账号或想停用 AI 时无路可走
    m.querySelector("#lic-clear").addEventListener("click", function () { clearKey(m); });
    // 弹窗打开时刷新「当前已保存」摘要与清除按钮显隐
    // （⚠ 必须放在这里：弹窗是动态创建的，脚本加载时这些元素还不存在）
    refreshKeyUi(m);

    // A款(自备算力)保存 key —— 统一走 KeyMgr
    m.querySelector("#lic-savekey").addEventListener("click", function () {
      var k = m.querySelector("#lic-api").value.trim();
      if (!k) { apiMsg(m, "请填写 DeepSeek API Key"); return; }
      m.querySelector("#lic-api").value = "";
      if (window.KeyMgr && window.KeyMgr.setKey) {
        window.KeyMgr.setKey("legal", k, "https://api.deepseek.com/v1", window.KeyMgr.DEFAULT_MODEL);
        apiMsg(m, "已保存（" + keyMask(k) + "），A款自备算力已生效。深鲸AI 可在「设置→算力与 Key」配置联动或独立 Key。");
        refreshKeyUi(m);
      } else {
        var cfg = read(KEY.llm, {});
        cfg.mode = "A"; cfg.apiKey = k; cfg.baseURL = "";
        write(KEY.llm, cfg);
        apiMsg(m, "已保存（" + keyMask(k) + "）。保存后工作台 AI 将走你自己的接口。");
        refreshKeyUi(m);
      }
    });

    /**
     * Key 的掩码摘要：保留前缀与末四位，便于用户确认「填的是哪一把」，
     * 又不至于把完整密钥暴露在屏幕上。
     */
    function keyMask(k) {
      var t = (k || "").trim();
      if (t.length <= 10) { return "已保存"; }
      return t.slice(0, 6) + "\u2026" + t.slice(-4);
    }

    /** 刷新「当前已保存」摘要与「清除 Key」按钮的显隐 */
    function refreshKeyUi(m) {
      var cfg = read(KEY.llm, {}) || {};
      var has = !!(cfg.apiKey && cfg.apiKey.length > 0);
      var cur = m.querySelector("#lic-api-cur");
      var clr = m.querySelector("#lic-clear");
      if (cur) { cur.textContent = has ? ("当前已保存：" + keyMask(cfg.apiKey)) : "当前未保存 Key（AI 将使用本地模板）"; }
      if (clr) { clr.style.display = has ? "" : "none"; }
    }

    /*
     * 清除已保存的 API Key。
     * 之前只能覆盖、不能删除：想停用 AI 或换用另一个 DeepSeek 账号时，
     * 用户在这台机器上没有退路。清除后 AI 自动退回本地模板模式，
     * 不影响任何业务数据。
     */
    function clearKey(m) {
      var cfg = read(KEY.llm, {}) || {};
      if (!cfg.apiKey && !cfg.groupKey) { apiMsg(m, "当前没有已保存的 Key。"); return; }
      cfg.apiKey = ""; cfg.groupKey = "";
      write(KEY.llm, cfg);
      if (window.KeyMgr && window.KeyMgr.setKey) { try { window.KeyMgr.setKey("legal", "", "", ""); } catch (e) {} }
      m.querySelector("#lic-api").value = "";
      apiMsg(m, "已清除本机保存的 API Key。AI 功能将退回本地模板模式，业务数据不受影响。");
      refreshKeyUi(m);
    }

    // —— 公益律师 免费申请 ——
    // 显示当前申请/审核状态
    (function showFreeStatus() {
      var fa = read(KEY.freeApply, null);
      var el = m.querySelector("#lic-fstatus");
      if (!el) return;
      if (fa && fa.status === "pending") { el.textContent = "已提交，等待审核（证明文件已存）；" + (fa.name || ""); }
      else if (fa && fa.status === "approved") { el.textContent = "已通过免费授权，请返回并配置你的 DeepSeek API Key（A款）。"; }
      else if (fa && fa.status === "rejected") { el.textContent = "审核未通过：" + (fa.reason || "请补充资料后重提"); }
      else { el.textContent = ""; }
    })();

    // 申请类型：free（公益·免费） / half（半公益·减半）
    var applyType = "free";
    function setFType(t) {
      applyType = t;
      var f = m.querySelector("#lic-ftype-free"), h = m.querySelector("#lic-ftype-half");
      if (f) { f.classList.toggle("active", t === "free"); }
      if (h) { h.classList.toggle("active", t === "half"); }
      var cap = m.querySelector("#lic-ftypecap");
      if (cap) { cap.style.display = (t === "half") ? "block" : "none"; }
      // 权益那句要跟着类型变 —— 选半公益却写「免费使用」自相矛盾
      var ben = m.querySelector("#lic-fbenefit");
      if (ben) {
        ben.innerHTML = (t === "half")
          ? "审核通过后<b>授权费按标准价减半</b>；"
          : "审核通过后<b>工作台免费使用</b>；";
      }
    }
    var btnFree = m.querySelector("#lic-ftype-free");
    var btnHalf = m.querySelector("#lic-ftype-half");
    if (btnFree) { btnFree.addEventListener("click", function () { setFType("free"); }); }
    if (btnHalf) { btnHalf.addEventListener("click", function () { setFType("half"); }); }

    // 选择证明材料（两份：公益身份证明 + 所在单位盖章证明）
    var pickedFile = null;
    var pickedCert = null;

    m.querySelector("#lic-fpick").addEventListener("click", function () { m.querySelector("#lic-ffile").click(); });
    m.querySelector("#lic-ffile").addEventListener("change", function () {
      var f = this.files && this.files[0];
      if (!f) { return; }
      if (!/\.(pdf|jpe?g|png|webp|heic)$/i.test(f.name)) {
        freeStatusMsg(m, "证明文件仅支持 PDF 或图片（jpg / png / webp / heic）", "#e07070");
        return;
      }
      pickedFile = f;
      m.querySelector("#lic-fname2").textContent = "已选：" + f.name + "（" + (f.size / 1024).toFixed(0) + " KB）";
    });

    // 公益身份证明：上传证书 或 走「暂无证书」通道
    m.querySelector("#lic-fcertpick").addEventListener("click", function () { m.querySelector("#lic-fcert").click(); });
    m.querySelector("#lic-fcert").addEventListener("change", function () {
      var f = this.files && this.files[0];
      if (!f) { return; }
      if (!/\.(pdf|jpe?g|png|webp|heic)$/i.test(f.name)) {
        freeStatusMsg(m, "证书仅支持 PDF 或图片（jpg / png / webp / heic）", "#e07070");
        return;
      }
      pickedCert = f;
      m.querySelector("#lic-fcertname").textContent = "已选：" + f.name + "（" + (f.size / 1024).toFixed(0) + " KB）";
      m.querySelector("#lic-fcertpick").classList.add("active");
      m.querySelector("#lic-fcertnone").classList.remove("active");
      m.querySelector("#lic-fcertbox").style.display = "none";
    });
    m.querySelector("#lic-fcertnone").addEventListener("click", function () {
      var on = this.classList.toggle("active");
      pickedCert = null;
      m.querySelector("#lic-fcertname").textContent = on ? "（已选择暂无证书）" : "未选择文件";
      m.querySelector("#lic-fcertpick").classList.toggle("active", !on);
      m.querySelector("#lic-fcertbox").style.display = on ? "block" : "none";
    });

    // 提交免费申请（本地保存申请 + 证明文件 base64，调用后台/本地审核存储）
    m.querySelector("#lic-fsubmit").addEventListener("click", function () {
      var name = m.querySelector("#lic-fname").value.trim();
      var type = "lawyer";
      var no = m.querySelector("#lic-fno").value.trim();
      var org = m.querySelector("#lic-forg").value.trim();
      var phone = m.querySelector("#lic-fphone").value.trim();
      // 公益名额免费发放，门槛必须写实：只判「非空」时填一个字母也能提交。

      if (name.length < 2) { freeStatusMsg(m, "请填写与执业证一致的真实姓名（至少 2 个字）", "#e07070"); return; }

      // 执业证号：与鸿蒙端、服务端同一套逐位校验（司法部编码规则）
      var licErr = checkLawyerLicense(no);
      if (licErr) { freeStatusMsg(m, licErr, "#e07070"); return; }
      // 执业类别：1 专职律师 / 8 法律援助律师 —— 公益计划面向这两类
      if (PUBLIC_SERVICE_CATS.indexOf(no.charAt(9)) < 0) {
        freeStatusMsg(m, "该执业证号的执业类别不属于公益计划范围。本计划面向法律援助律师（类别码 8）"
          + "与以公益法律服务为主要工作的专职律师（类别码 1）。如有疑问可邮件 service@deepwhale.org 说明。", "#e07070");
        return;
      }
      if (org.length < 4) { freeStatusMsg(m, "请填写公益机构或律所全称（至少 4 个字）", "#e07070"); return; }
      if (!/^1\d{10}$/.test(phone)) { freeStatusMsg(m, "请填写 11 位手机号", "#e07070"); return; }

      // 公益身份证明：必须上传证书，或如实说明原因并提供可核验网站。
      // 「如有则传」等于给不想传的人开了一道门，不设这个口子。
      var certNone = m.querySelector("#lic-fcertnone").classList.contains("active");
      var certExplain = (m.querySelector("#lic-fcertexp").value || "").trim();
      var certSite = (m.querySelector("#lic-fcertsite").value || "").trim();
      if (!certNone) {
        if (!pickedCert) {
          freeStatusMsg(m, "请上传公益身份证明（法律援助工作证 / 「1+1」志愿者证书 / 公益机构聘书）；"
            + "确无证书的，请选择「暂无证书」并填写原因与可核验网站。", "#e07070");
          return;
        }
      } else {
        if (certExplain.length < 10) { freeStatusMsg(m, "请说明无证书的原因（至少 10 个字）", "#e07070"); return; }
        if (certSite.length < 4) { freeStatusMsg(m, "请填写可核验您公益律师身份的网站名称", "#e07070"); return; }
      }
      if (!pickedFile) { freeStatusMsg(m, "请上传所在单位加盖公章的公益法律服务证明", "#e07070"); return; }

      // 真实性承诺：纠纷时的追责依据，未勾选不予提交
      if (!m.querySelector("#lic-fagree").checked) {
        freeStatusMsg(m, "请先阅读并勾选真实性承诺", "#e07070");
        return;
      }

      // 两份材料都要转 base64 上报
      var pending = certNone ? 1 : 2;
      var certData = "", proofData = "";
      function done() {
        pending--;
        if (pending > 0) { return; }
        // 字段名对齐服务端 /api/free-apply 的约定，便于桥直接转发
        // （与鸿蒙端上报的 payload 保持完全一致）
        var app = {
          status: "pending",
          applyType: applyType,          // free = 公益免费 / half = 半公益减半
          name: name, type: type, no: no, org: org, firm: org,
          phone: phone, machine: isRealDesktop() ? realMachine() : "",
          fileName: pickedFile.name, fileBase64: proofData,
          certName: certNone ? "" : pickedCert.name,
          certBase64: certNone ? "" : certData,
          certExplain: certNone ? certExplain : "",
          certSite: certNone ? certSite : "",
          agreed: true,
          at: Date.now(),
        };
        write(KEY.freeApply, app);
        if (window.Log) { window.Log.i('公益申请', '提交', '证号 ' + String(no).slice(0, 6) + '… / 机器码 ' + window.Log.maskMachine(app.machine)); }
        // 复用 preload 已有的 __freeSubmit 桥（main.js 里已改为上报服务端）
        var submitFn = window.__freeSubmit || window.__freeApplySubmit;
        if (submitFn && typeof submitFn === "function") {
          submitFn(app).then(function (r) {
            if (r && r.ok) {
              freeStatusMsg(m, "已提交，等待审核（审核结果将自动同步）。", "#7ddb8a");
            } else {
              freeStatusMsg(m, "已保存本机；后台上报失败：" + ((r && r.msg) || "请重试"), "#e0a070");
            }
          }).catch(function () { freeStatusMsg(m, "已保存本机；后台暂时无法连接。", "#e0a070"); });
        } else {
          freeStatusMsg(m, "已保存本机。请连同单位盖章证明邮件发送至 service@deepwhale.org，我们收到后开始审核。", "#7ddb8a");
        }
        var st = m.querySelector("#lic-fstatus");
        if (st) { st.textContent = "已提交，等待审核：" + name; }
      }
      var r1 = new FileReader();
      r1.onload = function () { proofData = r1.result; done(); };
      r1.readAsDataURL(pickedFile);
      if (certNone) { done(); }
      else {
        var r2 = new FileReader();
        r2.onload = function () { certData = r2.result; done(); };
        r2.readAsDataURL(pickedCert);
      }
    });

    m.querySelector("[data-close]").addEventListener("click", function () { m.remove(); });
    m.addEventListener("click", function (e) { if (e.target === m) m.remove(); });
  }

  function skuCard(id, name, desc, cur, price) {
    var on = (cur === id) ? "sku-on" : "";
    return "<div data-sku='" + id + "' class='sku-card " + on + "' style='cursor:pointer;padding:16px;border-radius:14px;transition:.15s'>" +
      "<div style='display:flex;align-items:center;justify-content:space-between'>" +
      "<div style='font-weight:700;font-size:14px'>" + name + "</div>" +
      (price ? "<div style='font-size:13px;font-weight:700;color:#4176e6'>" + price + "</div>" : "") +
      "</div>" +
      "<div style='font-size:12px;opacity:.72;margin-top:8px;line-height:1.6'>" + desc + "</div></div>";
  }

  function setSkuUI(m, v) {
    m.querySelectorAll("#lic-sku [data-sku]").forEach(function (el) {
      var on = el.getAttribute("data-sku") === v;
      el.classList.toggle("sku-on", on);
    });
    // 自备算力(A款)专属：Key 配置区 + 公益律师免费申请，仅选 A款 显示
    var b = m.querySelector("#lic-b");
    if (b) b.style.display = (v === "A") ? "block" : "none";
    var fr = m.querySelector("#lic-free");
    if (fr) fr.style.display = (v === "A") ? "block" : "none";
  }

  function msg(m, t, color) { var e = m.querySelector("#lic-msg"); if (e) { e.textContent = t; e.style.color = color || "#7ddb8a"; } }
  function smsMsg(m, t) { var e = m.querySelector("#lic-sms-msg"); if (e) e.textContent = t; }
  function apiMsg(m, t) { var e = m.querySelector("#lic-api-msg"); if (e) e.textContent = t; }
  function freeStatusMsg(m, t, color) { var e = m.querySelector("#lic-fstatus"); if (e) { e.textContent = t; e.style.color = color || "#7ddb8a"; } }

  function ensureBadge() {
    var id = "legal-license-badge";
    if (document.getElementById(id)) return;
    // 关闭记忆：legal-mode.trialBadgeClosedAt 时间戳，1天内不再显示
    var closedAt = read("legal-mode.trialBadgeClosedAt", 0);
    if (closedAt && (Date.now() - closedAt) < 24 * 3600 * 1000) return;
    if (isActivated()) return; // 已激活不显示试用块
    var b = document.createElement("button");
    b.id = id;
    b.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483640;padding:8px 14px;border-radius:999px;border:none;font:600 12.5px -apple-system,Segoe UI,sans-serif;cursor:pointer;background:rgba(20,24,32,.92);color:#e7ebf2;box-shadow:0 4px 16px rgba(0,0,0,.3);display:flex;align-items:center;gap:8px;";
    b.innerHTML = "<span>" + badgeText() + "</span><span class='trial-badge-close' style='font-size:14px;opacity:.7;font-weight:600'>✕</span>";
    b.addEventListener("click", function (e) {
      if (e.target && e.target.className === "trial-badge-close") {
        write("legal-mode.trialBadgeClosedAt", Date.now());
        var el = document.getElementById(id); if (el) el.remove();
        // 1天后重新弹：清理关闭记忆，下次进入重新识别
        setTimeout(function () { localStorage.removeItem("legal-mode.trialBadgeClosedAt"); updateBadgeText(); ensureBadge(); }, 24 * 3600 * 1000);
      } else {
        openModal();
      }
    });
    document.body.appendChild(b);
    setInterval(function () { var el = document.getElementById(id); if (el) el.querySelector("span").textContent = badgeText(); }, 60000);
  }

  // 激活后立即刷新徽标文本 + 关掉全屏 gate
  function updateBadgeText() {
    var b = document.getElementById("legal-license-badge");
    if (b) b.textContent = badgeText();
    var g = document.getElementById("legal-expire-gate");
    if (g && isActivated()) g.remove();
  }

  function gateIfExpired() {
    // 已激活：只留徽标
    if (isActivated()) { ensureBadge(); return; }
    // 试用期内：不弹禁止 gate，只留左下角徽标（提示剩余天数），用户可正常进工作台
    if (isTrialActive()) { ensureBadge(); return; }
    // 试用已结束 + 未激活：全屏拦截
    ensureBadge();
    if (document.getElementById("legal-expire-gate")) return;
    var g = document.createElement("div");
    g.id = "legal-expire-gate";
    g.style.cssText = "position:fixed;inset:0;z-index:2147483644;display:flex;align-items:center;justify-content:center;background:rgba(8,10,14,.94);color:#eef2f8;";
    g.innerHTML = "<div style='max-width:560px;text-align:center;padding:28px'>" +
      "<div style='font-size:36px'></div><h2 style='margin:10px 0'>试用已结束 · 请激活「深鲸·律师端」</h2>" +
      "<p style='color:#8ea3c2'>60 天试用已到期。请选择 <b>A款（自备 API Key）</b> 或 <b>B款（订阅算力，" + PRICE + "）</b>，完成手机号验证 + 机器绑定授权后激活；公益律师可申请免费使用。</p>" +
      "<div style='margin:16px 0'><button class='btn btn-primary' id='gate-open'>立即激活</button></div></div>";
    document.body.appendChild(g);
    g.querySelector("#gate-open").addEventListener("click", function () { g.remove(); openModal(); });
  }

  // —— 授权到期后的只读常驻横幅 ——
  // 与鸿蒙端一致：整个只读期间常驻、不可关闭，让用户始终知道当前能力与恢复方式。
  function showReadOnlyBanner() {
    if (!isReadOnly()) {
      var old = document.getElementById("legal-readonly-banner");
      if (old) old.remove();
      return;
    }
    if (document.getElementById("legal-readonly-banner")) return;
    var b = document.createElement("div");
    b.id = "legal-readonly-banner";
    b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483646;padding:12px 18px;" +
      "display:flex;align-items:center;gap:14px;justify-content:center;" +
      "background:linear-gradient(90deg,#7a2230,#a8323f);color:#fff;" +
      "border-bottom:1px solid rgba(255,255,255,.18);" +
      "font:13px -apple-system,Segoe UI,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.35);";
    b.innerHTML =
      "<div style='flex:0 0 auto;font-size:15px'>\uD83D\uDD12</div>" +
      "<div style='flex:1'><div style='font-weight:700'>授权已到期 · 当前为只读模式</div>" +
      "<div style='opacity:.92;font-size:12px;margin-top:2px'>已录入的数据仍可查看与导出；" +
      "续费后立即恢复全部功能，数据不受影响。</div></div>" +
      // 按钮用「纯白底 + 深红字」保证对比度（半透明白底配白字在红底上几乎看不清）
      "<button id='legal-readonly-btn' style='flex:0 0 auto;padding:8px 18px;border:0;border-radius:999px;" +
      "background:#fff;color:#8f1f2c;font-weight:700;font-size:13px;cursor:pointer;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.25)'>去续费</button>";
    document.body.appendChild(b);
    var btn = b.querySelector("#legal-readonly-btn");
    if (btn) btn.addEventListener("click", function () { openModal(); });
  }

  // —— 首次登录试用提醒（标准3：提醒试用期60天，及时注册授权）——
  function showTrialBanner() {
    if (!isTrialActive()) return;
    if (read("legal-mode.trialBannerShown", false)) { ensureBadge(); return; }
    var days = trialDays();
    var b = document.createElement("div");
    b.id = "legal-trial-banner";
    b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483646;padding:12px 18px;display:flex;align-items:center;gap:14px;justify-content:center;background:linear-gradient(90deg,#1a2340,#2a3a6b);color:#eef2f8;border-bottom:1px solid rgba(255,255,255,.12);font:13px -apple-system,Segoe UI,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.3);";
    b.innerHTML =
      "<div style='flex:0 0 auto;font-weight:700;font-size:14px'>深鲸·律师端</div>" +
      "<div style='flex:1;opacity:.92'>欢迎试用！当前为 <b style='color:#ffd479'>免费试用期 · 剩余 " + days + " 天</b>。试用期内全部功能正常可用；如使用满意，请及时<b>注册授权</b>，以免影响后续使用。</div>" +
      "<button class='btn btn-ghost' id='legal-trial-banner-btn' style='padding:7px 16px'>去激活</button>" +
      "<button class='btn btn-ghost' id='legal-trial-banner-close' style='padding:7px 12px'>知道了</button>";
    document.body.appendChild(b);
    var act = b.querySelector("#legal-trial-banner-btn");
    var close = b.querySelector("#legal-trial-banner-close");
    if (act) act.addEventListener("click", function () { write("legal-mode.trialBannerShown", true); b.remove(); openModal(); });
    if (close) close.addEventListener("click", function () { write("legal-mode.trialBannerShown", true); b.remove(); });
    ensureBadge();
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (isActivated()) ensureBadge();
    else { gateIfExpired(); showTrialBanner(); }
    // 只读横幅：优先级高于试用提醒，到期后常驻
    showReadOnlyBanner();
    setInterval(showReadOnlyBanner, 30000);
    // 免费申请审核结果轮询：用户已提交待审，则定期查后台；若通过则自动写入 free 授权并生效
    var fa = read(KEY.freeApply, null);
    if (window.__freeCheck && fa && fa.status === "pending") {
      setInterval(function () {
        try {
          var mch = isRealDesktop() ? realMachine() : "";
          if (!mch) return;
          window.__freeCheck(mch).then(function (r) {
            if (r && r.ok && (r.status === "approved" || r.status === "rejected")) {
              var cur = read(KEY.freeApply, null);
              if (cur && cur.status !== r.status) {
                cur.status = r.status;
                if (r.status === "approved") {
                  // 后台通过：写入免费授权（grant=free），工作台立即可用
                  write(KEY.activate, { phone: cur.phone, smsAt: Date.now(), machine: mch, grant: "free", plan: "free", approvedAt: Date.now() });
                  updateBadgeText();
                  var g = document.getElementById("legal-expire-gate");
                  if (g) g.remove();
                } else {
                  cur.reason = r.reason || "";
                }
                write(KEY.freeApply, cur);
              }
            }
          }).catch(function () {});
        } catch (e) {}
      }, 8000);
    }
  });

  window.License = {
    // 供实名校验（workbench.js）复用同一套证号规则 ——
    // 本产品是一个体系，证号校验规则三端必须一致（鸿蒙端 / 桌面端 / 服务端）。
    checkLawyerLicense: checkLawyerLicense,
    PUBLIC_SERVICE_CATS: PUBLIC_SERVICE_CATS,
    state: state,
    badgeText: badgeText,
    isActivated: isActivated,
    isTrialActive: isTrialActive,
    isFree: isFree,
    canUse: canUse,
    trialDays: trialDays,
    freeApplyStatus: freeApplyStatus,
    skuInfo: skuInfo,
    extendTrial: extendTrial,
    PRICE: PRICE,
    open: openModal,
    realMachine: realMachine,
  };
})();
