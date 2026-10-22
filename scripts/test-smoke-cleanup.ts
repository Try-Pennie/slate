// #4060: the booking canary's cleanup (scripts/lib/smoke-cleanup.ts) must never
// leave a booking active in silence, and must never cancel a booking this run did
// not create.
//
// Before: cleanup() in scripts/smoke-booking-api.ts swallowed every failed cancel and
// every failed sweep read with `.catch(() => {})`, so a run that lost the network left
// its bookings active with nothing naming them; and trackForCleanup took the manage
// token from ANY create answer, so a `409 confirm_required` that handed back somebody
// else's booking had that booking cancelled at teardown.
//
// Driven through injected calls with a real shaped network error; no network, no
// clock (the cancel's backoff goes through an injected sleep).
//
// Run: node --experimental-strip-types scripts/test-smoke-cleanup.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { createSmokeCleanup, type SmokeCleanupDeps } from "./lib/smoke-cleanup.ts";

function networkError(code: string): TypeError {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(new Error(`connect ${code}`), { code });
  return err;
}

type Row = { id: string; token: string; externalId: string; active: boolean };

/** The bookings API as the cleanup sees it: cancel by token, list and delete by owner. */
function fakeApi(rows: Row[]) {
  const calls: string[] = [];
  const failures: string[] = [];
  const state = { down: false, listDown: false, deleteStatus: 0 as number };
  const deps: SmokeCleanupDeps = {
    post: async (path) => {
      calls.push(`POST ${path}`);
      if (state.down) throw networkError("ETIMEDOUT");
      const token = path.match(/^\/api\/bookings\/([^/]+)\/cancel$/)?.[1];
      const row = rows.find((r) => r.token === token);
      if (!row) return { status: 404, body: {} };
      row.active = false;
      return { status: 200, body: { ok: true } };
    },
    list: async (externalId) => {
      calls.push(`GET ${externalId}`);
      if (state.down || state.listDown) throw networkError("ECONNRESET");
      return {
        status: 200,
        body: { bookings: rows.filter((r) => r.active && r.externalId === externalId).map((r) => ({ id: r.id })) },
      };
    },
    remove: async (externalId, bookingId) => {
      calls.push(`DELETE ${externalId} ${bookingId}`);
      if (state.down) throw networkError("ETIMEDOUT");
      if (state.deleteStatus) return { status: state.deleteStatus, body: {} };
      const row = rows.find((r) => r.id === bookingId && r.externalId === externalId && r.active);
      if (!row) return { status: 404, body: { code: "NOT_FOUND" } };
      row.active = false;
      return { status: 200, body: { outcome: "cancelled" } };
    },
    check: (ok, msg) => {
      if (!ok) failures.push(msg);
    },
    sleep: async () => {},
  };
  return { deps, calls, failures, state };
}

const created = (id: string, token: string) => ({
  status: 200,
  body: { outcome: "created", booking: { id, manageUrl: `https://slate.example/booking/manage/${token}` } },
});

