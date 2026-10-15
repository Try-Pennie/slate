// The pool grouping a server holds, and the bounded read that fills it from the snapshot
// the recompute lane publishes (#3460, `src/lib/booking/pool-grouping-reader.ts`).
//
// A server whose grouping is absent or stale fetches the snapshot once however many
// confirms ask, each waiting at most the bound, and installs it under the snapshot's own
// read time, newest wins. Every way of not getting one is a named reading, and keeps the
// confirm on its code's own line. The snapshot itself, the directory and the derivation's
// pin are `scripts/test-pool-grouping.ts`.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-pool-grouping-reader.ts
import {
  POOL_GROUPING_FORMAT,
  POOL_GROUPING_DIRECTORY_PROTOCOL,
  groupingEntriesOf,
  groupingSnapshotOf,
  groupingPutMessage,
  type GroupingEntry,
  type DirectoryStub,
} from "../src/lib/booking/pool-grouping.ts";
import {
  POOL_GROUPING_FRESH_MS,
  POOL_GROUPING_FETCH_MS,
  POOL_GROUPING_FETCH_GIVE_UP_MS,
  POOL_GROUPING_FUTURE_TOLERANCE_MS,
  POOL_GROUPING_RETRY_MS,
  POOL_GROUPING_OWN_READ_AFTER_MS,
  POOL_GROUPING_REFRESH_AHEAD_MS,
  makeGroupingStore,
  makeGroupingReader,
  lineGroupSourceOf,
} from "../src/lib/booking/pool-grouping-reader.ts";
import { readWithinDeadline, NoAnswerWithinError } from "../src/lib/read-within-deadline.ts";
import { makeConfirmLineObject } from "../src/lib/booking/confirm-line-object.ts";
import { ladderGroupOf, poolKeyDigest } from "../src/lib/booking/line-key.ts";
import { groupByPool, poolKeyFor } from "../src/lib/availability/pool-key.ts";
import { tierLadder, rungExcludesLow } from "../src/lib/routing/tiers.ts";
import { poolGroupingRoster } from "./lib/pool-grouping-fixture.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { memoryGroupingStorage } from "./lib/memory-grouping-storage.ts";

type Message = Record<string, unknown>;

const ROWS = poolGroupingRoster();
const RAW_KEY = new Map(ROWS.map((r) => [r.code, poolKeyFor(r)]));
const ENTRIES = groupingEntriesOf(groupByPool(ROWS));
const T0 = Date.parse("2026-10-07T14:00:00.000Z");
// The directory's protocol version, named so a test that writes a raw message says which.
void POOL_GROUPING_DIRECTORY_PROTOCOL;

// --- one server's grouping: compare and set, newest wins (L751, L443) -----------------
{
  let now = T0;
  const store = makeGroupingStore({ now: () => now, freshMs: POOL_GROUPING_FRESH_MS });
  eq(store.peek("120"), undefined, "store: an empty store knows nothing");
  eq(store.held(), null, "store: and holds nothing");
  assert(store.install(ENTRIES, T0 - 10_000, "read"), "store: a first grouping installs");
  eq(store.peek("120"), poolKeyDigest(RAW_KEY.get("120")!), "store: and answers a code's pool");
  eq(store.peek("999"), null, "store: and null for a code with no bucket, a gap");
  assert(!store.install(ENTRIES.slice(0, 5), T0 - 20_000, "snapshot"), "store: an OLDER grouping is refused");
  assert(!store.install(ENTRIES.slice(0, 5), T0 - 10_000, "snapshot"), "store: one read at the same moment is refused too, so nothing flips between equals");
  eq(store.peek("530"), poolKeyDigest(RAW_KEY.get("530")!), "store: and the newer one, which lists codes the refused ones did not, is still what it answers");
  assert(store.install(ENTRIES, T0 - 5_000, "snapshot"), "store: a NEWER grouping installs");
  eq(store.held()?.origin, "snapshot", "store: and remembers where it came from");
  eq(store.held()?.readAtMs, T0 - 5_000, "store: under ITS OWN read time, never moved forward");
  now = T0 - 5_000 + POOL_GROUPING_FRESH_MS;
  assert(store.fresh() && store.peek("120") !== undefined, "store: fresh up to the window measured from the read time");
  now += 1;
  assert(!store.fresh() && store.peek("120") === undefined, "store: and unknown one millisecond past it, exactly when a local read of that age would be");
}

// --- the directory, through the real object and its envelope -------------------------
function objectWorld() {
  const object = makeConfirmLineObject({
    now: () => T0,
    timer: () => () => {},
    leaseTimer: () => () => {},
    newId: (() => {
      let n = 0;
      return () => `id${++n}`;
    })(),
    directoryStorage: memoryGroupingStorage(),
  });
  // Through JSON both ways, as the platform carries it, so a shape that does not survive
  // serialisation fails here (L505).
  const send = async (role: "line" | "directory", m: Message) =>
    JSON.parse(await object.handle(role, JSON.parse(JSON.stringify(m)) as unknown)) as Message;
  return { send };
}

