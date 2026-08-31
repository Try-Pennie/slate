// The erasure purge worklist: what an operator SEES, and what each control says
// it is about to do (#1124).
//
// Everything here is pure, so the wording an admin reads and the arithmetic
// behind it are driven directly rather than through a mounted page. Three things
// this file exists to pin, each of which has shipped wrong somewhere before:
//
//   - an UNMEASURED residual is never rendered as a clean one. "Snowflake holds
//     nothing for this person" and "we could not ask Snowflake" are different
//     screens (L10), and the second one collapsing into the first is exactly how
//     a missed purge would stay invisible.
//   - each control names its own SCOPE. The per row button purges one erasure's
//     bookings; the footer button purges every booking in the trail, including
//     the ones already clean, which is what makes a missed purge self correcting.
//     The issue asked for that to be decided on the screen rather than left to
//     fall out of the code.
//   - the confirmation sentence is DERIVED from the state it is about to change
//     (L180), so it cannot read identically whether it is taking one booking or
//     thirty.
// Run: node --experimental-strip-types scripts/test-erasure-worklist.ts
import {
  MAX_ATTRIBUTED_ENTRIES,
  entryResidualTotal,
  entryStatus,
  needsPerEntryAttribution,
  summarizeWorklist,
  type ErasureWorklistEntry,
} from "../src/lib/snowflake/erasure-worklist.ts";
import {
  entryPurgeConfirm,
  entryPurgeLabel,
  entryResidualText,
  entryStatusLabel,
  purgeAllConfirm,
  purgeAllLabel,
  purgeFailedText,
  purgeLeftResidualText,
  purgeStalledText,
  purgeSucceededText,
  purgeTimeoutText,
  purgeWorkingText,
  trailUnreadableText,
  warehouseUnconfiguredText,
  warehouseUnreadableText,
  worklistHeadline,
  emptyTrailText,
} from "../src/lib/snowflake/erasure-worklist-copy.ts";
import { assert, finish } from "./lib/harness.ts";

const entry = (over: Partial<ErasureWorklistEntry> = {}): ErasureWorklistEntry => ({
  auditId: "a1",
  createdAt: "2026-08-30T12:00:00.000Z",
  emailSha256: "bf887269aa11223344556677889900aabbccddeeff00112233445566778899aa",
  bookingIds: ["bk1", "bk2"],
  residuals: [
    { table: "bookings", residual: 0 },
    { table: "booking_events", residual: 0 },
  ],
  unmeasuredReason: null,
  ...over,
});

// --- an unmeasured residual is its own state, never a clean one ---
{
  const measuredClean = entry();
  assert(entryResidualTotal(measuredClean) === 0, "a measured clean entry totals 0");
  assert(entryStatus(measuredClean) === "clean", "a measured clean entry is clean");

  const unmeasured = entry({ residuals: null, unmeasuredReason: "Snowflake refused the read" });
  assert(entryResidualTotal(unmeasured) === null, "an unmeasured entry totals null, not 0");
  assert(entryStatus(unmeasured) === "unknown", "an unmeasured entry is unknown, not clean");
  assert(
    entryStatusLabel("unknown") !== entryStatusLabel("clean"),
    "unknown and clean read differently",
  );
  assert(
    /could not|not measured|unknown/i.test(entryStatusLabel("unknown")),
    "the unknown label says it was not measured",
  );

  const outstanding = entry({ residuals: [{ table: "bookings", residual: 3 }] });
  assert(entryResidualTotal(outstanding) === 3, "residual totals across tables");
  assert(entryStatus(outstanding) === "outstanding", "a residual means outstanding");
}

// --- the residual sentence names the table, and never claims zero it did not measure ---
{
  assert(
    entryResidualText(entry({ residuals: [{ table: "bookings", residual: 2 }] })).includes("bookings"),
    "the residual line names the table holding data",
  );
  const unknownText = entryResidualText(entry({ residuals: null, unmeasuredReason: "no answer" }));
  assert(!/\b0\b/.test(unknownText), "an unmeasured residual never renders a zero");
  assert(unknownText.includes("no answer"), "an unmeasured residual carries its reason");
}

