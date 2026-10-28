/* Tab strip: shows the panel of the selected tab and hides the others. Panels are the elements named by aria-controls. */
(function () {
  "use strict";
  var nav = document.getElementById("mainTabs");
  if (!nav) return;
  var btns = Array.prototype.slice.call(nav.querySelectorAll('[role="tab"]'));
  function panel(b) { return document.getElementById(b.getAttribute("aria-controls")); }
  function show(btn) {
    btns.forEach(function (b) {
      var on = b === btn, p = panel(b);
      if (p) p.hidden = !on;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    window.scrollTo(0, 0);
  }
  btns.forEach(function (b, i) {
    b.addEventListener("click", function () { show(b); });
    b.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      var n = btns[(i + (e.key === "ArrowRight" ? 1 : btns.length - 1)) % btns.length];
      show(n); n.focus();
    });
  });
})();
