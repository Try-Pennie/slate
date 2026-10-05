// #3325: the cached switch reader every stored on/off setting is read through on a hot
// path (the frame lock, #3137, and the shared confirm line). One implementation of the
// cache, the deadline and the single read in flight, with the FAILURE POLICY as an
// option, because the two callers need opposite ones:
//
//   "hold"   a failed read stands for the whole TTL like a good one (the frame lock:
//            an outage costs one failing call per isolate per TTL);
//   "retry"  a failed read is NEVER cached as the answer: it answers the last good
//            value, or the default with none, and tries again after a short backoff
//            (the shared line: a burst of cold isolates on a saturated database must
//            not sit on the default for a whole TTL).
//
// Every reading says where its answer came from, so a caller can log it. The read, the
// clock and the timer are injected, so nothing here waits for real (L524).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-cached-switch.ts
import { makeCachedSwitchReader, type SwitchFailurePolicy, type SwitchTimer } from "../src/lib/cached-switch.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const TTL = 15_000;
const DEADLINE = 500;
const BACKOFF = 5_000;

interface World {
  now: number;
  stored: boolean | "fail" | "hang";
  reads: number;
  errors: unknown[];
  fallback: boolean;
  fire: () => void;
  armedMs: number;
}

function world(): World {
  return { now: 0, stored: false, reads: 0, errors: [], fallback: false, fire: () => {}, armedMs: -1 };
}

function reader(w: World, onFailure: SwitchFailurePolicy) {
  const timer: SwitchTimer = (ms, fire) => {
    w.armedMs = ms;
    w.fire = fire;
    return () => {};
  };
  return makeCachedSwitchReader({
    label: "test switch",
    read: () => {
      w.reads++;
      if (w.stored === "hang") return new Promise<boolean>(() => {});
      if (w.stored === "fail") return Promise.reject(new Error("db down"));
      return Promise.resolve(w.stored);
    },
    now: () => w.now,
    onError: (e) => w.errors.push(e),
    timer,
    ttlMs: TTL,
    readDeadlineMs: DEADLINE,
    fallback: () => w.fallback,
    onFailure,
  });
}

