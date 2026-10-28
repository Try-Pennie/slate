// The decision checks for each reminder email's last 24 hours on /admin/reminder-emails
// (docs/design/reminder-email-status.html, #4300). One entry, for the one decision its map
// verifies by a check: D1. D2 rests on the pictures; D3 and D4 are proven by
// scripts/test-reminder-status.ts. It runs in the browser against ONE rendered frame, the
// design's or the built page's, and reads only what both share: the email table's header
// cells, its rows and their text. It reads no styling class and no id the builder chose.
//
// Loaded by the design match score's web adapter: window.DESIGN_CHECKS = [{ id, frames,
// check(doc, ctx) -> { ok, detail } }].
(function () {
  var text = function (n) { return n ? n.textContent.replace(/\s+/g, " ").trim() : ""; };
  var all = function (root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); };
  var pass = function (detail) { return { ok: true, detail: detail || "" }; };
  var fail = function (detail) { return { ok: false, detail: detail }; };

  // The email table: the one whose first column header reads Email.
  var emailTable = function (doc) {
    return all(doc, "table").filter(function (t) {
      var first = t.querySelector("thead th");
      return text(first) === "Email";
    })[0] || null;
  };

  window.DESIGN_CHECKS = [
    {
      id: "D1",
      frames: ["f1"],
      check: function (doc) {
        var table = emailTable(doc);
        if (!table) return fail("no email table (no table whose first header reads Email)");
        var headers = all(table, "thead th");
        var last = text(headers[headers.length - 1]);
        if (last !== "Last 24 hours") return fail("the last header reads '" + last + "', not 'Last 24 hours'");
        var rows = all(table, "tbody tr");
        if (rows.length === 0) return fail("the email table has no rows");
        for (var i = 0; i < rows.length; i++) {
          var cells = all(rows[i], "td");
          if (cells.length !== headers.length) {
            return fail("row " + (i + 1) + " has " + cells.length + " cells under " + headers.length + " headers");
          }
          if (text(cells[cells.length - 1]) === "") return fail("row " + (i + 1) + " has nothing under Last 24 hours");
        }
        return pass(rows.length + " email rows, each with its last 24 hours");
      },
    },
  ];
})();
