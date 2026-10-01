// #2459: every departed person with a sign in ends up unable to mint a session,
// and every ACTIVE person Slate itself banned gets their access back, whichever
// path got them there. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/test-session-convergence.ts
//
// Why a convergence and not a call beside the reap's write. The hourly Salesforce
// reap departs people with its own batch write and never came through the
// offboarding path, so nobody it departed was banned in Supabase Auth: measured on
// 2026-10-01, 10 of the 13 departed rows holding an `auth_user_id` were not banned.
// Calling the revoke beside the write would still lose a failed one for ever,
// because the reap only selects rows that are NOT yet departed. The convergence
// reads the END STATE in both directions instead (who is departed and who active,
// against who Supabase Auth says is banned) and repairs the difference, so a
// failure either way is retried by the next run.
//
// Two way, because a one way convergence turned a failed restore into a permanent
// lock out: somebody reactivated mid run, banned, whose restore then failed, was
// active in Slate and banned in Auth, and no later run selected them.
//
// What is pinned: the plan decides from the auth system's own record (L58); a ban
// it did not write (anything short of the departure ban's length) is left alone; a
// failure on one person is its own boundary (L73); the run is bounded; and a
// listing that could not be read refuses rather than reporting zero. Then the
// reporter: it pages only on the second unhealthy run in a row, never on an
// expected backlog, and clears only off a measured healthy run.
import {
  convergeDepartedSessions,
  planSessionConvergence,
  isSlateDepartureBan,
  MAX_SESSION_REVOKES_PER_RUN,
  type SessionConvergenceDeps,
  type SessionConvergenceResult,
  type RosterAuthRow,
} from "@/lib/offboarding/session-convergence";
import {
  sessionConvergenceUnhealthy,
  reportSessionConvergence,
  formatSessionConvergenceAlert,
  formatSessionConvergenceRecovery,
  SESSION_CONVERGENCE_ALERT_KEY,
  type SessionConvergenceOutcome,
} from "@/lib/offboarding/session-convergence-alert";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const SLATE_BAN = "2126-09-07T12:00:00Z"; // what an 876000h ban reads as
const SHORT_BAN = "2026-10-08T12:00:00Z"; // a week: somebody else's ban
const PAST = "2026-01-01T00:00:00Z";

function departed(n: number): RosterAuthRow {
  return { id: `user-${n}`, auth_user_id: `auth-${n}`, departed: true };
}
function active(n: number): RosterAuthRow {
  return { id: `user-${n}`, auth_user_id: `auth-${n}`, departed: false };
}

// ---- whose ban it is ----------------------------------------------------------
{
  assert(isSlateDepartureBan(Date.parse(SLATE_BAN), NOW), "a ban a century out is Slate's departure ban");
  assert(!isSlateDepartureBan(Date.parse(SHORT_BAN), NOW), "a week long ban is somebody else's");
  assert(!isSlateDepartureBan(Date.parse(PAST), NOW), "a lapsed ban is no ban");
}

// ---- the plan ---------------------------------------------------------------
{
  const rows = [departed(1), departed(2), departed(3), departed(4), departed(5), active(6), active(7), active(8)];
  const listing = {
    complete: true,
    bans: new Map<string, string | null>([
      ["auth-1", SLATE_BAN], // already banned
      ["auth-2", null], // never banned: the reap's leaver
      ["auth-3", PAST], // a ban that has lapsed
      ["auth-4", "not a date"], // unreadable: re-banning is idempotent, so it is the safe side
      ["auth-6", SLATE_BAN], // active and still carrying Slate's ban: locked out
      ["auth-7", SHORT_BAN], // active and banned by somebody else: left alone
      ["auth-8", null], // active and fine
    ]),
  };
  const p = planSessionConvergence(rows, listing, NOW, 10);
  eq(p.toRevoke.map((r) => r.id), ["user-2", "user-3", "user-4"], "revokes the unbanned, the lapsed and the unreadable");
  eq(p.toRestore.map((r) => r.id), ["user-6"], "restores an active person carrying Slate's departure ban");
  eq(p.alreadyRevoked, 1, "counts the departed person already banned");
  eq(p.foreignBans, 1, "counts, and leaves alone, an active person banned some other way");
  eq(p.unlisted, 1, "a departed row the listing does not hold is counted, never banned blind");
  eq(p.deferred, 0, "nothing deferred under the cap");
}
{
  const rows = Array.from({ length: 30 }, (_, i) => departed(i));
  const bans = new Map<string, string | null>(rows.map((r) => [r.auth_user_id, null]));
  const p = planSessionConvergence(rows, { complete: true, bans }, NOW, 25);
  eq(p.toRevoke.length, 25, "bounded per run");
  eq(p.deferred, 5, "and says how many wait for the next run");
}
assert(MAX_SESSION_REVOKES_PER_RUN > 0 && MAX_SESSION_REVOKES_PER_RUN <= 50, "the per run cap is a real bound");

