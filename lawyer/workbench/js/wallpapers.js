/* =========================================================================
   wallpapers.js — 壁纸引擎（图片 / 视频 / GIF），支持内置精选 + 本地文件选择
   ========================================================================= */
(function () {
  // 内置精选壁纸（相对路径）。type: image | video。.gif 归入 image（浏览器自动播放）。
  const LIBRARY = [
    { name: "法律·藏青", src: "assets/wallpapers/legal-navy.jpg", type: "image", subtype: "brand" },
    { name: "极光", src: "assets/wallpapers/aurora.jpg", type: "image" },
    { name: "晚霞", src: "assets/wallpapers/sunset.jpg", type: "image" },
    { name: "晨雾", src: "assets/wallpapers/mist.jpg", type: "image" },
    { name: "星云", src: "assets/wallpapers/nebula.jpg", type: "image" },
    { name: "流光动态", src: "assets/wallpapers/aurora_small.gif", type: "image", subtype: "gif" },
    { name: "极光视频", src: "assets/wallpapers/aurora.mp4", type: "video" },
  ];

  const el = {
    layer: null,      // #wallpaper
    tint: null,       // 主题着色层
    dim: null,        // 可读性遮罩层
    thumbs: null,     // 壁纸缩略图容器
  };

  let current = null;

  function detectType(fileOrSrc) {
    const s = (fileOrSrc && fileOrSrc.name) ? fileOrSrc.name : String(fileOrSrc);
    const ext = (s.split(".").pop() || "").toLowerCase();
    const mime = fileOrSrc && fileOrSrc.type;
    if (mime) {
      if (mime.indexOf("video/") === 0) return "video";
      if (mime.indexOf("image/") === 0) return "image";
    }
    if (["mp4", "webm", "mov", "m4v", "ogg"].indexOf(ext) >= 0) return "video";
    return "image";
  }

  function clearLayers() {
    el.layer.innerHTML = "";
  }

  function setWallpaper(src, type, name, isLocal) {
    clearLayers();
    const target = document.createElement(type === "video" ? "video" : "img");
    if (type === "video") {
      target.src = src;
      target.autoplay = true;
      target.loop = true;
      target.muted = true;
      target.playsInline = true;
    } else {
      target.src = src;
      target.alt = name || "";
    }
    el.layer.appendChild(target);
    current = { src, type, name };

    // 视频/动图壁纸控制
    if (type === "video") {
      const v = target;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    }
    document.dispatchEvent(new CustomEvent("wallpaper:change", { detail: current }));
  }

  function buildThumbs(grid, onPick) {
    grid.innerHTML = "";
    LIBRARY.forEach(function (wp, i) {
      const t = document.createElement("div");
      t.className = "wp-thumb glow" + (current && current.src === wp.src ? " active" : "");
      t.setAttribute("data-type", wp.type);
      t.innerHTML =
        (wp.type === "video"
          ? '<video src="' + wp.src + '" muted loop autoplay playsinline></video>'
          : '<img src="' + wp.src + '" alt="">') +
        '<span class="wp-type-badge">' + (wp.type === "video" ? "视频" : (wp.subtype === "gif" ? "GIF" : "图片")) + "</span>" +
        '<span class="wp-name">' + wp.name + "</span>";
      t.addEventListener("click", function () {
        setWallpaper(wp.src, wp.type, wp.name, false);
        buildThumbs(grid, onPick);
      });
      grid.appendChild(t);
    });
  }

  function init() {
    el.layer = document.getElementById("wallpaper");
    el.tint = document.getElementById("wallpaper-tint");
    el.dim = document.getElementById("wallpaper-dim");
    // 默认壁纸
    setWallpaper(LIBRARY[3].src, "image", LIBRARY[3].name, false);
  }

  // 本地文件选择：支持图片 / GIF / 视频
  function pickFromFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const type = detectType(file);
    const url = URL.createObjectURL(file);
    setWallpaper(url, type, file.name, true);
  }

  window.Wallpapers = {
    LIBRARY: LIBRARY,
    init: init,
    set: setWallpaper,
    buildThumbs: buildThumbs,
    pickFromFile: pickFromFile,
    get current() { return current; },
  };
})();
