// The checks for the settled partner sign in staff link (#4411), one per checked decision in
// its decision map. Each reads only what the design and the build share: text, roles, element
// order and the link's target. None reads a styling class or an id the builder chose.
//
// The design's drawing gives its link a placeholder target ("#"), since a settled file is a page
// of its own with nowhere to go. So the link's target is held to /login on the built page, the
// one served over http, and the design's placeholder is accepted only on the design's own page.

(function () {
  function norm(t) { return (t || "").replace(/\s+/g, " ").trim(); }
  // An element's words, its text pieces joined by spaces, as a reader sees them across lines.
  function text(el) {
    if (!el) return "";
    var parts = [], w = el.ownerDocument.createTreeWalker(el, 4);
    while (w.nextNode()) parts.push(w.currentNode.nodeValue);
    return norm(parts.join(" "));
  }
  function ok(cond, detail) { return { ok: !!cond, detail: detail }; }

  var BUTTON = "Continue with Microsoft";
  var LINE = "Pennie staff? Sign in on the staff page";
  var LINK = "Sign in on the staff page";
  var STAFF_PAGE = "/login";

  window.DESIGN_CHECKS = [
    { id: "D1", frames: ["f1"], check: function (doc) {
      var main = doc.querySelector("main") || doc.body;
      var button = Array.prototype.slice.call(main.querySelectorAll("button, [role=button]"))
        .filter(function (b) { return text(b) === BUTTON; })[0];
      if (!button) return ok(false, "no Continue with Microsoft button");
      // The first element after the button, in the card, that says anything.
      var after = button.nextElementSibling;
      while (after && !text(after)) after = after.nextElementSibling;
      var link = after ? after.querySelector("a") : null;
      var href = link ? link.getAttribute("href") : null;
      var built = /^https?:/.test(doc.location.href);
      var target = built ? href === STAFF_PAGE : href === STAFF_PAGE || href === "#";
      return ok(after && after.tagName === "P" && text(after) === LINE && text(link) === LINK && target,
        "after the button '" + text(after) + "', link '" + text(link) + "' to " + JSON.stringify(href) +
        (built ? " on the built page" : " on the design's page"));
    } },
  ];
})();
