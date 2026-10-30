// The checks for the settled partner sign in panel (#4399), one per checked decision in its
// decision map. Each reads only what the design and the build share: text and element order.
// The photograph panel is the first section of the page's main, the one beside the sign in
// card; its words are the paragraphs inside it, the headline first and the line after it.
// None reads a styling class or an id the builder chose.

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
  // The photograph panel's paragraphs, in order.
  function panelWords(doc) {
    var main = doc.querySelector("main");
    var panel = main ? main.querySelector("section") : null;
    return panel ? Array.prototype.slice.call(panel.querySelectorAll("p")) : [];
  }

  var HEADLINE = "Booking for Pennie.";
  var LINE = "Help Pennie's customers talk to an advisor, now or at a time that suits them.";

  window.DESIGN_CHECKS = [
    { id: "D1", frames: ["f1"], check: function (doc) {
      var ps = panelWords(doc);
      return ok(ps.length === 2 && text(ps[0]) === HEADLINE,
        "panel paragraphs " + JSON.stringify(ps.map(text)));
    } },
    { id: "D2", frames: ["f1"], check: function (doc) {
      var ps = panelWords(doc);
      return ok(ps.length === 2 && text(ps[1]) === LINE,
        "panel paragraphs " + JSON.stringify(ps.map(text)));
    } },
  ];
})();
