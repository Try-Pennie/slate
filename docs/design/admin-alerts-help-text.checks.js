// The decision checks for the /admin/alerts switch design (docs/design/admin-alerts-help-text.html),
// one entry per decision its map verifies by a check (D1, D2, D4, D5, D6; D3 rests on the pictures,
// D7 and D8 are proven elsewhere). Each runs in the browser against ONE rendered frame, either a
// design frame or the built page's `?frame=` preview drawing the same fixture, and reads only what
// both sides share: each box's name and ticked state, the help its aria-describedby names, and text.
//
// Loaded by the design match score's web adapter: window.DESIGN_CHECKS = [{ id, frames, check(doc,
// ctx) -> { ok, detail } }], ctx = { frame, fixture } with the committed fixture
// (docs/design/fixtures/admin-alerts-help-text.json) as it is on disk.
(function () {
  var text = function (n) { return n ? n.textContent.replace(/\s+/g, " ").trim() : ""; };
  var pass = function (detail) { return { ok: true, detail: detail || "" }; };
  var fail = function (detail) { return { ok: false, detail: detail }; };
  var box = function (doc, name) { return doc.querySelector('input[type="checkbox"][name="' + name + '"]'); };
  var help = function (doc, name) {
    var b = box(doc, name);
    var id = b && b.getAttribute("aria-describedby");
    return id ? text(doc.getElementById(id)) : "";
  };
  var each = function (ctx, fn) {
    var frame = ctx.fixture.frames[ctx.frame];
    if (!frame) return fail("the fixture names no frame " + ctx.frame);
    for (var i = 0; i < ctx.fixture.switches.length; i++) {
      var s = ctx.fixture.switches[i];
      var why = fn(s, frame.armed[s.name] === true);
      if (why) return fail(why);
    }
    return pass();
  };

  window.DESIGN_CHECKS = [
    {
      id: "D1",
      frames: ["f1", "f2"],
      check: function (doc, ctx) {
        return each(ctx, function (s, on) {
          var b = box(doc, s.name);
          if (!b) return "no box named " + s.name;
          if (b.checked !== on) return s.name + " is " + (b.checked ? "ticked" : "clear") + ", the frame has it " + (on ? "on" : "off");
          var h = help(doc, s.name);
          var want = on ? s.on : s.off, other = on ? s.off : s.on;
          if (h !== want) return s.name + " reads '" + h + "', expected '" + want + "'";
          if (h.indexOf(other) >= 0) return s.name + " also carries the other state's sentence";
          if (/\b(On|Off):/.test(h)) return s.name + " carries an On: or Off: label";
          return "";
        });
      },
    },
    {
      id: "D2",
      frames: ["f1", "f2"],
      check: function (doc) {
        var slot = doc.getElementById("alert-switches");
        var card = slot && (slot.closest("section") || slot);
        if (!card) return fail("no alerting card");
        var t = text(card);
        var m = t.match(/nobody is notified|Saving applies|no deploy needed/i);
        return m ? fail("the card still says '" + m[0] + "'") : pass();
      },
    },
    {
      id: "D4",
      frames: ["f1"],
      check: function (doc) {
        var b = box(doc, "below_lead_tier_armed");
        if (!b || !b.checked) return fail("the below tier box is not ticked on this frame");
        var h = help(doc, "below_lead_tier_armed");
        if (!/one alert per call/i.test(h)) return fail("the below tier sentence reads '" + h + "'");
        return /follow up/i.test(h) ? fail("the below tier sentence promises a follow up") : pass();
      },
    },
    {
      id: "D5",
      frames: ["f2"],
      check: function (doc) {
        var b = box(doc, "below_lead_tier_armed");
        if (!b || b.checked) return fail("the below tier box is not clear on this frame");
        var h = help(doc, "below_lead_tier_armed");
        return /Turn this on before cutover/.test(h) ? pass() : fail("the below tier sentence reads '" + h + "'");
      },
    },
    {
      id: "D6",
      frames: ["f1", "f2"],
      check: function (doc, ctx) {
        return each(ctx, function (s, on) {
          if (on) return "";
          var h = help(doc, s.name);
          if (/leave this off/i.test(h)) return s.name + " still asks to wait: '" + h + "'";
          if (s.name === "low_volume_armed" && !/Turn this on once the traffic the floors were measured on reaches Slate/.test(h)) {
            return "bookings drop off lost its reason to wait: '" + h + "'";
          }
          return "";
        });
      },
    },
  ];
})();