async function main() {
  // --- both policies agree on a healthy switch ----------------------------------
  for (const policy of [{ kind: "hold" }, { kind: "retry", backoffMs: BACKOFF }] as SwitchFailurePolicy[]) {
    const w = world();
    const read = reader(w, policy);
    eq(await read(), { on: false, source: "read" }, `${policy.kind}: a good read answers its value, from a read`);
    w.stored = true;
    w.now = TTL - 1;
    eq(await read(), { on: false, source: "read" }, `${policy.kind}: inside the TTL the cached value stands`);
    eq(w.reads, 1, `${policy.kind}: and no second read was made`);
    w.now = TTL;
    eq(await read(), { on: true, source: "read" }, `${policy.kind}: at the TTL it is read again`);
    eq(w.errors.length, 0, `${policy.kind}: nothing was reported`);
  }

  // --- "hold": a failed read stands for the TTL like a good one ------------------
  {
    const w = world();
    w.stored = "fail";
    const read = reader(w, { kind: "hold" });
    eq(await read(), { on: false, source: "default" }, "hold: never read answers the default, and says so");
    eq(w.errors.length, 1, "hold: and the failure is reported, not swallowed");
    w.now = TTL - 1;
    eq(await read(), { on: false, source: "default" }, "hold: inside the TTL the failed read's answer stands");
    eq(w.reads, 1, "hold: without another call to a database that is down");
    w.stored = true;
    w.now = TTL;
    eq(await read(), { on: true, source: "read" }, "hold: at the TTL a good read lands");
    w.stored = "fail";
    w.now = 2 * TTL;
    eq(await read(), { on: true, source: "last-known" }, "hold: a later failure keeps the last good value");
    w.now = 3 * TTL - 1;
    eq(await read(), { on: true, source: "last-known" }, "hold: and that answer stands for the whole TTL");
    eq(w.reads, 3, "hold: with no read in between");
  }

  // --- "retry": a failed read is never cached as the answer ----------------------
  {
    const w = world();
    w.stored = "fail";
    const read = reader(w, { kind: "retry", backoffMs: BACKOFF });
    eq(await read(), { on: false, source: "default" }, "retry: never read answers the default, and says so");
    eq(w.errors.length, 1, "retry: and the failure is reported");
    w.now = BACKOFF - 1;
    eq(await read(), { on: false, source: "default" }, "retry: inside the backoff the default stands");
    eq(w.reads, 1, "retry: and the database is not asked again inside the backoff");
    w.stored = true;
    w.now = BACKOFF;
    eq(await read(), { on: true, source: "read" }, "retry: at the BACKOFF, not the TTL, it is read again and lands");
    eq(w.reads, 2, "retry: with exactly one more read");
  }

  {
    // After a good read, a failed refresh answers the last good value and is retried
    // after the backoff. Under "hold" the next read would be a whole TTL later.
    const w = world();
    w.stored = true;
    const read = reader(w, { kind: "retry", backoffMs: BACKOFF });
    eq(await read(), { on: true, source: "read" }, "retry: a good read of ON");
    w.stored = "fail";
    w.now = TTL;
    eq(await read(), { on: true, source: "last-known" }, "retry: a failed refresh answers the last good value");
    w.now = TTL + BACKOFF - 1;
    eq(await read(), { on: true, source: "last-known" }, "retry: and keeps answering it inside the backoff");
    eq(w.reads, 2, "retry: without asking again");
    w.now = TTL + BACKOFF;
    eq(await read(), { on: true, source: "last-known" }, "retry: at the backoff it asks again (and fails again)");
    eq(w.reads, 3, "retry: so the stale good value is never extended into a fresh TTL");
    w.stored = false;
    w.now = TTL + 2 * BACKOFF;
    eq(await read(), { on: false, source: "read" }, "retry: and the first good read after it lands at once");
  }

  {
    // The default is asked at the moment it is needed, never captured at construction:
    // a deployment's vars are assigned after module load on Workers.
    const w = world();
    w.stored = "fail";
    w.fallback = false;
    const read = reader(w, { kind: "retry", backoffMs: BACKOFF });
    eq((await read()).on, false, "retry: the default as it stands at the first failure");
    w.fallback = true;
    w.now = BACKOFF;
    eq(await read(), { on: true, source: "default" }, "retry: and as it stands at the next one");
  }

  // --- the read deadline, under both policies ------------------------------------
  for (const policy of [{ kind: "hold" }, { kind: "retry", backoffMs: BACKOFF }] as SwitchFailurePolicy[]) {
    const w = world();
    w.stored = "hang";
    const read = reader(w, policy);
    const cold = read();
    eq(w.armedMs, DEADLINE, `${policy.kind}: the read is armed with the deadline`);
    w.fire();
    eq(await cold, { on: false, source: "default" }, `${policy.kind}: a hung cold read answers the default`);
    eq(w.errors.length, 1, `${policy.kind}: and is reported`);
    const message = w.errors[0] instanceof Error ? w.errors[0].message : "";
    assert(
      message.includes("test switch") && message.includes(`${DEADLINE}ms`),
      `${policy.kind}: the deadline failure names the switch and the deadline (${message})`,
    );
  }

  // --- at most one read in flight ------------------------------------------------
  for (const policy of [{ kind: "hold" }, { kind: "retry", backoffMs: BACKOFF }] as SwitchFailurePolicy[]) {
    let reads = 0;
    let release: (v: boolean) => void = () => {};
    const read = makeCachedSwitchReader({
      label: "test switch",
      read: () => {
        reads++;
        return new Promise<boolean>((r) => (release = r));
      },
      now: () => 0,
      onError: () => {},
      timer: () => () => {},
      ttlMs: TTL,
      readDeadlineMs: DEADLINE,
      fallback: () => false,
      onFailure: policy,
    });
    const a = read();
    const b = read();
    release(true);
    eq([await a, await b], [{ on: true, source: "read" }, { on: true, source: "read" }], `${policy.kind}: both callers get the value`);
    eq(reads, 1, `${policy.kind}: from one read`);
  }

  {
    // A retry that comes due while a read is still out joins it, rather than starting a
    // second one against a database that is already slow.
    const w = world();
    w.stored = "hang";
    const read = reader(w, { kind: "retry", backoffMs: BACKOFF });
    const first = read();
    const second = read();
    eq(w.reads, 1, "retry: a second caller during a hung read does not start another read");
    w.fire();
    eq([await first, await second], [{ on: false, source: "default" }, { on: false, source: "default" }], "retry: both get the default");
  }

  {
    // A read that throws instead of rejecting is a failed read like any other.
    const errors: unknown[] = [];
    const read = makeCachedSwitchReader({
      label: "test switch",
      read: () => {
        throw new Error("threw before it could return a promise");
      },
      now: () => 0,
      onError: (e) => errors.push(e),
      timer: () => () => {},
      ttlMs: TTL,
      readDeadlineMs: DEADLINE,
      fallback: () => true,
      onFailure: { kind: "retry", backoffMs: BACKOFF },
    });
    eq(await read(), { on: true, source: "default" }, "a read that throws answers the default");
    eq(errors.length, 1, "and is reported");
  }

  finish();
}

void main();