// --- summary: unknown entries are counted separately, never folded into clean ---
{
  const s = summarizeWorklist([
    entry({ auditId: "a" }),
    entry({ auditId: "b", residuals: [{ table: "bookings", residual: 2 }] }),
    entry({ auditId: "c", residuals: null, unmeasuredReason: "unreadable" }),
  ]);
  assert(s.entries === 3, "counts every entry");
  assert(s.clean === 1, "one clean");
  assert(s.outstanding === 1, "one outstanding");
  assert(s.unknown === 1, "one unknown");
  assert(s.residualRows === 2, "residual rows sum only what was measured");

  const noneMeasured = summarizeWorklist([entry({ residuals: null, unmeasuredReason: "x" })]);
  assert(
    noneMeasured.residualRows === null,
    "with nothing measured the residual total is null, not 0",
  );

  const empty = summarizeWorklist([]);
  assert(empty.entries === 0 && empty.residualRows === 0, "an empty trail is measured, not unknown");
}

// --- the headline distinguishes clean, outstanding, and unmeasured ---
{
  const cleanHead = worklistHeadline(summarizeWorklist([entry()]));
  const unknownHead = worklistHeadline(
    summarizeWorklist([entry({ residuals: null, unmeasuredReason: "x" })]),
  );
  const outstandingHead = worklistHeadline(
    summarizeWorklist([entry({ residuals: [{ table: "bookings", residual: 4 }] })]),
  );
  assert(cleanHead !== unknownHead, "clean and unmeasured headlines differ");
  assert(outstandingHead !== cleanHead, "outstanding and clean headlines differ");
  assert(outstandingHead.includes("1"), "the outstanding headline counts the entries");
  assert(
    worklistHeadline(
      summarizeWorklist([
        entry({ auditId: "a", residuals: [{ table: "bookings", residual: 1 }] }),
        entry({ auditId: "b", residuals: [{ table: "bookings", residual: 1 }] }),
      ]),
    ).includes("2"),
    "the headline pluralises off the real count",
  );
  assert(emptyTrailText().length > 0, "an empty trail has its own sentence");
  assert(
    emptyTrailText() !== trailUnreadableText("boom"),
    "an empty trail and an unreadable one are different screens",
  );
}

// --- per control scope: the sentence says WHICH bookings it is about to touch ---
{
  const one = entry({ bookingIds: ["bk1", "bk2", "bk3"], residuals: [{ table: "bookings", residual: 1 }] });
  const rowConfirm = entryPurgeConfirm(one);
  assert(rowConfirm.includes("3"), "the per row confirm names how many bookings it takes");
  assert(/this erasure|these 3 bookings|only/i.test(rowConfirm), "the per row confirm says it is narrow");

  // L180: the sentence is derived, so a different entry produces a different sentence.
  const other = entryPurgeConfirm(entry({ bookingIds: ["bk1"] }));
  assert(other !== rowConfirm, "the confirm changes with the state it is about to change");
  assert(other.includes("1"), "a single booking entry says 1");

  const trail = { entryCount: 4, bookingCount: 11, otherOrgBookingCount: 0 };
  const allConfirm = purgeAllConfirm(trail);
  assert(allConfirm.includes("11"), "the trail wide confirm names every booking it touches");
  assert(allConfirm.includes("4"), "the trail wide confirm names every erasure it covers");
  assert(
    /already clean|again|every booking/i.test(allConfirm),
    "the trail wide confirm says it re runs bookings that are already clean",
  );
  assert(allConfirm !== rowConfirm, "the two controls do not share a sentence");
  assert(
    purgeAllConfirm({ entryCount: 5, bookingCount: 12, otherOrgBookingCount: 0 }) !== allConfirm,
    "the trail wide confirm is derived from the trail, not fixed",
  );

  // Scope honesty across orgs: the button covers the whole trail even though the
  // list is scoped to the reader's org, so it has to say so.
  const crossOrg = purgeAllConfirm({ entryCount: 4, bookingCount: 11, otherOrgBookingCount: 3 });
  assert(crossOrg.includes("3"), "a trail reaching another org names how many of its bookings");
  assert(crossOrg !== allConfirm, "the cross org case reads differently");

  assert(
    entryPurgeLabel() !== purgeAllLabel(),
    "the two buttons are labelled differently, so scope is readable at rest",
  );
  assert(/this erasure/i.test(entryPurgeLabel()), "the row button names its narrow scope");
  assert(/all|every|trail/i.test(purgeAllLabel()), "the footer button names its wide scope");
}

