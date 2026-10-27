// The checks for the settled coordinator booking page (#4205), one per checked decision in
// settled.json. Each reads only what the design and the build share: text, roles, aria and data
// attributes, and computed colours. None reads a styling class or an id the builder chose.

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
  function dialogOf(doc) { return doc.querySelector("[role=alertdialog], [role=dialog][aria-modal=true]"); }
  // Main's own content, leaving out any dialog drawn inside it.
  function pageText(doc) {
    var m = main(doc).cloneNode(true);
    all(m, "[role=alertdialog], dialog").forEach(function (d) { d.remove(); });
    return text(m);
  }
  function labelled(doc, name) {
    return all(doc, "[aria-labelledby]").filter(function (el) {
      return el.getAttribute("aria-labelledby").split(/\s+/).some(function (id) { var l = doc.getElementById(id); return l && text(l) === name; });
    })[0] || null;
  }
  function dayGroup(doc) { return labelled(doc, "Day"); }
  function timeGroup(doc) { return labelled(doc, "Time"); }
  function buttonNamed(root, re) {
    return all(root, "button").filter(function (b) { return re.test(norm(b.getAttribute("aria-label") || b.textContent)); })[0] || null;
  }
  function comboNamed(doc, name) {
    return all(doc, "[role=combobox]").filter(function (c) {
      var l = c.id && doc.querySelector("label[for='" + c.id + "']");
      return (l && text(l) === name) || c.getAttribute("aria-label") === name;
    })[0] || null;
  }
  function confirmButton(doc) { return buttonNamed(main(doc), /^(Book|Move) (the call|Thursday|Tuesday|Monday|Wednesday|Friday|Saturday|Sunday)|^Move the call to /); }
  function notice(doc) {
    return all(doc, "[role=status]").filter(function (el) { return / already has a call/.test(text(el)) && el.querySelector("input[type=checkbox]"); })[0] || null;
  }
  function details(doc) {
    var dl = main(doc).querySelector("dl");
    if (!dl) return null;
    var out = {};
    all(dl, "dt").forEach(function (dt) { var dd = dt.nextElementSibling; out[text(dt)] = text(dd); });
    return out;
  }
  function ok(cond, detail) { return { ok: !!cond, detail: detail }; }

  var CLOCKS = { Jordan: "It's 10:40am for Jordan right now.", Sam: "It's 9:40am for Sam right now." };

  window.DESIGN_CHECKS = [
    { id: "D1", frames: ["f-locked", "f-sam-empty"], check: function (doc) {
      var h1 = main(doc).querySelector("h1");
      var cust = all(main(doc), "h2").filter(function (h) { return text(h) === "Customer"; })[0];
      var day = dayGroup(doc);
      var order = cust && day && (cust.compareDocumentPosition(day) & 4);
      return ok(text(h1) === "Book a call" && order, "h1 '" + text(h1) + "', Customer before the Day group: " + !!order);
    } },
    { id: "D2", frames: ["f-unlocked", "f-sam-empty"], check: function (doc) {
      var m = main(doc).cloneNode(true);
      all(m, "[role=alertdialog], dialog").forEach(function (d) { d.remove(); });
      var hs = all(m, "h2, h3").map(text);
      return ok(hs.length === 1 && hs[0] === "Customer", "headings under the title: " + JSON.stringify(hs));
    } },
    { id: "D3", frames: ["f-locked", "f-pressed", "f-unlocked"], check: function (doc) {
      var n = notice(doc);
      var cb = n && n.querySelector("input[type=checkbox]");
      var label = cb && cb.closest("label");
      return ok(n && /^Jordan already has a call/.test(text(n)) && text(label) === "I told Jordan their Tuesday call will move",
        "notice: " + text(n).slice(0, 120));
    } },
    { id: "D4", frames: ["f-locked", "d-locked"], check: function (doc) {
      var n = notice(doc);
      if (!n) return ok(false, "no notice");
      var win = doc.defaultView, icon = n.querySelector("svg");
      var border = win.getComputedStyle(n).borderTopColor, mark = icon ? win.getComputedStyle(icon).color : "";
      return ok(border && border === mark, "border " + border + ", icon " + mark);
    } },
    { id: "D5", frames: ["f-locked", "f-unlocked"], check: function (doc) {
      var c = comboNamed(doc, "Why the call is moving");
      return ok(c && text(c) === "Choose a reason", "reason reads '" + text(c) + "'");
    } },
    { id: "D6", frames: ["f-locked", "f-unlocked", "f-done-move"], check: function (doc) {
      var t = pageText(doc);
      var count = t.split("Arizona (Phoenix)").length - 1;
      var isDone = /Moved by you|Booked by you/.test(t);
      var want = isDone ? 0 : 1;
      return ok(count === want && t.indexOf("Arizona time") < 0 && t.indexOf("Pacific") < 0, "zone named " + count + " times, wanted " + want);
    } },
    { id: "D7", frames: ["f-locked", "f-sam-empty"], check: function (doc) {
      var d = details(doc);
      return ok(d && "Phone" in d && "Time zone" in d && !("Team" in d) && Object.keys(d).length === 2, "terms: " + JSON.stringify(d && Object.keys(d)));
    } },
    { id: "D8", frames: ["f-locked", "f-sam-empty"], check: function (doc) {
      var d = details(doc) || {};
      var z = d["Time zone"] || "";
      var who = /Sam/.test(text(main(doc).querySelector("dl") && main(doc).querySelector("dl").previousElementSibling)) ? "Sam" : "Jordan";
      return ok(z.indexOf(CLOCKS[who]) >= 0, "Time zone reads '" + z + "'");
    } },
    { id: "D9", frames: ["f-sam-empty"], check: function (doc) {
      var t = pageText(doc);
      var tg = timeGroup(doc), cf = confirmButton(doc);
      return ok(dayGroup(doc) && t.indexOf("Choose a day to see when calls can start.") >= 0 && tg && cf && text(cf) === "Book the call" && cf.disabled,
        "Day " + !!dayGroup(doc) + ", Time " + !!tg + ", confirm '" + text(cf) + "'");
    } },
    { id: "D10", frames: ["f-locked", "f-pressed", "d-locked"], check: function (doc) {
      var days = all(dayGroup(doc) || doc, "button");
      var reason = comboNamed(doc, "Why the call is moving"), cf = confirmButton(doc);
      var off = days.length && days.every(function (b) { return b.disabled; }) && reason && reason.disabled && cf && cf.disabled;
      return ok(off && pageText(doc).indexOf("Check the box above after you tell Jordan.") >= 0, "all off: " + !!off);
    } },
    { id: "D11", frames: ["f-pressed"], check: function (doc) {
      var b = buttonNamed(main(doc), /^Check the box above first$/);
      return ok(b, "pointer: " + !!b);
    } },
    { id: "D12", frames: ["f-unlocked", "f-sam-empty"], check: function (doc) {
      var names = all(dayGroup(doc) || doc.createElement("div"), "button").map(function (b) { return b.getAttribute("aria-label") || text(b); });
      var want = ["Monday, November 16, Today", "Tuesday, November 17", "Wednesday, November 18", "Thursday, November 19"];
      return ok(JSON.stringify(names) === JSON.stringify(want), "days: " + JSON.stringify(names));
    } },
    { id: "D13", frames: ["f-today-closed"], check: function (doc) {
      var bs = all(dayGroup(doc) || doc.createElement("div"), "button");
      var first = bs[0], last = bs[bs.length - 1];
      return ok(first && first.disabled && /Closed/.test(text(first)) && last && /^Friday, November 20/.test(last.getAttribute("aria-label") || ""),
        "first '" + (first && first.getAttribute("aria-label")) + "', last '" + (last && last.getAttribute("aria-label")) + "'");
    } },
    { id: "D14", frames: ["f-unlocked"], check: function (doc) {
      return ok(pageText(doc).indexOf("On Thursday, November 19, calls can start from 8:00am to 5:30pm.") >= 0, "hours line missing");
    } },
    { id: "D15", frames: ["f-unlocked"], check: function (doc) {
      var ts = all(timeGroup(doc) || doc.createElement("div"), "button").map(text);
      var want = [];
      for (var m = 480; m <= 1050; m += 15) { var hr = Math.floor(m / 60); want.push((hr % 12 || 12) + ":" + (m % 60 < 10 ? "0" : "") + (m % 60) + (hr < 12 ? "am" : "pm")); }
      return ok(JSON.stringify(ts) === JSON.stringify(want), ts.length + " times, " + ts[0] + " to " + ts[ts.length - 1]);
    } },
    { id: "D16", frames: ["f-unlocked"], check: function (doc) {
      var g = timeGroup(doc);
      var groups = g ? all(g, "[role=group][aria-labelledby]") : [];
      var names = groups.map(function (x) { return text(doc.getElementById(x.getAttribute("aria-labelledby"))); });
      var morningOk = groups[0] && all(groups[0], "button").every(function (b) { return /am$/.test(text(b)); });
      var afternoonOk = groups[1] && all(groups[1], "button").every(function (b) { return /pm$/.test(text(b)); });
      return ok(JSON.stringify(names) === '["Morning","Afternoon"]' && morningOk && afternoonOk, "groups " + JSON.stringify(names));
    } },
    { id: "D17", frames: ["f-unlocked", "f-sam-empty"], check: function (doc) {
      return ok(pageText(doc).indexOf("Marcia") < 0, "Marcia named before booking");
    } },
    { id: "D18", frames: ["f-other", "d-other"], check: function (doc) {
      var ta = all(main(doc), "textarea").filter(function (t) { var l = t.id && doc.querySelector("label[for='" + t.id + "']"); return l && text(l) === "What happened"; })[0];
      return ok(ta && pageText(doc).indexOf("Write what happened.") >= 0, "box " + !!ta);
    } },
    { id: "D19", frames: ["f-other", "d-other"], check: function (doc) {
      var cf = confirmButton(doc);
      var sky = all(dayGroup(doc) || doc.createElement("div"), "button[aria-pressed=true]")[0];
      if (!cf || !sky) return ok(false, "confirm " + !!cf + ", chosen day " + !!sky);
      var win = doc.defaultView;
      var a = win.getComputedStyle(cf).backgroundColor, b = win.getComputedStyle(sky).backgroundColor;
      return ok(cf.disabled && a !== b, "refused " + a + " against Sky " + b);
    } },
    { id: "D20", frames: ["f-locked", "f-pressed", "f-other", "f-done-move"], check: function (doc) {
      return ok(!/\bTick\b/i.test(pageText(doc)), "the word Tick is on the page");
    } },
    { id: "D21", frames: ["f-locked", "f-sam-empty", "f-refusal"], check: function (doc) {
      var t = pageText(doc);
      var find = buttonNamed(main(doc), /^Find customer$/);
      return ok(t.indexOf("Try a sample") < 0 && find, "sample line " + (t.indexOf("Try a sample") >= 0) + ", Find " + !!find);
    } },
    { id: "D23", frames: ["f-dialog-move", "d-dialog-move"], check: function (doc) {
      var d = dialogOf(doc), t = text(d);
      return ok(d && t.indexOf("Move Jordan Rivera's call?") === 0 && t.indexOf("Thursday, November 19 at 2:00pm, Arizona time (Phoenix)") >= 0
        && t.indexOf("Moves Jordan's Tuesday, November 17 at 11:00am call") >= 0, "dialog: " + t);
    } },
    { id: "D24", frames: ["f-dialog-move", "f-sam-dialog"], check: function (doc) {
      var d = dialogOf(doc);
      var names = d ? all(d, "button").map(text) : [];
      var main2 = /Move/.test(text(d)) ? "Move the call" : "Book the call";
      return ok(JSON.stringify(names) === JSON.stringify(["Go back", main2]), "buttons " + JSON.stringify(names));
    } },
    { id: "D25", frames: ["f-sam-dialog"], check: function (doc) {
      var t = text(dialogOf(doc));
      return ok(t.indexOf("Book this call for Sam Okafor?") === 0 && t.indexOf("Tuesday, November 17 at 10:00am, Pacific time (Los Angeles)") >= 0 && t.indexOf("Moves") < 0, "dialog: " + t);
    } },
    { id: "D27", frames: ["f-done-move", "d-done-move"], check: function (doc) {
      var t = pageText(doc), fields = all(main(doc), "input, textarea, [role=combobox]").length;
      var bs = all(main(doc), "button").map(text);
      var want = "Book a call Moved Thursday, November 19 at 2:00pm With Ada Example. Jordan's booking link still works. Moved by you Book another call";
      return ok(t === want && fields === 0 && JSON.stringify(bs) === '["Book another call"]', "page '" + t + "', fields " + fields);
    } },
    { id: "D28", frames: ["f-sam-done"], check: function (doc) {
      var t = pageText(doc);
      return ok(t === "Book a call Booked Tuesday, November 17 at 10:00am With Priya Example. Booked by you Book another call", "page '" + t + "'");
    } },
    { id: "D29", frames: ["f-sam-marcia"], check: function (doc) {
      var t = pageText(doc);
      return ok(t === "Book a call Booked Tuesday, November 17 at 4:00pm With Marcia, Pennie's AI agent. No advisor was free at this time, so Marcia will text Sam. Booked by you Book another call", "page '" + t + "'");
    } },
    { id: "D31", frames: ["f-refusal"], check: function (doc) {
      var a = all(main(doc), "[role=alert]").map(text);
      return ok(a.indexOf("This is not a Salesforce Lead link or ID. Paste the link to the customer's Lead. You can also paste the ID at the end of the link. It starts with 00Q.") >= 0, "alerts " + JSON.stringify(a));
    } },
    { id: "D34", frames: ["d-locked", "d-unlocked", "d-other", "d-dialog-move", "d-done-move", "d-sam-empty"], check: function (doc) {
      var theme = doc.documentElement.getAttribute("data-theme");
      return ok(theme === "dark", "data-theme " + theme);
    } },
  ];
})();
