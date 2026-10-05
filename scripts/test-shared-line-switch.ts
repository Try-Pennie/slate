// #3325: the shared confirm line's stored switch, as a confirm reads it. Built on the
// cached switch reader with the RETRY policy: a failed read is never cached as the
// answer, so a burst of cold isolates on a saturated database does not all sit on a
// guessed value for a whole TTL. With no good read in an isolate the answer is the
// DEPLOYMENT DEFAULT (`SHARED_CONFIRM_LINE_DEFAULT`, a wrangler var: "on" in the load
// test, "off" in production until activation), and a default that is missing or not
// one of the two words means OFF and is reported once.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-shared-line-switch.ts
import {
  makeSharedLineSwitchReader,
  parseSharedLineDefault,
  SHARED_LINE_SWITCH_READ_DEADLINE_MS,
  SHARED_LINE_SWITCH_RETRY_MS,
  SHARED_LINE_SWITCH_TTL_MS,
  SHARED_LINE_SWITCH_TTL_SECONDS,
  type SharedLineDefaultProblem,
} from "../src/lib/booking/shared-line-switch-core.ts";
import { assert, eq, finish } from "./lib/harness.ts";

interface World {
  now: number;
  stored: boolean | "fail" | "hang";
  reads: number;
  rawDefault: string | undefined;
  readErrors: unknown[];
  problems: SharedLineDefaultProblem[];
  fire: () => void;
  armedMs: number;
}

function world(rawDefault: string | undefined): World {
  return { now: 0, stored: false, reads: 0, rawDefault, readErrors: [], problems: [], fire: () => {}, armedMs: -1 };
}

function reader(w: World) {
  return makeSharedLineSwitchReader({
    read: () => {
      w.reads++;
      if (w.stored === "hang") return new Promise<boolean>(() => {});
      if (w.stored === "fail") return Promise.reject(new Error("db down"));
      return Promise.resolve(w.stored);
    },
    now: () => w.now,
    rawDefault: () => w.rawDefault,
    onReadError: (e) => w.readErrors.push(e),
    onDefaultProblem: (p) => w.problems.push(p),
    timer: (ms, fire) => {
      w.armedMs = ms;
      w.fire = fire;
      return () => {};
    },
  });
}