// --- the reader: one bounded fetch per server, compare and set ------------------------
function readerWorld(opts: {
  answer?: (m: Message) => Promise<Message> | Message;
  unbound?: boolean;
  heldAt?: number | null;
  heldOrigin?: "read" | "snapshot";
  retryMs?: number;
  /** #3529: the server's own read, run when the directory has nothing fresh: how long it takes, and whether it lands. */
  ownRead?: { ms: number; lands: boolean };
  /** #3558: how long the directory takes to answer. */
  answerAfterMs?: number;
} = {}) {
  let now = T0;
  const pending: { at: number; fire: () => void; live: boolean }[] = [];
  const timer = (ms: number, fire: () => void) => {
    const t = { at: now + ms, fire, live: true };
    pending.push(t);
    return () => {
      t.live = false;
    };
  };
  const store = makeGroupingStore({ now: () => now, freshMs: POOL_GROUPING_FRESH_MS });
  if (opts.heldAt !== undefined && opts.heldAt !== null) store.install(ENTRIES, opts.heldAt, opts.heldOrigin ?? "read");
  const sent: Message[] = [];
  const started: Promise<unknown>[] = [];
  const ownReads: number[] = [];
  const directoryStub: DirectoryStub = {
    async send(m) {
      sent.push(m);
      if (opts.answerAfterMs) await new Promise<void>((resolve) => timer(opts.answerAfterMs!, resolve));
      const a = opts.answer ? await opts.answer(m) : { kind: "grouping", snapshot: null };
      return JSON.parse(JSON.stringify(a)) as Message;
    },
  };
  const reader = makeGroupingReader({
    store,
    directory: () => (opts.unbound ? null : directoryStub),
    now: () => now,
    timer,
    boundMs: POOL_GROUPING_FETCH_MS,
    freshMs: POOL_GROUPING_FRESH_MS,
    retryMs: opts.retryMs ?? POOL_GROUPING_RETRY_MS,
    refreshAheadMs: POOL_GROUPING_REFRESH_AHEAD_MS,
    onFetchStarted: (p) => started.push(p),
    ...(opts.ownRead
      ? {
          readOwn: async () => {
            ownReads.push(now);
            const at = now;
            await new Promise<void>((resolve) => timer(opts.ownRead!.ms, resolve));
            if (!opts.ownRead!.lands) throw new Error("planted own read failure");
            store.install(ENTRIES, at, "read");
          },
        }
      : {}),
  });
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      await new Promise((r) => setImmediate(r));
      const due = pending.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = Math.max(now, due.at);
      due.live = false;
      due.fire();
    }
    now = until;
    await new Promise((r) => setImmediate(r));
  };
  return { store, reader, sent, started, ownReads, advance, now: () => now, setNow: (t: number) => (now = t) };
}
const answering = (snapshot: unknown) => () => ({ kind: "grouping", snapshot });