async function main(): Promise<void> {
  // --- A 409 confirm_required hands back someone else's booking: never tracked ---
  {
    const other: Row = { id: "someone-else", token: "other-token", externalId: "ext-other", active: true };
    const api = fakeApi([other]);
    const cleanup = createSmokeCleanup(api.deps);
    cleanup.trackIdentity("ext-mine");
    const tracked = cleanup.track({
      status: 409,
      body: { outcome: "confirm_required", booking: { id: "someone-else", manageUrl: "https://slate.example/booking/manage/other-token" } },
    });
    eq(tracked, false, "a 409 confirm_required answer is not tracked");
    // A 200 that moved an existing booking is not this run's to cancel by token either.
    eq(
      cleanup.track({ status: 200, body: { outcome: "rescheduled", booking: { id: "someone-else", manageUrl: "https://x/booking/manage/other-token" } } }),
      false,
      "a 200 rescheduled answer is not tracked by token",
    );
    await cleanup.run();
    assert(!api.calls.some((c) => c.includes("other-token")), "cleanup never cancels the other booking's token");
    eq(other.active, true, "the other booking is still active");
    eq(api.failures.length, 0, "and nothing is reported");
  }

  // --- The happy path: tracked token cancelled, identity swept, nothing reported ---
  {
    const mine: Row = { id: "b1", token: "t1", externalId: "ext-1", active: true };
    const moved: Row = { id: "b2", token: "t2", externalId: "ext-1", active: true }; // a cross bucket move
    const api = fakeApi([mine, moved]);
    const cleanup = createSmokeCleanup(api.deps);
    cleanup.trackIdentity("ext-1");
    eq(cleanup.track(created("b1", "t1")), true, "a 200 created answer is tracked");
    await cleanup.run();
    eq(mine.active, false, "the tracked booking is cancelled");
    eq(moved.active, false, "the booking only the identity sweep knows is cancelled too");
    eq(api.failures.length, 0, `nothing is reported (got: ${api.failures.join(" | ")})`);
    await cleanup.run();
    eq(api.calls.filter((c) => c.startsWith("POST")).length, 1, "a second run does not repeat the cleared work");
  }

  // --- The network is gone: every booking left active is named, once ---
  {
    const mine: Row = { id: "b1", token: "t1", externalId: "ext-1", active: true };
    const api = fakeApi([mine]);
    api.state.down = true;
    const cleanup = createSmokeCleanup(api.deps);
    cleanup.trackIdentity("ext-1");
    cleanup.track(created("b1", "t1"));
    await cleanup.run();
    eq(mine.active, true, "the booking stayed active");
    eq(api.calls.filter((c) => c.startsWith("POST")).length, 3, "the cancel was tried 3 times");
    const named = api.failures.filter((f) => f.includes("b1") && /left active/.test(f));
    eq(named.length, 1, `booking b1 is named as left active exactly once (got: ${api.failures.join(" | ")})`);
    assert(
      api.failures.some((f) => f.includes("ext-1") && /could not list/.test(f) && f.includes("ECONNRESET")),
      `the failed sweep read is a failed check naming the identity (got: ${api.failures.join(" | ")})`,
    );
  }

  // --- The sweep read fails alone: the token cancel landed, only the read is reported ---
  {
    const mine: Row = { id: "b1", token: "t1", externalId: "ext-1", active: true };
    const api = fakeApi([mine]);
    api.state.listDown = true;
    const cleanup = createSmokeCleanup(api.deps);
    cleanup.trackIdentity("ext-1");
    cleanup.track(created("b1", "t1"));
    await cleanup.run();
    eq(mine.active, false, "the token cancel landed");
    eq(api.failures.length, 1, `only the unread sweep is reported (got: ${api.failures.join(" | ")})`);
    assert(/could not list/.test(api.failures[0] ?? ""), "and it says the sweep could not list");
  }

  // --- The sweep finds a booking it cannot delete: named with the status ---
  {
    const moved: Row = { id: "b9", token: "t9", externalId: "ext-1", active: true };
    const api = fakeApi([moved]);
    api.state.deleteStatus = 503;
    const cleanup = createSmokeCleanup(api.deps);
    cleanup.trackIdentity("ext-1");
    await cleanup.run();
    assert(
      api.failures.some((f) => f.includes("b9") && /left active/.test(f) && f.includes("503")),
      `an undeletable swept booking is named (got: ${api.failures.join(" | ")})`,
    );
  }

  // --- A token cancel that failed but the sweep then deleted: not reported ---
  {
    const mine: Row = { id: "b1", token: "t1", externalId: "ext-1", active: true };
    const api = fakeApi([mine]);
    const deps = { ...api.deps, post: async () => ({ status: 409, body: {} }) };
    const cleanup = createSmokeCleanup(deps);
    cleanup.trackIdentity("ext-1");
    cleanup.track(created("b1", "t1"));
    await cleanup.run();
    eq(mine.active, false, "the sweep cancelled what the token cancel could not");
    eq(api.failures.length, 0, `a booking the sweep proved gone is not reported (got: ${api.failures.join(" | ")})`);
  }

  // --- The canary is wired to it, and the swallowed form is gone ---
  {
    const src = readFileSync(join(import.meta.dirname, "smoke-booking-api.ts"), "utf8");
    assert(/createSmokeCleanup\(/.test(src), "smoke-booking-api cleans up through createSmokeCleanup");
    const SWALLOWED = /\.catch\(\(\)\s*=>\s*\{\s*\}\)/;
    assert(!SWALLOWED.test(src), "smoke-booking-api swallows no error with .catch(() => {})");
    assert(SWALLOWED.test("await fetch(url).catch(() => {});"), "control: the scan catches a swallowed fetch");
    const TRACK_BODY = /trackForCleanup\(\w+\.body\)/;
    assert(!TRACK_BODY.test(src), "trackForCleanup is handed the whole response, so it can read the status");
    assert(TRACK_BODY.test("trackForCleanup(created.body);"), "control: the scan catches a body only track");
  }

  finish();
}

void main();
