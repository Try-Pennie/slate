// #3137: the frame lock is a stored admin switch the middleware reads. These drive the
// per isolate reader with an injected read and clock (L524): how long a flip takes to
// land, what an unreadable switch does, and that concurrent requests share one read.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-frame-lock.ts
import { FRAME_LOCK_READ_DEADLINE_MS, FRAME_LOCK_TTL_MS, makeFrameLockReader } from "../src/lib/embed/frame-lock.ts";
import { assert, eq, finish } from "./lib/harness.ts";

async function main() {
  assert(FRAME_LOCK_TTL_MS <= 15_000, "a flip lands within 15 seconds, so turning it back off is near instant");

  // A flip is seen once the cached value ages out, and not before.
  {
    let now = 0;
    let stored = false;
    let reads = 0;
    const errors: unknown[] = [];
    const read = makeFrameLockReader({
      read: async () => {
        reads++;
        return stored;
      },
      now: () => now,
      onError: (e) => errors.push(e),
    });
    eq(await read(), false, "starts unlocked when the switch is off");
    stored = true;
    now = FRAME_LOCK_TTL_MS - 1;
    eq(await read(), false, "inside the TTL the cached value stands");
    eq(reads, 1, "and no second read was made");
    now = FRAME_LOCK_TTL_MS;
    eq(await read(), true, "at the TTL the switch is read again and the lock lands");
    stored = false;
    now = 2 * FRAME_LOCK_TTL_MS;
    eq(await read(), false, "and turning it off lands the same way");
    eq(errors.length, 0, "nothing was reported");
  }

  // An unreadable switch keeps the last value it read, and with none it is OPEN, the way
  // the booker has always run, so a blip never locks out framing nobody turned on. A
  // failed read is cached for the TTL too, so an outage adds no failing call per load.
  {
    let now = 0;
    let fail = true;
    let stored = true;
    let reads = 0;
    const errors: unknown[] = [];
    const read = makeFrameLockReader({
      read: async () => {
        reads++;
        if (fail) throw new Error("db down");
        return stored;
      },
      now: () => now,
      onError: (e) => errors.push(e),
    });
    eq(await read(), false, "never read: unlocked, so observing carries on and nobody listed is locked out");
    eq(errors.length, 1, "and the failure is reported, not swallowed");
    now = FRAME_LOCK_TTL_MS - 1;
    eq(await read(), false, "inside the TTL the failed read's answer stands");
    eq(reads, 1, "without another call to a database that is down");
    fail = false;
    now = FRAME_LOCK_TTL_MS;
    eq(await read(), true, "at the TTL it is read again, and a good read of ON lands");
    fail = true;
    now = 2 * FRAME_LOCK_TTL_MS;
    eq(await read(), true, "a failed read after that keeps the lock on rather than dropping it");
    eq(errors.length, 2, "which is reported");
    stored = false;
    fail = false;
    now = 3 * FRAME_LOCK_TTL_MS;
    eq(await read(), false, "a good read of OFF lands");
    fail = true;
    now = 4 * FRAME_LOCK_TTL_MS;
    eq(await read(), false, "and a failed read after it keeps it off");
  }

  // A read that never answers is cut at a short deadline and treated as a failed read,
  // because the middleware awaits it before every booker page: a hung database must not
  // stall the booker. The timer is injected, so nothing here waits for real (L524).
  {
    assert(FRAME_LOCK_READ_DEADLINE_MS <= 1_000, "the deadline is short enough not to be felt on a page load");
    let now = 0;
    let fire: () => void = () => {};
    let armedMs = -1;
    let stored: boolean | "hang" = "hang";
    const errors: unknown[] = [];
    const read = makeFrameLockReader({
      read: () => (stored === "hang" ? new Promise<boolean>(() => {}) : Promise.resolve(stored)),
      now: () => now,
      onError: (e) => errors.push(e),
      timer: (ms, f) => {
        armedMs = ms;
        fire = f;
        return () => {};
      },
    });
    const cold = read();
    eq(armedMs, FRAME_LOCK_READ_DEADLINE_MS, "the read is armed with the deadline");
    fire();
    eq(await cold, false, "a hung read on a cold isolate answers the cold default, unlocked");
    eq(errors.length, 1, "and is reported");

    stored = true;
    now = FRAME_LOCK_TTL_MS;
    eq(await read(), true, "a read that answers in time lands");
    stored = "hang";
    now = 2 * FRAME_LOCK_TTL_MS;
    const warm = read();
    fire();
    eq(await warm, true, "a hung read after that keeps the last value read");
  }

  // Concurrent requests on a cold isolate share one read.
  {
    let reads = 0;
    let release: (v: boolean) => void = () => {};
    const read = makeFrameLockReader({
      read: () => {
        reads++;
        return new Promise<boolean>((r) => (release = r));
      },
      now: () => 0,
      onError: () => {},
    });
    const a = read();
    const b = read();
    release(true);
    eq([await a, await b], [true, true], "both requests get the value");
    eq(reads, 1, "from one read");
  }

  finish();
}

void main();