async function readerTests() {
  {
    const w = readerWorld({ heldAt: T0 - 1_000 });
    const r = await w.reader.ensure();
    eq(r.source, "held", "reader: a server holding a fresh grouping fetches nothing");
    eq(w.sent.length, 0, "reader: not one call");
  }
  {
    const w = readerWorld({ unbound: true });
    eq((await w.reader.ensure()).source, "unbound", "reader: no binding is said as unbound, never as absent");
  }
  {
    const w = readerWorld({ answer: answering(groupingSnapshotOf(ENTRIES, T0 - 5_000)) });
    const r = await w.reader.ensure();
    eq(r.source, "installed", "reader: a cold server installs a fresh snapshot");
    eq(w.store.held()?.readAtMs, T0 - 5_000, "reader: under the snapshot's own read time, so its freshness bound is the same minute as a local read's");
    eq(w.store.held()?.origin, "snapshot", "reader: and the server knows its grouping came from the snapshot");
    eq(w.store.peek("121"), poolKeyDigest(RAW_KEY.get("121")!), "reader: and answers from it");
    eq(r.ageMs, 5_000, "reader: and says how old the snapshot was");
    eq(w.sent[0]?.op, "grouping-get", "reader: by one grouping get");
    eq(w.sent[0]?.dv, POOL_GROUPING_DIRECTORY_PROTOCOL, "reader: in the directory's own version");
    eq(w.started.length, 1, "reader: and hands the fetch to whoever keeps the invocation alive for it");
  }
  {
    const w = readerWorld({ heldAt: T0 - 70_000, answer: answering(groupingSnapshotOf(ENTRIES, T0 - 5_000)) });
    eq((await w.reader.ensure()).source, "installed", "reader: a STALE server installs a fresh snapshot too");
  }
  {
    // #3481: the directory's get says where it answered from, an additive field for the
    // daily proof. A server installs exactly as it did without it, and the directory's
    // protocol is unchanged, so builds on either side of the change read each other.
    for (const from of ["storage", "memory", "somewhere new"]) {
      const w = readerWorld({ answer: () => ({ kind: "grouping", snapshot: groupingSnapshotOf(ENTRIES, T0 - 5_000), from }) });
      eq((await w.reader.ensure()).source, "installed", `reader: an answer saying it came from ${from} installs as one that says nothing`);
      eq(w.store.peek("121"), poolKeyDigest(RAW_KEY.get("121")!), `reader: and the grouping from ${from} answers as before`);
    }
    const real = objectWorld();
    eq((await real.send("directory", groupingPutMessage(groupingSnapshotOf(ENTRIES, T0 - 5_000)))).kind, "stored", "reader: the real directory stores a snapshot");
    const w = readerWorld({ answer: (m) => real.send("directory", m) });
    eq((await w.reader.ensure()).source, "installed", "reader: and a server installs what the real directory hands back, the new field and all");
  }
  const refusedBy = async (label: string, answer: (m: Message) => Promise<Message> | Message, want: string) => {
    const w = readerWorld({ answer });
    const r = await w.reader.ensure();
    eq(r.source, want, `reader: ${label} is ${want}`);
    eq(w.store.held(), null, `reader: ${label} installs nothing, so the confirm keeps its code's own line`);
  };
  await refusedBy("a stale snapshot", answering(groupingSnapshotOf(ENTRIES, T0 - POOL_GROUPING_FRESH_MS - 1)), "stale");
  await refusedBy("no snapshot at all", answering(null), "absent");
  await refusedBy("a snapshot of another format", answering({ ...groupingSnapshotOf(ENTRIES, T0), format: POOL_GROUPING_FORMAT + 1 }), "format-mismatch");
  await refusedBy("an empty snapshot", answering({ ...groupingSnapshotOf(ENTRIES, T0), count: 0, entries: [] }), "refused");
  await refusedBy("a partial snapshot", answering({ ...groupingSnapshotOf(ENTRIES, T0), entries: ENTRIES.slice(0, 30) }), "refused");
  await refusedBy("a snapshot read in the future", answering(groupingSnapshotOf(ENTRIES, T0 + POOL_GROUPING_FUTURE_TOLERANCE_MS + 1)), "refused");
  // An older build's object knows no grouping op: it answers the line's own refusals.
  await refusedBy("an older object's version refusal", () => ({ kind: "gone", why: "version" }), "refused");
  await refusedBy("an older object's unknown op", () => ({ kind: "bad", why: "unknown op" }), "refused");
  await refusedBy("an object that throws", () => {
    throw new Error("the object refused");
  }, "unreachable");
  {
    // Slow: the object never answers. The confirm waits the bound and no longer.
    const w = readerWorld({ answer: () => new Promise<Message>(() => {}) });
    let out: Awaited<ReturnType<typeof w.reader.ensure>> | null = null;
    void w.reader.ensure().then((r) => (out = r));
    await w.advance(POOL_GROUPING_FETCH_MS - 1);
    eq(out, null, "reader: a slow object is waited on up to the bound");
    await w.advance(1);
    const settled = out as { source: string; waitedMs: number | null } | null;
    eq(settled?.source, "timeout", "reader: and past it the confirm moves on, as timeout");
    eq(settled?.waitedMs, POOL_GROUPING_FETCH_MS, "reader: having waited exactly the bound");
  }
  {
    // Review of #3471 (L440, L629): the bound is the confirm's OWN wait, counted from when
    // it needs the grouping, never from when the prelude started the fetch at
    // authentication. Otherwise slow ceilings and a slow body read spend the bound before
    // the confirm reaches its line, and it keys by code while the answer is on its way,
    // which is the split this exists to end.
    let release: (m: Message) => void = () => {};
    const w = readerWorld({ answer: () => new Promise<Message>((r) => (release = r)) });
    const started = w.reader.start();
    await w.advance(POOL_GROUPING_FETCH_MS + 100);
    let out: { source: string; waitedMs: number | null } | null = null;
    void w.reader.wait(started).then((r) => (out = r));
    await w.advance(50);
    eq(out, null, "reader: a fetch the prelude started, still in flight past the bound when the confirm reaches its line, is still waited on");
    release({ kind: "grouping", snapshot: groupingSnapshotOf(ENTRIES, w.now() - 1_000) });
    await w.advance(1);
    const got = out as { source: string; waitedMs: number | null } | null;
    eq(got?.source, "installed", "reader: and the confirm keys from its answer");
    assert(got?.waitedMs !== null && got?.waitedMs !== undefined && got.waitedMs >= 50 && got.waitedMs <= 51, `reader: and its wait is counted from when it started waiting, not from the prelude (got ${got?.waitedMs})`);
  }
  {
    // And the bound still holds from there: a confirm that reaches its line late waits at
    // most the bound more, then moves on.
    const w = readerWorld({ answer: () => new Promise<Message>(() => {}) });
    const started = w.reader.start();
    await w.advance(POOL_GROUPING_FETCH_MS + 100);
    let out: { source: string; waitedMs: number | null } | null = null;
    void w.reader.wait(started).then((r) => (out = r));
    await w.advance(POOL_GROUPING_FETCH_MS - 1);
    eq(out, null, "reader: a late confirm waits up to the bound from its own start");
    await w.advance(1);
    const got = out as { source: string; waitedMs: number | null } | null;
    eq(got?.source, "timeout", "reader: and no longer, as timeout");
    eq(got?.waitedMs, POOL_GROUPING_FETCH_MS, "reader: having waited exactly the bound itself");
  }
  {
    // A fetch that answered before the confirm needed it costs the confirm nothing.
    const w = readerWorld({ answer: answering(groupingSnapshotOf(ENTRIES, T0 - 5_000)) });
    const started = w.reader.start();
    await w.advance(300);
    const r = await w.reader.wait(started);
    eq(r.source, "installed", "reader: an answer that landed during the ceilings is used");
    eq(r.waitedMs, 0, "reader: and the confirm waited nothing for it");
  }
  {
    // A late answer, past one confirm's bound but inside the fetch's own, still installs,
    // so the NEXT confirm on this server keys its ladder from it.
    let release: (m: Message) => void = () => {};
    const w = readerWorld({ answer: () => new Promise<Message>((r) => (release = r)) });
    let first: { source: string } | null = null;
    void w.reader.ensure().then((r) => (first = r));
    await w.advance(POOL_GROUPING_FETCH_MS);
    eq((first as { source: string } | null)?.source, "timeout", "reader: the confirm that waited the bound moved on");
    await w.advance(300);
    release({ kind: "grouping", snapshot: groupingSnapshotOf(ENTRIES, w.now() - 1_000) });
    await w.advance(1);
    eq(w.store.held()?.origin, "snapshot", "reader: and the answer that arrived later still installed");
    eq((await w.reader.ensure()).source, "held", "reader: so the next confirm fetches nothing");
  }
  {
    // A fetch that never answers is given up on, so the request keeping it alive past its
    // response is not held until the platform cuts it.
    const w = readerWorld({ answer: () => new Promise<Message>(() => {}) });
    void w.reader.ensure();
    let settled: unknown = "pending";
    void (w.started[0] as Promise<unknown>).then((r) => (settled = r));
    await w.advance(POOL_GROUPING_FETCH_GIVE_UP_MS - 1);
    eq(settled, "pending", "reader: the fetch itself is waited on up to its own give up");
    await w.advance(1);
    eq((settled as { source?: string }).source, "timeout", "reader: and then ends, as timeout");
  }
  {
    // One fetch per server, however many confirms arrive at once.
    let release: (m: Message) => void = () => {};
    const w = readerWorld({ answer: () => new Promise<Message>((r) => (release = r)) });
    const all = Array.from({ length: 10 }, () => w.reader.ensure());
    await w.advance(10);
    release({ kind: "grouping", snapshot: groupingSnapshotOf(ENTRIES, T0 - 2_000) });
    const results = await Promise.all(all);
    eq(w.sent.length, 1, "reader: ten confirms at once send ONE get");
    assert(results.every((r) => r.source === "installed"), `reader: and every one of them is answered from it (got ${results.map((r) => r.source).join(",")})`);
  }
  {
    // A fetch older than the bound is not joined: on the platform, a fetch started by a
    // request that has since ended can be left pending for ever, and joining it would
    // turn every later confirm on this server into a timeout.
    let calls = 0;
    const w = readerWorld({
      answer: () => {
        calls++;
        return calls === 1 ? new Promise<Message>(() => {}) : { kind: "grouping", snapshot: groupingSnapshotOf(ENTRIES, T0) };
      },
    });
    const first = w.reader.ensure();
    await w.advance(POOL_GROUPING_FETCH_MS);
    eq((await first).source, "timeout", "reader: the first confirm times out on a fetch that never answers");
    await w.advance(1);
    const second = await w.reader.ensure();
    eq(calls, 2, "reader: the next confirm starts a fresh fetch rather than joining the dead one");
    eq(second.source, "installed", "reader: and is answered by it");
  }
  {
    // Compare and set: a warm up that lands while the fetch is in flight is newer than the
    // snapshot, and the snapshot must not put the older grouping back over it.
    let release: (m: Message) => void = () => {};
    const w = readerWorld({ answer: () => new Promise<Message>((r) => (release = r)) });
    const p = w.reader.ensure();
    await w.advance(20);
    w.store.install(ENTRIES, w.now(), "read");
    release({ kind: "grouping", snapshot: groupingSnapshotOf(ENTRIES.slice(0, 7).concat(ENTRIES.slice(8)).map((e) => e) as GroupingEntry[], T0 - 30_000) });
    const r = await p;
    eq(r.source, "held", "reader: a snapshot older than what the server now holds is not installed");
    eq(w.store.held()?.origin, "read", "reader: and the newer local read is what stays");
  }
}

