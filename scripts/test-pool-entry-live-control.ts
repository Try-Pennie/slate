// Pure logic for the LIVE pool entry check (#2316). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/test-pool-entry-live-control.ts
//
// Why this exists. `pnpm verify:pool-entry` runs the activation gate's reads (the
// reachability probe, then `onboardIntoPool`) against REAL Google, because the
// gate's refusal paths are driven by hand written fakes and a fake agrees with our
// assumption about Google's interface by construction (L52). The live half cannot
// be unit tested, and the half that DECIDES what the live answers mean must not be
// left untested because of it.
//
// BOTH directions (L1): a readable agent with every calendar hydrated passes, an
// account with no Calendar licence refused by the probe passes, and every other
// combination refuses with its own code. A one sided control is satisfied by a
// gate hard wired to a single answer.
//
// The codes and messages are asserted distinct (L11): one message answering for
// another is how "could not check" ends up reading as "checked, all fine".
import {
  OUTCOMES,
  readInputs,
  checkSubjects,
  judgeReadable,
  judgeUnprovisioned,
  settle,
  type OutcomeCode,
  type SubjectRow,
  type DirectionVerdict,
} from "./lib/pool-entry-live-check.ts";
import { poolEntryRefusal } from "@/lib/bookable/pool-entry-verdict";
import type { PoolEntryResult } from "@/lib/google/pool-entry";
import { assert, eq, finish } from "./lib/harness.ts";

const produced = new Set<OutcomeCode>();
function saw(code: OutcomeCode | null): void {
  if (code) produced.add(code);
}

const READABLE = "reader@trypennie.com";
const UNLICENSED = "departed@trypennie.com";

function subject(over: Partial<SubjectRow> = {}): SubjectRow {
  return {
    id: "user-1",
    email: READABLE,
    bookable: true,
    deactivatedAt: null,
    ...over,
  };
}
const unlicensed = subject({
  id: "user-2",
  email: UNLICENSED,
  bookable: false,
  deactivatedAt: "2026-08-24T07:52:34.954+00:00",
});

function entry(over: Partial<PoolEntryResult> = {}): PoolEntryResult {
  return { calendars: 1, hydrated: 1, failed: 0, watch: "current", outOfBudget: false, ...over };
}

// ---- inputs ---------------------------------------------------------------
{
  const r = readInputs({});
  assert(!r.ok, "no emails at all refuses before anything is read");
  if (!r.ok) {
    eq(r.code, "inputs-missing", "as missing inputs");
    saw(r.code);
  }
}
{
  const r = readInputs({ POOL_ENTRY_READABLE_EMAIL: READABLE, POOL_ENTRY_UNPROVISIONED_EMAIL: "  " });
  assert(!r.ok, "a blank unprovisioned email is missing, not a subject (L138)");
  if (!r.ok) eq(r.code, "inputs-missing", "and says so");
}
{
  const r = readInputs({ POOL_ENTRY_READABLE_EMAIL: READABLE, POOL_ENTRY_UNPROVISIONED_EMAIL: ` ${READABLE.toUpperCase()} ` });
  assert(!r.ok, "one account named for BOTH directions cannot prove both, so it refuses");
  if (!r.ok) {
    eq(r.code, "inputs-same-account", "as the same account");
    saw(r.code);
  }
}
{
  const r = readInputs({ POOL_ENTRY_READABLE_EMAIL: ` ${READABLE} `, POOL_ENTRY_UNPROVISIONED_EMAIL: UNLICENSED });
  assert(r.ok, "two distinct emails are accepted");
  if (r.ok) {
    eq(r.readableEmail, READABLE, "trimmed");
    eq(r.unprovisionedEmail, UNLICENSED, "as given");
  }
}

