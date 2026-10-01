// Putting cal.com back (#2890). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-calcom-put-back.ts
//
// While cal.com is retired every approved absence records "skipped: cal.com
// retired" instead of being written. Pressing "Put cal.com back" has to say how
// many of those the sweep will now copy, on the confirmation and on the saved
// notice, and the count has to be the SAME selection the sweep retries: approved,
// not ended, an agent who is still here, and that exact skip (L16).
import {
  PUT_BACK_UNKNOWN,
  putBackBacklog,
  putBackConfirmSentence,
  putBackQuery,
  putBackSavedSentence,
  type PutBackRow,
} from "../src/lib/calcom/put-back.ts";
import { OUTCOME_CALCOM_RETIRED } from "../src/lib/calcom/outcomes.ts";
import { MAX_RETRIES_PER_TICK, selectCandidates, toCandidates } from "../src/lib/monitor/calcom-override-sweep.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-10-01T15:00:00Z");
const day = 86_400_000;
const at = (ms: number) => new Date(ms).toISOString();

const row = (over: Partial<PutBackRow> = {}): PutBackRow => ({
  id: "r",
  userId: "u-active",
  startsAt: at(NOW + 2 * day),
  endsAt: at(NOW + 3 * day),
  effect: OUTCOME_CALCOM_RETIRED,
  ...over,
});
const active = new Set(["u-active"]);

// --- which rows count --------------------------------------------------------
{
  const rows: PutBackRow[] = [
    row({ id: "future" }),
    row({ id: "under-way", startsAt: at(NOW - day), endsAt: at(NOW + day) }),
    row({ id: "ended", startsAt: at(NOW - 3 * day), endsAt: at(NOW - day) }),
    row({ id: "departed", userId: "u-gone" }),
    row({ id: "written", effect: "ok" }),
    row({ id: "failed", effect: "failed: schedule patch returned 500" }),
    row({ id: "no-account", effect: "skipped: not in cal.com (a@b.com)" }),
  ];
  eq(
    putBackBacklog(rows, active, NOW),
    2,
    "counts only retired skips that have not ended, for agents still here",
  );
  eq(putBackBacklog([], active, NOW), 0, "nothing waiting is a measured zero");
  // An unreadable end is counted rather than dropped: the sweep's own loader judges
  // "not ended" in SQL and would hand the row over, so the count must not be lower.
  eq(
    putBackBacklog([row({ endsAt: "not a date" })], active, NOW),
    1,
    "an unreadable end is counted, the fail-safe side",
  );

  // The count is the sweep's selection, not a second definition of it (L16): the
  // rows it counts are exactly the retired skips the sweep would retry.
  const counted = rows.filter((r) => r.effect === OUTCOME_CALCOM_RETIRED);
  const swept = selectCandidates(
    toCandidates(
      rows.filter((r) => Date.parse(r.endsAt) > NOW),
      new Map([["u-active", "a@trypennie.com"]]),
    ),
    NOW,
  ).filter((c) => c.effect === OUTCOME_CALCOM_RETIRED);
  eq(swept.length, putBackBacklog(counted, active, NOW), "the count equals what the sweep retries");
}

// --- the confirmation, before the press ----------------------------------------
{
  const none = putBackConfirmSentence(0);
  const one = putBackConfirmSentence(1);
  const many = putBackConfirmSentence(12);
  const unknown = putBackConfirmSentence(null);
  assert(/no time off/i.test(none), `zero says nothing is waiting: ${none}`);
  assert(/\b1 approved time off request\b/.test(one) && !/requests/.test(one), `one is singular: ${one}`);
  assert(/\b12 approved time off requests\b/.test(many), `many names the count: ${many}`);
  assert(many.includes(String(MAX_RETRIES_PER_TICK)), `many says how many go per run: ${many}`);
  assert(/could not/i.test(unknown) && !/\d/.test(unknown.replace(/5 minutes/, "")), `unknown invents no number: ${unknown}`);
}

// --- the saved notice, after the press -----------------------------------------
{
  eq(putBackQuery(3), "&copy=3", "a count travels on the redirect");
  eq(putBackQuery(null), `&copy=${PUT_BACK_UNKNOWN}`, "an unreadable count travels as unknown, never as zero");
  eq(putBackQuery(0), "&copy=0", "a measured zero travels as zero");

  const base = /cal\.com is back/i;
  const three = putBackSavedSentence("3");
  assert(base.test(three) && /\b3 approved time off requests\b/.test(three), `names the count: ${three}`);
  const zero = putBackSavedSentence("0");
  assert(base.test(zero) && /no time off/i.test(zero), `zero says nothing needed copying: ${zero}`);
  const unknown = putBackSavedSentence(PUT_BACK_UNKNOWN);
  assert(base.test(unknown) && /could not count/i.test(unknown), `unknown says so: ${unknown}`);
  // A value that is not a count (a hand edited or truncated link) claims no number.
  for (const raw of [undefined, "", "abc", "-1", "1.5"]) {
    const s = putBackSavedSentence(raw);
    assert(base.test(s) && !/\d+ approved/.test(s), `"${String(raw)}" claims no count: ${s}`);
  }
}

finish();
