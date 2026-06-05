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

  function openModal(link, ns) {
    var overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;display:flex;" +
      "align-items:center;justify-content:center;background:rgba(0,0,0,.5)";

    var modal = document.createElement("div");
    modal.style.cssText =
      "background:#fff;border-radius:12px;width:min(720px,92vw);" +
      "max-height:90vh;overflow:auto;position:relative";

    var close = document.createElement("button");
    close.textContent = "×";
    close.setAttribute("aria-label", "Close");
    close.style.cssText =
      "position:absolute;top:8px;right:12px;border:0;background:transparent;" +
      "font-size:24px;line-height:1;cursor:pointer;color:#666;z-index:1";

    var iframe = document.createElement("iframe");
    iframe.src = bookingUrl(link, ns);
    iframe.style.cssText = "width:100%;border:0;min-height:560px";
    iframe.setAttribute("title", "Slate booking");
    iframe.allow = "fullscreen";

    function hide() {
      overlay.remove();
      if (activeIframe === iframe) activeIframe = null;
    }
    close.addEventListener("click", hide);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) hide();
    });

    modal.appendChild(close);
    modal.appendChild(iframe);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    activeIframe = iframe;
  }

  // Delegated so dynamically-added triggers work too.
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest && e.target.closest("[data-cal-link]");
    if (!el) return;
    e.preventDefault();
    openModal(
      el.getAttribute("data-cal-link") || "",
      el.getAttribute("data-cal-namespace") || "",
    );
  });

  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.type === "slate:resize" && typeof d.height === "number" && activeIframe) {
      activeIframe.style.height = d.height + "px";
    } else if (d.type === "slate:bookingSuccessful") {
      emit("bookingSuccessful", d.data);
    }
  });
})();