// --- the line key, the same both ways, for every code (L246) ---------------------------
async function sameKeyBothWays() {
  // The local route: what a server's own read installs.
  const local = makeGroupingStore({ now: () => T0, freshMs: POOL_GROUPING_FRESH_MS });
  local.install(groupingEntriesOf(groupByPool(ROWS)), T0 - 1_000, "read");
  // The snapshot route: what the lane publishes, put to the REAL object and fetched back
  // by the real reader, through JSON both ways.
  const { send } = objectWorld();
  await send("directory", groupingPutMessage(groupingSnapshotOf(groupingEntriesOf(groupByPool(ROWS)), T0 - 1_000)));
  const fetched = makeGroupingStore({ now: () => T0, freshMs: POOL_GROUPING_FRESH_MS });
  const reader = makeGroupingReader({
    store: fetched,
    directory: () => ({ send: (m) => send("directory", m) }),
    now: () => T0,
    timer: () => () => {},
    boundMs: POOL_GROUPING_FETCH_MS,
    freshMs: POOL_GROUPING_FRESH_MS,
    retryMs: POOL_GROUPING_RETRY_MS,
    refreshAheadMs: POOL_GROUPING_REFRESH_AHEAD_MS,
  });
  eq((await reader.ensure()).source, "installed", "both ways: the snapshot route installs");
  let same = 0;
  for (const { code } of ROWS) {
    const a = ladderGroupOf(code, local.peek);
    const b = ladderGroupOf(code, fetched.peek);
    if (a !== null && a === b) same++;
    else assert(false, `both ways: ${code} keys ${a} locally and ${b} from the snapshot`);
  }
  eq(same, 60, "both ways: every one of the sixty codes builds the SAME ladder key from a local read and from the snapshot, so they can never split a line silently");

  // And the grouping it builds is the right one: two codes share a key exactly when their
  // whole ladders walk the same pools at every rung (judged here from the raw pool keys,
  // not the digests the key is built from), so a different pool anywhere never shares.
  const truth = (code: string) => JSON.stringify(tierLadder(code).map((r) => [RAW_KEY.get(r) ?? null, rungExcludesLow(code, r)]));
  let pairs = 0;
  let shared = 0;
  for (const a of ROWS) {
    for (const b of ROWS) {
      if (a.code >= b.code) continue;
      pairs++;
      const keysEqual = ladderGroupOf(a.code, fetched.peek) === ladderGroupOf(b.code, fetched.peek);
      if (keysEqual) shared++;
      if (keysEqual !== (truth(a.code) === truth(b.code))) {
        assert(false, `grouping: ${a.code} and ${b.code} ${keysEqual ? "share a line though their ladders differ" : "were split though their ladders are the same"}`);
      }
    }
  }
  assert(pairs === 1770 && shared > 0, `grouping: of ${pairs} pairs, the ${shared} that share a line are exactly those whose ladders match`);
  eq(ladderGroupOf("120", fetched.peek), ladderGroupOf("121", fetched.peek), "grouping: 120 and 121, the burst's two codes, share a line from the snapshot");
  assert(ladderGroupOf("411", fetched.peek) !== ladderGroupOf("410", fetched.peek), "grouping: the bucket with a hand named member splits off");
  assert(ladderGroupOf("511", fetched.peek) !== ladderGroupOf("510", fetched.peek), "grouping: and so does every ladder that walks it");
}

