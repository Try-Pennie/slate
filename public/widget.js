/**
 * Slate embed SDK — a drop-in replacement for the cal.com embed (`embed.js`).
 *
 * It implements the same `Cal()` API surface the cal embed snippet expects, so
 * an existing cal integration swaps to Slate by changing only (1) the script
 * src to this file and (2) the `origin` passed to Cal("init", …). Supported:
 *
 *   Cal("init", "<namespace>", { origin });   // per-namespace origin
 *   Cal.ns["<ns>"]("ui", { ... });             // accepted (Slate styles itself)
 *   Cal.ns["<ns>"]("prerender", { ... });      // accepted, no-op (see below)
 *   Cal("on", { action: "bookingSuccessful", callback });
 *   window.Cal.config.forwardQueryParams = true;
 *   <button data-cal-link="router?form=…" data-cal-namespace="review"
 *           data-cal-config='{"layout":"month_view"}'>Book</button>
 *
 * Routing is by the `xbc` query param (the bucket code); the external record id
 * is read from `external_id`. `data-cal-link` clicks open a modal iframe at
 * `<origin>/book?…` carrying the link's own query plus, when
 * forwardQueryParams is set, the host page's query. The trigger's
 * `data-cal-config` is read for cal.com's `metadata[<key>]` entries, which map
 * onto Slate's own param names through a small explicit table (#2716); a URL
 * param wins on a collision, and every other config key is accepted as a no-op.
 *
 * `on` actions (#2658), under cal.com's own names so a host's GTM listener needs
 * no Slate branch. Each callback receives `{ detail: { type, data } }`:
 *
 *   navigatedToBooker             a trigger was clicked, before the modal opens   {}
 *   bookerViewed                  the booker first rendered in this frame load    { slotsLoaded }
 *   bookerReady                   the availability answered with times            { slotsLoaded: true }
 *   bookerReopened                the modal opened again on this page             {}
 *   bookerReloaded                the modal iframe loaded a second time           {}
 *   linkFailed                    the booker could not be used                    { code, msg }
 *   bookingSuccessfulV2           a fresh booking                                 { uid, startTime, endTime, status, isTest }
 *   rescheduleBookingSuccessfulV2 a lead moved the call they already had          same shape
 *   bookingCancelled              the in embed cancel succeeded                   { booking: { uid, startTime, endTime, cancellationReason } }
 *   bookingSuccessful             UNCHANGED: fresh and moved alike                { booking, salesforceId, outcome }
 *   *                             every event above, with `detail.type` set
 *
 * A host records a booking from bookingSuccessfulV2 OR from bookingSuccessful,
 * never both: they announce the same booking. No event carries the lead's
 * contact.
 *
 * The modal frame is built on the FIRST open and kept across close and reopen
 * (#2678), the way cal.com keeps its modal: closing hides the overlay, and the
 * next click on a trigger with the same namespace and the same booking URL shows
 * the same iframe again, so the Booker inside keeps its chosen day, time and
 * typed details, and bookerViewed / bookerReady fire once per page load rather
 * than once per open. One frame is kept per namespace: a trigger whose booking
 * URL differs (another xbc, other params) replaces that namespace's frame, and a
 * second namespace gets a frame of its own. `prerender` stays a no-op: Slate
 * does NOT build the frame at page load as cal.com's pre-render does, it warms
 * the availability read instead (#251), and the frame is built on the first
 * click.
 */
