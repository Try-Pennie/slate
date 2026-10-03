// The per-isolate cached read of the org's hours (#1296).
//
// Run: node --experimental-strip-types scripts/test-business-hours-cache.ts
//
// Gate 1 filters at READ time, so every served response asks for the hours. A
// PostgREST round trip per request is not affordable there, and a long-lived cache
// would mean a narrowing sat unenforced for as long as the cache lasted. The TTL is
// therefore aligned to `SLOT_TTL_SECONDS`, the same 5 seconds the slot cache itself
// already tolerates: an edit lands on the next request rather than the next
// recompute.
//
// The failure direction is Dan's decision (2026-08-06): a refresh that fails serves
// the LAST KNOWN hours rather than taking the booker down, so a blip in one read
// cannot stop leads booking. That is safe to do quietly ONLY because a sustained
// failure is loud somewhere else: `getBucketSlots` throws on it, so `recompute
// BucketSlots` writes nothing, rows go stale, and `bucket_slots_stale` pages after
// six minutes. The fallback buys time; it does not hide the fault.
//
// The one case with nothing to fall back to (a cold isolate whose very first read
// fails) still throws, because inventing a week is the one thing that could silently
// re-open hours an admin had narrowed.
import { makeCachedHoursReader } from "../src/lib/booking/business-hours-cache.ts";
import type { BusinessHours } from "../src/lib/booking/business-hours-cache.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const TTL = 5000;

const week = (startMinute: number): BusinessHours => ({
  zone: "America/New_York",
  rules: [{ weekday: 1, start_minute: startMinute, end_minute: 20 * 60 }],
  source: "stored",
});

/** A loader whose answer and failure mode the test drives, counting its calls. */
function loader() {
  const state = {
    calls: 0,
    value: week(8 * 60),
    fail: null as Error | null,
  };
  return {
    state,
    load: async (): Promise<BusinessHours> => {
      state.calls++;
      if (state.fail) throw state.fail;
      return state.value;
    },
  };
}

function reader(l: ReturnType<typeof loader>, clock: { ms: number }) {
  const stale: { ageMs: number }[] = [];
  const read = makeCachedHoursReader({
    load: l.load,
    ttlMs: TTL,
    now: () => clock.ms,
    onStale: (ageMs) => stale.push({ ageMs }),
  });
  return { read, stale };
}

// --- inside the TTL, one read serves every caller ---------------------------------
{
  const l = loader();
  const clock = { ms: 1_000_000 };
  const { read } = reader(l, clock);

  await read();
  await read();
  clock.ms += TTL - 1;
  await read();

  eq(l.state.calls, 1, "three reads inside the TTL cost exactly one round trip");
}

// --- past the TTL, an edit lands on the next request -------------------------------
{
  const l = loader();
  const clock = { ms: 1_000_000 };
  const { read } = reader(l, clock);

  const before = await read();
  eq(before.rules[0].start_minute, 8 * 60, "the first read serves what is stored");

  // An admin narrows the day while the entry is still warm.
  l.state.value = week(10 * 60);
  eq((await read()).rules[0].start_minute, 8 * 60, "inside the TTL the warm entry still serves");

  clock.ms += TTL;
  eq(
    (await read()).rules[0].start_minute,
    10 * 60,
    "once the TTL passes the narrowed week is served, with no recompute needed",
  );
  eq(l.state.calls, 2, "the refresh is one extra round trip, not one per read");
}

// --- a failed refresh serves the last known hours, loudly --------------------------
{
  const l = loader();
  const clock = { ms: 1_000_000 };
  const { read, stale } = reader(l, clock);

  const good = await read();
  clock.ms += TTL;
  l.state.fail = new Error("business hours are unusable: connection reset");

  const served = await read();
  eq(served.rules[0].start_minute, good.rules[0].start_minute, "a failed refresh serves the last known week");
  eq(stale.length, 1, "serving stale hours is reported, never silent");
  eq(stale[0].ageMs, TTL, "the report carries how old the served week is");

  // It keeps serving, and keeps reporting, rather than reporting once and going quiet.
  clock.ms += TTL;
  await read();
  eq(stale.length, 2, "every stale serve is reported, so a lasting outage stays visible");
  eq(stale[1].ageMs, TTL * 2, "the reported age grows with the outage");
}

