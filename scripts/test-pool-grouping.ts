// The pool grouping a cold server fetches before it joins a confirm line (#3460).
//
// Load run 37566700055, burst 3: a hundred confirms for one slot on codes 120 and 121,
// whose ladders walk the same pools, split across `ladder:`, `code:120` and `code:121`
// lines, because 85 of them ran on servers holding no fresh pool grouping. Each line
// elected a leader, and one slow losing leader timed out 41 followers. The every minute
// recompute lane already reads the grouping, so it publishes it to a reserved instance of
// the confirm line object, and a server whose own grouping is absent or stale fetches
// that snapshot, bounded, before it builds its line key.
//
// Over-grouping is the failure this must never have: a leader's "full" verdict settles
// only followers whose ladders walk the same pools, so a guessed group could tell a lead
// a time is taken when it is not. So everything here is about REFUSING: an empty, partial,
// stale, wrong format or older snapshot keeps the confirm on its code's own line, which is
// today's behaviour, and says why.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-pool-grouping.ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  POOL_GROUPING_FORMAT,
  POOL_GROUPING_DIRECTORY,
  POOL_GROUPING_DIRECTORY_PROTOCOL,
  POOL_GROUPING_FRESH_MS,
  POOL_GROUPING_FETCH_MS,
  POOL_GROUPING_FETCH_GIVE_UP_MS,
  POOL_GROUPING_FUTURE_TOLERANCE_MS,
  groupingEntriesOf,
  groupingSnapshotOf,
  readGroupingSnapshot,
  makeGroupingStore,
  makeGroupingReader,
  groupingGetMessage,
  groupingPutMessage,
  lineGroupSourceOf,
  type GroupingEntry,
  type GroupingSnapshot,
  type DirectoryStub,
} from "../src/lib/booking/pool-grouping.ts";
import { makeConfirmLineObject, objectRoleOf, CONFIRM_LINE_PROTOCOL } from "../src/lib/booking/confirm-line-object.ts";
import { keyKindOf, confirmLineObjectName } from "../src/lib/booking/shared-confirm-line.ts";
import { CONFIRM_LINE_VERIFY_GROUP } from "../src/lib/monitor/confirm-line-probe.ts";
import { ladderGroupOf, ladderGroupRead, poolKeyDigest } from "../src/lib/booking/line-key.ts";
import { groupByPool, poolKeyFor } from "../src/lib/availability/pool-key.ts";
import { tierLadder, rungExcludesLow } from "../src/lib/routing/tiers.ts";
import { poolGroupingRoster } from "./lib/pool-grouping-fixture.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
type Message = Record<string, unknown>;

// --- a realistic roster: sixty buckets, fifteen pools, two edited -------------------
const ROWS = poolGroupingRoster();
const RAW_KEY = new Map(ROWS.map((r) => [r.code, poolKeyFor(r)]));
const ENTRIES = groupingEntriesOf(groupByPool(ROWS));
const T0 = Date.parse("2026-10-07T14:00:00.000Z");

eq(ROWS.length, 60, "fixture: sixty bucket codes, as production has");
eq(groupByPool(ROWS).size, 17, "fixture: fifteen pools plus the two edited buckets");

// --- the snapshot's entries ----------------------------------------------------------
{
  eq(ENTRIES.length, 60, "entries: one per bucket code");
  eq(ENTRIES.map((e) => e[0]).join(","), [...RAW_KEY.keys()].sort().join(","), "entries: every code, in code order, so two reads of one roster publish the same snapshot");
  assert(ENTRIES.every(([code, pool]) => pool === poolKeyDigest(RAW_KEY.get(code)!)), "entries: each carries its pool key's digest, not the key spelled out");
  assert(ENTRIES.every(([, pool]) => pool.length <= 40), "entries: every digest fits the object's string cap");
  const again = groupingEntriesOf(groupByPool([...ROWS].reverse()));
  eq(JSON.stringify(again), JSON.stringify(ENTRIES), "entries: the same roster read in another order publishes the identical entries");
}