(function () {
  "use strict";

  // --- every word the embed says, in ONE place ------------------------------
  //
  // slate-embed-copy: start
  //
  // This is the embed's whole vocabulary, and it lives here so it can be READ
  // before it ships (#1421). The booker and the manage page already have that
  // through `pnpm preview:booker`, which is trustworthy because it calls the real
  // copy builders and holds no wording of its own (L41). This file cannot import
  // one: it is a dependency-free static asset served to third-party pages, with no
  // build step between it and the browser.
  //
  // So the preview READS this block out of the shipping file instead. That gives
  // the same guarantee by a different route, and it only holds while the block is
  // the only place the embed's wording lives, which
  // `scripts/test-embed-invite-preview.ts` enforces in both directions: every entry
  // here must be reachable by the preview, and no user-visible string may sit
  // outside it.
  //
  // Most leads meet Slate through this chrome rather than the standalone page, so
  // these six lines are read more than any other copy in the product.
  var COPY = {
    /** The dialog itself, for anyone arriving on a screen reader. */
    modalLabel: "Book a call",
    /** The X in the corner. */
    close: "Close",
    /** Announced while the booker loads. */
    loading: "Loading",
    /** And shown, for a lead who has asked for reduced motion and so sees no
     *  spinner. Without it that lead gets a blank panel. */
    loadingText: "Loading\u2026",
    /** The load failed. It says what to do, not what broke. */
    loadFailed: "We couldn't load the booking form. Check your connection and try again.",
    /** The way out of that. */
    retry: "Try again",
    /** The frame, named so a screen reader's frame list is navigable. */
    frameTitle: "Pennie booking",
  };
  // slate-embed-copy: end

  var prior = window.Cal;
  var priorNs = prior && prior.ns ? prior.ns : {};
  var queuedGlobal = prior && prior.q ? prior.q.slice() : [];

  var namespaces = {}; // ns -> { origin, ui }
  var listeners = {}; // action -> [callback]
  // The frame currently ON SCREEN, and how to hide it. Null while no modal is
  // shown, including while frames sit hidden between opens (#2678): only the
  // visible frame may announce a booking or close the modal. A hidden frame's
  // resize and lifecycle messages are matched through `frames` instead.
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
    // The named listeners, then the "*" wildcard (#2658): the tagging spec's QA
    // listener subscribes to everything and reads `detail.type` to tell them apart.
    var subscribers = (listeners[action] || []).concat(listeners["*"] || []);
    subscribers.forEach(function (cb) {
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

  // --- data-cal-config metadata → booking URL params (#2716) ----------------
  //
  // cal.com takes extra booking fields on the trigger as `metadata[<key>]`
  // entries in `data-cal-config`, and a partner written against cal.com puts its
  // join keys there (trypennie's BookButton does). Slate reads the same keys off
  // the booking URL under its own names (PARTNER_KEYS, #2659), so this table maps
  // one onto the other. Each entry is <Slate's URL param>: <cal.com metadata key>.
  //
  // Explicit on purpose, never a generic rename: an unknown metadata key is
  // dropped (with one console message per key per page) rather than forwarded,
  // since anything on the booking URL rides into prefill, the booking row, every
  // webhook and the warehouse. This file cannot import PARTNER_KEYS, so
  // `widget-embed.test.ts` reads this block out of the shipped file and holds its
  // param names against the constant in both directions (L41).
  //
  // slate-partner-metadata: start
  var PARTNER_METADATA = {
    submissionId: "sfdc_submission_id",
    regalProfileId: "regal_profile_id",
  };
  // slate-partner-metadata: end

  var warnedMetadata = {};
  var warnedUnreadableConfig = 0;

  function embedWarn(message) {
    try {
      console.warn("Slate embed: " + message);
    } catch (_e) {
      /* never throw into the host page */
    }
  }

  // The trigger's config as an object, or null. An attribute that is absent, not
  // JSON, or JSON that is not an object is ignored: the open must never depend on
  // a host's config being well formed. An unreadable one is still SAID, once per
  // page, because it may have carried a partner key that is now silently missing
  // from the booking (L11), and an absent attribute is not the same fact.
  function readTriggerConfig(trigger) {
    var raw = trigger && trigger.getAttribute ? trigger.getAttribute("data-cal-config") : null;
    if (!raw) return null;
    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_e) {
      parsed = null;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    if (!warnedUnreadableConfig) {
      warnedUnreadableConfig = 1;
      embedWarn("data-cal-config is not a JSON object, so none of it was read.");
    }
    return null;
  }

  // Every other config key (`layout`, `cal.embed.pageType`, ...) is accepted and
  // ignored, as before: Slate styles and lays itself out.
  function metadataParams(config) {
    var out = {};
    if (!config) return out;
    var byMetadataKey = {};
    Object.keys(PARTNER_METADATA).forEach(function (param) {
      byMetadataKey[PARTNER_METADATA[param]] = param;
    });
    Object.keys(config).forEach(function (key) {
      var m = /^metadata\[(.+)\]$/.exec(key);
      if (!m) return;
      var param = Object.prototype.hasOwnProperty.call(byMetadataKey, m[1])
        ? byMetadataKey[m[1]]
        : null;
      if (!param) {
        if (!warnedMetadata[m[1]]) {
          warnedMetadata[m[1]] = 1;
          embedWarn("data-cal-config metadata[" + m[1] + "] is not a field Slate reads, so it was not sent.");
        }
        return;
      }
      // A blank or non string value is absent: an empty join key joins nothing.
      var value = config[key];
      if (typeof value !== "string") return;
      value = value.trim();
      if (value) out[param] = value;
    });
    return out;
  }

  function bookingUrl(link, ns, config) {
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
    // The trigger's metadata fills only what the URLs did not set: a URL
    // parameter wins over the config on a collision (#2716).
    var fromConfig = metadataParams(config);
    Object.keys(fromConfig).forEach(function (param) {
      if (!params.has(param)) params.set(param, fromConfig[param]);
    });
    // Forward the namespace's ui config so the booker matches the host page.
    var ui = (namespaces[ns] || namespaces[""] || {}).ui || {};
    if (ui.theme) params.set("theme", ui.theme);
    if (ui.brandColor) params.set("brand", ui.brandColor);
    params.set("embed", "1");
    // Tell the Booker which origin to target its outbound postMessages at, so the
    // slate:bookingSuccessful lead PII is never broadcast to "*" (#593). This is
    // the host page's own origin — the frame the modal lives in.
    params.set("parentOrigin", window.location.origin);
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
      "border-radius:0!important;box-shadow:none!important}" +
      // #2769: the full screen modal is one size, so the frame fills it and a
      // short step centres inside the booker rather than leaving white beneath a
      // dark one. A taller step still grows the frame and the modal scrolls.
      ".slate-widget-modal iframe{min-height:100%!important}}" +
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

  // One frame per namespace, kept across close and reopen (#2678). A frame is
  // { url, overlay, iframe, show, hide, destroy }; `url` is the booking URL it
  // was built for, so a trigger carrying a different link replaces it.
  var frames = {};

  function frameFor(source) {
    if (!source) return null;
    var keys = Object.keys(frames);
    for (var i = 0; i < keys.length; i++) {
      var f = frames[keys[i]];
      if (f.iframe.contentWindow === source) return f;
    }
    return null;
  }

  function openModal(link, ns, trigger) {
    var url = bookingUrl(link, ns, readTriggerConfig(trigger));
    var frame = frames[ns];
    // A different booking URL is a different booker, so the old frame goes (one
    // per namespace bounds the memory a page can hold). A frame the host page
    // has torn out of the DOM is gone too, whatever it thinks it is.
    if (frame && (frame.url !== url || !document.body.contains(frame.overlay))) {
      frame.destroy();
      frame = null;
    }
    if (!frame) {
      frame = buildFrame(url);
      frames[ns] = frame;
    }
    frame.show(trigger);
  }

  function buildFrame(bookUrl) {
    ensureChromeStyle();
    var reduceMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Built hidden; show() is what puts it on screen.
    var overlay = document.createElement("div");
    overlay.className = "slate-widget-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;display:none;" +
      "align-items:center;justify-content:center;background:rgba(29,33,47,0.55)";

    var modal = document.createElement("div");
    modal.className = "slate-widget-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", COPY.modalLabel);
    modal.style.cssText =
      // #2729: 896px is the standalone booker's content width (its max-w-4xl),
      // the width its two column layout was designed at. 720px sat under the
      // booker's switch, so the modal only ever showed the phone layout.
      "background:#fff;border-radius:16px;width:min(896px,92vw);" +
      "max-height:90vh;max-height:90dvh;overflow:auto;position:relative;" +
      "box-shadow:0 12px 32px rgba(29,33,47,0.18);" +
      "box-sizing:border-box;font-family:'PP Mori',-apple-system," +
      "BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;" +
      "color:rgb(52,52,52);line-height:1.5;text-align:left;letter-spacing:normal";

    var close = document.createElement("button");
    close.textContent = "×";
    close.setAttribute("aria-label", COPY.close);
    // #2766: inside the box's padding, so the focus ring (a 2px outline 2px
    // out, plus a 4px glow, 8px in all) stays inside the 16px rounded corner
    // rather than being clipped by it. The booker leaves this corner empty in
    // the embed (#2748): its test band and its clock row stop short of it, and
    // `embed-one-size.test.tsx` holds the two sides against each other.
    close.style.cssText =
      "position:absolute;top:12px;right:12px;border:0;background:transparent;" +
      "width:44px;height:44px;display:flex;align-items:center;" +
      "justify-content:center;border-radius:12px;" +
      "font-size:24px;line-height:1;cursor:pointer;" +
      "z-index:1;box-sizing:border-box;margin:0;padding:0;" +
      "letter-spacing:normal;text-align:center;font-family:'PP Mori'," +
      "-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif";
    // #2748: the control is drawn over whatever is BEHIND it, which is the white
    // chrome while the frame loads and the booker once it has, and a dark booker
    // made the graphite glyph and ring all but invisible. So its ink follows the
    // booker's theme once the booker is showing. Literals, because the host page
    // has no Pennie tokens: the dark half mirrors `--pennie-muted-dark`,
    // `--pennie-beige` and the sky focus line D17 sets for navy; the light half
    // is the graphite recipe (the 3:1 line is the outline; the sky glow is
    // decorative in both).
    var darkBooker = /[?&]theme=dark(?:&|$)/.test(bookUrl);
    var CLOSE_ON_LIGHT = { rest: "rgb(106,106,112)", strong: "rgb(52,52,52)", ring: "rgb(52,52,52)" };
    var CLOSE_ON_DARK = { rest: "rgb(165,162,177)", strong: "rgb(249,246,240)", ring: "rgb(130,208,255)" };
    var closeFocused = false;
    var closeHovered = false;
    function paintClose() {
      var ink = darkBooker && loadState === "loaded" ? CLOSE_ON_DARK : CLOSE_ON_LIGHT;
      close.style.color = closeFocused || closeHovered ? ink.strong : ink.rest;
      close.style.outline = closeFocused ? "2px solid " + ink.ring : "";
      close.style.outlineOffset = closeFocused ? "2px" : "";
      close.style.boxShadow = closeFocused ? "0 0 0 4px rgba(130,208,255,0.45)" : "";
    }
    close.addEventListener("mouseenter", function () {
      closeHovered = true;
      paintClose();
    });
    close.addEventListener("mouseleave", function () {
      closeHovered = false;
      paintClose();
    });
    close.addEventListener("focus", function () {
      closeFocused = true;
      paintClose();
    });
    close.addEventListener("blur", function () {
      closeFocused = false;
      paintClose();
    });

    // Branded loading state on the white surface. It must NEVER spin forever:
    // if the iframe never loads (Slate origin down/blocked/stalled) a ~12s
    // timeout converts the spinner into a plain-language error + retry (#628),
    // so the lead always sees "working" and "failed" as distinct states rather
    // than an indefinite spinner on this first-impression surface.
    var LOAD_TIMEOUT_MS = 12000;
    var loadTimer = null;
    // "loading" until the iframe's first load, then "loaded"; "failed" while the
    // error and its retry are up. The timer runs only while "loading" and only
    // while the modal is shown, so a reopen of a loaded frame starts no clock.
    var loadState = "loading";

    var loader = document.createElement("div");
    loader.className = "slate-widget-loader";
    loader.style.cssText =
      "position:absolute;inset:0;display:flex;flex-direction:column;" +
      "align-items:center;justify-content:center;gap:14px;text-align:center;" +
      "background:#fff;border-radius:inherit;box-sizing:border-box;" +
      "margin:0;padding:24px;color:rgb(52,52,52)";

    function clearNode(n) {
      while (n.firstChild) n.removeChild(n.firstChild);
    }

    function renderLoading() {
      clearNode(loader);
      loader.setAttribute("role", "status");
      loader.setAttribute("aria-label", COPY.loading);
      if (reduceMotion) {
        loader.textContent = COPY.loadingText;
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
    }

    function renderError() {
      clearNode(loader);
      loader.setAttribute("role", "alert");
      loader.removeAttribute("aria-label");
      loader.style.color = "rgb(52,52,52)";
      loader.style.fontSize = "14px";

      var msg = document.createElement("p");
      msg.textContent = COPY.loadFailed;
      msg.style.cssText = "margin:0;max-width:280px;line-height:1.5";

      var retry = document.createElement("button");
      retry.textContent = COPY.retry;
      retry.style.cssText =
        "min-height:44px;padding:0 20px;border:0;border-radius:12px;" +
        "background:#82D0FF;color:rgb(52,52,52);font-size:15px;cursor:pointer;" +
        "box-sizing:border-box;margin:0;font-family:inherit";
      retry.addEventListener("focus", function () {
        retry.style.outline = "2px solid rgb(52,52,52)";
        retry.style.outlineOffset = "2px";
        retry.style.boxShadow = "0 0 0 4px rgba(130,208,255,0.45)";
      });
      retry.addEventListener("blur", function () {
        retry.style.outline = "";
        retry.style.outlineOffset = "";
        retry.style.boxShadow = "";
      });
      retry.addEventListener("click", function () {
        loadState = "loading";
        renderLoading();
        armLoadTimer();
        iframe.src = bookUrl; // force a fresh load attempt
      });

      loader.appendChild(msg);
      loader.appendChild(retry);
      retry.focus();
    }

    // The two ways the modal itself can fail to show a booker (#2658), announced
    // as `linkFailed` beside the two the Booker reports from inside the frame.
    // These sentences are read by an analyst in a GA4 report, never by a lead,
    // which is why they sit outside the copy block above: the lead's own words
    // for the same moment are `COPY.loadFailed`, on screen.
    var LOAD_FAILED = {
      timeout: { code: "load_timeout", msg: "The booking form did not load in time" },
      error: { code: "load_error", msg: "The booking form could not be loaded" },
    };

    function armLoadTimer() {
      if (loadTimer) clearTimeout(loadTimer);
      loadTimer = setTimeout(function () {
        loadTimer = null;
        loadState = "failed";
        renderError();
        emit("linkFailed", LOAD_FAILED.timeout);
      }, LOAD_TIMEOUT_MS);
    }

    function stopLoadTimer() {
      if (loadTimer) {
        clearTimeout(loadTimer);
        loadTimer = null;
      }
    }

    renderLoading();
    paintClose();

    // Loads of THIS iframe. The second and later announce `bookerReloaded`: a
    // retry after a failed load, or a reload from inside the frame. A close and
    // reopen is not a load, since the frame is kept (#2678).
    var loads = 0;

    var iframe = document.createElement("iframe");
    iframe.src = bookUrl;
    // #2729: the floor sits under the two column booker's shortest loaded height
    // (about 447px, measured in the 896px modal). At 560 the frame outgrew a
    // booker that no longer stacks, and a strip of empty page showed beneath it.
    // display:block, because an inline frame sits on a text baseline and left
    // a 6px strip of the modal's white under a dark booker (#2766).
    iframe.style.cssText =
      "display:block;width:100%;border:0;min-height:440px;opacity:0" +
      (reduceMotion ? "" : ";transition:opacity .15s ease,height .15s ease");
    iframe.setAttribute("title", COPY.frameTitle);
    iframe.allow = "fullscreen";
    iframe.addEventListener("load", function () {
      stopLoadTimer();
      loadState = "loaded";
      paintClose();
      if (loader.parentNode) loader.parentNode.removeChild(loader);
      iframe.style.opacity = "1";
      loads++;
      if (loads > 1) emit("bookerReloaded", {});
    });
    iframe.addEventListener("error", function () {
      stopLoadTimer();
      loadState = "failed";
      renderError();
      emit("linkFailed", LOAD_FAILED.error);
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

    var prevOverflow = "";
    var inerted = [];
    var visible = false;
    // The element focus returns to on close: whichever trigger opened the modal
    // this time, since two buttons can share one namespace and link.
    var trigger = null;

    // Hide, never remove (#2678): the overlay stays in the DOM, off screen and
    // out of the accessibility tree, so the next show() finds the Booker exactly
    // where the lead left it. Idempotent, because a hidden frame's own close
    // button and a stale Escape can both still reach it.
    function hide() {
      if (!visible) return;
      visible = false;
      stopLoadTimer();
      document.removeEventListener("keydown", onKeydown, true);
      overlay.style.display = "none";
      overlay.setAttribute("aria-hidden", "true");
      if (typeof overlay.inert === "boolean") overlay.inert = true;
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

    function show(openedBy) {
      trigger = openedBy;
      if (visible) {
        close.focus();
        return;
      }
      // Only one modal is on screen at a time, whichever namespace owns it.
      if (activeModalHide && activeModalHide !== hide) activeModalHide();
      visible = true;
      overlay.style.display = "flex";
      overlay.removeAttribute("aria-hidden");
      if (typeof overlay.inert === "boolean") overlay.inert = false;

      // Scroll lock + background inert while the dialog is open.
      prevOverflow = document.body.style.overflow;
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

      document.addEventListener("keydown", onKeydown, true);
      // The 12s clock runs against the FIRST load only: a frame that already
      // loaded needs none, and a close mid-load stopped it, so a reopen of a
      // frame still loading starts it again rather than spinning forever.
      if (loadState === "loading" && !loadTimer) armLoadTimer();

      activeIframe = iframe;
      activeModalHide = hide;
      close.focus();
    }

    function destroy() {
      hide();
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
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
    overlay.setAttribute("aria-hidden", "true");
    if (typeof overlay.inert === "boolean") overlay.inert = true;
    document.body.appendChild(overlay);

    return { url: bookUrl, overlay: overlay, iframe: iframe, show: show, hide: hide, destroy: destroy };
  }

  // --- error beacon (#1368) --------------------------------------------------
  // If this script throws while opening the modal, the customer taps the button
  // and nothing happens: no request reaches Slate, so every server-side detector
  // stays green while the booking is lost. This is the only signal for that.
  //
  // Deliberately NOT a window.onerror. This file runs in the HOST page, so a
  // global handler would collect the host site's own errors, which are both noise
  // and not ours to collect. Only Slate's own entry points are wrapped.
  //
  // sendBeacon with a text/plain body is a "simple" cross-origin request: no
  // preflight, no response to read, and nothing for the host page to wait on. The
  // report is scrubbed of contact data SERVER side (a booking URL this file builds
  // can carry a lead's prefill), so no scrubber is duplicated here.
  var reported = 0;
  function reportWidgetError(err, ns) {
    try {
      if (reported >= 3) return; // a broken page must not become a flood
      var origin = originFor(ns);
      if (!origin || !navigator.sendBeacon) return;
      reported++;
      var body = JSON.stringify({
        kind: "error",
        message: String((err && err.message) || err || "unknown widget error"),
        stack: err && err.stack ? String(err.stack) : null,
        source: "widget.js",
        page: "/widget",
      });
      navigator.sendBeacon(
        origin + "/api/client-errors",
        new Blob([body], { type: "text/plain" }),
      );
    } catch (_e) {
      // The reporter must never be the thing that breaks the host page.
    }
  }

  // How many times each namespace's modal has been OPENED on this page (#2658).
  // The second and later opens announce `bookerReopened`, which is the spec's
  // "came back to the booker" signal. Counted after the open returned (#2677):
  // counted before it, a first click that threw (an iframe the host's CSP
  // blocked) left the count at one, and the first click that worked read as a
  // reopen of a booker nobody had seen.
  var opens = {};

  // Delegated so dynamically-added triggers work too.
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest && e.target.closest("[data-cal-link]");
    if (!el) return;
    e.preventDefault();
    var ns = el.getAttribute("data-cal-namespace") || "";
    try {
      // Before the modal exists, as cal.com does: this is the click, not the view.
      emit("navigatedToBooker", {});
      openModal(el.getAttribute("data-cal-link") || "", ns, el);
      opens[ns] = (opens[ns] || 0) + 1;
      if (opens[ns] > 1) emit("bookerReopened", {});
    } catch (err) {
      // Report and swallow: a throw here would otherwise surface as an error in
      // the HOST page's console and leave the customer with a dead button.
      reportWidgetError(err, ns);
    }
  });

  // --- availability prefetch (#251) -----------------------------------------
  // Warm GET <origin>/api/availability?bucket=<xbc> as soon as a trigger is on
  // the page (and again on first intent), so the cache-first booker opens with
  // slots already computed instead of paying the ~3.8s cold-compute on open.
  // Fire-and-forget and best-effort: it never blocks or throws into the host
  // page, and each bucket is warmed at most once per page load.
  var warmed = {};
  function bucketCodeFor(link) {
    var params = new URLSearchParams();
    var q = link.indexOf("?");
    if (q >= 0) {
      new URLSearchParams(link.slice(q + 1)).forEach(function (v, k) {
        params.set(k, v);
      });
    }
    // Mirror bookingUrl: a forwarded window query can override the link's xbc.
    if (realCal.config && realCal.config.forwardQueryParams) {
      new URLSearchParams(window.location.search).forEach(function (v, k) {
        params.set(k, v);
      });
    }
    return params.get("xbc") || "";
  }
  function warmAvailability(link, ns) {
    var xbc = bucketCodeFor(link);
    if (!xbc) return;
    var url = originFor(ns) + "/api/availability?bucket=" + encodeURIComponent(xbc);
    if (warmed[url]) return;
    warmed[url] = 1;
    // no-cors: the host page is cross-origin to the Slate app, so we can't (and
    // don't need to) read the response. The request still runs server-side and
    // warms the precomputed row + edge cache. Result is discarded.
    try {
      if (typeof fetch === "function") {
        fetch(url, { mode: "no-cors", credentials: "omit", cache: "no-store" }).catch(
          function () {},
        );
      }
    } catch (_e) {
      /* never throw into the host page */
    }
  }
  function warmTrigger(el) {
    if (!el || !el.getAttribute) return;
    warmAvailability(
      el.getAttribute("data-cal-link") || "",
      el.getAttribute("data-cal-namespace") || "",
    );
  }
  function warmAllTriggers() {
    var els = document.querySelectorAll("[data-cal-link]");
    for (var i = 0; i < els.length; i++) warmTrigger(els[i]);
  }
  // Intent: warm on the first hover/focus/touch of a trigger (delegated, so
  // dynamically-added triggers are covered). All three events bubble.
  ["pointerover", "focusin", "touchstart"].forEach(function (type) {
    document.addEventListener(
      type,
      function (e) {
        var el = e.target && e.target.closest && e.target.closest("[data-cal-link]");
        if (el) warmTrigger(el);
      },
      true,
    );
  });
  // Render: warm any triggers already on the page (the common single-button case).
  warmAllTriggers();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", warmAllTriggers);
  }

  // The Booker's own lifecycle messages and the cal.com event each becomes
  // (#2658). The raw name is what a host framing /book itself listens for; the
  // widget name is what a `Cal("on")` listener gets. Payloads pass through as
  // posted: the Booker builds them, and it never puts the lead's contact in one.
  var LIFECYCLE = {
    "slate:bookerViewed": "bookerViewed",
    "slate:bookerReady": "bookerReady",
    "slate:linkFailed": "linkFailed",
    "slate:bookingCancelled": "bookingCancelled",
  };

  // cal.com's V2 success shape, derived from the one success message the Booker
  // has always posted. `outcome` says which of the two events it is; a value this
  // file does not know derives NEITHER, because announcing a moved call as a
  // booking is the misreport the split exists to prevent.
  var V2_BY_OUTCOME = {
    created: "bookingSuccessfulV2",
    rescheduled: "rescheduleBookingSuccessfulV2",
  };
  function v2Payload(data) {
    var b = (data && data.booking) || {};
    return {
      uid: b.id,
      startTime: b.startsAt,
      endTime: b.endsAt,
      status: "confirmed",
      isTest: b.isTest,
    };
  }

  window.addEventListener("message", function (e) {
    var d = e.data || {};
    // Every branch here checks the SOURCE (#593): a nested or malicious frame on
    // the host page must not be able to resize the modal, spoof the host's
    // conversion callback, announce a stage or close the dialog. Two kinds of
    // check (#2678): a booking and an escape are taken from the frame ON SCREEN
    // only (`activeIframe`); a resize and a lifecycle stage are taken from any
    // frame this file built, hidden ones included, because they are facts about
    // that frame load. A hidden frame's height must be right when it is shown
    // again, and a bookerReady that arrives after a fast close will never be
    // posted again, so it is announced when it arrives.
    var frame = frameFor(e.source);
    if (d.type === "slate:resize" && typeof d.height === "number" && frame) {
      frame.iframe.style.height = d.height + "px";
    } else if (
      d.type === "slate:bookingSuccessful" &&
      activeIframe &&
      e.source === activeIframe.contentWindow
    ) {
      // The original event stays byte for byte for the hosts written against it
      // (#2643); the V2 event is derived beside it, never instead of it.
      emit("bookingSuccessful", d.data);
      var v2 = V2_BY_OUTCOME[d.data && d.data.outcome];
      if (v2) emit(v2, v2Payload(d.data));
    } else if (LIFECYCLE[d.type] && frame) {
      emit(LIFECYCLE[d.type], d.data);
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
