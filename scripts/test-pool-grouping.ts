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
// malformed, another format), the directory's newest wins, that a snapshot builds the very
// ladder key a local read builds for every code, and the derivation under its format.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-pool-grouping.ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  POOL_GROUPING_FORMAT,
  POOL_GROUPING_DIRECTORY,
  POOL_GROUPING_DIRECTORY_PROTOCOL,
  groupingEntriesOf,
  groupingSnapshotOf,
  readGroupingSnapshot,
  groupingGetMessage,
  groupingPutMessage,
  type GroupingEntry,
  type GroupingSnapshot,
} from "../src/lib/booking/pool-grouping.ts";
import { fileSource, functionSource } from "./lib/function-source.ts";
import { makeConfirmLineObject, objectRoleOf, CONFIRM_LINE_PROTOCOL } from "../src/lib/booking/confirm-line-object.ts";
import { keyKindOf, confirmLineObjectName } from "../src/lib/booking/shared-confirm-line.ts";
import { CONFIRM_LINE_VERIFY_GROUP } from "../src/lib/monitor/confirm-line-probe.ts";
import { ladderGroupOf, poolKeyDigest } from "../src/lib/booking/line-key.ts";
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

// --- the line key, the same both ways, for every code (L246) ---------------------------
async function sameKeyBothWays() {
  // A grouping, as a server holding it answers for a code: its pool, or null for a code
  // with no bucket (a gap).
  const peekOf = (entries: readonly GroupingEntry[]) => {
    const byCode = new Map(entries.map(([c, p]) => [c, p]));
    return (code: string) => byCode.get(code) ?? null;
  };
  // The local route: the entries a server's own read derives.
  const local = { peek: peekOf(groupingEntriesOf(groupByPool(ROWS))) };
  // The snapshot route: what the lane publishes, put to the REAL object and read back,
  // through JSON both ways.
  const { send } = objectWorld();
  await send("directory", groupingPutMessage(groupingSnapshotOf(groupingEntriesOf(groupByPool(ROWS)), T0 - 1_000)));
  const read = readGroupingSnapshot((await send("directory", groupingGetMessage())).snapshot, POOL_GROUPING_FORMAT);
  assert(read.kind === "snapshot", "both ways: the published snapshot reads back from the directory");
  if (read.kind !== "snapshot") return;
  const fetched = { peek: peekOf(read.snapshot.entries) };
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
  // fixture hash, the derivation's actual output, did not move either time.
  const PINNED: Record<number, { sources: string; fixture: string }> = {
    1: { sources: "9f7ba83cae0ba4aa", fixture: "b1c70a4b91b48a81" },
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
  await sameKeyBothWays();
  finish();
}

void main();
