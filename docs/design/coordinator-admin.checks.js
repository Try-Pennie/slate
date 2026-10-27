// The checks for the settled Coordinator booking admin page (#4264), one per checked decision in
// settled.json. Each reads only what the design and the build share: text, roles, aria attributes,
// element order and computed colours. None reads a styling class or an id the builder chose.

(function () {
  function norm(t) { return (t || "").replace(/\s+/g, " ").trim(); }
  // An element's words, its text pieces joined by spaces, as a reader sees them across lines.
  function text(el) {
    if (!el) return "";
    var parts = [], w = el.ownerDocument.createTreeWalker(el, 4);
    while (w.nextNode()) parts.push(w.currentNode.nodeValue);
    return norm(parts.join(" "));
  }
  function all(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  function main(doc) { return doc.querySelector("main") || doc.body; }
  function ok(cond, detail) { return { ok: !!cond, detail: detail }; }
  function before(a, b) { return !!(a && b && (a.compareDocumentPosition(b) & 4)); }
  function name(b) { return norm(b.getAttribute("aria-label") || text(b)); }

  var TITLE = "Coordinator booking";
  var INTRO = "The offshore team who book and move customers' calls by phone. Slate opens no other page to them.";
  var SECTION = "Scheduling coordinators";
  var HEADING = "Coordinator calls nobody is free for";
  var RULE = "Only scheduling coordinators, booking on their own page, can ever put a call on Marcia, Pennie's AI agent. Leads booking on the website never can.";
  var OFF = "Off. A coordinator who tries to book one is refused.";
  var ON = "On. A coordinator can book one on Marcia, and Regal rings it to whichever advisor is free.";
  var TURN_ON = "Let coordinators book on Marcia";
  var TURN_OFF = "Stop booking them on Marcia";
  var CONFIRM_ON = "From the next booking, a coordinator can book a time no advisor is free for. The call goes on Marcia, and Regal rings it to whichever advisor is free when it comes up. You can turn this off again here.";
  var EMPTY = "Nobody has coordinator access yet. You give it on Team access.";
  var FAILED = "Could not read who has coordinator access. Nobody's access has changed. Reload the page to try again.";
  var REMOVE_AISHA = "Aisha Bello will no longer be able to sign in to Slate or book calls. The calls Aisha has already booked stay as they are.";
  var PEOPLE = [
    "Aisha Bello abello@trypennie.com 2 hours ago Remove",
    "Grace Okafor gokafor@trypennie.com yesterday Remove",
    "Marco Delgado mdelgado@trypennie.com today Remove",
    "Priya Raman praman@trypennie.com 4 days ago Remove",
    "Tomas Rivera trivera@trypennie.com 38 days ago Remove",
  ];

  function section(doc) {
    var h2 = all(main(doc), "h2").filter(function (h) { return text(h) === SECTION; })[0];
    return h2 ? h2.closest("section") : null;
  }
  function switchHeading(doc) { return all(main(doc), "h3").filter(function (h) { return text(h) === HEADING; })[0] || null; }
  // The switch: the smallest element holding its heading and its button or question.
  function switchBox(doc) {
    var h = switchHeading(doc);
    var box = h && h.parentElement;
    while (box && !box.querySelector("button")) box = box.parentElement;
    return box;
  }
  function paragraphs(root) { return all(root, "p").map(text); }
  // The colour an element draws its text in, against the product's own error token.
  function isErrorColour(el) {
    var probe = el.ownerDocument.createElement("span");
    probe.style.color = "var(--error)";
    el.parentElement.append(probe);
    var want = el.ownerDocument.defaultView.getComputedStyle(probe).color;
    probe.remove();
    return el.ownerDocument.defaultView.getComputedStyle(el).color === want;
  }
  function bodyRows(doc) {
    var s = section(doc), t = s && s.querySelector("table");
    return t ? all(t, "tbody tr") : [];
  }

  window.DESIGN_CHECKS = [
    { id: "D1", frames: ["f-off", "f-confirm-on", "f-on", "f-remove", "f-empty", "f-failed", "d-off"], check: function (doc) {
      var h1 = main(doc).querySelector("h1");
      var nav = doc.querySelector('nav[aria-label="Admin sections"]');
      var current = nav && nav.querySelector('a[aria-current="page"]');
      var group = nav && all(nav, "h2").filter(function (h) { return text(h) === "Bookings"; })[0];
      var links = group ? all(group.parentElement, "a").map(text) : [];
      return ok(text(h1) === TITLE && current && text(current) === TITLE && links[0] === "Look up a booking" && links[1] === TITLE,
        "h1 '" + text(h1) + "', current '" + text(current) + "', Bookings " + JSON.stringify(links));
    } },
    { id: "D4", frames: ["f-off", "f-confirm-on", "f-on", "f-remove", "f-empty", "f-failed", "d-off"], check: function (doc) {
      var h2s = all(main(doc), "h2").map(text), s = section(doc), h = switchHeading(doc);
      var list = s && (s.querySelector("table") ||
        all(s, "[role=alert]").filter(function (a) { return !a.querySelector("button"); })[0] ||
        all(s, "p").filter(function (p) { return text(p) === EMPTY; })[0]);
      return ok(JSON.stringify(h2s) === JSON.stringify([SECTION]) && s && s.contains(h) && before(h, list),
        "h2s " + JSON.stringify(h2s) + ", switch before list: " + before(h, list));
    } },
    { id: "D5", frames: ["f-off", "f-confirm-on", "f-on", "f-remove", "f-empty", "f-failed", "d-off"], check: function (doc) {
      var h1 = main(doc).querySelector("h1"), next = h1 && h1.nextElementSibling;
      return ok(text(next) === INTRO, "after h1 '" + text(next) + "'");
    } },
    { id: "D6", frames: ["f-off", "f-confirm-on", "f-on", "f-remove", "f-empty", "f-failed", "d-off"], check: function (doc) {
      var h = switchHeading(doc), rule = h && h.nextElementSibling;
      return ok(h && text(rule) === RULE, "heading " + !!h + ", rule '" + text(rule) + "'");
    } },
    { id: "D7", frames: ["f-off", "f-remove", "f-empty", "f-failed", "d-off"], check: function (doc) {
      var box = switchBox(doc), ps = box ? paragraphs(box) : [];
      var bs = box ? all(box, "button") : [];
      var b = bs[0];
      return ok(ps.indexOf(OFF) >= 0 && ps.indexOf(ON) < 0 && bs.length === 1 && name(b) === TURN_ON && isErrorColour(b),
        "lines " + JSON.stringify(ps) + ", buttons " + JSON.stringify(bs.map(name)) + ", error colour " + (b ? isErrorColour(b) : "n/a"));
    } },
    { id: "D8", frames: ["f-confirm-on"], check: function (doc) {
      var box = switchBox(doc), a = box && box.querySelector("[role=alert]");
      var bs = a ? all(a, "button") : [];
      var msg = a ? text(a.querySelector("p")) : "";
      return ok(msg === CONFIRM_ON && bs.length === 2 && name(bs[0]) === TURN_ON && isErrorColour(bs[0]) && name(bs[1]) === "Cancel" && !isErrorColour(bs[1]),
        "message '" + msg + "', buttons " + JSON.stringify(bs.map(name)));
    } },
    { id: "D9", frames: ["f-on"], check: function (doc) {
      var box = switchBox(doc), ps = box ? paragraphs(box) : [], bs = box ? all(box, "button") : [];
      return ok(ps.indexOf(ON) >= 0 && ps.indexOf(OFF) < 0 && bs.length === 1 && name(bs[0]) === TURN_OFF && !box.querySelector("[role=alert]"),
        "lines " + JSON.stringify(ps) + ", buttons " + JSON.stringify(bs.map(name)));
    } },
    { id: "D10", frames: ["f-off", "f-confirm-on", "f-on", "d-off"], check: function (doc) {
      var s = section(doc), t = s && s.querySelector("table");
      var heads = t ? all(t, "thead th").map(text) : [];
      var rows = bodyRows(doc).map(text);
      return ok(JSON.stringify(heads) === JSON.stringify(["Coordinator", "Last signed in", "Remove"]) && JSON.stringify(rows) === JSON.stringify(PEOPLE),
        "headers " + JSON.stringify(heads) + ", rows " + JSON.stringify(rows));
    } },
    { id: "D11", frames: ["f-off", "f-confirm-on", "f-on", "d-off"], check: function (doc) {
      var rows = bodyRows(doc), bad = [];
      rows.forEach(function (r) {
        var who = text(r.querySelector("td p")), b = r.querySelector("button");
        if (!b || name(b) !== "Remove " + who || isErrorColour(b)) bad.push(who);
      });
      return ok(rows.length === 5 && bad.length === 0, rows.length + " rows, wrong: " + JSON.stringify(bad));
    } },
    { id: "D12", frames: ["f-remove"], check: function (doc) {
      var rows = bodyRows(doc);
      var aisha = rows.filter(function (r) { return text(r.querySelector("td p")) === "Aisha Bello"; })[0];
      var next = aisha && aisha.nextElementSibling, a = next && next.querySelector("[role=alert]");
      var bs = a ? all(a, "button").map(name) : [];
      return ok(a && text(a.querySelector("p")) === REMOVE_AISHA && JSON.stringify(bs) === JSON.stringify(["Remove Aisha Bello", "Cancel"]) && !aisha.querySelector("button"),
        "question '" + (a ? text(a.querySelector("p")) : "") + "', buttons " + JSON.stringify(bs));
    } },
    { id: "D13", frames: ["f-empty"], check: function (doc) {
      var s = section(doc), ps = s ? paragraphs(s) : [];
      return ok(s && !s.querySelector("table") && ps.indexOf(EMPTY) >= 0, "table " + !!(s && s.querySelector("table")) + ", lines " + JSON.stringify(ps));
    } },
    { id: "D14", frames: ["f-failed"], check: function (doc) {
      var s = section(doc), ps = s ? paragraphs(s) : [];
      var alerts = s ? all(s, "[role=alert]").map(text) : [];
      return ok(s && !s.querySelector("table") && ps.indexOf(EMPTY) < 0 && alerts.indexOf(FAILED) >= 0,
        "table " + !!(s && s.querySelector("table")) + ", alerts " + JSON.stringify(alerts));
    } },
    { id: "D15", frames: ["d-off"], check: function (doc) {
      var theme = doc.documentElement.getAttribute("data-theme");
      return ok(theme === "dark", "data-theme " + theme);
    } },
  ];
})();
