/* UI polish only (no app logic): app-bar elevation on scroll, hides the floating nav while the keyboard is open. */
(function () {
  "use strict";
  var root = document.documentElement;

  /* app bar gets a surface once content scrolls under it */
  var bar = document.querySelector(".bar");
  var scrolled = false, raf = 0;
  function onScroll() {
    raf = 0; var on = (window.scrollY || document.documentElement.scrollTop) > 6;
    if (bar && on !== scrolled) { scrolled = on; bar.classList.toggle("scrolled", on); }
  }
  window.addEventListener("scroll", function () { if (!raf) raf = requestAnimationFrame(onScroll); }, { passive: true }); onScroll();

  /* soft keyboard: the visual viewport shrinks a lot -> hide the floating navigation bar */
  var vv = window.visualViewport;
  if (vv) {
    var full = window.innerHeight;
    function kb() {
      if (window.innerHeight > full) full = window.innerHeight;
      var open = full - vv.height > 150 && /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "");
      root.classList.toggle("kb", open);
    }
    vv.addEventListener("resize", kb); document.addEventListener("focusout", function () { setTimeout(kb, 120); });
  }
})();
