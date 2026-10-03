// #3137: the frame lock is a stored admin switch the middleware reads. These drive the
// per isolate reader with an injected read and clock (L524): how long a flip takes to
// land, what an unreadable switch does, and that concurrent requests share one read.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-frame-lock.ts
import { FRAME_LOCK_TTL_MS, makeFrameLockReader } from "../src/lib/embed/frame-lock.ts";
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

  // An unreadable switch keeps the last value it read, and with none it is off.
  {
    let now = 0;
    let fail = true;
    const errors: unknown[] = [];
    const read = makeFrameLockReader({
      read: async () => {
        if (fail) throw new Error("db down");
        return true;
      },
      now: () => now,
      onError: (e) => errors.push(e),
    });
    eq(await read(), false, "never read: unlocked, so a database blip cannot black out every partner page");
    eq(errors.length, 1, "and the failure is reported, not swallowed");
    now = 1;
    eq(await read(), false, "a failed read is retried on the next request, not cached for the TTL");
    eq(errors.length, 2, "which is reported again");
    fail = false;
    now = 2;
    eq(await read(), true, "a good read lands");
    fail = true;
    now = 2 + FRAME_LOCK_TTL_MS;
    eq(await read(), true, "after that, a failed read keeps the last value read rather than dropping the lock");
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