// --- the source a confirm's line records ---------------------------------------------
{
  const held = { readAtMs: T0, origin: "snapshot" as const };
  eq(lineGroupSourceOf({ group: "ladder:x" }, held, { source: "installed", waitedMs: 30, ageMs: 1 }), "snapshot", "source: a ladder from an installed snapshot");
  eq(lineGroupSourceOf({ group: "ladder:x" }, { ...held, origin: "read" }, { source: "held", waitedMs: null, ageMs: null }), "local", "source: a ladder from the server's own read");
  eq(lineGroupSourceOf({ group: null, why: "own-code-missing" }, held, { source: "installed", waitedMs: 1, ageMs: 1 }), "own-code-missing", "source: a grouping without the confirm's own code");
  for (const s of ["timeout", "stale", "refused", "absent", "format-mismatch", "unreachable", "unbound"] as const) {
    eq(lineGroupSourceOf({ group: null, why: "unknown-rung" }, null, { source: s, waitedMs: 1, ageMs: null }), s, `source: a fetch that ended ${s} is said as ${s}`);
  }
  eq(lineGroupSourceOf({ group: null, why: "unknown-rung" }, null, null), "not-asked", "source: a confirm that never asked is said as not asked, never as a reason it did not meet");
  eq(lineGroupSourceOf({ group: null, why: "unknown-rung" }, held, { source: "held", waitedMs: null, ageMs: null }), "stale", "source: a grouping that was fresh at the start and expired before the key is stale");
}

