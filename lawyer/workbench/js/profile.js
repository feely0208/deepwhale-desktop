/* =========================================================================
   profile.js — 第1条补充项（简化）：头像可换成自己喜欢的图
   默认显示律师姓名首字（姓）；用户可自行上传图片替换。
   特效（沉浸光感/动效）统一由 css/components.css + css/workbench.css 提供，
   对应 HMOS 代码工坊的「沉浸光感 / 组件动效」，web 侧以 CSS 等效实现。
   ========================================================================= */
(function () {
  const KEY = "legal-mode.profile";

  // 氛围强调色（联动按钮/进度条/统计卡的沉浸光感）
  const ACCENTS = [
    { id: "blue", accent: "#4f8cff", accent2: "#7aa8ff" },
    { id: "violet", accent: "#7b5bff", accent2: "#a98cff" },
    { id: "teal", accent: "#12b5a5", accent2: "#4fd9c9" },
    { id: "amber", accent: "#f59e0b", accent2: "#fbbf24" },
    { id: "rose", accent: "#f43f8e", accent2: "#fb7bb0" },
  ];

  const DEFAULTS = { name: "张冬宝", title: "主任律师", avatar: null, accent: "blue" };

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (e) {}
    return Object.assign({}, DEFAULTS);
  }
  function save() { localStorage.setItem(KEY, JSON.stringify(state)); }

  function accentObj() {
    return ACCENTS.find(function (x) { return x.id === state.accent; }) || ACCENTS[0];
  }
  function initials() {
    return (state.name || "律").trim().charAt(0) || "律";
  }
  function avatarImg() { return state.avatar; } // dataURL 或 null

  // 顶栏 / 各处头像统一渲染
  function renderTopbar() {
    const el = document.getElementById("topAvatar");
    if (!el) return;
    // 用绝对定位让图片 100% 铺满圆形容器，绕开 grid/布局影响，确保正圆
    el.style.position = "relative";
    el.style.overflow = "hidden";
    el.style.borderRadius = "50%";
    el.style.padding = "0";
    if (state.avatar) {
      el.style.background = "transparent";
      el.innerHTML = "<img src='" + state.avatar + "' alt='' style='position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%;display:block'>";
    } else {
      el.style.background = "linear-gradient(135deg," + accentObj().accent + "," + accentObj().accent2 + ")";
      el.innerHTML = "<span style='position:absolute;inset:0;display:flex;align-items:center;justify-content:center'>" + initials() + "</span>";
    }
  }

  function applyAccent() {
    const a = accentObj();
    const r = document.documentElement.style;
    r.setProperty("--accent", a.accent);
    r.setProperty("--accent-2", a.accent2);
  }

  // —— 个人化面板 ——
  let modal;
  function openPanel() {
    const img = avatarImg();
    const swatches = ACCENTS.map(function (a) {
      const cur = state.accent === a.id;
      return "<div class='swatch" + (cur ? " active" : "") + "' style='background:" + a.accent +
        "' data-accent='" + a.id + "'></div>";
    }).join("");

    modal = document.createElement("div");
    modal.className = "modal-overlay show";
    modal.innerHTML =
      "<div class='modal pro-panel glow'>" +
      "<h3>个人化</h3>" +

      "<div class='pro-section'>" +
      "<div class='pro-label'>头像</div>" +
      "<div style='display:flex;align-items:center;gap:16px'>" +
      "<div class='avatar-lg' id='pAvatarPreview'>" +
        (img ? "<img src='" + img + "' alt=''>" : initials()) +
      "</div>" +
      "<div style='display:flex;flex-direction:column;gap:10px'>" +
        "<label class='btn btn-ghost btn-sm' style='cursor:pointer'> 上传喜欢的新头像<input type='file' id='avatarUpload' accept='image/*' style='display:none'></label>" +
        "<button class='btn btn-ghost btn-sm' id='avatarReset'>恢复为姓氏</button>" +
        "<span style='font-size:12px;color:var(--text-dim)'>不选则显示姓氏首字</span>" +
      "</div></div></div>" +

      "<div class='pro-section'>" +
      "<div class='pro-label'>称呼</div>" +
      "<div class='form-row'>" +
        "<div class='form-group'><label>姓名</label><input id='pName' value='" + state.name + "'></div>" +
        "<div class='form-group'><label>头衔</label><input id='pTitle' value='" + state.title + "'></div>" +
      "</div></div>" +

      "<div class='pro-section'>" +
      "<div class='pro-label'>氛围强调色（沉浸光感）</div>" +
      "<div class='swatch-row'>" + swatches + "</div></div>" +

      "<div class='pro-foot'>" +
        "<button class='btn btn-ghost' data-close>取消</button>" +
        "<button class='btn btn-primary' data-save>保存</button>" +
      "</div></div>";

    document.body.appendChild(modal);

    modal.querySelectorAll("[data-accent]").forEach(function (el) {
      el.addEventListener("click", function () {
        state.accent = el.getAttribute("data-accent");
        selectIn(modal, "[data-accent]", "data-accent", state.accent);
        applyAccent();
        renderTopbar();
        // 预览色随头像背景
        var prev = modal.querySelector("#pAvatarPreview");
        if (prev) { prev.style.background = "linear-gradient(135deg," + accentObj().accent + "," + accentObj().accent2 + ")"; }
      });
    });
    modal.querySelector("#avatarUpload").addEventListener("change", function () {
      const file = this.files && this.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function (e) { setUploaded(e.target.result); };
      reader.readAsDataURL(file);
    });
    modal.querySelector("#avatarReset").addEventListener("click", function () {
      state.avatar = null;
      renderTopbar();
      updatePreview();
    });
    modal.querySelector("[data-close]").addEventListener("click", function () { close(); });
    modal.querySelector("[data-save]").addEventListener("click", function () {
      state.name = modal.querySelector("#pName").value.trim() || state.name;
      state.title = modal.querySelector("#pTitle").value.trim() || state.title;
      save();
      applyAccent();
      renderTopbar();
      close();
    });
    modal.addEventListener("click", function (e) { if (e.target === modal) close(); });
  }

  function updatePreview() {
    const prev = modal && modal.querySelector("#pAvatarPreview");
    if (!prev) return;
    if (state.avatar) {
      prev.style.background = "transparent";
      prev.innerHTML = "<img src='" + state.avatar + "' alt=''>";
    } else {
      prev.style.background = "linear-gradient(135deg," + accentObj().accent + "," + accentObj().accent2 + ")";
      prev.innerHTML = initials();
    }
  }

  // 上传后打开"头像裁剪编辑器"（cropperjs）：移动 + 滚轮缩放；保存/取消按钮置顶保证可点
  function setUploaded(dataUrl) {
    const OUT = 128;
    const oe = document.createElement("div");
    oe.className = "modal-overlay show";
    oe.style.zIndex = "2147483646";
    // 保存/取消放到独立高 z-index 区，避免被 cropper 容器盖住导致点不到
    oe.innerHTML =
      "<div class='modal glow' style='width:440px;position:relative'>" +
      "<div class='card-head'><h3> 调整头像（拖动定位 · 滚轮缩放）</h3></div>" +
      "<div style='text-align:center'><img id='cr-img' src='" + dataUrl + "' style='display:block;max-width:100%;max-height:320px'></div>" +
      "<div class='modal-actions' style='position:relative;z-index:9999'>" +
      "<button class='btn btn-primary' data-crop-ok>保存</button>" +
      "<button class='btn btn-ghost' data-crop-cancel>取消</button></div>" +
      "</div>";
    document.body.appendChild(oe);
    const img = oe.querySelector("#cr-img");
    const cropper = new Cropper(img, {
      aspectRatio: 1, viewMode: 3, dragMode: "move", autoCropArea: 1,
      cropBoxMovable: true, cropBoxResizable: true, toggleDragModeOnDblclick: false,
    });

    oe.querySelector("[data-crop-ok]").addEventListener("click", function () {
      try {
        const data = cropper.getCroppedCanvas({ width: OUT, height: OUT, minWidth: 32, minHeight: 32 });
        const c = document.createElement("canvas");
        c.width = OUT; c.height = OUT;
        const ctx = c.getContext("2d");
        ctx.beginPath(); ctx.arc(OUT / 2, OUT / 2, OUT / 2, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(data, 0, 0, OUT, OUT);
        state.avatar = c.toDataURL("image/png");
        save(); renderTopbar(); updatePreview(); oe.remove();
      } catch (e) { if (window.toast) window.toast("保存头像失败：" + e.message, "error"); }
    });
    oe.querySelector("[data-crop-cancel]").addEventListener("click", function () { cropper.destroy(); oe.remove(); });
  }

  function selectIn(root, selector, attr, val) {
    root.querySelectorAll(selector).forEach(function (el) {
      el.classList.toggle("active", el.getAttribute(attr) === String(val));
    });
  }
  function close() { if (modal) { modal.remove(); modal = null; } }

  function init() {
    applyAccent();
    renderTopbar();
    const av = document.getElementById("topAvatar");
    if (av) av.addEventListener("click", openPanel);
  }

  window.Profile = {
    init: init,
    get: function () { return state; },
    open: openPanel,
    applyAccent: applyAccent,
    renderTopbar: renderTopbar,
    setName: function (name) { state.name = name || state.name; save(); renderTopbar(); },
    setTitle: function (title) { state.title = title || state.title; save(); },
  };

  document.addEventListener("DOMContentLoaded", init);
})();
