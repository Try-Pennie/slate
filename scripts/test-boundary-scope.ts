// #1974: the sentence that says HOW WIDELY a page is failing.
//
// It is the fact that decides whether the reader gets up. One catch on one load
// is a stale bundle, a chunk that failed to load, or somebody's extension; the
// same page failing eleven times in half an hour is a page nobody can use, and
// before the count both arrived on the same path and read identically (L77).
//
// Each of the three states says only what was actually measured (L11), and the
// unmeasured one is the trap: it must not borrow the wording of either other
// state, because both of those would report a scope nothing established.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-boundary-scope.ts
import { boundaryCatchAlert } from "../src/lib/notify/misc-alert-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const alert = (count: number | null, measured: boolean) =>
  boundaryCatchAlert("/admin", "digest 1", { count, measured, windowMinutes: 30 });

// A COUNTED BREAK names the figure and the window it was counted over. A number
// with no window is not a rate, and the reader cannot judge eleven without it.
{
  const text = alert(11, true);
  assert(/11 loads/.test(text), "the figure reaches the message");
  assert(/last 30 minutes/.test(text), "and so does the window it was counted over");
  assert(/rather than one person's browser/.test(text), "and it says what the figure rules out");
}

// THE FIGURE MISSING is not the same as the break being small. The alert is only
// sent on a repeat, so more-than-once is known even where the number is not, and
// claiming only that is the honest reading.
{
  const text = alert(null, true);
  assert(/more than once/.test(text), "an unread figure still reports the repeat it knows about");
  assert(/could not read the exact figure/.test(text), "and says the figure itself is missing");
  assert(!/\bNaN\b|null|undefined/.test(text), "without leaking the absent value");
}

// THE COUNTER FAILING is a third thing again, and the one most easily mistaken
// for the others: the scope is not small and it is not large, it is UNKNOWN.
{
  const text = alert(null, false);
  assert(/could not count/.test(text), "an unmeasured run says the counting failed");
  assert(/scope as unknown/.test(text), "and names the scope as the open question");
  assert(!/more than once/.test(text), "rather than claiming a repeat it never established");
  assert(!/loads of it have shown/.test(text), "or a figure");
}

// No two of the three read the same, because they ask for different next moves.
{
  const three = [alert(11, true), alert(null, true), alert(null, false)];
  eq(new Set(three).size, 3, "each state says something different");
  for (const t of three) {
    assert(/\/admin/.test(t), "every state still names the page");
    assert(/Worker logs/.test(t), "and still points at where the detail is");
    assert(!/undefined|\[object|NaN/.test(t), "and leaks nothing");
  }
}

// A COUNT OF ONE cannot render "1 loads". The route does not send on a single
// catch, so this is a shape nobody should meet, but the copy is the last place
// that can make it unreadable if anything ever does.
{
  const text = alert(1, true);
  assert(!/\b1 loads\b/.test(text), "a count of one never renders as a plural");
  assert(/more than once/.test(text), "it falls to the sentence that claims only the repeat");
}

finish();