// ---- subjects -------------------------------------------------------------
{
  const cases: [SubjectRow | null, SubjectRow | null, OutcomeCode, string][] = [
    [null, unlicensed, "readable-not-found", "a readable email with no Slate user refuses"],
    [subject({ bookable: false }), unlicensed, "readable-not-bookable",
      "a readable agent OUTSIDE the pool refuses, since onboarding them would build a pool entry for somebody nobody activated"],
    [subject({ deactivatedAt: "2026-09-01T00:00:00Z" }), unlicensed, "readable-deactivated",
      "a deactivated readable agent refuses, separately from not bookable"],
    [subject(), null, "unprovisioned-not-found", "an unprovisioned email with no Slate user refuses"],
  ];
  for (const [r, u, code, msg] of cases) {
    const v = checkSubjects(r, u);
    eq(v?.code ?? null, code, msg);
    saw(v?.code ?? null);
  }
  eq(checkSubjects(subject(), unlicensed), null, "a bookable readable agent and an existing unlicensed one are accepted");
  eq(
    checkSubjects(subject({ deactivatedAt: "2026-09-01T00:00:00Z", bookable: false }), unlicensed)?.code ?? null,
    "readable-deactivated",
    "deactivated is named over not bookable when both hold, since it is the cause",
  );
}

// ---- readable direction ---------------------------------------------------
function readable(probe: Parameters<typeof judgeReadable>[0], e: Parameters<typeof judgeReadable>[1]): DirectionVerdict {
  const v = judgeReadable(probe, e);
  saw(v.code);
  return v;
}
{
  const v = readable(null, { kind: "result", result: entry({ calendars: 2, hydrated: 2 }) });
  assert(v.ok, "reachable, and every calendar hydrated, passes");
  eq(v.code, null, "with no refusal code");
}
{
  const cases: [Parameters<typeof judgeReadable>[0], Parameters<typeof judgeReadable>[1], OutcomeCode, string][] = [
    ["google_not_provisioned", { kind: "not-run" }, "readable-not-provisioned",
      "the readable agent's probe reporting no Calendar licence refuses on its own code"],
    ["google_unreachable", { kind: "not-run" }, "readable-refused",
      "the readable agent's probe reporting the account gone refuses on its own code"],
    ["google_unverified", { kind: "not-run" }, "readable-unverified",
      "a probe that could not tell twice refuses as unverified, not as a verdict"],
    [null, { kind: "threw", detail: "boom" }, "readable-threw",
      "onboarding that threw refuses; the least informative failure never passes (L93)"],
    [null, { kind: "result", result: entry({ calendars: 0, hydrated: 0 }) }, "readable-no-calendars",
      "no calendars at all refuses: nothing was hydrated because nothing was found"],
    [null, { kind: "result", result: entry({ calendars: 2, hydrated: 1, failed: 1 }) }, "readable-not-hydrated",
      "one calendar failing among two refuses"],
    [null, { kind: "result", result: entry({ calendars: 2, hydrated: 1, failed: 0, outOfBudget: true }) },
      "readable-out-of-budget", "a run the budget cut short refuses as out of budget, not as a failed calendar"],
    [null, { kind: "result", result: entry({ calendars: 2, hydrated: 1, failed: 0, outOfBudget: false }) },
      "gate-admitted-unhydrated",
      "a calendar neither hydrated nor failed while the SHIPPED predicate admits is the gate letting somebody in unread"],
  ];
  for (const [p, e, code, msg] of cases) {
    const v = readable(p, e);
    assert(!v.ok, msg);
    eq(v.code, code, `${msg}: code`);
  }
  // A measured failure outranks the budget, exactly as the gate ranks them (#2317).
  const v = readable(null, { kind: "result", result: entry({ calendars: 3, hydrated: 1, failed: 1, outOfBudget: true }) });
  eq(v.code, "readable-not-hydrated", "a failed calendar outranks an exhausted budget, as the gate ranks them");
}
{
  // The live check must agree with the SHIPPED predicate on everything it passes,
  // or a pass here would be about a gate that does not exist (L107).
  const pass = entry({ calendars: 3, hydrated: 3 });
  eq(poolEntryRefusal(pass), null, "the shipped predicate admits what the live check passes");
  eq(poolEntryRefusal(entry({ calendars: 1, hydrated: 0, failed: 1 })), "calendar_unhydrated", "and refuses a failed calendar");
  eq(poolEntryRefusal(entry({ calendars: 2, hydrated: 1, outOfBudget: true })), "activation_timed_out", "and names a timeout");
  eq(poolEntryRefusal(entry({ calendars: 2, hydrated: 1, failed: 1, outOfBudget: true })), "calendar_unhydrated",
    "and ranks a measured failure over the budget");
  eq(poolEntryRefusal(null), "calendar_unhydrated", "and refuses a throw as unhydrated");
  eq(poolEntryRefusal(entry({ calendars: 0, hydrated: 0 })), "calendar_unhydrated", "and refuses no calendars");
}