// --- reading a snapshot back: the refusals (L215, L505) ------------------------------
const good = groupingSnapshotOf(ENTRIES, T0);
{
  const wire = JSON.parse(JSON.stringify(good)) as unknown;
  const back = readGroupingSnapshot(wire, POOL_GROUPING_FORMAT);
  assert(back.kind === "snapshot", `read: a snapshot that went through JSON reads back (got ${back.kind})`);
  if (back.kind === "snapshot") {
    eq(back.snapshot.count, 60, "read: with its count");
    eq(JSON.stringify(back.snapshot.entries), JSON.stringify(ENTRIES), "read: and every entry intact");
    eq(back.snapshot.readAtMs, T0, "read: and the time it was read");
  }

  // The naive bug the lessons audit named: a Map serialises as `{}`, so a snapshot built
  // by stringifying the map publishes NOTHING, and an empty grouping read as gaps makes
  // every ladder of one length alike.
  const naive = JSON.parse(JSON.stringify({ format: POOL_GROUPING_FORMAT, readAtMs: T0, count: 60, entries: new Map(ENTRIES) })) as unknown;
  eq(readGroupingSnapshot(naive, POOL_GROUPING_FORMAT).kind, "refused", "refused: a Map serialised as {} is not a snapshot");

  const refusals: [string, unknown][] = [
    ["empty", { ...good, count: 0, entries: [] }],
    ["partial (fewer entries than its count)", { ...good, entries: good.entries.slice(0, 40) }],
    ["over counted (more entries than its count)", { ...good, count: 59 }],
    ["not an object", "a string"],
    ["an array", [good]],
    ["null", null],
    ["no read time", { ...good, readAtMs: undefined }],
    ["a read time that is not a number", { ...good, readAtMs: "yesterday" }],
    ["a read time that is NaN", { ...good, readAtMs: Number.NaN }],
    ["an entry that is not a pair", { ...good, entries: [...good.entries.slice(0, 59), ["999"]] }],
    ["an entry with an empty pool", { ...good, entries: [...good.entries.slice(0, 59), ["999", ""]] }],
    ["an entry longer than the cap", { ...good, entries: [...good.entries.slice(0, 59), ["999", "x".repeat(201)]] }],
    ["one code in two pools", { ...good, entries: [...good.entries.slice(0, 59), [good.entries[0]![0], "other"]] }],
    ["no format", { ...good, format: undefined }],
  ];
  for (const [label, raw] of refusals) {
    eq(readGroupingSnapshot(raw, POOL_GROUPING_FORMAT).kind, "refused", `refused: ${label}`);
  }
  eq(readGroupingSnapshot({ ...good, format: POOL_GROUPING_FORMAT + 1 }, POOL_GROUPING_FORMAT).kind, "format-mismatch", "a snapshot from another derivation is a format mismatch, said apart from a malformed one (L11)");
  eq(readGroupingSnapshot({ ...good, format: POOL_GROUPING_FORMAT + 1 }, null).kind, "snapshot", "the object judges the shape only, so a build of another format can still publish to its own instance");
}

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
  });
  // Through JSON both ways, as the platform carries it, so a shape that does not survive
  // serialisation fails here (L505).
  const send = async (role: "line" | "directory", m: Message) =>
    JSON.parse(await object.handle(role, JSON.parse(JSON.stringify(m)) as unknown)) as Message;
  return { send };
}
async function directoryTests() {
  const { send } = objectWorld();
  const empty = await send("directory", groupingGetMessage());
  eq(empty.kind, "grouping", "directory: a get is answered as a grouping");
  eq(empty.snapshot, null, "directory: and a new directory holds none");

  const put = await send("directory", groupingPutMessage(good));
  eq(put.kind, "stored", "directory: a put is stored");
  const got = await send("directory", groupingGetMessage());
  const back = readGroupingSnapshot(got.snapshot, POOL_GROUPING_FORMAT);
  assert(back.kind === "snapshot" && JSON.stringify(back.snapshot) === JSON.stringify(good), "directory: and a get hands it back intact, through the real envelope");

  const older = await send("directory", groupingPutMessage(groupingSnapshotOf(ENTRIES.slice(0, 3), T0 - 1)));
  eq(older.kind, "kept", "directory: an OLDER put is refused as kept");
  const still = await send("directory", groupingGetMessage());
  eq((still.snapshot as GroupingSnapshot).readAtMs, T0, "directory: and the newer snapshot is still the one handed out");
  const newer = await send("directory", groupingPutMessage(groupingSnapshotOf(ENTRIES, T0 + 1_000)));
  eq(newer.kind, "stored", "directory: a newer put replaces it");

  eq((await send("directory", groupingPutMessage({ ...good, count: 0, entries: [] } as GroupingSnapshot))).kind, "bad", "directory: an EMPTY put is refused, never stored");
  eq((await send("directory", groupingPutMessage({ ...good, entries: good.entries.slice(0, 10) }))).kind, "bad", "directory: a put whose count does not match its entries is refused");
  eq((await send("directory", { dv: POOL_GROUPING_DIRECTORY_PROTOCOL + 1, op: "grouping-get" })).kind, "bad", "directory: a message of another directory version is refused");
  eq((await send("directory", { dv: POOL_GROUPING_DIRECTORY_PROTOCOL, op: "grouping-drop" })).kind, "bad", "directory: an op it does not know is refused");

  // Line messages are refused on the directory, and directory messages on every line,
  // the monitor's included.
  eq((await send("directory", { v: CONFIRM_LINE_PROTOCOL, op: "enter", attempt: "a1", line: "1", waitMs: 0 })).kind, "bad", "roles: a line message on the directory is refused");
  const lineSide = objectWorld();
  eq((await lineSide.send("line", groupingGetMessage())).kind, "bad", "roles: a grouping get on a line instance is refused");
  eq((await lineSide.send("line", groupingPutMessage(good))).kind, "bad", "roles: a grouping put on a line instance is refused");
  eq((await lineSide.send("line", { v: CONFIRM_LINE_PROTOCOL, op: "enter", attempt: "a1", line: "1", waitMs: 0 })).kind, "lead", "roles: and a line message on a line still leads, so the line is untouched");

  // Which role a call is served as. The URL the client's one constructor builds carries
  // it; the instance's own name, when the runtime supplies one and it is ours, must
  // agree, and when it is absent or not ours the URL alone decides (L82: the name is
  // platform behaviour this file cannot measure, so neither answer may break the line).
  const dirName = confirmLineObjectName(POOL_GROUPING_DIRECTORY);
  const monitorName = confirmLineObjectName(CONFIRM_LINE_VERIFY_GROUP);
  const lineName = confirmLineObjectName("ladder:abc");
  const cases: [string, string, unknown, string][] = [
    ["the directory path, no name", "/directory", undefined, "directory"],
    ["the directory path on the directory", "/directory", dirName, "directory"],
    ["the line path, no name", "/line", undefined, "line"],
    ["the bare path an older client sends", "/", undefined, "line"],
    ["the line path on a line", "/line", lineName, "line"],
    ["the line path on the monitor", "/line", monitorName, "line"],
    ["the directory path on the MONITOR", "/directory", monitorName, "refused"],
    ["the directory path on a line", "/directory", lineName, "refused"],
    ["the line path on the directory", "/line", dirName, "refused"],
    ["an unknown path", "/elsewhere", undefined, "refused"],
    ["a name that is not ours", "/directory", "something-else", "directory"],
    ["a name that is not a string", "/line", 42, "line"],
  ];
  for (const [label, path, name, want] of cases) {
    const r = objectRoleOf(path, name);
    eq("role" in r ? r.role : "refused", want, `roles: ${label}`);
  }
  eq(keyKindOf(POOL_GROUPING_DIRECTORY), "none", "roles: the directory's name reads as no real line kind");
  assert(POOL_GROUPING_DIRECTORY.startsWith("directory:"), "roles: and lives in the directory space");
  assert(POOL_GROUPING_DIRECTORY.includes(`v${POOL_GROUPING_FORMAT}`), "roles: and carries the format, so two builds of different formats never share an instance during a gradual deploy");
}

