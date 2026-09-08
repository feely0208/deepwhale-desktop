/* =========================================================================
   theme.js — 主题引擎（跟随系统 / 浅色 / 深色），对齐 DSH 原生观感
   ========================================================================= */
(function () {
  const KEY = "legal-mode.theme"; // system | light | dark
  const mq = window.matchMedia("(prefers-color-scheme: dark)");

  function apply(mode) {
    const resolved = mode === "system" ? (mq.matches ? "dark" : "light") : mode;
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.style.colorScheme = resolved;
    return resolved;
  }

  let current = localStorage.getItem(KEY) || "system";
  apply(current);

  // 跟随系统时，系统主题变化自动同步
  mq.addEventListener("change", function () {
    if (current === "system") apply("system");
  });

  function set(mode) {
    current = mode;
    localStorage.setItem(KEY, mode);
    const resolved = apply(mode);
    // 通知界面刷新选中态
    document.dispatchEvent(new CustomEvent("theme:change", { detail: { mode, resolved } }));
    return resolved;
  }

  window.Theme = {
    get: function () { return current; },
    set: set,
    cycle: function () {
      const order = ["system", "light", "dark"];
      set(order[(order.indexOf(current) + 1) % order.length]);
    },
  };
})();