// ---- unprovisioned direction ----------------------------------------------
{
  const v = judgeUnprovisioned("google_not_provisioned");
  saw(v.code);
  assert(v.ok, "an unlicensed account refused by the gate as not provisioned passes");
}
{
  const cases: [Parameters<typeof judgeUnprovisioned>[0], OutcomeCode, string][] = [
    [null, "unprovisioned-admitted", "an unlicensed account the probe REACHED is a gate that would let them through"],
    ["google_unreachable", "unprovisioned-refused-as-gone",
      "refused as gone is the right answer to the wrong question, so it does not prove the not-provisioned arm"],
    ["google_unverified", "unprovisioned-unverified", "a probe that could not tell proves nothing either way"],
  ];
  for (const [p, code, msg] of cases) {
    const v = judgeUnprovisioned(p);
    saw(v.code);
    assert(!v.ok, msg);
    eq(v.code, code, `${msg}: code`);
  }
}

// ---- settle ---------------------------------------------------------------
{
  const ok = judgeReadable(null, { kind: "result", result: entry() });
  const unOk = judgeUnprovisioned("google_not_provisioned");
  const s = settle(ok, unOk);
  eq(s.exit, 0, "both directions proved exits 0");
  saw(s.code);
  eq(s.code, "passed", "as passed");

  const rBad = judgeReadable(null, { kind: "result", result: entry({ calendars: 0, hydrated: 0 }) });
  const uBad = judgeUnprovisioned(null);
  eq(settle(ok, uBad).code, "unprovisioned-admitted", "one direction failing fails the run: the other passing proves nothing alone");
  eq(settle(rBad, unOk).code, "readable-no-calendars", "in either direction");
  eq(settle(rBad, uBad).code, "readable-no-calendars", "when both fail, the readable direction names the run");
  eq(settle(rBad, uBad).exit, OUTCOMES["readable-no-calendars"].exit, "on its own exit code");
}

// ---- the table itself -----------------------------------------------------
{
  const codes = Object.keys(OUTCOMES) as OutcomeCode[];
  const exits = codes.map((c) => OUTCOMES[c].exit);
  eq(new Set(exits).size, exits.length, "no two outcomes share an exit code");
  const messages = codes.map((c) => OUTCOMES[c].meaning);
  eq(new Set(messages).size, messages.length, "no two outcomes share a message");
  assert(OUTCOMES.passed.exit === 0, "only passed exits 0");
  assert(codes.filter((c) => OUTCOMES[c].exit === 0).length === 1, "and nothing else does");
  assert(codes.every((c) => /\S/.test(OUTCOMES[c].meaning)), "every outcome says something");
  // Every outcome the table declares must be one a case above produced, or the
  // table promises a code nothing can reach (L151). users-unreadable is the one
  // the pure half cannot produce: it is a failed database read, owned by the
  // script, and is named here rather than left silently exempt (L129).
  const onlyLive: OutcomeCode[] = ["users-unreadable"];
  const unproduced = codes.filter((c) => !produced.has(c) && !onlyLive.includes(c));
  eq(unproduced, [], "every declared outcome is produced by some case");
}

finish();