// --- a timeout is told apart by its type, never its wording (review of #3470, L199) -----
async function timeoutTyping() {
  // readWithinDeadline reports a deadline it ran out on as its own error class, carrying
  // the bound, and keeps the wording other readers of it already match.
  const reports: unknown[] = [];
  let fire: () => void = () => {};
  const pending = readWithinDeadline(() => new Promise<null>(() => {}), 7, (err) => reports.push(err), (_ms, f) => ((fire = f), () => {}));
  fire();
  eq(await pending, null, "deadline: a read that never answers comes back null");
  const err = reports[0];
  assert(err instanceof NoAnswerWithinError, `deadline: and is reported as a NoAnswerWithinError (got ${String(err)})`);
  eq((err as NoAnswerWithinError).ms, 7, "deadline: carrying the bound it ran out on");
  eq((err as Error).message, "no answer within 7ms", "deadline: in the wording the other readers already match");
  // The reader classifies by the type: a REJECTION whose text happens to read like a
  // timeout is a failed call, never a timeout.
  const w = readerWorld({
    answer: () => {
      throw new Error("no answer within 5ms");
    },
  });
  eq((await w.reader.ensure()).source, "unreachable", "deadline: a rejection that only reads like a timeout is a failed call");
  const slow = readerWorld({ answer: () => new Promise<Message>(() => {}) });
  void slow.reader.ensure();
  let settled: unknown = "pending";
  void (slow.started[0] as Promise<unknown>).then((r) => (settled = r));
  await slow.advance(POOL_GROUPING_FETCH_GIVE_UP_MS);
  eq((settled as { source?: string }).source, "timeout", "deadline: and a fetch that ran out of time is a timeout, by its type");
}

// --- the cost a refused or flooding caller can cause is bounded per server -----------------
//
// Review of #3471: a confirm starts the fetch the moment its key is known to be good, before
// the per key and per address ceilings answer, so a caller with a good key over its ceiling
// starts it too. That is bounded per SERVER, never per request: a fresh grouping fetches
// nothing; while a fetch is in flight every caller joins it; and once a fetch has found
// nothing usable, the next is not started for `POOL_GROUPING_RETRY_MS`.
async function boundedPerServer() {
  const w = readerWorld({ answer: () => ({ kind: "grouping", snapshot: null }) });
  const first = await w.reader.ensure();
  eq(first.source, "absent", "retry: the first confirm fetches and finds nothing");
  const after: string[] = [];
  for (let i = 0; i < 50; i++) after.push((await w.reader.ensure()).source);
  eq(w.sent.length, 1, "retry: fifty confirms after it start no fetch of their own");
  assert(after.every((s) => s === "backoff"), `retry: each says it did not ask again (got ${[...new Set(after)].join(",")})`);
  await w.advance(POOL_GROUPING_RETRY_MS - 1);
  eq((await w.reader.ensure()).source, "backoff", "retry: still inside the window");
  eq(w.sent.length, 1, "retry: so still one fetch");
  await w.advance(1);
  eq((await w.reader.ensure()).source, "absent", "retry: and once the window has passed, the next confirm asks again");
  eq(w.sent.length, 2, "retry: with one more fetch");
  // A fetch that installed sets no window: the grouping is fresh, so nothing is fetched anyway.
  const ok = readerWorld({ answer: answering(groupingSnapshotOf(ENTRIES, T0 - 1_000)) });
  eq((await ok.reader.ensure()).source, "installed", "retry: a fetch that installs");
  eq((await ok.reader.ensure()).source, "held", "retry: is followed by a held grouping, never a backoff");
  // And the confirm's line says so in its own word.
  eq(lineGroupSourceOf({ group: null, why: "unknown-rung" }, null, { source: "backoff", waitedMs: null, ageMs: null }), "backoff", "retry: a confirm that did not ask again is said as backoff");
}