// ---- the run ----------------------------------------------------------------
type Fake = SessionConvergenceDeps & { revoked: string[]; restored: string[]; order: string[] };
function deps(over: Partial<SessionConvergenceDeps> & {
  roster?: RosterAuthRow[];
  bans?: Map<string, string | null>;
  revokeFails?: Set<string>;
  restoreFails?: Set<string>;
  reactivatedMeanwhile?: Set<string>;
} = {}): Fake {
  const revoked: string[] = [];
  const restored: string[] = [];
  const order: string[] = [];
  return {
    revoked,
    restored,
    order,
    listAuthBans: over.listAuthBans ?? (async () => {
      order.push("listAuthBans");
      return { complete: true, bans: over.bans ?? new Map() };
    }),
    listRoster: over.listRoster ?? (async () => {
      order.push("listRoster");
      return over.roster ?? [];
    }),
    revoke: over.revoke ?? (async (authUserId: string) => {
      order.push(`revoke:${authUserId}`);
      if (over.revokeFails?.has(authUserId)) throw new Error("GoTrue said no");
      revoked.push(authUserId);
      return "revoked" as const;
    }),
    restore: over.restore ?? (async (authUserId: string) => {
      order.push(`restore:${authUserId}`);
      if (over.restoreFails?.has(authUserId)) throw new Error("GoTrue said no");
      restored.push(authUserId);
      return "restored" as const;
    }),
    stillDeparted: over.stillDeparted ?? (async (ids: string[]) => {
      order.push("stillDeparted");
      return new Set(ids.filter((id) => !over.reactivatedMeanwhile?.has(id)));
    }),
    now: () => NOW,
  };
}

function measured(over: Partial<SessionConvergenceResult> = {}): SessionConvergenceOutcome {
  return { ok: true, result: clean(over) };
}

function clean(over: Partial<SessionConvergenceResult> = {}): SessionConvergenceResult {
  return {
    departed: 0, alreadyRevoked: 0, revoked: 0, revokeFailed: 0, restored: 0, restoreFailed: 0,
    foreignBans: 0, deferred: 0, unlisted: 0, listingComplete: true, ...over,
  };
}