// --- a recovered read replaces the stale entry -------------------------------------
{
  const l = loader();
  const clock = { ms: 1_000_000 };
  const { read, stale } = reader(l, clock);

  await read();
  clock.ms += TTL;
  l.state.fail = new Error("boom");
  await read();

  l.state.fail = null;
  l.state.value = week(10 * 60);
  clock.ms += TTL;
  eq((await read()).rules[0].start_minute, 10 * 60, "once the read recovers the current week is served again");

  const reported = stale.length;
  clock.ms += 1;
  await read();
  eq(stale.length, reported, "a healthy serve inside the TTL reports nothing");
}

// --- a cold isolate with nothing to fall back on must NOT invent a week ------------
{
  const l = loader();
  const clock = { ms: 1_000_000 };
  const { read, stale } = reader(l, clock);
  l.state.fail = new Error("business hours are unusable: 6 of 7 weekdays are stored");

  let err: unknown;
  try {
    await read();
  } catch (e) {
    err = e;
  }
  assert(
    err instanceof Error && /unusable/.test(err.message),
    "the very first read failing throws: there is no last known week to serve",
  );
  eq(stale.length, 0, "nothing is reported as stale when nothing was ever cached");
}

// --- a failure must not be cached as if it were an answer --------------------------
{
  const l = loader();
  const clock = { ms: 1_000_000 };
  const { read } = reader(l, clock);
  l.state.fail = new Error("boom");

  await read().catch(() => {});
  l.state.fail = null;
  // No clock movement: a cached failure would keep throwing (or serve nothing) here.
  const recovered = await read();
  eq(recovered.rules[0].start_minute, 8 * 60, "the very next read after a failure tries again immediately");
}

// --- a burst of cold or expired reads shares ONE load (#3123) ----------------------
// Without a shared in flight load, N requests arriving while the entry is missing or
// expired each start their own round trip, which is the stampede the TTL exists to
// prevent. The followers must await the leader's promise instead.
{
  const state = { calls: 0, release: null as null | ((v: BusinessHours) => void), reject: null as null | ((e: Error) => void) };
  const clock = { ms: 1_000_000 };
  const stale: number[] = [];
  const read = makeCachedHoursReader({
    load: () => {
      state.calls++;
      return new Promise<BusinessHours>((res, rej) => {
        state.release = res;
        state.reject = rej;
      });
    },
    ttlMs: TTL,
    now: () => clock.ms,
    onStale: (ageMs) => stale.push(ageMs),
  });

  const burst = Promise.all([read(), read(), read(), read(), read()]);
  eq(state.calls, 1, "five concurrent cold reads start exactly one load");
  state.release!(week(9 * 60));
  const served = await burst;
  assert(served.every((h) => h.rules[0].start_minute === 9 * 60), "every caller in the burst gets the one load's answer");

  // Expired entry, burst, and the shared load REJECTS: every caller falls back to the
  // last known week (each one reported), and the failure is not left in flight.
  clock.ms += TTL;
  const failing = Promise.all([read(), read(), read()]);
  eq(state.calls, 2, "a burst on an expired entry starts exactly one refresh");
  state.reject!(new Error("connection reset"));
  const fallback = await failing;
  assert(fallback.every((h) => h.rules[0].start_minute === 9 * 60), "a shared refresh that fails serves the last known week to every caller");
  eq(stale.length, 3, "each stale serve in the burst is reported");

  const next = read();
  eq(state.calls, 3, "a rejected load is cleared, so the next read tries again at once");
  state.release!(week(10 * 60));
  eq((await next).rules[0].start_minute, 10 * 60, "the retry serves the fresh week");
}

// --- a cold burst whose shared load fails throws for every caller ------------------
{
  let calls = 0;
  let reject: ((e: Error) => void) | null = null;
  const read = makeCachedHoursReader({
    load: () => {
      calls++;
      return new Promise<BusinessHours>((_res, rej) => {
        reject = rej;
      });
    },
    ttlMs: TTL,
    now: () => 1_000_000,
    onStale: () => {},
  });
  const outcomes = Promise.allSettled([read(), read()]);
  eq(calls, 1, "a cold burst shares one load even when it will fail");
  reject!(new Error("unusable"));
  const settled = await outcomes;
  assert(settled.every((o) => o.status === "rejected"), "with nothing cached every caller in a failed cold burst throws");
}

finish();
