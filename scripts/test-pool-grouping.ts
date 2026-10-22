// The pool grouping snapshot the recompute lane publishes for a cold server to key its
// confirm line from (#3460).
//
// Load run 37566700055, burst 3: a hundred confirms for one slot on codes 120 and 121,
// whose ladders walk the same pools, split across `ladder:`, `code:120` and `code:121`
// lines, because 85 of them ran on servers holding no fresh pool grouping. Each line
// elected a leader, and one slow losing leader timed out 41 followers. The every minute
// recompute lane already reads the grouping, so it publishes it to a reserved instance of
// the confirm line object. The reader that installs it lives with its caller
// (`pool-grouping-reader.ts`, #3460's second half).
//
// Over-grouping is the failure this must never have: a leader's "full" verdict settles
// only followers whose ladders walk the same pools, so a guessed group could tell a lead
// a time is taken when it is not. So this pins the snapshot's REFUSALS (empty, partial,
// malformed, another format), the directory's newest wins, and the derivation under its
// format. That a snapshot builds the very ladder key a local read builds for every code is
// `scripts/test-pool-grouping-reader.ts`, through the real reader and store.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-pool-grouping.ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  POOL_GROUPING_FORMAT,
  POOL_GROUPING_DIRECTORY,
  POOL_GROUPING_DIRECTORY_PROTOCOL,
  POOL_GROUPING_FUTURE_TOLERANCE_MS,
  POOL_GROUPING_STORAGE_KEY,
  groupingEntriesOf,
  groupingSnapshotOf,
  readGroupingSnapshot,
  groupingGetMessage,
  groupingPutMessage,
  type GroupingSnapshot,
  type GroupingDirectoryStorage,
} from "../src/lib/booking/pool-grouping.ts";
import { fileSource, functionSource } from "./lib/function-source.ts";
import { memoryGroupingStorage } from "./lib/memory-grouping-storage.ts";
import { makeConfirmLineObject, objectRoleOf, CONFIRM_LINE_PROTOCOL } from "../src/lib/booking/confirm-line-object.ts";
import { keyKindOf, confirmLineObjectName } from "../src/lib/booking/shared-confirm-line.ts";
import { CONFIRM_LINE_VERIFY_GROUP } from "../src/lib/monitor/confirm-line-probe.ts";
import { ladderGroupOf, poolKeyDigest } from "../src/lib/booking/line-key.ts";
import { groupByPool, poolKeyFor } from "../src/lib/availability/pool-key.ts";
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