// #3529: load run 37841835577, burst 2. The lane publishes once a minute and a snapshot
// is fresh for one minute from its read's start, so each minute has a gap in which the
// directory holds only a stale one (77s apart that time). Every confirm of a crowd that
// lands in the gap keyed by code, the two codes of one ladder formed two lines and raced
// each other, and three of twelve timed out. Now a server whose directory answer is not
// fresh reads the grouping itself, at once and within the confirm's own wait, which is
// the read it already did after the response: the same reads, earlier, and never a
// longer staleness than a local read's minute.
async function ownReadFallback() {
  for (const answer of [answering(groupingSnapshotOf(ENTRIES, T0 - 73_000)), answering(null)]) {
    const w = readerWorld({ answer, ownRead: { ms: 200, lands: true } });
    const reading = w.reader.ensure();
    await w.advance(POOL_GROUPING_FETCH_MS);
    const r = await reading;
    eq(r.source, "read", "own read: a server the directory had nothing fresh for reads the grouping itself, inside its wait");
    eq(w.ownReads.length, 1, "own read: one read");
    eq(w.store.held()?.origin, "read", "own read: and holds it as its own read, which a local read's minute bounds");
    eq(w.store.peek("121"), poolKeyDigest(RAW_KEY.get("121")!), "own read: and keys from it");
  }
  {
    // Coalesced: a crowd on one server makes ONE read, however many wait.
    const w = readerWorld({ answer: answering(null), ownRead: { ms: 200, lands: true } });
    const all = Array.from({ length: 20 }, () => w.reader.ensure());
    await w.advance(POOL_GROUPING_FETCH_MS);
    const got = await Promise.all(all);
    assert(got.every((g) => g.source === "read"), `own read: every confirm of the crowd keys from it (got ${JSON.stringify([...new Set(got.map((g) => g.source))])})`);
    eq(w.ownReads.length, 1, "own read: and the crowd costs the server one read");
  }
  {
    // A read slower than the wait answers as before, and still lands for the next.
    const w = readerWorld({ answer: answering(null), ownRead: { ms: 2_000, lands: true } });
    const reading = w.reader.ensure();
    await w.advance(POOL_GROUPING_FETCH_MS);
    eq((await reading).source, "timeout", "own read: one slower than the wait is a timeout for this confirm");
    await w.advance(2_000);
    assert(w.store.fresh(), "own read: and still installs, for the confirms after it");
  }
  {
    // A read that fails is the directory's own answer, never something fresh.
    const w = readerWorld({ answer: answering(null), ownRead: { ms: 50, lands: false } });
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => warned.push(String(args[0]));
    let source: string;
    try {
      const reading = w.reader.ensure();
      await w.advance(POOL_GROUPING_FETCH_MS);
      source = (await reading).source;
    } finally {
      console.warn = realWarn;
    }
    eq(source, "absent", "own read: a failed read leaves the directory's answer as the reading");
    assert(!w.store.fresh(), "own read: and installs nothing");
    // #3529 review: and says so, so a read that keeps failing is not just another absent.
    assert(warned.some((l) => l.includes("tag=pool-grouping") && l.includes("own read")), `own read: a failed read is logged (got ${JSON.stringify(warned)})`);
  }
  {
    // #3558: a directory slow to answer must not hold the own read back. Load run
    // 37952874789 met a crowd when the directory held nothing fresh and answered slowly; its
    // servers started their own reads only once it answered, and 56 of 100 confirms timed out
    // and keyed by code. The own read starts once the directory has not answered within
    // its head start, alongside it, and lands inside the confirm's wait.
    const w = readerWorld({ answer: answering(null), answerAfterMs: 450, ownRead: { ms: 200, lands: true } });
    const reading = w.reader.ensure();
    await w.advance(POOL_GROUPING_FETCH_MS);
    eq((await reading).source, "read", "slow directory: the own read lands inside the confirm's wait");
    eq(w.ownReads[0], T0 + POOL_GROUPING_OWN_READ_AFTER_MS, "slow directory: started once the directory had not answered within its head start");
  }
  {
    // An own read that fails before a slow directory answers leaves the directory's answer
    // to stand once it arrives, said as itself, and logged; never a reading made up first.
    const w = readerWorld({ answer: answering(null), answerAfterMs: 400, ownRead: { ms: 50, lands: false } });
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => warned.push(String(args[0]));
    let source: string;
    try {
      const reading = w.reader.ensure();
      await w.advance(POOL_GROUPING_FETCH_MS);
      source = (await reading).source;
    } finally {
      console.warn = realWarn;
    }
    eq(source, "absent", "slow directory, failed own read: the directory's answer stands once it arrives");
    assert(warned.some((l) => l.includes("own read failed") && l.includes('directory="unanswered"')), `slow directory, failed own read: logged as failing before the directory answered (got ${JSON.stringify(warned)})`);
  }
  {
    // An own read that hangs must not leave the fetch unsettled for ever: the server's next
    // confirm would join a fetch that never ends. It is given up with the directory's own
    // give up, and the directory's answer stands.
    const w = readerWorld({ answer: answering(null), ownRead: { ms: 1_000_000, lands: true } });
    void w.reader.ensure();
    await w.advance(POOL_GROUPING_FETCH_GIVE_UP_MS + 10);
    let settled: string | null = null;
    void Promise.all(w.started).then(() => (settled = "settled"));
    await w.advance(1);
    eq(settled, "settled", "hung own read: the fetch settles by its give up");
  }
  {
    // A directory that answers fresh inside the head start costs no own read at all.
    const w = readerWorld({ answer: answering(groupingSnapshotOf(ENTRIES, T0 - 5_000)), answerAfterMs: 40, ownRead: { ms: 200, lands: true } });
    const reading = w.reader.ensure();
    await w.advance(POOL_GROUPING_FETCH_MS);
    eq((await reading).source, "installed", "fast directory: its fresh answer installs");
    eq(w.ownReads.length, 0, "fast directory: and no own read is made");
  }
  {
    // A directory slow to answer with something fresh still installs when it lands first.
    const w = readerWorld({ answer: answering(groupingSnapshotOf(ENTRIES, T0 - 5_000)), answerAfterMs: 250, ownRead: { ms: 400, lands: true } });
    const reading = w.reader.ensure();
    await w.advance(POOL_GROUPING_FETCH_MS);
    eq((await reading).source, "installed", "slow fresh directory: whichever lands first answers, here the directory");
  }
  {
    // Control: a fresh snapshot needs no read of its own.
    const w = readerWorld({ answer: answering(groupingSnapshotOf(ENTRIES, T0 - 5_000)), ownRead: { ms: 50, lands: true } });
    eq((await w.reader.ensure()).source, "installed", "own read control: a fresh snapshot installs as before");
    eq(w.ownReads.length, 0, "own read control: and no own read is made");
  }
}