async function main() {
  // --- the constants ---------------------------------------------------------------
  eq(SHARED_LINE_SWITCH_TTL_MS, 15_000, "one good read stands for 15 seconds");
  eq(SHARED_LINE_SWITCH_TTL_SECONDS, 15, "and the copy quotes the same number, in whole seconds");
  eq(SHARED_LINE_SWITCH_READ_DEADLINE_MS, 500, "a read that takes longer than 500ms is treated as failed");
  eq(SHARED_LINE_SWITCH_RETRY_MS, 5_000, "a failed read is retried after 5 seconds");
  assert(SHARED_LINE_SWITCH_RETRY_MS < SHARED_LINE_SWITCH_TTL_MS, "the retry comes well before the TTL would");
  assert(
    SHARED_LINE_SWITCH_RETRY_MS > SHARED_LINE_SWITCH_READ_DEADLINE_MS,
    "and after the deadline, so a hung read is cut before the next one may start",
  );

  // --- the deployment default --------------------------------------------------------
  eq(parseSharedLineDefault("on"), { on: true, problem: null }, '"on" means on');
  eq(parseSharedLineDefault("off"), { on: false, problem: null }, '"off" means off');
  eq(parseSharedLineDefault(undefined), { on: false, problem: { kind: "missing" } }, "missing means off, and is a problem");
  eq(parseSharedLineDefault(""), { on: false, problem: { kind: "missing" } }, "blank is missing too");
  eq(
    parseSharedLineDefault("ON"),
    { on: false, problem: { kind: "unrecognised", raw: "ON" } },
    "case is not forgiven: ON is reported rather than guessed at",
  );
  eq(
    parseSharedLineDefault("true"),
    { on: false, problem: { kind: "unrecognised", raw: "true" } },
    "nor is a word that is not one of the two",
  );

  // --- a healthy switch ---------------------------------------------------------------
  {
    const w = world("off");
    const read = reader(w);
    w.stored = true;
    eq(await read(), { on: true, source: "read" }, "a good read of ON answers ON, from a read");
    eq(w.armedMs, SHARED_LINE_SWITCH_READ_DEADLINE_MS, "the read is armed with the deadline");
    w.stored = false;
    w.now = SHARED_LINE_SWITCH_TTL_MS - 1;
    eq(await read(), { on: true, source: "read" }, "inside the TTL the cached value stands");
    w.now = SHARED_LINE_SWITCH_TTL_MS;
    eq(await read(), { on: false, source: "read" }, "at the TTL a flip lands");
    eq(w.reads, 2, "with one read per TTL");
    eq(w.problems.length, 0, "a recognised default is never reported");
  }

  // --- a cold isolate that cannot read: the deployment default ---------------------------
  for (const [raw, on] of [
    ["on", true],
    ["off", false],
  ] as const) {
    const w = world(raw);
    w.stored = "fail";
    const read = reader(w);
    eq(await read(), { on, source: "default" }, `a cold failed read answers the deployment default "${raw}"`);
    eq(w.readErrors.length, 1, `and the failed read is reported (default "${raw}")`);
  }

  // --- a failed read is never cached as the answer ------------------------------------
  {
    const w = world("off");
    w.stored = "fail";
    const read = reader(w);
    eq((await read()).source, "default", "cold and unreadable: the default");
    w.now = SHARED_LINE_SWITCH_RETRY_MS - 1;
    await read();
    eq(w.reads, 1, "inside the retry backoff the database is not asked again");
    w.stored = true;
    w.now = SHARED_LINE_SWITCH_RETRY_MS;
    eq(await read(), { on: true, source: "read" }, "at the backoff, not the TTL, it reads again and the switch lands");
  }
  {
    const w = world("off");
    w.stored = true;
    const read = reader(w);
    await read();
    w.stored = "fail";
    w.now = SHARED_LINE_SWITCH_TTL_MS;
    eq(await read(), { on: true, source: "last-known" }, "after a good read, a failed one answers the last good value");
    w.now = SHARED_LINE_SWITCH_TTL_MS + SHARED_LINE_SWITCH_RETRY_MS;
    await read();
    eq(w.reads, 3, "and is retried after the backoff");
  }

  // --- at most one read in flight -------------------------------------------------------
  {
    const w = world("off");
    w.stored = "hang";
    const read = reader(w);
    const a = read();
    const b = read();
    eq(w.reads, 1, "two confirms on a cold isolate share one read");
    w.fire();
    eq([await a, await b], [{ on: false, source: "default" }, { on: false, source: "default" }], "and one answer");
  }

  // --- a bad default is reported ONCE, and on the first call -------------------------------
  {
    const w = world("maybe");
    w.stored = true;
    const read = reader(w);
    eq((await read()).on, true, "a good read wins whatever the default says");
    eq(w.problems, [{ kind: "unrecognised", raw: "maybe" }], "but the bad default is reported on the first call");
    w.stored = "fail";
    w.now = SHARED_LINE_SWITCH_TTL_MS;
    await read();
    w.now = SHARED_LINE_SWITCH_TTL_MS + SHARED_LINE_SWITCH_RETRY_MS;
    await read();
    eq(w.problems.length, 1, "and never again in this isolate");
  }
  {
    const w = world(undefined);
    w.stored = "fail";
    const read = reader(w);
    eq(await read(), { on: false, source: "default" }, "a missing default means off");
    w.now = SHARED_LINE_SWITCH_RETRY_MS;
    await read();
    eq(w.problems, [{ kind: "missing" }], "reported once as missing");
  }

  finish();
}

void main();