// --- the three progress states read differently, and the timeout is actionable ---
{
  const working = purgeWorkingText(3);
  const stalled = purgeStalledText(25);
  const timedOut = purgeTimeoutText(90);
  assert(working.includes("3"), "the working state shows elapsed seconds, so it is visibly alive");
  assert(purgeWorkingText(4) !== working, "the working line moves with the clock");
  assert(stalled !== working, "still working reads differently from just started");
  assert(stalled.includes("25"), "the still working line carries the elapsed time");
  assert(timedOut !== stalled && timedOut !== working, "timed out is its own state");
  assert(/try again|retry/i.test(timedOut), "the timeout tells the reader what to do");
  assert(
    /may have|might have|check/i.test(timedOut),
    "the timeout does not claim the purge failed, only that we stopped waiting",
  );
}

// --- a failed purge never reads as a success ---
{
  const failed = purgeFailedText("a purge is already running");
  assert(failed.includes("a purge is already running"), "the failure carries the server's reason");
  assert(!/complete|succeeded|cleared/i.test(failed), "a failure never borrows success wording");

  const noReason = purgeFailedText(null);
  assert(noReason.length > 0, "a failure with no reason still says something");
  assert(!/undefined|null/.test(noReason), "a missing reason never leaks a null");

  const ran = purgeSucceededText({
    bookingIds: ["bk1", "bk2"],
    rowsByTable: { bookings: 2, booking_events: 1 },
  });
  assert(ran.includes("2"), "success names how many bookings it purged");
  assert(/verif/i.test(ran), "success says the verify is what makes it true");

  const left = purgeLeftResidualText([
    "bookings: 1 row(s) still hold contact PII after the purge",
  ]);
  assert(left.includes("bookings: 1"), "a residual after the purge carries the measured reason");
  assert(!/complete|succeeded/i.test(left), "a purge that left data behind is not a success");
}

// --- an unreadable trail and an unconfigured warehouse are distinct screens ---
{
  const t = trailUnreadableText("permission denied for table audit_log");
  assert(t.includes("permission denied"), "the trail failure carries its reason");
  assert(!/no |nothing|none/i.test(t.split(":")[0] ?? ""), "it never opens by claiming emptiness");

  const w = warehouseUnreadableText("Snowflake returned 503");
  assert(w.includes("503"), "the warehouse failure carries its reason");
  assert(w !== t, "a trail failure and a warehouse failure are different messages");

  const u = warehouseUnconfiguredText();
  assert(u !== w, "unconfigured is not the same as unreadable");
  assert(/not configured|no warehouse|mirror/i.test(u), "unconfigured says what is missing");
}

// --- when attribution runs ---
{
  assert(needsPerEntryAttribution(0) === false, "a clean trail needs no per entry attribution");
  assert(needsPerEntryAttribution(3) === true, "a residual has to be attributed to an entry");
  assert(
    needsPerEntryAttribution(null) === false,
    "an unmeasurable trail total cannot be attributed, so nothing is claimed",
  );
  assert(MAX_ATTRIBUTED_ENTRIES > 0, "the attribution pass is bounded");
}

// --- the copy rules hold on every string this surface can render ---
{
  const all = [
    worklistHeadline(summarizeWorklist([entry()])),
    entryStatusLabel("clean"),
    entryStatusLabel("outstanding"),
    entryStatusLabel("unknown"),
    entryResidualText(entry()),
    entryResidualText(entry({ residuals: null, unmeasuredReason: "no answer" })),
    entryPurgeLabel(),
    entryPurgeConfirm(entry()),
    purgeAllLabel(),
    purgeAllConfirm({ entryCount: 2, bookingCount: 5, otherOrgBookingCount: 1 }),
    purgeWorkingText(2),
    purgeStalledText(20),
    purgeTimeoutText(90),
    purgeFailedText("boom"),
    purgeFailedText(null),
    purgeSucceededText({ bookingIds: ["bk1"], rowsByTable: { bookings: 1 } }),
    purgeLeftResidualText(["bookings: 1 row(s) still hold contact PII after the purge"]),
    trailUnreadableText("boom"),
    warehouseUnreadableText("boom"),
    warehouseUnconfiguredText(),
    emptyTrailText(),
  ];
  for (const text of all) {
    assert(typeof text === "string" && text.length > 0, `every builder returns a real string`);
    // Written as escapes so this file holds no literal dash for the style hook to
    // catch: the hook cannot tell a line BANNING the character from one using it.
    assert(!/[\u2014\u2013]/.test(text), `no em or en dash in: ${text}`);
    assert(!/\p{Extended_Pictographic}/u.test(text), `no emoji in: ${text}`);
    assert(
      !/undefined|NaN|\[object Object\]/.test(text),
      `no leaked placeholder in: ${text}`,
    );
  }
}

finish();