// --- the directory, through the real object and its envelope -------------------------
type DirectoryStorage = GroupingDirectoryStorage;
function objectWorld(directoryStorage: DirectoryStorage = memoryGroupingStorage()) {
  const object = makeConfirmLineObject({
    now: () => T0,
    timer: () => () => {},
    leaseTimer: () => () => {},
    newId: (() => {
      let n = 0;
      return () => `id${++n}`;
    })(),
    directoryStorage,
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

  // #3479: the platform hibernates an idle object after ten seconds and discards its
  // memory, so the directory keeps its snapshot in the object's own storage. A NEW object
  // over the same storage is exactly what a woken instance is (load run 37601024392: every
  // burst arrived 46 to 48 seconds after the last publish and read nothing).
  {
    const storage = memoryGroupingStorage();
    const asleep = objectWorld(storage);
    eq((await asleep.send("directory", groupingPutMessage(good))).kind, "stored", "eviction: a put is stored");
    const woken = objectWorld(storage);
    const back = readGroupingSnapshot((await woken.send("directory", groupingGetMessage())).snapshot, POOL_GROUPING_FORMAT);
    assert(back.kind === "snapshot" && JSON.stringify(back.snapshot) === JSON.stringify(good), "eviction: a woken directory still hands out the snapshot stored before it slept");
    eq((await woken.send("directory", groupingPutMessage(groupingSnapshotOf(ENTRIES.slice(0, 3), T0 - 1)))).kind, "kept", "eviction: and an older put after waking is still kept, so newest wins survives the sleep");
    const writes = storage.writes;
    eq((await woken.send("directory", groupingPutMessage(groupingSnapshotOf(ENTRIES, T0 - 1)))).kind, "kept", "eviction: a kept put");
    eq(storage.writes, writes, "eviction: writes nothing, so a crowd of older backup publishes costs no storage");
  }
  {
    // #3481: a get says where it answered from, so the daily proof can tell an instance
    // that woke and read its storage back from one that never slept. `storage` only on the
    // get that loaded it, `memory` on every call after, whatever the call was.
    const storage = memoryGroupingStorage();
    const first = objectWorld(storage);
    const fresh = await first.send("directory", groupingGetMessage());
    eq(fresh.from, "storage", "answered from: a new instance's first get loads its storage, and says so");
    eq(fresh.snapshot, null, "answered from: and an empty storage still holds nothing");
    eq((await first.send("directory", groupingGetMessage())).from, "memory", "answered from: the next get on the same instance is served from memory");
    eq((await first.send("directory", groupingPutMessage(good))).kind, "stored", "answered from: a put is stored");
    eq((await first.send("directory", groupingGetMessage())).from, "memory", "answered from: and a get after it, on the same instance, is still memory");

    const woken = await objectWorld(storage).send("directory", groupingGetMessage());
    eq(woken.from, "storage", "answered from: a woken instance's first get is answered from storage");
    const back = readGroupingSnapshot(woken.snapshot, POOL_GROUPING_FORMAT);
    assert(back.kind === "snapshot" && JSON.stringify(back.snapshot) === JSON.stringify(good), "answered from: and hands back the snapshot stored before it slept");

    // A woken instance whose first call is a PUT loaded its storage on that put, so the
    // get after it is memory: `storage` means this very get read storage, never that the
    // instance is new.
    const putFirst = objectWorld(storage);
    eq((await putFirst.send("directory", groupingPutMessage(groupingSnapshotOf(ENTRIES, T0 + 5_000)))).kind, "stored", "answered from: a woken instance stores a newer put");
    eq((await putFirst.send("directory", groupingGetMessage())).from, "memory", "answered from: and the get after that put is memory, since the put did the load");

    // A load that failed is retried by the next call, and that call is the one that read
    // storage.
    let failNext = true;
    const flaky: DirectoryStorage = {
      get: async (key) => {
        if (failNext) {
          failNext = false;
          throw new Error("storage is down");
        }
        return storage.get(key);
      },
      put: (key, value) => storage.put(key, value),
    };
    const retried = objectWorld(flaky);
    eq((await retried.send("directory", groupingGetMessage())).kind, "bad", "answered from: a get whose load fails is refused");
    eq((await retried.send("directory", groupingGetMessage())).from, "storage", "answered from: and the get that loaded it next says storage");
    eq((await retried.send("directory", groupingGetMessage())).from, "memory", "answered from: and the one after, memory");
  }
  {
    // A write that fails is a refusal, never `stored`: the publisher stamps its heartbeat
    // only on stored, so a directory that cannot persist is paged rather than believed.
    const failing: DirectoryStorage = {
      get: async () => undefined,
      put: async () => {
        throw new Error("storage is down");
      },
    };
    const w = objectWorld(failing);
    eq((await w.send("directory", groupingPutMessage(good))).kind, "bad", "storage: a put whose write fails is refused");
    eq((await w.send("directory", groupingGetMessage())).snapshot, null, "storage: and the snapshot that did not persist is never handed out");
  }
  {
    // A read that fails is not an empty directory (L215): it is refused, which a reader
    // counts as `refused` rather than `absent`.
    const unreadable: DirectoryStorage = {
      get: async () => {
        throw new Error("storage is down");
      },
      put: async () => {},
    };
    eq((await objectWorld(unreadable).send("directory", groupingGetMessage())).kind, "bad", "storage: a get whose read fails is refused, never an empty directory");
  }
  {
    // What storage holds is judged by the same rules as a put (L1013): a value that does
    // not read as a snapshot is none, and a put over it is stored.
    const corrupt: DirectoryStorage = { get: async () => ({ format: POOL_GROUPING_FORMAT, readAtMs: T0, count: 2, entries: [] }), put: async () => {} };
    const w = objectWorld(corrupt);
    eq((await w.send("directory", groupingGetMessage())).snapshot, null, "storage: a stored value that is not a snapshot is none");
    eq((await w.send("directory", groupingPutMessage(good))).kind, "stored", "storage: and a put over it is stored");
  }

  // #3483: a put stamped in the future is refused before it is stored. Stored, it would
  // outlive every hibernation and be answered over every later honest put (all "older"
  // than it), while every reader refuses it: the directory would be poisoned for good.
  // The bound is the reader's own tolerance, one constant.
  {
    const w = objectWorld();
    const future = groupingSnapshotOf(ENTRIES, T0 + POOL_GROUPING_FUTURE_TOLERANCE_MS + 1);
    eq((await w.send("directory", groupingPutMessage(future))).kind, "bad", "future: a put stamped beyond the tolerance is refused");
    eq((await w.send("directory", groupingGetMessage())).snapshot, null, "future: and is never handed out");
    eq((await w.send("directory", groupingPutMessage(good))).kind, "stored", "future: so the next honest put is still stored");
    // Control: exactly at the tolerance is the clock skew readers accept, so it is kept.
    const edge = groupingSnapshotOf(ENTRIES, T0 + POOL_GROUPING_FUTURE_TOLERANCE_MS);
    eq((await objectWorld().send("directory", groupingPutMessage(edge))).kind, "stored", "future: control, a put at exactly the tolerance is stored");
  }
  {
    // A woken instance whose storage already holds a future snapshot (written before
    // this rule, or by a build without it) reads it as none, and stores the next put.
    const storage = memoryGroupingStorage();
    await storage.put(POOL_GROUPING_STORAGE_KEY, groupingSnapshotOf(ENTRIES, T0 + POOL_GROUPING_FUTURE_TOLERANCE_MS + 60_000));
    const woken = objectWorld(storage);
    eq((await woken.send("directory", groupingGetMessage())).snapshot, null, "future: a stored snapshot from the future is read as none on waking");
    eq((await woken.send("directory", groupingPutMessage(good))).kind, "stored", "future: and the next honest put replaces it");
  }

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
  // Found by the TypeScript compiler and read as the source's own tokens, comments and
  // layout removed (review of #3470, L135, L552): a brace count is cut short by a brace
  // inside a string or a regex, and then the pin guards a fragment of the function, while
  // the compiler's printer would tie the hash to the installed TypeScript version.
  const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
  const functionText = (file: string, name: string) => functionSource(file, read(file), name) ?? `missing:${name}`;
  {
    // Control: a function whose body holds braces inside a string, a template and a regex
    // is found whole, up to its own closing brace and no further.
    const tricky = [
      "export function tricky(x: string): number {",
      '  const a = "}}}";',
      "  const b = `${x}}`;",
      "  const c = /\\}+/.test(x);",
      "  return a.length + b.length + (c ? 1 : 0);",
      "}",
      "export function after() { return 2; }",
    ].join("\n");
    const found = functionSource("tricky.ts", tricky, "tricky") ?? "";
    assert(found.endsWith("return a . length + b . length + ( c ? 1 : 0 ) ; }") && !found.includes("after"), `pin: control, braces in strings, templates and regexes do not cut a function short (got ${JSON.stringify(found)})`);
    eq(functionSource("tricky.ts", tricky, "absent"), null, "pin: control, a function that is not there is said to be missing, never an empty text");
    // Control (review of #3470, L552): the text is the source's OWN tokens, never the
    // compiler's printer, whose layout belongs to the installed TypeScript version, so a
    // compiler upgrade would fail the pin with no change to the derivation. A doc comment,
    // a line comment and the layout are all dropped.
    eq(
      functionSource("plain.ts", "/** what f does */\nfunction f ( x:string ) {\n  // a note\n  return `${x}}`  ;\n}", "f"),
      "function f ( x : string ) { return `${ x }}` ; }",
      "pin: control, a function's text is its own tokens, comments and layout removed, independent of the compiler's printer",
    );
  }
  const sources = [
    fileSource("pool-key.ts", read("src/lib/availability/pool-key.ts")),
    functionText("src/lib/availability/precompute.ts", "listPoolBuckets"),
    functionText("src/lib/routing/tiers.ts", "tierLadder"),
    functionText("src/lib/routing/tiers.ts", "cascadeFloorTier"),
    functionText("src/lib/routing/tiers.ts", "rungExcludesLow"),
    functionText("src/lib/routing/tiers.ts", "isTopTierCode"),
    functionText("src/lib/booking/line-key.ts", "fingerprint"),
    // The hash the fingerprint is made of, in its own file since #4102 shared it.
    fileSource("cyrb53.ts", read("src/lib/cyrb53.ts")),
    functionText("src/lib/booking/line-key.ts", "ladderGroupRead"),
    functionText("src/lib/booking/pool-grouping.ts", "groupingEntriesOf"),
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
  // Format 1's source hash was re-pinned twice, before it ever shipped: when the sources
  // moved from a brace count to the compiler's printed text, and again when they moved
  // from that printed text to the source's own tokens (review of #3470, L552). Its
  // fixture hash, the derivation's actual output, did not move either time. A third time
  // when the hash moved into src/lib/cyrb53.ts to be shared with the booking pace readings
  // (#4102): same output for 20,001 keys compared against the old copy, and the fixture
  // hash again unchanged.
  const PINNED: Record<number, { sources: string; fixture: string }> = {
    1: { sources: "1eda1fa8e92f529a", fixture: "b1c70a4b91b48a81" },
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
  finish();
}

void main();
