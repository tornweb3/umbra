/*! Umbra embed v1. Optional: the link works without it.
 *
 * Turns an Umbra payment link into a popup so the visitor keeps your page
 * open behind it, and does nothing else. No network calls, no cookies, no
 * storage, nothing touched outside the anchors it was pointed at.
 *
 * It is not an iframe on purpose. The payment page shows an address the
 * visitor is about to send irreversible money to, and inside a frame they
 * cannot see which origin produced it, which removes the one check they can
 * actually perform. It also means this gateway being down renders as a broken
 * hole in someone else's page rather than an ordinary link.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script) return;
  var origin;
  try {
    origin = new URL(script.src).origin;
  } catch (e) {
    return;
  }
  var prefix = origin + "/p/";

  function open(event) {
    // Let the browser do its usual thing for modified clicks.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    var href = this.href;
    if (href.lastIndexOf(prefix, 0) !== 0) return;
    var popup = window.open(href, "umbra-pay", "width=440,height=760,noopener");
    // Blocked, or blocked silently: fall through to normal navigation.
    if (popup) event.preventDefault();
  }

  function attach() {
    var links = document.querySelectorAll('a[href^="' + prefix + '"]');
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute("data-umbra-bound")) continue;
      links[i].setAttribute("data-umbra-bound", "1");
      links[i].addEventListener("click", open);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
})();
