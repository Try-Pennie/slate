// #2459: every departed person with a sign in ends up unable to mint a session,
// whichever path departed them. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/test-session-convergence.ts
//
// Why a convergence and not a call beside the reap's write. The hourly Salesforce
// reap departs people with its own batch write and never came through the
// offboarding path, so nobody it departed was banned in Supabase Auth: measured on
// 2026-10-01, 10 of the 13 departed rows holding an `auth_user_id` were not banned.
// Calling the revoke beside the write would still lose a failed one for ever,
// because the reap only selects rows that are NOT yet departed, so nothing would
// ever ask again. The convergence reads the END STATE instead (who is departed,
// and who Supabase Auth says is banned) and repairs the difference, so a failure
// is retried by the next run and the rows already damaged are repaired by the
// first one.
//
// What is pinned here: the plan decides from the auth system's own record and
// never from a stamp Slate wrote (L58); a failure on one person is its own
// boundary (L73); the run is bounded; a person reactivated while the run was in
// flight is given their access back rather than locked out with nothing saying
// why; and a listing that could not be read refuses rather than reporting zero.
import {
  convergeDepartedSessions,
  planSessionConvergence,
  MAX_SESSION_REVOKES_PER_RUN,
  type SessionConvergenceDeps,
  type DepartedRow,
} from "@/lib/offboarding/session-convergence";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const FUTURE = "2126-09-07T12:00:00Z";
const PAST = "2026-01-01T00:00:00Z";

function row(n: number): DepartedRow {
  return { id: `user-${n}`, auth_user_id: `auth-${n}` };
}

// ---- the plan ---------------------------------------------------------------
{
  const departed = [row(1), row(2), row(3), row(4), row(5)];
  const listing = {
    complete: true,
    bans: new Map<string, string | null>([
      ["auth-1", FUTURE], // already banned
      ["auth-2", null], // never banned: the reap's leaver
      ["auth-3", PAST], // a ban that has lapsed
      ["auth-4", "not a date"], // unreadable: re-banning is idempotent, so it is the safe side
    ]),
  };
  const p = planSessionConvergence(departed, listing, NOW, 10);
  eq(p.toRevoke.map((r) => r.id), ["user-2", "user-3", "user-4"], "revokes the unbanned, the lapsed and the unreadable");
  eq(p.alreadyRevoked, 1, "and counts the one already banned without touching it");
  eq(p.unlisted, 1, "a departed row the listing does not hold is counted, never banned blind");
  eq(p.deferred, 0, "nothing deferred under the cap");
}
{
  const departed = Array.from({ length: 30 }, (_, i) => row(i));
  const bans = new Map<string, string | null>(departed.map((r) => [r.auth_user_id, null]));
  const p = planSessionConvergence(departed, { complete: true, bans }, NOW, 25);
  eq(p.toRevoke.length, 25, "bounded per run");
  eq(p.deferred, 5, "and says how many wait for the next run");
  eq(p.unlisted, 0, "and none of them is unlisted");
}
{
  // A complete listing that lacks a departed person's auth user means the auth
  // user is gone, so there is nothing to revoke. Counted all the same.
  const p = planSessionConvergence([row(1)], { complete: true, bans: new Map([["auth-9", null]]) }, NOW, 10);
  eq(p.toRevoke.length, 0, "an auth user the listing does not hold is not banned");
  eq(p.unlisted, 1, "and is counted");
}
assert(MAX_SESSION_REVOKES_PER_RUN > 0 && MAX_SESSION_REVOKES_PER_RUN <= 50, "the per run cap is a real bound");

// ---- the run ----------------------------------------------------------------
type Fake = SessionConvergenceDeps & { revoked: string[]; restored: string[]; order: string[] };
function deps(over: Partial<SessionConvergenceDeps> & {
  departed?: DepartedRow[];
  bans?: Map<string, string | null>;
  revokeFails?: Set<string>;
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
    listDeparted: over.listDeparted ?? (async () => {
      order.push("listDeparted");
      return over.departed ?? [];
    }),
    revoke: over.revoke ?? (async (authUserId: string) => {
      order.push(`revoke:${authUserId}`);
      if (over.revokeFails?.has(authUserId)) throw new Error("GoTrue said no");
      revoked.push(authUserId);
      return "revoked" as const;
    }),
    restore: over.restore ?? (async (authUserId: string) => {
      order.push(`restore:${authUserId}`);
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

async function main(): Promise<void> {
  {
    const d = deps({
      departed: [row(1), row(2)],
      bans: new Map([["auth-1", FUTURE], ["auth-2", null]]),
    });
    const r = await convergeDepartedSessions(d);
    eq(d.revoked, ["auth-2"], "bans only the departed person who is not banned");
    eq(r, { departed: 2, alreadyRevoked: 1, revoked: 1, failed: 0, deferred: 0, unlisted: 0, restoredAfterRace: 0, listingComplete: true },
      "and reports every count");
    assert(d.order.indexOf("listAuthBans") < d.order.indexOf("listDeparted"),
      "reads the auth listing BEFORE the departed rows, so the window a reactivation can race is the shortest one");
  }
  {
    // One failure is its own boundary (L73): the people behind it are still banned.
    const d = deps({
      departed: [row(1), row(2), row(3)],
      bans: new Map([["auth-1", null], ["auth-2", null], ["auth-3", null]]),
      revokeFails: new Set(["auth-1"]),
    });
    const r = await convergeDepartedSessions(d);
    eq(d.revoked, ["auth-2", "auth-3"], "a refused ban does not abandon the others");
    eq(r.failed, 1, "and is counted as failed, never as revoked");
    eq(r.revoked, 2, "while the others count as revoked");
  }
  {
    // Somebody reactivated between the read and the ban would otherwise be locked
    // out with nothing on any screen saying why. The run reads back and restores.
    const d = deps({
      departed: [row(1), row(2)],
      bans: new Map([["auth-1", null], ["auth-2", null]]),
      reactivatedMeanwhile: new Set(["user-2"]),
    });
    const r = await convergeDepartedSessions(d);
    eq(d.restored, ["auth-2"], "gives a person reactivated mid run their access back");
    eq(r.restoredAfterRace, 1, "and says so");
    eq(r.revoked, 1, "and does not count them as revoked");
  }
  {
    // Nothing banned: no read back, so a quiet hour costs two reads.
    const d = deps({ departed: [row(1)], bans: new Map([["auth-1", FUTURE]]) });
    await convergeDepartedSessions(d);
    assert(!d.order.includes("stillDeparted"), "a run that banned nobody does not read back");
  }
  {
    // A listing that could not be read must refuse, not answer "nothing to do":
    // an empty listing would report every departed person as unlisted and ban none.
    const d = deps({
      departed: [row(1)],
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
    // A truncated listing still acts on what it holds, and says it was partial.
    const d = deps({
      departed: [row(1), row(2)],
      listAuthBans: async () => ({ complete: false, bans: new Map([["auth-1", null]]) }),
    });
    const r = await convergeDepartedSessions(d);
    eq(d.revoked, ["auth-1"], "a partial listing bans the people it can see");
    eq(r.listingComplete, false, "and reports the listing as partial");
    eq(r.unlisted, 1, "and counts the one it could not see");
  }
  finish();
}

void main();