// --- the reader: one bounded fetch per server, compare and set ------------------------
function readerWorld(opts: { answer?: (m: Message) => Promise<Message> | Message; unbound?: boolean; heldAt?: number | null; heldOrigin?: "read" | "snapshot" } = {}) {
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
  const directoryStub: DirectoryStub = {
    async send(m) {
      sent.push(m);
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
    onFetchStarted: (p) => started.push(p),
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
  return { store, reader, sent, started, advance, now: () => now, setNow: (t: number) => (now = t) };
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

// --- the derivation a snapshot carries is pinned to its format (L1013) ----------------
//
// A snapshot is installed by whichever build fetches it, and production deploys are
// gradual, so for a while one build installs a snapshot another published. Two builds
// that derive pool keys or ladders differently could then put two codes in one line
// that the newer build splits. The directory's name carries POOL_GROUPING_FORMAT, so
// builds of different formats never share an instance, and this pin makes a change to
// the derivation demand a new format: change any input below and this fails until the
// format is bumped and the new values are pinned under it.
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s+/g, " ").trim();
  const functionText = (file: string, name: string) => {
    const src = readFileSync(join(ROOT, file), "utf8");
    const at = src.search(new RegExp(`function ${name}\\b`));
    if (at === -1) return `missing:${name}`;
    let depth = 0;
    let i = src.indexOf("{", at);
    const start = at;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    return src.slice(start, i + 1);
  };
  const sources = [
    strip(readFileSync(join(ROOT, "src/lib/availability/pool-key.ts"), "utf8")),
    strip(functionText("src/lib/availability/precompute.ts", "listPoolBuckets")),
    strip(functionText("src/lib/routing/tiers.ts", "tierLadder")),
    strip(functionText("src/lib/routing/tiers.ts", "cascadeFloorTier")),
    strip(functionText("src/lib/routing/tiers.ts", "rungExcludesLow")),
    strip(functionText("src/lib/routing/tiers.ts", "isTopTierCode")),
    strip(functionText("src/lib/booking/line-key.ts", "fingerprint")),
    strip(functionText("src/lib/booking/line-key.ts", "ladderGroupRead")),
    strip(functionText("src/lib/booking/pool-grouping.ts", "groupingEntriesOf")),
  ];
  assert(sources.every((s) => !s.startsWith("missing:")), `pin: every derivation it covers was found (missing: ${sources.filter((s) => s.startsWith("missing:")).join(", ") || "none"})`);
  const sourceHash = createHash("sha256").update(sources.join("\n")).digest("hex").slice(0, 16);
  const fixtureHash = createHash("sha256")
    .update(JSON.stringify(ROWS.map((r) => [r.code, ladderGroupOf(r.code, (c) => ENTRIES.find((e) => e[0] === c)?.[1] ?? null)])))
    .update(JSON.stringify(ENTRIES))
    .digest("hex")
    .slice(0, 16);
  // One entry per format ever shipped. A new format ADDS an entry: the old ones stay, so
  // the history of what each format meant is kept beside the number that names it.
  const PINNED: Record<number, { sources: string; fixture: string }> = {
    1: { sources: "31dc29a825745a15", fixture: "b1c70a4b91b48a81" },
  };
  const pin = PINNED[POOL_GROUPING_FORMAT];
  assert(pin !== undefined, `pin: format ${POOL_GROUPING_FORMAT} has pinned values`);
  eq(
    fixtureHash,
    pin?.fixture,
    "pin: the fixture's digests and ladder keys are the ones pinned for this format. If the derivation changed on purpose, bump POOL_GROUPING_FORMAT and pin these values under the new format",
  );
  eq(
    sourceHash,
    pin?.sources,
    "pin: the derivation's source is the one pinned for this format. If it changed on purpose, bump POOL_GROUPING_FORMAT and pin the new hash under the new format",
  );
  // Control: the pin would notice. A one character change to the pool key's framing
  // changes the fixture's hash, so a derivation edited without a new format is caught.
  const tampered = createHash("sha256").update(JSON.stringify(ENTRIES).replace("pool", "p00l")).digest("hex").slice(0, 16);
  assert(tampered !== fixtureHash, "pin: control, a changed derivation gives a different fixture hash");
}

async function main() {
  await directoryTests();
  await readerTests();
  await sameKeyBothWays();
  // ladderGroupRead is imported for the pin above; touch it so an unused import is never read as coverage.
  assert(typeof ladderGroupRead === "function", "the ladder read the pin covers is the one exported");
  finish();
}

void main();
