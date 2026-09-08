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
    freeApply: "legal-mode.freeApply",   // 免费申请提交状态 { status:'pending'|'approved'|'rejected', ... }
  };
  var PRICE = "¥399/年";
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
      "<input id='lic-api' placeholder='sk-…（DeepSeek API Key）' type='password' autocomplete='off' style='flex:1;min-width:240px;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +
      "<button class='btn btn-primary' id='lic-savekey'>保存 Key</button></div>" +
      "<div id='lic-api-msg' style='font-size:12px;color:#7aa8ff;margin-top:6px'></div></div>" +

      // —— 公益律师 免费申请（仅 A款·自备算力 显示；公益律师=自备 key，等同A款）——
      "<div id='lic-free' style='margin-top:16px;border-top:1px solid rgba(255,255,255,.1);padding-top:12px;display:none'>" +
      "<div class='sec-title'>公益律师 · 免费申请（自备算力款）</div>" +
      "<div style='font-size:12px;color:#8ea3c2;margin-bottom:8px'>适用于：公益律师（法律援助 / 公益机构执业）。审核通过后<b>工作台免费使用</b>；<b>AI 算力需自备 DeepSeek API Key</b>（同 A 款），我们不承担算力消耗。</div>" +
      "<div style='display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px'>" +
      "<input id='lic-fname' placeholder='姓名' style='padding:9px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +
      "<input id='lic-fno' placeholder='执业证号' style='padding:9px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +
      "<input id='lic-forg' placeholder='公益机构 / 律所' style='padding:9px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +
      "<input id='lic-ffirm' placeholder='证明人姓名 / 签署单位' style='padding:9px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +
      "</div>" +
      // —— 手机号 + 两个操作按钮 同一行（手机号占左，按钮靠右，避免下方再拉长）——
      "<div style='display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px'>" +
      "<input id='lic-ffile' type='file' accept='image/*,application/pdf' style='display:none'>" +
      "<input id='lic-fphone' placeholder='手机号' style='flex:1;min-width:160px;padding:9px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'>" +
      "<button class='btn btn-primary' id='lic-fpick'>上传证明文件</button>" +
      "<button class='btn btn-primary' id='lic-fsubmit'>提交免费申请</button>" +
      "</div>" +
      "<div style='display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px'>" +
      "<span id='lic-fname2' style='font-size:12px;color:#7aa8ff'>未选择文件</span>" +
      "<span id='lic-fstatus' style='font-size:12px;color:#8ea3c2'></span>" +
      "</div>" +
      "<div style='font-size:11px;color:#8ea3c2'>上传证明文件（证明人或单位签署，用于公益资质佐证；仅作审核用，不公开）</div>" +
      "</div>" +

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
      function finish() {
        if (!isRealDesktop()) { msg(m, "请在深鲸·律师端桌面端完成离线激活（本浏览器无法取得机器指纹）", "#e07070"); return; }
        // 机器指纹授权：校验授权码
        var r = realVerify(keyIn);
        if (!r.ok) { msg(m, "授权码无效：" + (r.msg || "请核对机器码/到期"), "#e07070"); return; }
        write(KEY.activate, { phone: ph, smsAt: Date.now(), machine: realMachine(), plan: "std", exp: r.exp || null, lic: keyIn.toUpperCase() });
        write(KEY.phoneCache, ph);
        msg(m, "已激活（手机号 + 机器绑定）" + (r.exp ? (" 至 " + r.exp) : "") + "。数据仅本地保存。", "#7ddb8a");
        m.querySelector("#lic-status").textContent = "当前：" + badgeText();
        updateBadgeText();
        ensureBadge();
      }
      // 服务端校验验证码（密钥/校验都在华为云服务器，App 不含密钥）
      if (typeof window.__verifySms === "function") {
        window.__verifySms({ phone: ph, code: code }).then(function (v) {
          if (!v || !v.valid) { msg(m, "验证码不正确，请核对", "#e07070"); return; }
          finish();
        }).catch(function () { msg(m, "短信校验服务异常，请重试", "#e07070"); });
        return;
      }
      // 无桥：本地回退校验
      if (String(code).slice(0, 6) !== String(_smsCache.code).slice(0, 6)) { msg(m, "验证码不正确，请核对", "#e07070"); return; }
      finish();
    });

    // A款(自备算力)保存 key —— 统一走 KeyMgr
    m.querySelector("#lic-savekey").addEventListener("click", function () {
      var k = m.querySelector("#lic-api").value.trim();
      if (!k) { apiMsg(m, "请填写 DeepSeek API Key"); return; }
      if (window.KeyMgr && window.KeyMgr.setKey) {
        window.KeyMgr.setKey("legal", k, "https://api.deepseek.com/v1", window.KeyMgr.DEFAULT_MODEL);
        apiMsg(m, "已保存(" + k.slice(0, 6) + "…)，A款自备算力已生效。深鲸AI 可在「设置→算力与 Key」配置联动或独立 Key。");
      } else {
        var cfg = read(KEY.llm, {});
        cfg.mode = "A"; cfg.apiKey = k; cfg.baseURL = "";
        write(KEY.llm, cfg);
        apiMsg(m, "已保存(" + k.slice(0, 6) + "…)。保存后工作台 AI 将走你自己的接口。");
      }
    });

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

    // 选择证明文件
    var pickedFile = null;
    m.querySelector("#lic-fpick").addEventListener("click", function () { m.querySelector("#lic-ffile").click(); });
    m.querySelector("#lic-ffile").addEventListener("change", function () {
      var f = this.files && this.files[0];
      if (!f) return;
      pickedFile = f;
      m.querySelector("#lic-fname2").textContent = "已选：" + f.name + "（" + (f.size / 1024).toFixed(1) + " KB）";
    });

    // 提交免费申请（本地保存申请 + 证明文件 base64，调用后台/本地审核存储）
    m.querySelector("#lic-fsubmit").addEventListener("click", function () {
      var name = m.querySelector("#lic-fname").value.trim();
      var type = "lawyer"; // 公益律师（法学生通道已删除）
      var no = m.querySelector("#lic-fno").value.trim();
      var org = m.querySelector("#lic-forg").value.trim();
      var firm = m.querySelector("#lic-ffirm").value.trim();
      var phone = m.querySelector("#lic-fphone").value.trim();
      if (!name || !no || !org || !firm) { freeStatusMsg(m, "请填写完整：姓名/证号/单位/证明人签署单位", "#e07070"); return; }
      if (!/^1\d{10}$/.test(phone)) { freeStatusMsg(m, "请填写11位手机号", "#e07070"); return; }
      if (!pickedFile) { freeStatusMsg(m, "请上传证明人/单位签署的证明文件", "#e07070"); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var app = {
          status: "pending",
          name: name, type: type, no: no, org: org, firm: firm,
          phone: phone, machine: isRealDesktop() ? realMachine() : "",
          file: { name: pickedFile.name, data: reader.result }, // data: base64 dataURL
          at: Date.now(),
        };
        write(KEY.freeApply, app);
        // 若桌面端有免费申请持久化桥，交给 main 持久化到本地审核库
        if (window.__freeSubmit && typeof window.__freeSubmit === "function") {
          window.__freeSubmit(app).then(function (r) {
            freeStatusMsg(m, r && r.ok ? "已提交，等待审核（已存入本地审核库）" : ("提交失败：" + (r && r.msg || "")), "#7ddb8a");
          }).catch(function () {
            freeStatusMsg(m, "已提交（本地保存），等待审核", "#7ddb8a");
          });
        } else {
          freeStatusMsg(m, "已提交，等待审核（证明文件已存本机）", "#7ddb8a");
        }
        m.querySelector("#lic-fstatus").textContent = "已提交，等待审核：" + name;
      };
      reader.readAsDataURL(pickedFile);
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
