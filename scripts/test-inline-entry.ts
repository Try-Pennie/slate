// What the booker is asked to open as, read from its address (#3718). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-inline-entry.ts
//
// `/book` and `/demo` both read it, so the inline card, its two pieces (Geoff,
// 2026-10-15) and the pop up a piece opens are asked for the same way on both.
// Anything it cannot read is absent, never a guess: an unknown piece is the whole
// card, a malformed time or day opens the booker as usual.
import { readInlineEntry } from "../src/lib/embed/inline-entry.ts";
import { eq, finish } from "./lib/harness.ts";

const none = { layout: undefined, piece: null, initialSlot: null, initialDay: null, pressCallMeNow: false };
eq(readInlineEntry({}), none, "a plain address asks for the full booker");
eq(readInlineEntry({ layout: "month_view" }), none, "a cal.com layout is not ours");
eq(readInlineEntry({ layout: "inline" }), { ...none, layout: "inline" }, "the whole card");
eq(readInlineEntry({ layout: "inline", piece: "times" }).piece, "times", "the times piece");
eq(readInlineEntry({ layout: "inline", piece: "callMeNow" }).piece, "callMeNow", "the Call me now piece");
eq(readInlineEntry({ layout: "inline", piece: "everything" }).piece, null, "an unknown piece is the whole card");
eq(readInlineEntry({ piece: "times" }).piece, null, "a piece needs the inline layout");
eq(readInlineEntry({ layout: ["inline", "x"], piece: ["times"] }).piece, "times", "a repeated parameter reads its first value");

eq(readInlineEntry({ slot: "2026-10-16T14:30:00.000Z" }).initialSlot, "2026-10-16T14:30:00.000Z", "a picked time opens the full booker on it");
eq(readInlineEntry({ slot: "tomorrow" }).initialSlot, null, "a time that is not an instant is absent");
eq(readInlineEntry({ slot: "2026-10-16T25:99:00.000Z" }).initialSlot, null, "an impossible instant is absent");
eq(readInlineEntry({ day: "2026-10-16" }).initialDay, "2026-10-16", "View more times opens on a day");
eq(readInlineEntry({ day: "2026-13-40" }).initialDay, null, "an impossible day is absent");
eq(readInlineEntry({ layout: "inline", slot: "2026-10-16T14:30:00.000Z" }).initialSlot, null, "the card never opens on a time: only the pop up does");

eq(readInlineEntry({ layout: "inline", cmnPress: "1" }).pressCallMeNow, true, "the Call me now pop up presses on arrival");
eq(readInlineEntry({ cmnPress: "1" }).pressCallMeNow, false, "only the card can press");
eq(readInlineEntry({ layout: "inline", piece: "callMeNow", cmnPress: "1" }).pressCallMeNow, false, "never the small piece itself");
eq(readInlineEntry({ layout: "inline", cmnPress: "yes" }).pressCallMeNow, false, "only 1 presses");

finish();