// #3759: a grouping fresh at the prelude can expire before the confirm builds its key,
// because freshness is judged twice and the ceilings run in between. Load runs 26 and 32
// (38682217703, 38718473769) met it on every server at once: the previous burst, 60s
// earlier, had every server read a grouping at the same moment, so the next burst arrived
// 0.10s to 0.15s before all of them expired, decided `held`, fetched nothing, and keyed by
// code 150ms later while the directory held the lane's snapshot from 13.6s before.
async function refreshAhead() {
  const ceilingsMs = 300;
  const lanesSnapshot = () => groupingSnapshotOf(ENTRIES, T0 - 13_600);
  {
    const w = readerWorld({ heldAt: T0 - (POOL_GROUPING_FRESH_MS - 150), answer: answering(lanesSnapshot()) });
    const started = w.reader.start();
    await w.advance(ceilingsMs);
    const r = await w.reader.wait(started);
    assert(w.store.peek("121") !== undefined, "refresh ahead: a grouping 150ms from expiry at the prelude is still fresh at the key, 300ms later");
    eq(r.source, "installed", "refresh ahead: because the prelude fetched the directory's newer snapshot rather than deciding held");
    eq(w.store.held()?.readAtMs, T0 - 13_600, "refresh ahead: and installed it under its own read time");
  }
  {
    // The margin is the measured span between the prelude and the key: max 1,902ms over
    // 4,009 confirms in those two runs.
    assert(POOL_GROUPING_REFRESH_AHEAD_MS >= 1_902, `refresh ahead: the margin covers the longest measured prelude to key span (${POOL_GROUPING_REFRESH_AHEAD_MS}ms)`);
    assert(POOL_GROUPING_REFRESH_AHEAD_MS < POOL_GROUPING_FRESH_MS / 2, "refresh ahead: and is a small part of the window, so the extra fetching is confined to the end of each minute");
  }
  {
    const w = readerWorld({ heldAt: T0 - (POOL_GROUPING_FRESH_MS - POOL_GROUPING_REFRESH_AHEAD_MS), answer: answering(lanesSnapshot()) });
    eq((await w.reader.ensure()).source, "held", "refresh ahead: a grouping with exactly the margin left is held, no fetch");
    eq(w.sent.length, 0, "refresh ahead: not one call");
  }
  {
    const w = readerWorld({ heldAt: T0 - (POOL_GROUPING_FRESH_MS - POOL_GROUPING_REFRESH_AHEAD_MS) - 1, answer: answering(lanesSnapshot()) });
    eq((await w.reader.ensure()).source, "installed", "refresh ahead: one millisecond less and it fetches");
    eq(w.sent.length, 1, "refresh ahead: by one call");
  }
  {
    // The directory has nothing newer (the lane has stopped publishing): the confirm keeps
    // what it holds, said as held, exactly as before. Nothing here extends the minute.
    const w = readerWorld({ heldAt: T0 - (POOL_GROUPING_FRESH_MS - 150), answer: answering(groupingSnapshotOf(ENTRIES, T0 - (POOL_GROUPING_FRESH_MS - 150))) });
    eq((await w.reader.ensure()).source, "held", "refresh ahead: a directory with nothing newer leaves the held grouping, said as held");
    w.setNow(T0 + 151);
    eq(w.store.peek("121"), undefined, "refresh ahead: and it still expires on its own minute, never later");
  }
}

async function main() {
  await readerTests();
  await refreshAhead();
  await ownReadFallback();
  await sameKeyBothWays();
  await timeoutTyping();
  await boundedPerServer();
  finish();
}

void main();
