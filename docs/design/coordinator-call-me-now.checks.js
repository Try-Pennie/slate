// The checks for the settled live transfer offer on the coordinator page (#4380), one per checked
// decision in docs/design/coordinator-call-me-now.html. Each reads only what the design and the
// build share: text, element kinds, roles and layout. None reads a styling class or an id the
// builder chose. The transfer line comes from the committed fixture when the score hands it in.

(function () {
  function norm(t) { return (t || "").replace(/\s+/g, " ").trim(); }
  function text(el) {
    if (!el) return "";
    var parts = [], w = el.ownerDocument.createTreeWalker(el, 4);
    while (w.nextNode()) parts.push(w.currentNode.nodeValue);
    return norm(parts.join(" "));
  }
  function all(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  function main(doc) { return doc.querySelector("main") || doc.body; }
  function shown(el) {
    if (!el) return false;
    var cs = el.ownerDocument.defaultView.getComputedStyle(el), r = el.getBoundingClientRect();
    return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
  }
  function headed(doc, name) {
    var h = all(main(doc), "h2, h3").filter(function (x) { return text(x) === name; })[0];
    return h ? h.closest("section") : null;
  }
  function offer(doc) { return headed(doc, "Advisors are free now"); }
  function customerCard(doc) { return headed(doc, "Customer"); }
  // The booking card: the section holding the group labelled Day.
  function bookingCard(doc) {
    var label = all(main(doc), "[id]").filter(function (el) { return text(el) === "Day"; })[0];
    var group = label && main(doc).querySelector("[role=group][aria-labelledby~='" + label.id + "']");
    return group ? group.closest("section") : null;
  }
  function before(a, b) { return !!(a && b && a !== b && (a.compareDocumentPosition(b) & 4)); }
  function line(ctx) { return (ctx && ctx.fixture && ctx.fixture.transferLine) || "786-504-0671"; }
  function ok(cond, detail) { return { ok: !!cond, detail: detail }; }

  window.DESIGN_CHECKS = [
    { id: "D1", frames: ["f1"], check: function (doc) {
      var card = offer(doc), cust = customerCard(doc), book = bookingCard(doc);
      return ok(card && shown(card) && before(cust, card) && before(card, book),
        "offer card: " + !!card + ", after the customer card: " + before(cust, card) + ", before the booking card: " + before(card, book));
    } },
    { id: "D2", frames: ["f1"], check: function (doc, ctx) {
      var card = offer(doc), want = line(ctx);
      var times = text(main(doc)).split(want).length - 1;
      var inCard = card && text(card).indexOf(want) !== -1;
      var button = card && all(card, "button").filter(function (b) { return norm(b.textContent) === "Transfer now"; })[0];
      return ok(times === 1 && inCard && button && shown(button),
        want + " shown " + times + " time(s), in the card: " + !!inCard + ", Transfer now button: " + !!button);
    } },
    { id: "D3", frames: ["f1"], check: function (doc) {
      var card = offer(doc), book = bookingCard(doc);
      var says = card && text(card).indexOf("If it doesn't connect, book a time below.") !== -1;
      return ok(says && book && shown(book) && before(card, book),
        "fallback line: " + !!says + ", booking card shown below: " + !!(book && shown(book) && before(card, book)));
    } },
  ];
})();
