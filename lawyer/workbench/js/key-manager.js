/* =========================================================================
   key-manager.js — 算力与 Key 管理（深鲸·律师端）
   -------------------------------------------------------------------------
   - A款 = 一律自备算力（用户自填 DeepSeek key，不外发，不提供集团算力）。
   - 每个端可配独立 key，可切换；也要支持"共用一把 key"。
   - 端：legal(工作台 AI) / dsh(深鲸 AI 中枢)。分别可配 key，或 [联动] 共用。
   - key 仅存本机 localStorage。
   ========================================================================= */
(function () {
  // config 结构: { legal:{apiKey,baseURL,model}, dsh:{apiKey,baseURL,model}, link:boolean }
  // link=true 表示 legal 与 dsh 共用一把 key（取 legal 的）。
  var KEY = "legal-mode.llm";
  var DEFAULT_MODEL = "deepseek-v4-flash";

  function read() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || "{}"); return (v && typeof v === "object") ? v : {}; } catch (e) { return {}; }
  }
  function write(cfg) { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {} }

  function cfgOf(end) {
    var c = read();
    if (end === "dsh") {
      // 联动：深鲸端共用 legal 的 key
      if (c.link && c.legal && c.legal.apiKey) return c.legal;
      return c.dsh || {};
    }
    return c.legal || {};
  }

  // 读取某端生效的 key（供 ai.js 调用）
  function getKey(end) {
    var c = read();
    // dsh 联动时用 legal
    var src = (end === "dsh" && c.link) ? c.legal : (c[end] || {});
    return src && src.apiKey ? src.apiKey : "";
  }
  function getBase(end) {
    var c = read();
    var src = (end === "dsh" && c.link) ? c.legal : (c[end] || {});
    return (src && src.baseURL) || "https://api.deepseek.com/v1";
  }
  function getModel(end) {
    var c = read();
    var src = (end === "dsh" && c.link) ? c.legal : (c[end] || {});
    return (src && src.model) || DEFAULT_MODEL;
  }
  function isLinked() { var c = read(); return !!c.link; }

  // 设置某端 key
  function setKey(end, apiKey, baseURL, model) {
    var c = read();
    c[end] = { apiKey: apiKey, baseURL: baseURL || "https://api.deepseek.com/v1", model: model || DEFAULT_MODEL };
    write(c);
  }
  // 设置联动开关
  function setLink(on) {
    var c = read();
    c.link = !!on;
    // 联动时：深鲸端若无独立 key，也同步一份到 dsh（便于查看）
    if (on && c.legal && c.legal.apiKey && (!c.dsh || !c.dsh.apiKey)) { c.dsh = Object.assign({}, c.legal); }
    write(c);
  }

  // 返回当前完整状态（供界面显示）
  function status() {
    var c = read();
    return {
      legal: c.legal || {},
      dsh: c.dsh || {},
      link: !!c.link,
      effectiveDsh: cfgOf("dsh"),
    };
  }

  function toCheck() {
    // 供 ai.js 读取（简化，保留旧字段兼容）
    var legal = cfgOf("legal");
    return { mode: "A", apiKey: legal.apiKey || "", baseURL: legal.baseURL || "https://api.deepseek.com/v1" };
  }

  // ——「算力与 Key」管理弹窗 ——
  function openUI() {
    var m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML =
      "<div class='modal glow' style='width:720px;max-height:88vh;overflow:auto'>" +
      "<div class='card-head'><h3> 算力与 Key（A款 · 自备算力）</h3></div>" +
      "<div style='font-size:12px;color:#8ea3c2;margin-bottom:12px'>A款 = 一律自备 DeepSeek API Key（不提供集团算力）。你可以<b>分别</b>为「法律工作台」和「深鲸AI」配置各自的 Key，或<b>联动共用</b>一把以统计用量。Key 仅保存在本机。</div>" +
      "<div style='display:flex;align-items:center;gap:8px;margin-bottom:12px'>" +
      "<label style='font-size:13px;color:#cfe6ea'><input type='checkbox' id='km-link' style='margin-right:6px'>联动共用：深鲸AI 使用法律工作台的同一把 Key</label>" +
      "</div>" +
      kmField("legal", "法律工作台 AI Key（sk-…）") +
      "<div style='height:14px'></div>" +
      kmField("dsh", "深鲸AI 中枢 Key（sk-…）") +
      "<div class='modal-actions'><button class='btn btn-primary' id='km-save'>保存</button><button class='btn btn-ghost' data-close>关闭</button></div>" +
      "<div id='km-msg' style='margin-top:10px;font-size:12px;color:#7ddb8a'></div>" +
      "</div>";
    document.body.appendChild(m);
    var st = status();
    var link = m.querySelector("#km-link");
    link.checked = st.link;
    m.querySelector("#km-legal-key").value = (st.legal && st.legal.apiKey) || "";
    m.querySelector("#km-dsh-key").value = (st.dsh && st.dsh.apiKey) || "";
    function refill() {
      // 联动时：深鲸key禁用/隐藏，用法律key
      var dkey = m.querySelector("#km-dsh-key");
      if (link.checked) { dkey.value = m.querySelector("#km-legal-key").value || dkey.value; dkey.disabled = true; }
      else dkey.disabled = false;
    }
    refill();
    link.addEventListener("change", refill);
    m.querySelector("#km-legal-key").addEventListener("input", function () { if (link.checked) m.querySelector("#km-dsh-key").value = this.value; });

    m.querySelector("[data-close]").addEventListener("click", function () { m.remove(); });
    m.addEventListener("click", function (e) { if (e.target === m) m.remove(); });
    m.querySelector("#km-save").addEventListener("click", function () {
      var legalKey = m.querySelector("#km-legal-key").value.trim();
      var dshKey = m.querySelector("#km-dsh-key").value.trim();
      if (!legalKey) { m.querySelector("#km-msg").textContent = "请填写法律工作台 DeepSeek API Key（A款必填）"; m.querySelector("#km-msg").style.color = "#e07070"; return; }
      setKey("legal", legalKey, "https://api.deepseek.com/v1", DEFAULT_MODEL);
      setKey("dsh", (link.checked ? legalKey : (dshKey || legalKey)), "https://api.deepseek.com/v1", DEFAULT_MODEL);
      setLink(link.checked);
      m.querySelector("#km-msg").textContent = "已保存。" + (link.checked ? "（深鲸AI 联动共用法律工作台 Key）" : "（法律工作台 与 深鲸AI 各自独立 Key）");
      m.querySelector("#km-msg").style.color = "#7ddb8a";
    });
  }

  function kmField(end, label) {
    var val = (end === "legal") ? (status().legal && status().legal.apiKey) || "" : (status().dsh && status().dsh.apiKey) || "";
    return "<div class='form-group'><label>" + label + "</label>" +
      "<input id='km-" + end + "-key' placeholder='sk-…（DeepSeek API Key，仅存本机）' type='password' autocomplete='off' value='" + val + "' style='width:100%;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'></div>";
  }

  window.KeyMgr = {
    getKey: getKey, getBase: getBase, getModel: getModel, isLinked: isLinked,
    setKey: setKey, setLink: setLink, status: status, read: read, write: write, toCheck: toCheck,
    open: openUI, DEFAULT_MODEL: DEFAULT_MODEL,
  };

  // 把旧格式(legal-mode.llm={mode,apiKey,baseURL})迁移到新结构 legal:{...}+link
  (function migrate() {
    var c = read();
    // 旧格式：有顶层 apiKey 且无 c.legal
    if (!c.end && c.apiKey && !c.legal) {
      c.legal = { apiKey: c.apiKey, baseURL: c.baseURL || "https://api.deepseek.com/v1", model: c.model || DEFAULT_MODEL };
      delete c.mode; delete c.apiKey; delete c.baseURL; delete c.model;
      c.link = false; write(c);
    } else if (c.mode && !c.legal) {
      c.legal = { apiKey: c.apiKey || "", baseURL: c.baseURL || "https://api.deepseek.com/v1", model: c.model || DEFAULT_MODEL };
      delete c.mode; delete c.apiKey; delete c.baseURL; delete c.model; write(c);
    }
  })();
})();