async function main(): Promise<void> {
  {
    const d = deps({
      roster: [departed(1), departed(2), active(3)],
      bans: new Map([["auth-1", SLATE_BAN], ["auth-2", null], ["auth-3", null]]),
    });
    const r = await convergeDepartedSessions(d);
    eq(d.revoked, ["auth-2"], "bans only the departed person who is not banned");
    eq(r, clean({ departed: 2, alreadyRevoked: 1, revoked: 1 }), "and reports every count");
    assert(d.order.indexOf("listAuthBans") < d.order.indexOf("listRoster"),
      "reads the auth listing BEFORE the roster, so the window a lifecycle change can race is the shortest one");
  }
  {
    // One failure is its own boundary (L73): the people behind it are still banned.
    const d = deps({
      roster: [departed(1), departed(2), departed(3)],
      bans: new Map([["auth-1", null], ["auth-2", null], ["auth-3", null]]),
      revokeFails: new Set(["auth-1"]),
    });
    const r = await convergeDepartedSessions(d);
    eq(d.revoked, ["auth-2", "auth-3"], "a refused ban does not abandon the others");
    eq(r.revokeFailed, 1, "and is counted as failed, never as revoked");
    eq(r.revoked, 2, "while the others count as revoked");
  }
  {
    // The two way half: an active person still carrying Slate's ban is given access.
    const d = deps({ roster: [active(1)], bans: new Map([["auth-1", SLATE_BAN]]) });
    const r = await convergeDepartedSessions(d);
    eq(d.restored, ["auth-1"], "restores an active person Slate's departure ban still locks out");
    eq(r.restored, 1, "and counts it as restored");
  }
  {
    const d = deps({ roster: [active(1)], bans: new Map([["auth-1", SHORT_BAN]]) });
    const r = await convergeDepartedSessions(d);
    eq(d.restored, [], "never lifts a ban Slate did not write");
    eq(r.foreignBans, 1, "and says it saw one");
  }
  {
    const d = deps({ roster: [active(1)], bans: new Map([["auth-1", SLATE_BAN]]), restoreFails: new Set(["auth-1"]) });
    const r = await convergeDepartedSessions(d);
    eq(r.restoreFailed, 1, "a refused restore is counted as failed");
    eq(r.restored, 0, "and not as restored");
  }
  {
    // Reactivated between the read and the ban: read back and restored at once.
    const d = deps({
      roster: [departed(1), departed(2)],
      bans: new Map([["auth-1", null], ["auth-2", null]]),
      reactivatedMeanwhile: new Set(["user-2"]),
    });
    const r = await convergeDepartedSessions(d);
    eq(d.restored, ["auth-2"], "gives a person reactivated mid run their access back");
    eq(r.revoked, 1, "does not count them as revoked");
    eq(r.restored, 1, "counts them as restored");
  }
  {
    // ...and when THAT restore fails, it is a failure, not a revoke, and the next
    // run (which now reads them as active and banned) restores them.
    const d = deps({
      roster: [departed(2)],
      bans: new Map([["auth-2", null]]),
      reactivatedMeanwhile: new Set(["user-2"]),
      restoreFails: new Set(["auth-2"]),
    });
    const r = await convergeDepartedSessions(d);
    eq(r.revoked, 0, "a raced ban whose restore failed is not counted as revoked");
    eq(r.restoreFailed, 1, "it is counted as a failed restore");
    const next = deps({ roster: [active(2)], bans: new Map([["auth-2", SLATE_BAN]]) });
    await convergeDepartedSessions(next);
    eq(next.restored, ["auth-2"], "and the next run converges it");
  }
  {
    const d = deps({ roster: [departed(1)], bans: new Map([["auth-1", SLATE_BAN]]) });
    await convergeDepartedSessions(d);
    assert(!d.order.includes("stillDeparted"), "a run that banned nobody does not read back");
  }
  {
    const d = deps({
      roster: [departed(1)],
      listAuthBans: async () => {
        throw new Error("auth admin 503");
      },
    });
    let threw = "";
    try {
      await convergeDepartedSessions(d);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    assert(threw.includes("auth admin 503"), "an unreadable auth listing throws with its reason");
    eq(d.revoked, [], "and bans nobody");
  }
  {
    const d = deps({
      roster: [departed(1), departed(2)],
      listAuthBans: async () => ({ complete: false, bans: new Map([["auth-1", null]]) }),
    });
    const r = await convergeDepartedSessions(d);
    eq(d.revoked, ["auth-1"], "a partial listing bans the people it can see");
    eq(r.listingComplete, false, "and reports the listing as partial");
    eq(r.unlisted, 1, "and counts the one it could not see");
  }

  // ---- the health judgement and the reporter --------------------------------
  eq(sessionConvergenceUnhealthy(measured()), null, "a clean run is healthy");
  eq(sessionConvergenceUnhealthy(measured({ deferred: 12 })), null, "a backlog the cap left for next run is expected, not unhealthy");
  eq(sessionConvergenceUnhealthy(measured({ foreignBans: 1, unlisted: 2 })), null, "a foreign ban or an unlisted row is not a failure");
  for (const [outcome, why] of [
    [{ ok: false, reason: "could not list auth users: 503" }, "an unreadable read"],
    [measured({ revokeFailed: 1 }), "a refused ban"],
    [measured({ restoreFailed: 1 }), "a refused restore"],
    [measured({ listingComplete: false }), "a partial listing"],
  ] as [SessionConvergenceOutcome, string][]) {
    assert(sessionConvergenceUnhealthy(outcome) !== null, `${why} is unhealthy`);
  }

  type Rec = { streaks: number; cleared: number; sent: string[]; resolved: number };
  function reporter(streakAnswers: boolean[]) {
    const rec: Rec = { streaks: 0, cleared: 0, sent: [], resolved: 0 };
    const seq = [...streakAnswers];
    return {
      rec,
      d: {
        recordStreak: async () => {
          rec.streaks += 1;
          return seq.shift() ?? false;
        },
        clearStreak: async () => {
          rec.cleared += 1;
        },
        notify: async (key: string, _ms: number, text: string) => {
          rec.sent.push(`${key}|${text}`);
        },
        resolve: async () => {
          rec.resolved += 1;
          return true;
        },
        cooldownMs: async () => 6 * 60 * 60_000,
      },
    };
  }
  {
    const { rec, d } = reporter([false]);
    await reportSessionConvergence({ ok: false, reason: "listing refused" }, d);
    eq(rec.sent.length, 0, "a single unhealthy run pages nobody");
    eq(rec.resolved, 0, "and clears nothing, because it measured nothing healthy");
    eq(rec.cleared, 0, "and does not reset the streak");
  }
  {
    const { rec, d } = reporter([true]);
    await reportSessionConvergence(measured({ restoreFailed: 1 }), d);
    eq(rec.sent.length, 1, "the second unhealthy run in a row pages");
    assert(rec.sent[0].startsWith(`${SESSION_CONVERGENCE_ALERT_KEY}|`), "on its own key");
  }
  {
    const { rec, d } = reporter([]);
    await reportSessionConvergence(measured({ deferred: 30 }), d);
    eq(rec.streaks, 0, "a backlog run does not count toward the streak");
    eq(rec.cleared, 1, "it is a measured healthy run, so it resets the streak");
    eq(rec.resolved, 1, "and sends the all clear");
  }
  {
    // A Slack failure must never fail the roster run.
    const { d } = reporter([true]);
    await reportSessionConvergence(measured({ revokeFailed: 2 }), {
      ...d,
      notify: async () => {
        throw new Error("slack down");
      },
    });
    assert(true, "a notify that throws is contained");
  }

  // ---- the copy ---------------------------------------------------------------
  const unreadable = formatSessionConvergenceAlert({ ok: false, reason: "could not list auth users: 503" });
  assert(unreadable.includes("could not list auth users: 503"), "an unreadable run names its reason");
  const lockedOut = formatSessionConvergenceAlert(measured({ restoreFailed: 2, revokeFailed: 1 }));
  assert(/2 people/.test(lockedOut) && /locked out/.test(lockedOut), "a failed restore says somebody active is locked out");
  assert(/1 person/.test(lockedOut), "and counts a failed ban in the singular");
  const partial = formatSessionConvergenceAlert(measured({ listingComplete: false }));
  assert(/partial|could not see/.test(partial), "a partial listing says so");
  for (const text of [unreadable, lockedOut, partial, formatSessionConvergenceRecovery()]) {
    assert(!/[\u2014\u2013]/.test(text), "carries no dash");
    assert(!text.startsWith("Slate"), "does not open with the app name");
  }
  finish();
}

void main();
