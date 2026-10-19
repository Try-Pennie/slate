// The decision checks for the Team capacity design (docs/design/team-capacity.html), one entry per
// decision in its decision map (D1 to D28); D25 has no on screen form, so it is listed and not
// scored. Each runs in the browser against ONE rendered frame,
// either a design frame or the built page rendering the same fixture, and reads only what both
// sides share: the data-tc hooks, visible text, roles and computed colours. Never a styling class,
// since the build draws with Tailwind and the design does not.
//
// Loaded by scripts/design-match/score.ts (claude-config#1364 is the general version).
// window.TC_CHECKS = [{ id, frames, check(doc, ctx) -> { ok, detail } }], where ctx carries the
// fixture and the frame's own variant. A decision with no on screen form says so in `offScreen`
// and is proven elsewhere; it is left out of the screen score and reported by name.
(function () {
  var q = function (doc, tc) { return Array.prototype.slice.call(doc.querySelectorAll('[data-tc="' + tc + '"]')); };
  var one = function (doc, tc) { return doc.querySelector('[data-tc="' + tc + '"]'); };
  var text = function (n) { return n ? n.textContent.replace(/\s+/g, " ").trim() : ""; };
  var rgb = function (doc, n, prop) { return n ? doc.defaultView.getComputedStyle(n)[prop] : ""; };
  var pass = function (detail) { return { ok: true, detail: detail || "" }; };
  var fail = function (detail) { return { ok: false, detail: detail }; };
  var before = function (a, b) { return !!(a && b && (a.compareDocumentPosition(b) & 4)); };

  // The team totals the cards must show, from the fixture, by the settled rules: out and
  // not syncing advisors count in neither number, and the percent rounds down.
  function expectedTotals(ctx, dayIdx) {
    var open = 0, cap = 0, out = 0, unsynced = 0;
    ctx.fixture.advisors.forEach(function (a) {
      var d = a.days[dayIdx];
      if (ctx.unsynced.indexOf(a.name) >= 0) { unsynced++; return; }
      if (d.out) { out++; return; }
      open += d.open; cap += d.capacity;
    });
    var full = cap ? (open === 0 ? 100 : Math.min(99, Math.floor(100 * (1 - open / cap)))) : null;
    return { open: open, cap: cap, out: out, unsynced: unsynced, full: full };
  }

  var ALL = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9"];
  var LIGHT = ["f1", "f3", "f4", "f5", "f7", "f8", "f9"];

  window.TC_CHECKS = [
    { id: "D1", frames: ["f1"], check: function (doc) {
      var h1 = doc.querySelector("main h1");
      if (text(h1) !== "Team capacity") return fail("page heading is '" + text(h1) + "'");
      var cur = doc.querySelector('nav[aria-label="Admin sections"] a[aria-current="page"]');
      if (text(cur) !== "Team capacity") return fail("current sidebar item is '" + text(cur) + "'");
      var bucket = Array.prototype.find.call(doc.querySelectorAll('nav[aria-label="Admin sections"] a'), function (a) { return text(a) === "Bucket availability"; });
      if (!before(bucket, cur)) return fail("Team capacity is not after Bucket availability");
      return pass();
    } },
    { id: "D2", frames: ["f1"], check: function (doc) {
      return before(q(doc, "day-card")[0], one(doc, "lane-row")) ? pass() : fail("the day cards do not come before the advisors");
    } },
    { id: "D3", frames: ALL, check: function (doc, ctx) {
      var cards = q(doc, "day-card");
      if (cards.length !== ctx.fixture.offeredOpenDays) return fail(cards.length + " day cards found");
      for (var i = 0; i < cards.length; i++) {
        var want = expectedTotals(ctx, i).open;
        var got = Number(text(cards[i].querySelector('[data-tc="calls-open"]')).replace(/,/g, ""));
        if (got !== want) return fail("card " + (i + 1) + " shows " + got + " calls open, the fixture gives " + want);
      }
      return pass();
    } },
    { id: "D4", frames: ["f1"], check: function (doc, ctx) {
      var n = q(doc, "day-card").length;
      return n === ctx.fixture.offeredOpenDays ? pass() : fail(n + " day cards, the window is " + ctx.fixture.offeredOpenDays);
    } },
    { id: "D5", frames: ["f1"], check: function (doc) {
      var c = q(doc, "day-card")[0];
      if (!c) return fail("no day cards");
      var order = ["calls-open", "full-bar", "pct", "out-count"].map(function (t) { return c.querySelector('[data-tc="' + t + '"]'); });
      if (order.some(function (n) { return !n; })) return fail("a card is missing calls open, its bar, its percent or its out count");
      for (var i = 1; i < order.length; i++) if (!before(order[i - 1], order[i])) return fail("card order is not calls open, bar, percent, out");
      return pass();
    } },
    { id: "D6", frames: ALL, check: function (doc, ctx) {
      var cards = q(doc, "day-card");
      if (cards.length !== ctx.fixture.offeredOpenDays) return fail(cards.length + " day cards found");
      for (var i = 0; i < cards.length; i++) {
        var want = expectedTotals(ctx, i).full;
        var m = /^(\d+)% full/.exec(text(cards[i].querySelector('[data-tc="pct"]')));
        if (!m || Number(m[1]) !== want) return fail("card " + (i + 1) + " reads '" + text(cards[i].querySelector('[data-tc="pct"]')) + "', expected " + want + "% full");
      }
      return pass();
    } },
    { id: "D7", frames: ["f1"], check: function (doc, ctx) {
      var cards = q(doc, "day-card"), tabs = q(doc, "day-tab");
      if (cards.length !== ctx.fixture.offeredOpenDays) return fail(cards.length + " day cards found");
      for (var i = 0; i < cards.length; i++) {
        var t = expectedTotals(ctx, i), flagged = t.full >= ctx.nearlyFull && t.open > 0;
        var chip = cards[i].querySelector('[data-tc="flag"]');
        if (flagged !== (text(chip) === "Nearly full")) return fail("card " + (i + 1) + " flag is '" + text(chip) + "' at " + t.full + "%");
        if (flagged && rgb(doc, chip, "backgroundColor") !== "rgb(255, 208, 115)") return fail("the Nearly full chip is " + rgb(doc, chip, "backgroundColor") + ", not mustard");
        var dot = tabs[i] && tabs[i].querySelector('[data-tc="tab-flag"]');
        if (flagged && !dot) return fail("tab " + (i + 1) + " has no flag dot");
      }
      return pass();
    } },
    { id: "D8", frames: ["f6"], check: function (doc) {
      var first = q(doc, "day-card")[0];
      if (!first) return fail("no day cards");
      var chip = first.querySelector('[data-tc="flag"]');
      if (text(chip) !== "Full") return fail("today's chip reads '" + text(chip) + "'");
      return rgb(doc, chip, "backgroundColor") === "rgb(196, 61, 61)" ? pass() : fail("the Full chip is " + rgb(doc, chip, "backgroundColor"));
    } },
    { id: "D9", frames: ["f1", "f5"], check: function (doc, ctx) {
      if (ctx.frame === "f1") {
        var line = one(doc, "nearly-full-line");
        if (!line) return fail("no nearly full line");
        if (text(line).indexOf("Nearly full at " + ctx.nearlyFull + "% full or more.") !== 0) return fail("the line reads '" + text(line) + "'");
        var b = line.querySelector("button");
        return b && text(b) === "Change" ? pass() : fail("Change is not a button");
      }
      var form = one(doc, "nearly-full-form");
      var input = form && form.querySelector("input");
      if (!input || input.value !== String(ctx.nearlyFull)) return fail("no input holding " + ctx.nearlyFull + " when Change is open");
      return /Save/.test(text(form)) && /Cancel/.test(text(form)) ? pass() : fail("the open form lacks Save or Cancel");
    } },
    { id: "D10", frames: ["f1"], check: function (doc, ctx) {
      var n = q(doc, "lane-row").length;
      return n === ctx.fixture.advisors.length ? pass() : fail(n + " advisor rows, the fixture has " + ctx.fixture.advisors.length);
    } },
    { id: "D11", frames: ["f1"], check: function (doc, ctx) {
      var names = q(doc, "advisor").map(text);
      if (names.length !== ctx.fixture.advisors.length) return fail(names.length + " advisor names found");
      var sorted = names.slice().sort(function (a, b) { return a.localeCompare(b); });
      return names.join("|") === sorted.join("|") ? pass() : fail("advisors are not in name order");
    } },
    { id: "D12", frames: ["f1"], check: function (doc) {
      var sel = doc.querySelector('[data-tc="day-tab"][data-selected="true"]');
      if (!sel) return fail("no selected day tab");
      if (!/^Tomorrow/.test(text(sel))) return fail("the page opens on '" + text(sel) + "'");
      return before(q(doc, "day-card")[0], q(doc, "day-tab")[0]) ? pass() : fail("the tabs are not below the cards");
    } },
    { id: "D13", frames: ["f1", "f2", "f3", "f4", "f5", "f7", "f8", "f9"], check: function (doc) {
      // Used up time is always the stronger, filled mark; open room is the empty box (Dan,
      // 2026-10-19, after the literal "dark means used up" inverted in the dark theme).
      var taken = one(doc, "taken"), open = one(doc, "open-call");
      if (!taken) return fail("no used up time drawn");
      var probe = doc.createElement("div"); probe.style.background = "var(--surface)"; doc.body.append(probe);
      var surface = doc.defaultView.getComputedStyle(probe).backgroundColor; probe.remove();
      if (rgb(doc, taken, "backgroundColor") === surface) return fail("used up time is not filled");
      if (open && rgb(doc, open, "backgroundColor") !== surface) return fail("an open call is filled, not an empty box");
      return pass();
    } },
    { id: "D14", frames: LIGHT, check: function (doc) {
      if (!one(doc, "taken")) return fail("no used up time drawn");
      var c = rgb(doc, one(doc, "taken"), "backgroundColor");
      return c === "rgb(60, 152, 218)" ? pass() : fail("used up time is " + c);
    } },
    { id: "D15", frames: ["f1"], check: function (doc) {
      var o = one(doc, "open-call");
      if (!o) return fail("no open call drawn");
      var shadow = rgb(doc, o, "boxShadow"), border = rgb(doc, o, "borderTopColor");
      return /rgb\(60, 152, 218\)/.test(shadow + " " + border) ? pass() : fail("an open call is not outlined in the used up blue");
    } },
    { id: "D16", frames: ["f1"], check: function (doc) {
      var ticks = q(doc, "tick").map(text);
      if (ticks[0] !== "8am" || ticks[ticks.length - 1] !== "9pm") return fail("the axis runs " + ticks[0] + " to " + ticks[ticks.length - 1]);
      var row = q(doc, "lane-row").find(function (r) { return r.querySelector('[data-tc="off-shift"]'); });
      var off = row && row.querySelector('[data-tc="off-shift"]');
      if (!off || !/repeating-linear-gradient/.test(rgb(doc, off, "backgroundImage"))) return fail("time outside the shift is not striped");
      var cnt = row.querySelector('[data-tc="open-count"]'), lane = off.parentElement;
      if (!cnt) return fail("no Open count on the advisor rows");
      var gap = cnt.getBoundingClientRect().left - lane.getBoundingClientRect().right;
      return gap >= 16 ? pass() : fail("only " + Math.round(gap) + "px between the timeline and the Open count");
    } },
    { id: "D17", frames: ["f4"], check: function (doc, ctx) {
      var row = q(doc, "lane-row").find(function (r) { return text(r.querySelector('[data-tc="advisor"]')) === ctx.timeOff; });
      var t = row && row.querySelector('[data-tc="time-off"]');
      return t && /repeating-linear-gradient/.test(rgb(doc, t, "backgroundImage")) ? pass() : fail("the hour off is not striped on " + ctx.timeOff + "'s row");
    } },
    { id: "D18", frames: ["f1"], check: function (doc) {
      var w = one(doc, "whole-day");
      return w && text(w) === "Out, approved time off" ? pass() : fail("no grey bar reading Out, approved time off");
    } },
    { id: "D19", frames: ["f3"], check: function (doc, ctx) {
      var row = q(doc, "lane-row").find(function (r) { return text(r.querySelector('[data-tc="advisor"]')) === ctx.unsynced[0]; });
      if (!row || !row.querySelector('[data-state="not-syncing"]')) return fail("the not syncing lane is not marked");
      if (!/Calendar not syncing/.test(text(row))) return fail("the lane does not say Calendar not syncing");
      var c0 = q(doc, "day-card")[0];
      return c0 && text(c0.querySelector('[data-tc="not-counted"]')) === "1 not counted" ? pass() : fail("the card does not say 1 not counted");
    } },
    { id: "D20", frames: ["f3"], check: function (doc) {
      if (!one(doc, "now")) return fail("no Now line");
      if (text(one(doc, "now-label")) !== "Now") return fail("no Now label on the axis");
      return one(doc, "gone") ? pass() : fail("today's past hours are not drawn");
    } },
    { id: "D21", frames: ["f1"], check: function (doc) {
      var names = q(doc, "advisor");
      return names.length && names.every(function (n) { return n.tagName === "A"; }) ? pass() : fail("not every advisor name is a link");
    } },
    { id: "D22", frames: ["f1", "f7"], check: function (doc, ctx) {
      var btn = Array.prototype.find.call(doc.querySelectorAll("button"), function (b) { return text(b) === "Pick a date"; });
      if (!btn) return fail("no Pick a date button");
      if (!q(doc, "day-tab").length || !before(q(doc, "day-tab").slice(-1)[0], btn)) return fail("Pick a date is not at the end of the tabs");
      if (ctx.frame === "f1") return pass();
      var dlg = one(doc, "date-picker");
      if (!dlg || !/October 2026/.test(text(dlg))) return fail("the month calendar is not open");
      var sun = Array.prototype.filter.call(dlg.querySelectorAll("[aria-disabled='true']"), function (c) { return text(c) === "18"; });
      return sun.length ? pass() : fail("Sunday the 18th can be picked");
    } },
    { id: "D23", frames: ["f8"], check: function (doc) {
      return text(one(doc, "day-note")) === "Leads can't book this day yet, so it will fill up more than it shows." ? pass() : fail("the note reads '" + text(one(doc, "day-note")) + "'");
    } },
    { id: "D24", frames: ["f9"], check: function (doc) {
      if (!/^Ended \d+% full, with room left for [\d,]+ more calls\.$/.test(text(one(doc, "day-note")))) return fail("the summary reads '" + text(one(doc, "day-note")) + "'");
      return one(doc, "open-call") ? pass() : fail("unused room is not drawn");
    } },
    { id: "D25", frames: [], offScreen: "History is stored as each half hour passes: proven by the history lane's own tests, not on screen." },
    { id: "D26", frames: ["f10"], check: function (doc) {
      var f = one(doc, "failed");
      if (!f || !/^Couldn't load advisor calendars/.test(text(f))) return fail("no failure card naming the read");
      return !one(doc, "day-card") && !one(doc, "lane-row") ? pass() : fail("numbers are shown beside the failure");
    } },
    { id: "D27", frames: LIGHT, check: function (doc) {
      var t = doc.querySelector('[data-tc="day-tab"][data-selected="true"]');
      if (!t) return fail("no selected day tab");
      var bg = rgb(doc, t, "backgroundColor"), fg = rgb(doc, t, "color");
      return bg === "rgb(130, 208, 255)" && fg === "rgb(52, 52, 52)" ? pass() : fail("the selected tab is " + fg + " on " + bg);
    } },
    { id: "D28", frames: ["f2"], check: function (doc) {
      var root = doc.documentElement, theme = root.getAttribute("data-theme");
      var token = doc.defaultView.getComputedStyle(root).getPropertyValue("--surface").trim();
      var card = q(doc, "day-card").find(function (c) { return !c.querySelector('[data-tc="flag"]'); });
      if (theme !== "dark") return fail("the frame is not in the dark theme");
      if (!card) return fail("no unflagged day card");
      var probe = doc.createElement("div"); probe.style.background = token; doc.body.append(probe);
      var want = doc.defaultView.getComputedStyle(probe).backgroundColor; probe.remove();
      return rgb(doc, card, "backgroundColor") === want ? pass() : fail("an unflagged card is " + rgb(doc, card, "backgroundColor") + ", the surface token is " + want);
    } }
  ];
})();
