// The decision checks for the Team capacity design (docs/design/team-capacity.html), one entry per
// decision its decision map verifies by a check (D1 to D44 but D25, which has no on screen form and
// is marked "verify": "elsewhere" in the map, as D45 is). D29 to D41 are the booking pace (#4101): the pace
// lines on the cards, the one line under them when the pace cannot be read, and the timeline's key.
// D42 to D44 are today after every shift has ended and a day nobody works (#4127). Each runs in the browser against ONE rendered frame,
// either a design frame or the built page rendering the same fixture, and reads only what both
// sides share: the data-tc hooks, visible text, roles and computed colours. Never a styling class,
// since the build draws with Tailwind and the design does not.
//
// Loaded by the design match score's web adapter (scripts/design-score/capture-web.mjs, copied from
// claude-config): window.DESIGN_CHECKS = [{ id, frames, check(doc, ctx) -> { ok, detail } }], where
// ctx is { frame, fixture }, the frame's id and the committed fixture
// (docs/design/fixtures/team-capacity.json) as it is on disk. The frames apply illustrations to it
// (a calendar not syncing, an hour off, a full day), so frameView applies them here the same way;
// scripts/test-design-checks-frame-view.ts holds it to fixtureView, the page's own.
(function () {
  var q = function (doc, tc) { return Array.prototype.slice.call(doc.querySelectorAll('[data-tc="' + tc + '"]')); };
  var one = function (doc, tc) { return doc.querySelector('[data-tc="' + tc + '"]'); };
  var text = function (n) { return n ? n.textContent.replace(/\s+/g, " ").trim() : ""; };
  var rgb = function (doc, n, prop) { return n ? doc.defaultView.getComputedStyle(n)[prop] : ""; };
  var pass = function (detail) { return { ok: true, detail: detail || "" }; };
  var fail = function (detail) { return { ok: false, detail: detail }; };
  var before = function (a, b) { return !!(a && b && (a.compareDocumentPosition(b) & 4)); };
  // A token's colour as the frame computes it, for comparing with what an element draws.
  var token = function (doc, name, prop) {
    var probe = doc.createElement("div");
    probe.style[prop || "color"] = "var(" + name + ")";
    doc.body.append(probe);
    var v = doc.defaultView.getComputedStyle(probe)[prop || "color"];
    probe.remove();
    return v;
  };
  // A day card's pace lines, by the card's place: 0 is Today, 1 Tomorrow, 2 Wednesday, 3 Thursday.
  var DAY = ["Today", "Tomorrow", "Wednesday", "Thursday"];
  var paceLines = function (doc, i) {
    var c = q(doc, "day-card")[i];
    return c ? Array.prototype.slice.call(c.querySelectorAll('[data-tc="pace"]')).map(text) : null;
  };
  var paceIs = function (doc, i, want) {
    var got = paceLines(doc, i);
    if (!got) return fail("no " + DAY[i] + " card");
    return got.join(" | ") === want.join(" | ") ? pass() : fail(DAY[i] + "'s card reads '" + got.join(" | ") + "', expected '" + want.join(" | ") + "'");
  };
  // The second pace line of a card, the estimate.
  var estimateIs = function (doc, i, want) {
    var got = paceLines(doc, i);
    if (!got) return fail("no " + DAY[i] + " card");
    return got.length === 2 && got[1] === want ? pass() : fail(DAY[i] + "'s card reads '" + got.join(" | ") + "', expected the estimate '" + want + "'");
  };
  // The one line under the cards when the pace cannot be read, and that no card keeps a pace line.
  var oneNotice = function (doc) {
    var n = q(doc, "pace-notice");
    if (n.length !== 1) return { err: n.length + " pace notices, expected one" };
    if (!before(one(doc, "nearly-full-line"), n[0]) || !before(n[0], one(doc, "day-tab"))) return { err: "the notice is not under the nearly full line, above the timeline" };
    if (one(doc, "pace")) return { err: "a card still shows a pace line" };
    return { node: n[0] };
  };

  // One frame's numbers, after its illustrations: what fixtureView
  // (src/lib/admin/team-capacity-fixture.ts) hands the page for the same frame.
  function frameView(fixture, frame) {
    var f = fixture.frames[frame];
    if (!f) throw new Error("the fixture names no frame " + frame);
    var snap = fixture.snapshot, t = fixture.examples.timeOff;
    var callMs = snap.eventType.duration_min * 60000;
    // An unreadable time refuses, as fixtureView's does: dropped as a call, it would move the totals
    // the checks expect while every comparison with it quietly read false (L50).
    var stamp = function (iso) {
      var ms = Date.parse(iso);
      if (!isFinite(ms)) throw new Error("the fixture holds an unreadable time: \"" + iso + "\"");
      return ms;
    };
    var advisors = snap.advisors.map(function (a) {
      return { name: a.name, days: a.days.map(function (d, i) {
        var day = { open: d.open, capacity: d.capacity, out: d.out };
        if (f.examples && a.name === t.advisor && i === t.dayIndex) {
          var s0 = stamp(t.start), s1 = stamp(t.end);
          day.open = d.openTimes.filter(function (x) { var ms = stamp(x); return ms + callMs <= s0 || ms >= s1; }).length;
        }
        if (f.illustrate === "today-full" && i === 0) day.open = 0;
        // Every shift today over (#4127): nothing ahead, so no capacity either.
        if (f.illustrate === "today-ended" && i === 0) { day.open = 0; day.capacity = 0; }
        // Wednesday with nobody working: everyone not out has no shift (#4127).
        if (f.illustrate === "nobody-on-shift" && i === 2 && !day.out) { day.open = 0; day.capacity = 0; }
        return day;
      }) };
    });
    return {
      offeredOpenDays: snap.offeredOpenDays,
      advisors: advisors,
      unsynced: f.examples ? [fixture.examples.unsynced] : [],
      timeOff: t.advisor,
      nearlyFull: fixture.nearlyFullPct,
    };
  }
  var view = function (ctx) { return frameView(ctx.fixture, ctx.frame); };
  window.DESIGN_CHECKS_FRAME_VIEW = frameView;

  // The team totals the cards must show, from the fixture, by the settled rules: out and
  // not syncing advisors count in neither number, and the percent rounds down.
  function expectedTotals(v, dayIdx) {
    var open = 0, cap = 0, out = 0, unsynced = 0;
    v.advisors.forEach(function (a) {
      var d = a.days[dayIdx];
      if (v.unsynced.indexOf(a.name) >= 0) { unsynced++; return; }
      if (d.out) { out++; return; }
      open += d.open; cap += d.capacity;
    });
    var full = cap ? (open === 0 ? 100 : Math.min(99, Math.floor((100 * (cap - open)) / cap))) : null;
    return { open: open, cap: cap, out: out, unsynced: unsynced, full: full };
  }

  var ALL = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9"];
  var LIGHT = ["f1", "f3", "f4", "f5", "f7", "f8", "f9"];

  window.DESIGN_CHECKS = [
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
      if (cards.length !== view(ctx).offeredOpenDays) return fail(cards.length + " day cards found");
      for (var i = 0; i < cards.length; i++) {
        var want = expectedTotals(view(ctx), i).open;
        var got = Number(text(cards[i].querySelector('[data-tc="calls-open"]')).replace(/,/g, ""));
        if (got !== want) return fail("card " + (i + 1) + " shows " + got + " calls open, the fixture gives " + want);
      }
      return pass();
    } },
    { id: "D4", frames: ["f1"], check: function (doc, ctx) {
      var n = q(doc, "day-card").length;
      return n === view(ctx).offeredOpenDays ? pass() : fail(n + " day cards, the window is " + view(ctx).offeredOpenDays);
    } },
    { id: "D5", frames: ["f1"], check: function (doc) {
      var cards = q(doc, "day-card");
      if (!cards.length) return fail("no day cards");
      for (var k = 0; k < cards.length; k++) {
        var c = cards[k];
        var order = ["calls-open", "full-bar", "pct", "pace", "out-count"].map(function (t) { return c.querySelector('[data-tc="' + t + '"]'); });
        if (order.some(function (n) { return !n; })) return fail("card " + (k + 1) + " is missing calls open, its bar, its percent, its pace or its time off line");
        for (var i = 1; i < order.length; i++) if (!before(order[i - 1], order[i])) return fail("card " + (k + 1) + " is not in the order calls open, bar, percent, pace, time off");
        var m = /^(\d+) (advisor|advisors) off$/.exec(text(order[4]));
        if (!m || (m[1] === "1") !== (m[2] === "advisor")) return fail("card " + (k + 1) + "'s time off line reads '" + text(order[4]) + "'");
      }
      return pass();
    } },
    { id: "D6", frames: ALL, check: function (doc, ctx) {
      var cards = q(doc, "day-card");
      if (cards.length !== view(ctx).offeredOpenDays) return fail(cards.length + " day cards found");
      for (var i = 0; i < cards.length; i++) {
        var want = expectedTotals(view(ctx), i).full;
        var m = /^(\d+)% full/.exec(text(cards[i].querySelector('[data-tc="pct"]')));
        if (!m || Number(m[1]) !== want) return fail("card " + (i + 1) + " reads '" + text(cards[i].querySelector('[data-tc="pct"]')) + "', expected " + want + "% full");
      }
      return pass();
    } },
    { id: "D7", frames: ["f1"], check: function (doc, ctx) {
      var cards = q(doc, "day-card"), tabs = q(doc, "day-tab");
      if (cards.length !== view(ctx).offeredOpenDays) return fail(cards.length + " day cards found");
      for (var i = 0; i < cards.length; i++) {
        var t = expectedTotals(view(ctx), i), flagged = t.full >= view(ctx).nearlyFull && t.open > 0;
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
        if (text(line).indexOf("Nearly full at " + view(ctx).nearlyFull + "% full or more.") !== 0) return fail("the line reads '" + text(line) + "'");
        var b = line.querySelector("button");
        return b && text(b) === "Change" ? pass() : fail("Change is not a button");
      }
      var form = one(doc, "nearly-full-form");
      var input = form && form.querySelector("input");
      if (!input || input.value !== String(view(ctx).nearlyFull)) return fail("no input holding " + view(ctx).nearlyFull + " when Change is open");
      return /Save/.test(text(form)) && /Cancel/.test(text(form)) ? pass() : fail("the open form lacks Save or Cancel");
    } },
    { id: "D10", frames: ["f1"], check: function (doc, ctx) {
      var n = q(doc, "lane-row").length;
      return n === view(ctx).advisors.length ? pass() : fail(n + " advisor rows, the fixture has " + view(ctx).advisors.length);
    } },
    { id: "D11", frames: ["f1"], check: function (doc, ctx) {
      var names = q(doc, "advisor").map(text);
      if (names.length !== view(ctx).advisors.length) return fail(names.length + " advisor names found");
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
      var row = q(doc, "lane-row").find(function (r) { return text(r.querySelector('[data-tc="advisor"]')) === view(ctx).timeOff; });
      var t = row && row.querySelector('[data-tc="time-off"]');
      return t && /repeating-linear-gradient/.test(rgb(doc, t, "backgroundImage")) ? pass() : fail("the hour off is not striped on " + view(ctx).timeOff + "'s row");
    } },
    { id: "D18", frames: ["f1"], check: function (doc) {
      var w = one(doc, "whole-day");
      return w && text(w) === "Out, approved time off" ? pass() : fail("no grey bar reading Out, approved time off");
    } },
    { id: "D19", frames: ["f3"], check: function (doc, ctx) {
      var row = q(doc, "lane-row").find(function (r) { return text(r.querySelector('[data-tc="advisor"]')) === view(ctx).unsynced[0]; });
      if (!row || !row.querySelector('[data-state="not-syncing"]')) return fail("the not syncing lane is not marked");
      if (!/Calendar not syncing/.test(text(row))) return fail("the lane does not say Calendar not syncing");
      var c0 = q(doc, "day-card")[0];
      var line = c0 && c0.querySelector('[data-tc="not-syncing"]');
      return text(line) === "1 calendar not syncing" ? pass() : fail("today's card says '" + text(line) + "', not 1 calendar not syncing");
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
      if (!/^Ended \d+% full, with room left for [\d,]+ more calls?\.$/.test(text(one(doc, "day-note")))) return fail("the summary reads '" + text(one(doc, "day-note")) + "'");
      return one(doc, "open-call") ? pass() : fail("unused room is not drawn");
    } },
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
    } },
    { id: "D29", frames: ["f1", "f2", "f11"], check: function (doc) {
      var muted = token(doc, "--fg-muted");
      var two = q(doc, "day-card").filter(function (c) { return c.querySelectorAll('[data-tc="pace"]').length === 2; });
      if (!two.length) return fail("no card shows two pace lines");
      for (var k = 0; k < two.length; k++) {
        var lines = Array.prototype.slice.call(two[k].querySelectorAll('[data-tc="pace"]'));
        if (!/^Filling at [\d,]+ an hour$/.test(text(lines[0]))) return fail("the first pace line reads '" + text(lines[0]) + "', not the pace");
        if (!before(two[k].querySelector('[data-tc="pct"]'), lines[0])) return fail("the pace lines are not under the percent");
        for (var j = 0; j < lines.length; j++) if (rgb(doc, lines[j], "color") !== muted) return fail("'" + text(lines[j]) + "' is " + rgb(doc, lines[j], "color") + ", not the muted text " + muted);
      }
      return pass();
    } },
    { id: "D30", frames: ["f1", "f11"], check: function (doc, ctx) {
      return ctx.frame === "f1" ? estimateIs(doc, 3, "Won't fill at this pace") : estimateIs(doc, 2, "Full by 9:30pm at this pace");
    } },
    { id: "D31", frames: ["f1"], check: function (doc) {
      return estimateIs(doc, 2, "Full by 9:30am Tue at this pace");
    } },
    { id: "D32", frames: ["f11", "f12"], check: function (doc, ctx) {
      return ctx.frame === "f11" ? estimateIs(doc, 3, "Full by 7pm Tue") : estimateIs(doc, 2, "Won't fill");
    } },
    { id: "D33", frames: ["f1"], check: function (doc) {
      var pct = q(doc, "day-card")[1] && q(doc, "day-card")[1].querySelector('[data-tc="pct"]');
      var m = /^(\d+)% full/.exec(text(pct));
      if (!m || Number(m[1]) < 95) return fail("Tomorrow's card is not at 95% or more: '" + text(pct) + "'");
      return paceIs(doc, 1, ["Filling at 9 an hour"]);
    } },
    { id: "D34", frames: ["f1"], check: function (doc) {
      return paceIs(doc, 0, ["Not filling right now"]);
    } },
    { id: "D35", frames: ["f12"], check: function (doc) {
      return paceIs(doc, 3, ["Pace shows after 3 hours of readings"]);
    } },
    { id: "D36", frames: ["f11"], check: function (doc) {
      return paceIs(doc, 1, ["Readings missed, pace back by 6:30pm"]);
    } },
    { id: "D37", frames: ["f1"], check: function (doc) {
      var border = token(doc, "--border");
      var withTwo = q(doc, "day-card").find(function (c) { return c.querySelectorAll('[data-tc="pace"]').length === 2; });
      if (!withTwo) return fail("no card shows two pace lines");
      var lines = withTwo.querySelectorAll('[data-tc="pace"]');
      var cs = function (n, p) { return doc.defaultView.getComputedStyle(n)[p]; };
      if (cs(lines[0], "marginTop") !== "12px") return fail("the first pace line is " + cs(lines[0], "marginTop") + " below the percent, not 12px");
      if (cs(lines[1], "marginTop") !== "2px") return fail("the second pace line is " + cs(lines[1], "marginTop") + " below the first, not 2px");
      var off = withTwo.querySelector('[data-tc="out-count"]');
      if (!off) return fail("the card has no time off line");
      var got = [cs(off, "marginTop"), cs(off, "borderTopWidth"), cs(off, "borderTopStyle"), cs(off, "borderTopColor"), cs(off, "paddingTop")];
      var want = ["12px", "1px", "solid", border, "10px"];
      return got.join(" ") === want.join(" ") ? pass() : fail("above the time off line: " + got.join(" ") + ", expected " + want.join(" "));
    } },
    { id: "D38", frames: ["f13"], check: function (doc) {
      var r = oneNotice(doc);
      if (r.err) return fail(r.err);
      var parts = r.node.children;
      if (parts.length !== 2 || text(parts[0]) !== "Couldn't load how fast the days are filling." || text(parts[1]) !== "Try reloading in a minute.") return fail("the notice reads '" + text(r.node) + "'");
      if (rgb(doc, parts[0], "color") !== token(doc, "--error")) return fail("the notice is " + rgb(doc, parts[0], "color") + ", not the error colour");
      return rgb(doc, parts[1], "color") === token(doc, "--fg-muted") ? pass() : fail("Try reloading is not muted");
    } },
    { id: "D39", frames: ["f14"], check: function (doc) {
      var r = oneNotice(doc);
      if (r.err) return fail(r.err);
      if (text(r.node) !== "Couldn't update how fast the days are filling since 1:30pm.") return fail("the notice reads '" + text(r.node) + "'");
      var words = r.node.firstElementChild || r.node;
      return rgb(doc, words, "color") === token(doc, "--error") ? pass() : fail("the notice is " + rgb(doc, words, "color") + ", not the error colour");
    } },
    { id: "D40", frames: ["f1", "f2", "f3"], check: function (doc, ctx) {
      var key = one(doc, "key");
      if (!key) return fail("no key");
      var row = key.parentElement;
      var btn = Array.prototype.find.call(row.querySelectorAll("button"), function (b) { return text(b) === "Pick a date"; });
      if (!btn || !before(btn, key)) return fail("the key does not follow Pick a date in the tab row");
      var rowRight = row.getBoundingClientRect().right - parseFloat(doc.defaultView.getComputedStyle(row).paddingRight);
      if (Math.abs(key.getBoundingClientRect().right - rowRight) > 1) return fail("the key is not pushed to the right of the tab row");
      var labels = q(doc, "key-item").map(text);
      var want = ctx.frame === "f3" ? ["Busy", "Open", "Not working", "Past"] : ["Busy", "Open", "Not working"];
      if (labels.join("|") !== want.join("|")) return fail("the key reads " + labels.join(", "));
      var muted = token(doc, "--fg-muted");
      if (q(doc, "key-item").some(function (n) { return rgb(doc, n, "color") !== muted; })) return fail("the key is not in the muted text");
      var sw = function (k) { return key.querySelector('[data-tc="key-swatch"][data-key="' + k + '"]'); };
      var taken = rgb(doc, one(doc, "taken"), "backgroundColor");
      if (!sw("busy") || rgb(doc, sw("busy"), "backgroundColor") !== taken) return fail("Busy's mark is not the timeline's used up fill");
      var open = sw("open");
      if (!open || rgb(doc, open, "backgroundColor") !== token(doc, "--surface", "backgroundColor") || rgb(doc, open, "boxShadow").indexOf(taken) < 0) return fail("Open's mark is not the white outlined box");
      if (!sw("off") || !/repeating-linear-gradient/.test(rgb(doc, sw("off"), "backgroundImage"))) return fail("Not working's mark is not striped");
      if (ctx.frame === "f3" && (!sw("past") || !/repeating-linear-gradient/.test(rgb(doc, sw("past"), "backgroundImage")))) return fail("Past's mark is not hatched");
      return pass();
    } },
    { id: "D42", frames: ["f15"], check: function (doc, ctx) {
      var c = q(doc, "day-card")[0];
      if (!c) return fail("no Today card");
      var h = ctx.fixture.frames.f15.todayHistory;
      var pct = h.open === 0 ? 100 : Math.min(99, Math.floor((100 * (h.capacity - h.open)) / h.capacity));
      var head = c.querySelector('[data-tc="headline"]'), result = c.querySelector('[data-tc="result"]');
      var bar = c.querySelector('[data-tc="full-bar"]'), pctLine = c.querySelector('[data-tc="pct"]');
      if (text(head) !== "Done for today") return fail("Today's headline reads '" + text(head) + "'");
      if (c.querySelector('[data-tc="calls-open"]')) return fail("Today's card still shows a calls open number");
      if (text(result) !== h.open + " calls went unbooked") return fail("the line under it reads '" + text(result) + "'");
      if (!bar || text(pctLine) !== pct + "% full") return fail("the bar and percent read '" + text(pctLine) + "', expected " + pct + "% full");
      return before(head, result) && before(result, bar) && before(bar, pctLine) ? pass() : fail("Done for today, the unbooked line, the bar and the percent are out of order");
    } },
    { id: "D43", frames: ["f15"], check: function (doc) {
      var cards = q(doc, "day-card"), c = cards[0];
      if (!c) return fail("no Today card");
      if (c.querySelector('[data-tc="flag"]')) return fail("the finished day carries a chip");
      if (c.querySelector('[data-tc="pace"]')) return fail("the finished day shows a pace line");
      // Thursday, 36% full, is unflagged: the finished day must be the same plain surface.
      var plain = cards.find(function (x, i) { return i > 0 && !x.querySelector('[data-tc="flag"]'); });
      if (!plain) return fail("no unflagged card to compare with");
      return rgb(doc, c, "backgroundColor") === rgb(doc, plain, "backgroundColor") ? pass() : fail("the finished day is tinted " + rgb(doc, c, "backgroundColor"));
    } },
    { id: "D44", frames: ["f16"], check: function (doc) {
      var c = q(doc, "day-card")[2];
      if (!c) return fail("no Wednesday card");
      var n = c.querySelector('[data-tc="calls-open"]'), result = c.querySelector('[data-tc="result"]');
      if (text(n) !== "0" || !/ calls open/.test(text(c))) return fail("Wednesday's card does not read 0 calls open");
      if (text(result) !== "No one on shift" || !before(n, result)) return fail("the line under it reads '" + text(result) + "'");
      var extra = ["full-bar", "pct", "pace", "out-count", "not-syncing", "flag"].filter(function (tc) { return c.querySelector('[data-tc="' + tc + '"]'); });
      return extra.length ? fail("Wednesday's card still shows " + extra.join(", ")) : pass();
    } },
    { id: "D46", frames: ["f6"], check: function (doc) {
      var first = q(doc, "day-card")[0];
      if (!first) return fail("no day cards");
      if (text(first.querySelector('[data-tc="flag"]')) !== "Full") return fail("today's card carries no Full chip");
      var lines = first.querySelectorAll('[data-tc="pace"]');
      return lines.length === 0 ? pass() : fail("today's full card shows " + lines.length + " pace line(s): '" + text(lines[0]) + "'");
    } },
    { id: "D47", frames: ["f1"], check: function (doc) {
      var tops = q(doc, "day-card").map(function (card) {
        var first = card.querySelector('[data-tc="out-count"], [data-tc="not-syncing"]');
        return first ? Math.round(first.getBoundingClientRect().top) : null;
      }).filter(function (t) { return t !== null; });
      if (tops.length < 2) return fail("fewer than two cards have a time off line to line up");
      return tops.every(function (t) { return t === tops[0]; }) ? pass() : fail("the time off lines start at " + tops.join(", ") + "px");
    } },
    { id: "D41", frames: ["f1"], check: function (doc) {
      if (q(doc, "key-item").map(text).indexOf("Open") < 0) return fail("the key does not name the white box Open");
      if (text(one(doc, "open-heading")) !== "Open") return fail("the timeline's column reads '" + text(one(doc, "open-heading")) + "'");
      var bad = q(doc, "day-card").find(function (c) { return !/ calls? open/.test(text(c)); });
      return bad ? fail("a card does not say calls open") : pass();
    } }
  ];
})();
