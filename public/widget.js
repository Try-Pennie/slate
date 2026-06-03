/**
 * Slate embed SDK (Cal.com-style). Injects an iframe pointing at a Slate
 * booking URL and wires up auto-resize + booking callbacks via postMessage.
 *
 * Usage (inline):
 *   <div id="slate"></div>
 *   <script src="https://YOUR-SLATE/widget.js"></script>
 *   <script>
 *     Slate.inline({
 *       selector: "#slate",
 *       url: "https://YOUR-SLATE/booking/SF_ID?xbc=411&name=...&email=...",
 *       onBooking: (b) => console.log("booked", b),
 *     });
 *   </script>
 *
 * Usage (popup):
 *   Slate.popup({ url: "...", text: "Book a call" });
 */
(function () {
  "use strict";

  function withEmbed(url) {
    var u = new URL(url, window.location.href);
    u.searchParams.set("embed", "1");
    return u.toString();
  }

  function makeIframe(url) {
    var iframe = document.createElement("iframe");
    iframe.src = withEmbed(url);
    iframe.style.width = "100%";
    iframe.style.border = "0";
    iframe.style.minHeight = "480px";
    iframe.setAttribute("title", "Slate booking");
    iframe.allow = "fullscreen";
    return iframe;
  }

  function listen(iframe, onBooking) {
    window.addEventListener("message", function (e) {
      var data = e.data || {};
      if (data.type === "slate:resize" && typeof data.height === "number") {
        iframe.style.height = data.height + "px";
      }
      if (data.type === "slate:booking" && typeof onBooking === "function") {
        onBooking(data.booking, data);
      }
    });
  }

  function inline(opts) {
    var target =
      typeof opts.selector === "string"
        ? document.querySelector(opts.selector)
        : opts.selector;
    if (!target) throw new Error("Slate.inline: target not found");
    var iframe = makeIframe(opts.url);
    target.appendChild(iframe);
    listen(iframe, opts.onBooking);
    return iframe;
  }

  function popup(opts) {
    var btn = document.createElement("button");
    btn.textContent = opts.text || "Book a call";
    btn.style.cssText =
      "position:fixed;right:24px;bottom:24px;z-index:2147483646;" +
      "background:#171717;color:#fff;border:0;border-radius:9999px;" +
      "padding:14px 22px;font:600 14px system-ui;cursor:pointer;" +
      "box-shadow:0 6px 24px rgba(0,0,0,.2)";

    var overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;display:none;" +
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
      "font-size:24px;line-height:1;cursor:pointer;color:#666";

    var iframe = makeIframe(opts.url);
    iframe.style.minHeight = "560px";

    modal.appendChild(close);
    modal.appendChild(iframe);
    overlay.appendChild(modal);
    listen(iframe, opts.onBooking);

    function show() {
      overlay.style.display = "flex";
    }
    function hide() {
      overlay.style.display = "none";
    }
    btn.addEventListener("click", show);
    close.addEventListener("click", hide);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) hide();
    });

    document.body.appendChild(btn);
    document.body.appendChild(overlay);
    return { show: show, hide: hide };
  }

  window.Slate = { inline: inline, popup: popup };
})();
