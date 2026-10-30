// The checks for the settled partner sign in page (#4379, #4399, #4411), one per checked
// decision in its decision map. Each reads only what the design and the build share: text,
// roles, element order and a link's target. None reads a styling class or an id the builder
// chose. D3 (the staff login is unchanged) is proven elsewhere, by src/app/login/page.test.tsx.

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
  // The sign in card: the element holding the page's heading.
  function card(doc) {
    var h1 = main(doc).querySelector("h1");
    return h1 ? h1.parentElement : null;
  }
  // The photograph panel's paragraphs, in order: the first section of the page, beside the card.
  function panelWords(doc) {
    var panel = main(doc).querySelector("section");
    return panel ? all(panel, "p") : [];
  }

  var HEADING = "Sign in to book calls";
  var LINE = "Sign in with your work Microsoft account to book calls for Pennie's customers.";
  var BUTTON = "Continue with Microsoft";
  var PANEL_HEADLINE = "Booking for Pennie.";
  var PANEL_LINE = "Help Pennie's customers talk to an advisor, now or at a time that suits them.";
  var STAFF_LINE = "Pennie staff? Sign in on the staff page";
  var STAFF_LINK = "Sign in on the staff page";
  var STAFF_PAGE = "/login";

  window.DESIGN_CHECKS = [
    { id: "D1", frames: ["f1"], check: function (doc) {
      var c = card(doc);
      var inCard = c ? all(c, "button, [role=button]") : [];
      var onPage = all(main(doc), "button, [role=button]");
      var google = /google/i.test(text(main(doc)));
      return ok(inCard.length === 1 && text(inCard[0]) === BUTTON && onPage.length === 1 && !google,
        "card buttons " + JSON.stringify(inCard.map(text)) + ", page buttons " + onPage.length + ", mentions Google " + google);
    } },
    { id: "D2", frames: ["f1"], check: function (doc) {
      var h1 = main(doc).querySelector("h1");
      var line = h1 ? h1.nextElementSibling : null;
      return ok(text(h1) === HEADING && line && line.tagName === "P" && text(line) === LINE,
        "heading '" + text(h1) + "', line '" + text(line) + "'");
    } },
    { id: "D4", frames: ["f1"], check: function (doc) {
      var ps = panelWords(doc);
      return ok(ps.length === 2 && text(ps[0]) === PANEL_HEADLINE, "panel paragraphs " + JSON.stringify(ps.map(text)));
    } },
    { id: "D5", frames: ["f1"], check: function (doc) {
      var ps = panelWords(doc);
      return ok(ps.length === 2 && text(ps[1]) === PANEL_LINE, "panel paragraphs " + JSON.stringify(ps.map(text)));
    } },
    { id: "D6", frames: ["f1"], check: function (doc) {
      var c = card(doc);
      var button = c ? all(c, "button, [role=button]").filter(function (b) { return text(b) === BUTTON; })[0] : null;
      if (!button) return ok(false, "no Continue with Microsoft button in the card");
      // The first element after the button, in the card, that says anything.
      var after = button.nextElementSibling;
      while (after && !text(after)) after = after.nextElementSibling;
      var link = after ? after.querySelector("a") : null;
      var href = link ? link.getAttribute("href") : null;
      return ok(after && after.tagName === "P" && text(after) === STAFF_LINE && text(link) === STAFF_LINK && href === STAFF_PAGE,
        "after the button '" + text(after) + "', link '" + text(link) + "' to " + JSON.stringify(href));
    } },
  ];
})();
