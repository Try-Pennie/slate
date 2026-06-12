/**
 * Slate embed SDK — a drop-in replacement for the cal.com embed (`embed.js`).
 *
 * It implements the same `Cal()` API surface the cal embed snippet expects, so
 * an existing cal integration swaps to Slate by changing only (1) the script
 * src to this file and (2) the `origin` passed to Cal("init", …). Supported:
 *
 *   Cal("init", "<namespace>", { origin });   // per-namespace origin
 *   Cal.ns["<ns>"]("ui", { ... });             // accepted (Slate styles itself)
 *   Cal.ns["<ns>"]("prerender", { ... });      // no-op (Slate is cache-first)
 *   Cal("on", { action: "bookingSuccessful", callback });
 *   window.Cal.config.forwardQueryParams = true;
 *   <button data-cal-link="router?form=…" data-cal-namespace="review"
 *           data-cal-config='{"layout":"month_view"}'>Book</button>
 *
 * Routing is by the `xbc` query param (the bucket code); the external record id
 * is read from `external_id`. `data-cal-link` clicks open a modal iframe at
 * `<origin>/book?…` carrying the link's own query plus, when
 * forwardQueryParams is set, the host page's query.
 */
(function () {
  "use strict";

  var prior = window.Cal;
  var priorNs = prior && prior.ns ? prior.ns : {};
  var queuedGlobal = prior && prior.q ? prior.q.slice() : [];

  var namespaces = {}; // ns -> { origin, ui }
  var listeners = {}; // action -> [callback]
  var activeIframe = null;
  var activeModalHide = null;

  function ensureNs(ns) {
    return (namespaces[ns] = namespaces[ns] || { origin: "", ui: {} });
  }

  function on(action, cb) {
    if (action && typeof cb === "function") {
      (listeners[action] = listeners[action] || []).push(cb);
    }
  }

  function emit(action, payload) {
    (listeners[action] || []).forEach(function (cb) {
      try {
        cb({ detail: { type: action, data: payload } });
      } catch {
        /* a subscriber throwing must not break delivery to others */
      }
    });
  }

  // Process one `Cal.ns[ns](...)` command: [method, ...args].
  function handleNsCommand(ns, args) {
    var method = args[0];
    var n = ensureNs(ns);
    if (method === "init") {
      var initOpts = args[2] || args[1] || {};
      if (initOpts && initOpts.origin) n.origin = initOpts.origin;
    } else if (method === "ui") {
      n.ui = args[1] || {};
    } else if (method === "on") {
      var o = args[1] || {};
      on(o.action, o.callback);
    }
    // "prerender" and anything else: accepted, no-op (kept API-compatible).
  }

  function registerNs(ns) {
    if (!realCal.ns[ns]) {
      realCal.ns[ns] = function () {
        handleNsCommand(ns, Array.prototype.slice.call(arguments));
      };
    }
    ensureNs(ns);
  }

  // Process one global `Cal(...)` command.
  function handleGlobalCommand(args) {
    var method = args[0];
    if (method === "init") {
      if (typeof args[1] === "string") {
        registerNs(args[1]);
        handleNsCommand(args[1], args);
      } else {
        var opts = args[1] || {};
        if (opts.origin) ensureNs("").origin = opts.origin;
      }
    } else if (method === "on") {
      var o = args[1] || {};
      on(o.action, o.callback);
    }
    // "initNamespace" and others: no-op.
  }

  function realCal() {
    handleGlobalCommand(Array.prototype.slice.call(arguments));
  }
  realCal.ns = {};
  realCal.config = (prior && prior.config) || {};
  realCal.loaded = true;

  // Drain everything the loader stub queued before this script loaded.
  Object.keys(priorNs).forEach(function (ns) {
    registerNs(ns);
    var q = priorNs[ns] && priorNs[ns].q ? priorNs[ns].q : [];
    q.forEach(function (args) {
      handleNsCommand(ns, args);
    });
  });
  queuedGlobal.forEach(handleGlobalCommand);

  window.Cal = realCal;

  // --- link → Slate booking URL --------------------------------------------

  function originFor(ns) {
    var n = namespaces[ns] || namespaces[""] || {};
    return (n.origin || window.location.origin).replace(/\/$/, "");
  }

  function bookingUrl(link, ns) {
    var params = new URLSearchParams();
    var q = link.indexOf("?");
    if (q >= 0) {
      new URLSearchParams(link.slice(q + 1)).forEach(function (v, k) {
        params.set(k, v);
      });
    }
    if (realCal.config && realCal.config.forwardQueryParams) {
      new URLSearchParams(window.location.search).forEach(function (v, k) {
        params.set(k, v);
      });
    }
    // Forward the namespace's ui config so the booker matches the host page.
    var ui = (namespaces[ns] || namespaces[""] || {}).ui || {};
    if (ui.theme) params.set("theme", ui.theme);
    if (ui.brandColor) params.set("brand", ui.brandColor);
    params.set("embed", "1");
    return originFor(ns) + "/book?" + params.toString();
  }

  // --- modal ----------------------------------------------------------------

  // One-time host <style>: spinner keyframes, mobile full-screen override
  // (!important beats the inline desktop sizing, so a rotate/resize after
  // open still applies), and a reduced-motion kill switch.
  function ensureChromeStyle() {
    if (document.getElementById("slate-widget-css")) return;
    var style = document.createElement("style");
    style.id = "slate-widget-css";
    style.textContent =
      "@keyframes slate-spin{to{transform:rotate(360deg)}}" +
      "@media (max-width:640px){.slate-widget-modal{width:100%!important;" +
      "height:100vh!important;height:100dvh!important;max-height:none!important;" +
      "border-radius:0!important;box-shadow:none!important}}" +
      "@media (prefers-reduced-motion:reduce){.slate-widget-modal," +
      ".slate-widget-modal *{animation:none!important;transition:none!important}}" +
      // Hostile-host defense: a class rule out-specifies a host
      // `* { font-family:... !important }` reset, so the chrome's typography
      // holds even when inline (non-important) resets would lose the cascade.
      ".slate-widget-modal{font-size:16px!important}" +
      ".slate-widget-modal,.slate-widget-modal *{font-family:'PP Mori'," +
      "-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif" +
      "!important;letter-spacing:normal!important}";
    document.head.appendChild(style);
  }

  function openModal(link, ns, trigger) {
    ensureChromeStyle();
    var reduceMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    var overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;display:flex;" +
      "align-items:center;justify-content:center;background:rgba(29,33,47,0.55)";

    var modal = document.createElement("div");
    modal.className = "slate-widget-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Book a call");
    modal.style.cssText =
      "background:#fff;border-radius:16px;width:min(720px,92vw);" +
      "max-height:90vh;max-height:90dvh;overflow:auto;position:relative;" +
      "box-shadow:0 12px 32px rgba(29,33,47,0.18);" +
      "box-sizing:border-box;font-family:'PP Mori',-apple-system," +
      "BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;" +
      "color:rgb(52,52,52);line-height:1.5;text-align:left;letter-spacing:normal";

    var close = document.createElement("button");
    close.textContent = "×";
    close.setAttribute("aria-label", "Close");
    close.style.cssText =
      "position:absolute;top:2px;right:2px;border:0;background:transparent;" +
      "width:44px;height:44px;display:flex;align-items:center;" +
      "justify-content:center;border-radius:12px;" +
      "font-size:24px;line-height:1;cursor:pointer;color:rgb(106,106,112);" +
      "z-index:1;box-sizing:border-box;margin:0;padding:0;" +
      "letter-spacing:normal;text-align:center;font-family:'PP Mori'," +
      "-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif";
    close.addEventListener("mouseenter", function () {
      close.style.color = "rgb(52,52,52)";
    });
    close.addEventListener("mouseleave", function () {
      close.style.color = "rgb(106,106,112)";
    });
    // Theme-aware focus recipe (literal: the modal chrome is always white) -
    // graphite outline carries the 3:1 contrast; the sky glow is decorative.
    close.addEventListener("focus", function () {
      close.style.outline = "2px solid rgb(52,52,52)";
      close.style.outlineOffset = "2px";
      close.style.boxShadow = "0 0 0 4px rgba(130,208,255,0.45)";
      close.style.color = "rgb(52,52,52)";
    });
    close.addEventListener("blur", function () {
      close.style.outline = "";
      close.style.outlineOffset = "";
      close.style.boxShadow = "";
      close.style.color = "rgb(106,106,112)";
    });

    // Branded loading state on the white surface, removed on iframe load.
    var loader = document.createElement("div");
    loader.setAttribute("role", "status");
    loader.setAttribute("aria-label", "Loading");
    loader.style.cssText =
      "position:absolute;inset:0;display:flex;align-items:center;" +
      "justify-content:center;background:#fff;border-radius:inherit;" +
      "box-sizing:border-box;margin:0;padding:0";
    if (reduceMotion) {
      loader.textContent = "Loading…";
      loader.style.color = "rgb(106,106,112)";
      loader.style.fontSize = "14px";
    } else {
      var spinner = document.createElement("div");
      spinner.style.cssText =
        "width:36px;height:36px;border-radius:50%;box-sizing:border-box;" +
        "border:3px solid rgba(130,208,255,0.35);border-top-color:#82D0FF;" +
        "animation:slate-spin .8s linear infinite";
      loader.appendChild(spinner);
    }

    var iframe = document.createElement("iframe");
    iframe.src = bookingUrl(link, ns);
    iframe.style.cssText =
      "width:100%;border:0;min-height:560px;opacity:0" +
      (reduceMotion ? "" : ";transition:opacity .15s ease,height .15s ease");
    iframe.setAttribute("title", "Pennie booking");
    iframe.allow = "fullscreen";
    iframe.addEventListener("load", function () {
      if (loader.parentNode) loader.parentNode.removeChild(loader);
      iframe.style.opacity = "1";
    });

    // Forward-tab sentinel: focus leaving the iframe's last element lands
    // here and wraps back to the close button (host-side trap boundary).
    var sentinel = document.createElement("div");
    sentinel.tabIndex = 0;
    sentinel.style.cssText =
      "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
    sentinel.addEventListener("focus", function () {
      close.focus();
    });

    var prevOverflow = document.body.style.overflow;
    var inerted = [];

    function hide() {
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      document.body.style.overflow = prevOverflow;
      inerted.forEach(function (el) {
        if (typeof el.inert === "boolean") el.inert = false;
        else el.removeAttribute("aria-hidden");
      });
      inerted = [];
      if (activeIframe === iframe) activeIframe = null;
      if (activeModalHide === hide) activeModalHide = null;
      if (trigger && typeof trigger.focus === "function") {
        try {
          trigger.focus();
        } catch {
          /* trigger may have left the DOM; closing still succeeds */
        }
      }
    }

    function onKeydown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        hide();
        return;
      }
      if (e.key !== "Tab") return;
      if (e.shiftKey && document.activeElement === close) {
        e.preventDefault();
        iframe.focus();
      } else if (!e.shiftKey && document.activeElement === iframe) {
        e.preventDefault();
        close.focus();
      } else if (
        !document.activeElement ||
        document.activeElement === document.body
      ) {
        e.preventDefault();
        close.focus();
      }
    }

    close.addEventListener("click", hide);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) hide();
    });
    document.addEventListener("keydown", onKeydown, true);

    modal.appendChild(close);
    modal.appendChild(iframe);
    modal.appendChild(loader);
    modal.appendChild(sentinel);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Scroll lock + background inert while the dialog is open.
    document.body.style.overflow = "hidden";
    Array.prototype.forEach.call(document.body.children, function (child) {
      if (child === overlay) return;
      if (typeof child.inert === "boolean") {
        if (!child.inert) {
          child.inert = true;
          inerted.push(child);
        }
      } else if (!child.hasAttribute("aria-hidden")) {
        child.setAttribute("aria-hidden", "true");
        inerted.push(child);
      }
    });

    activeIframe = iframe;
    activeModalHide = hide;
    close.focus();
  }

  // Delegated so dynamically-added triggers work too.
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest && e.target.closest("[data-cal-link]");
    if (!el) return;
    e.preventDefault();
    openModal(
      el.getAttribute("data-cal-link") || "",
      el.getAttribute("data-cal-namespace") || "",
      el,
    );
  });

  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.type === "slate:resize" && typeof d.height === "number" && activeIframe) {
      activeIframe.style.height = d.height + "px";
    } else if (d.type === "slate:bookingSuccessful") {
      emit("bookingSuccessful", d.data);
    } else if (
      d.type === "slate:escape" &&
      activeModalHide &&
      activeIframe &&
      e.source === activeIframe.contentWindow
    ) {
      // Escape pressed inside the booking iframe (its keydowns never reach
      // this document); close the modal exactly like a host-side Escape.
      activeModalHide();
    }
  });
})();
