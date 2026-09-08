/* =========================================================================
   data-import.js — 通用数据导入向导（Excel/CSV → 列头映射 → 写入工作台）
   -------------------------------------------------------------------------
   支持模块：cases(案件) / clients(客户) / contracts(合同)
   流程：选文件 → 主进程 xlsx 解析 → 列头映射(自动匹配+可调) → 预览 → 导入
   - 文件解析：window.__parseImportFile(file) -> {ok, sheets:[{name,rows}]}
   - 列头映射：把表格首行(表头)映射到模块字段；常见表头名自动匹配。
   - 写入：按模块 key 存入 localStorage(legal-mode.cases/clients/contracts)。
   ========================================================================= */
(function () {
  // —— 三个模块的字段定义 + 常见列头别名（自动匹配用） ——
  var MODULES = {
    cases: {
      label: "案件",
      storageKey: "legal-mode.cases",
      fields: [
        { key: "no",      label: "案号",       aliases: ["案号", "案件编号", "编号", "立案号", "案件号"] },
        { key: "title",   label: "案件标题",   aliases: ["案件标题", "案件名称", "名称", "案由", "案件"] },
        { key: "type",    label: "案件类型",   aliases: ["案件类型", "类型", "性质"] },
        { key: "party",   label: "当事人",     aliases: ["当事人", "原告", "被告", "委托人", "客户"] },
        { key: "court",   label: "审理法院",   aliases: ["审理法院", "法院", "受理法院", "管辖法院", "审判法院"] },
        { key: "status",  label: "案件状态",   aliases: ["案件状态", "状态", "进展", "阶段"] },
        { key: "priority",label: "优先级",     aliases: ["优先级", "紧急程度", "级别"] },
        { key: "lawyer",  label: "承办律师",   aliases: ["承办律师", "律师", "主办律师", "负责人"] },
        { key: "date",    label: "立案日期",   aliases: ["立案日期", "立案时间", "日期", "收案日期", "受理日期"] },
        { key: "progress",label: "进度%",      aliases: ["进度", "完成度", "进度%"] },
      ],
    },
    clients: {
      label: "客户",
      storageKey: "legal-mode.clients",
      fields: [
        { key: "name",    label: "姓名/名称",  aliases: ["姓名", "名称", "客户名", "客户名称", "当事人", "委托人"] },
        { key: "type",    label: "客户类型",   aliases: ["类型", "客户类型", "性质"] },
        { key: "phone",   label: "电话",       aliases: ["电话", "手机", "手机号", "联系电话", "联系方式"] },
        { key: "idCard",  label: "证件号",     aliases: ["证件号", "身份证号", "证号", "执照号"] },
        { key: "address", label: "地址",       aliases: ["地址", "住所", "通讯地址"] },
        { key: "email",   label: "邮箱",       aliases: ["邮箱", "电子邮箱", "email", "Email"] },
        { key: "notes",   label: "备注",       aliases: ["备注", "说明", "备注信息"] },
      ],
    },
    contracts: {
      label: "合同",
      storageKey: "legal-mode.contracts",
      fields: [
        { key: "no",      label: "合同编号",   aliases: ["合同编号", "编号", "合同号", "no"] },
        { key: "name",    label: "合同名称",   aliases: ["合同名称", "名称", "合同名"] },
        { key: "type",    label: "合同类型",   aliases: ["类型", "合同类型"] },
        { key: "party",   label: "相对方",     aliases: ["相对方", "当事人", "对方", "客户", "甲方", "乙方"] },
        { key: "amount",  label: "金额",       aliases: ["金额", "合同金额", "费用", "标的额"] },
        { key: "status",  label: "合同状态",   aliases: ["状态", "合同状态", "履行状态"] },
        { key: "expiry",  label: "到期日",     aliases: ["到期日", "到期", "期限", "到期日期"] },
        { key: "caseTitle",label: "关联案件",  aliases: ["关联案件", "关联案件名", "案由"] },
      ],
    },
  };

  // 自动匹配：对于表头名，找到它的候选字段（按匹配度）
  function autoMap(header, fields) {
    var h = String(header || "").trim().toLowerCase().replace(/\s+/g, "");
    if (!h) return null;
    // 精确别名匹配
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.key.toLowerCase() === h) return f.key;
      for (var j = 0; j < f.aliases.length; j++) {
        if (String(f.aliases[j]).toLowerCase().replace(/\s+/g, "") === h) return f.key;
      }
    }
    // 包含匹配（如"当事人姓名"包含"当事人"）
    for (var i2 = 0; i2 < fields.length; i2++) {
      var f2 = fields[i2];
      for (var j2 = 0; j2 < f2.aliases.length; j2++) {
        var al = String(f2.aliases[j2]).toLowerCase().replace(/\s+/g, "");
        if (al && h.indexOf(al) >= 0) return f2.key;
      }
    }
    return null;
  }

  // 读取 localStorage 里的现有数据（数组）
  function readStore(key) {
    try { var v = localStorage.getItem(key); var a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }

  // 打开导入向导
  function openImportWizard(kind) {
    var M = MODULES[kind];
    if (!M) return;
    var m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML =
      '<div class="modal glow" style="width:760px;max-height:88vh;overflow:auto">' +
      '<div class="card-head"><h3> 导入' + M.label + '数据（Excel/CSV）</h3></div>' +
      '<div class="intl-note" style="margin-bottom:10px">支持 .xlsx / .csv / .xls。选择文件后，将逐列对应到" + M.label + "字段；常见表头会自动匹配，可手动调整。</div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">' +
      '<input id="imFile" type="file" accept=".xlsx,.xls,.csv" style="display:none">' +
      '<button class="btn btn-primary" id="imPick"> 选择文件</button>' +
      '<span id="imFileInfo" style="font-size:12px;color:#7aa8ff">未选择文件</span></div>' +
      '<div id="imBody" style="font-size:12px;color:#8ea3c2">请先选择 Excel/CSV 文件。</div>' +
      '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">' +
      '<button class="btn btn-primary" id="imConfirm" style="display:none"> 确认导入</button>' +
      '<button class="btn btn-ghost" data-close>关闭</button></div>' +
      '<div id="imMsg" style="margin-top:10px;font-size:12px;color:#7ddb8a"></div>' +
      '</div>';
    document.body.appendChild(m);
    var close = function () { m.remove(); };
    m.querySelector("[data-close]").addEventListener("click", close);
    m.addEventListener("click", function (e) { if (e.target === m) close(); });

    // 选择文件
    var fileInput = m.querySelector("#imFile");
    m.querySelector("#imPick").addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", async function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      m.querySelector("#imFileInfo").textContent = "解析中：" + f.name + "…";
      if (!window.__parseImportFile) { m.querySelector("#imBody").innerHTML = "解析引擎未就绪（桌面端）。请在深鲸·律师端桌面端使用导入。"; return; }
      var r = await window.__parseImportFile(f);
      if (!r || !r.ok) { m.querySelector("#imBody").innerHTML = "解析失败：" + ((r && r.msg) || "未知错误"); return; }
      m.querySelector("#imFileInfo").textContent = "已解析：" + f.name + "（" + r.sheets.length + " 个表）";
      renderMapping(m, M, r.sheets[0] ? r.sheets[0].rows : []);
    });

    function renderMapping(mm, mod, rows) {
      // rows[0] 是表头行；rows[1..] 是数据
      if (!rows || rows.length < 1) { mm.querySelector("#imBody").innerHTML = "文件为空或没有表头。"; return; }
      var header = (rows[0] || []).map(function (c) { return (c == null ? "" : String(c)); });
      var dataRows = rows.slice(1).filter(function (r) { return r && r.some(function (c) { return c != null && c !== ""; }); });
      var body = mm.querySelector("#imBody");
      // 列头映射选择器
      var fieldsHtml = mod.fields.map(function (f) { return "<option value='" + f.key + "'>" + f.label + "</option>"; }).join("");
      var headerHtml = header.map(function (h, i) {
        var auto = autoMap(h, mod.fields);
        return "<div style='display:flex;gap:6px;align-items:center;padding:3px 0'><span style='width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' title='" + esc(h) + "'>" + esc(h || "(空列)") + "</span>" +
          "<select data-col='" + i + "' style='width:160px;padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.18);background:#12151c;color:#eef2f8'><option value=''>不导入</option>" + fieldsHtml + "</select></div>";
      }).join("");
      body.innerHTML =
        "<div style='margin-bottom:8px'><b>列头映射（第 1 行表头 → 字段）</b>：</div>" +
        "<div style='max-height:220px;overflow:auto;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px'>" + headerHtml + "</div>" +
        "<div style='margin-top:10px;font-size:12px;color:#8ea3c2'>数据行：<b id='imRowCount'></b> 条。已自动匹配的列如上，可手动调整。</div>" +
        "<div style='margin-top:10px;max-height:180px;overflow:auto'>" + previewTable(header, dataRows.slice(0, 6)) + "</div>";
      // 应用自动匹配默认值
      body.querySelectorAll("[data-col]").forEach(function (sel) {
        var i = parseInt(sel.getAttribute("data-col"), 10);
        var auto = autoMap(header[i], mod.fields);
        if (auto) sel.value = auto;
      });
      mm.querySelector("#imRowCount").textContent = dataRows.length;
      mm.querySelector("#imConfirm").style.display = "";
      mm.querySelector("#imConfirm").onclick = function () {
        var map = {};
        body.querySelectorAll("[data-col]").forEach(function (sel) {
          var i = parseInt(sel.getAttribute("data-col"), 10);
          if (sel.value) map[sel.value] = i; // 字段key -> 列索引
        });
        var imported = dataRows.map(function (row) {
          var obj = {};
          Object.keys(map).forEach(function (fkey) {
            var v = row[map[fkey]];
            obj[fkey] = (v == null ? "" : String(v)).trim();
          });
          // 日期字段：Excel 序列号转 YYYY-MM-DD；MMDD/时间戳归一
          obj.date = normDate(obj.date);
          obj.expiry = normDate(obj.expiry);
          return obj;
        }).filter(function (o) { return Object.keys(o).some(function (k) { return o[k] !== ""; }); });
        if (!imported.length) { mm.querySelector("#imMsg").textContent = "没有可导入的数据行。"; return; }
        // 写入存储：cases/clients = 覆盖为新数组（保留已有？这里合并），contracts 合并
        var store = readStore(mod.storageKey);
        var merged = store.concat(imported);
        try { localStorage.setItem(mod.storageKey, JSON.stringify(merged)); } catch (e) {}
        mm.querySelector("#imMsg").textContent = "已导入 " + imported.length + " 条" + M.label + "数据（共 " + merged.length + " 条）。刷新后可见。";
        // 通知工作台刷新
        if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已导入 " + imported.length + " 条" + M.label, "success");
        try { if (window.DispatchEvent) { window.dispatchEvent(new Event("data-imported")); } } catch (e) {}
      };
    }
  }

  function esc(s) { return String(s == null ? "" : s).replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  // Excel 序列号(1900系统)转 YYYY-MM-DD；已是字符串日期原样返回；空/无效返回空
  function normDate(v) {
    if (v == null || v === "") return "";
    var s = String(v).trim();
    // 纯数字 → Excel 序列号
    if (/^\d+(\.\d+)?$/.test(s)) {
      var n = parseFloat(s);
      if (n > 20000 && n < 60000) { // Excel 日期序列号范围
        var d = new Date(Math.round((n - 25569) * 86400 * 1000));
        if (!isNaN(d.getTime())) {
          return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
        }
      }
      return s;
    }
    // 形如 2026-08-01 / 2026/08/01
    var mm = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (mm) return mm[1] + "-" + String(mm[2]).padStart(2, "0") + "-" + String(mm[3]).padStart(2, "0");
    return s;
  }

  function previewTable(header, rows) {
    var th = header.map(function (h) { return "<th style='padding:4px 8px;text-align:left;font-size:11px'>" + esc(h || "") + "</th>"; }).join("");
    var tr = rows.map(function (r) {
      return "<tr>" + header.map(function (_, i) { return "<td style='padding:4px 8px;font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" + esc(r[i] == null ? "" : r[i]) + "</td>"; }).join("") + "</tr>";
    }).join("");
    return "<table class='table' style='font-size:11px'><thead><tr>" + th + "</tr></thead><tbody>" + tr + "</tbody></table>";
  }

  window.DataImport = {
    open: openImportWizard,
    MODULES: MODULES,
    autoMap: autoMap,
    readStore: readStore,
  };
})();
