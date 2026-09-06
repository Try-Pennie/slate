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
//     The controls those lines described went in #1961: the page is read only
//     now, and what stands where the buttons did is a sentence saying how a
//     purge IS run. Their tests were deleted rather than adjusted (L252).
// Run: node --experimental-strip-types scripts/test-erasure-worklist.ts
import {
  entryResidualTotal,
  entryStatus,
  summarizeWorklist,
  MAX_ATTRIBUTED_ENTRIES,
  needsPerEntryAttribution,
  type ErasureWorklistEntry,
} from "../src/lib/snowflake/erasure-worklist.ts";
import {
  entryResidualText,
  entryStatusLabel,
  howToPurgeText,
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

// --- when the loader asks Snowflake about each entry separately ---
//
// Restored here in #1961. Its only coverage used to sit inside the bulk purge
// confirm's tests, and deleting those with the controls took it with them: live
// code whose only test was a side effect of testing something else (L281).
//
// Attribution costs one warehouse round trip per table per entry, so the two
// cases that must NOT spend one are the whole point: a measured zero already
// proves every entry is clean, because each entry's bookings are a subset of the
// trail's, and an unmeasurable total cannot be attributed to anything.
{
  assert(needsPerEntryAttribution(4), "a measured residual is attributed to entries");
  assert(!needsPerEntryAttribution(0), "a measured zero already proves every entry clean");
  assert(
    !needsPerEntryAttribution(null),
    "and an unmeasured total cannot be attributed, so it spends no call either",
  );
  // The two cheap answers are DIFFERENT states even though they cost the same,
  // and the loader tells them apart elsewhere: zero renders as clean, null as
  // unknown. This is only asserting neither one triggers the round trips.
  assert(MAX_ATTRIBUTED_ENTRIES > 0, "the bound is a real number of entries");
  assert(
    Number.isInteger(MAX_ATTRIBUTED_ENTRIES),
    "and a whole one, since it indexes a list",
  );
}

// --- there is no control here any more (#1961) ---
//
// The blocks that stood here drove the purge controls: the per row confirm's
// scope, the bulk confirm's, the labels, and the three progress states. They
// were DELETED rather than adjusted when the controls went, because their whole
// content was the behaviour being removed, and a test defending a reversed
// decision is the guard that keeps it alive (L252).
//
// What replaces them is the sentence that stands where the button did. A screen
// that names a fault and offers no remedy teaches its reader to skim it (L126,
// L148), so the absence has to be explained rather than left as a gap.
{
  const how = howToPurgeText();
  assert(/no button for this, deliberately/i.test(how), "it says the absence is a decision");
  assert(/cannot be undone/i.test(how), "and why: the deletion is irreversible");
  assert(/naming who asked/i.test(how), "it says the run has to name who asked for the erasure");
  assert(/refuses to run without that name/i.test(how), "and that this is enforced rather than asked politely");
  assert(/pii-erasure-runbook/.test(how), "and where the steps are");
  // It names no COMMAND and no secret. A runbook step changes and a copy string
  // does not, and one naming a stale command is worse than one naming none
  // (L210). This is the assertion that fails if somebody pastes a curl in here.
  assert(!/curl|CRON_SECRET|http/i.test(how), "and it pastes in no command or secret to go stale");
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
    howToPurgeText(),
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
