/**
 * The pool grouping a server holds to key its confirm line, and the snapshot of it
 * every server can fetch from one place (#3460).
 *
 * WHY. A confirm joins the LADDER line of its code (`line-key.ts`) only when its server
 * holds a fresh grouping of every bucket code into its pool. Until #3460 a server
 * learned the grouping only from its own read, scheduled after its first confirm's
 * response, and kept it for a minute. Load run 37566700055 fired its bursts a minute
 * apart, so most confirms in each burst ran on servers holding nothing: a hundred
 * confirms for one slot on codes 120 and 121, whose ladders are the same pools, split
 * across a `ladder:` line and both codes' own lines. Each line elected a leader, and
 * one slow losing leader timed out 41 followers. In burst 1, 46 servers each did the
 * warm up, 93 full table reads at a median of 4.5s.
 *
 * WHAT. The every minute recompute lane already reads the grouping. It publishes it,
 * with the time its read STARTED, to a reserved instance of the confirm line object
 * (the DIRECTORY), and any server's own read publishes too, as a backup. A server whose
 * grouping is absent or stale fetches that snapshot, once however many confirms ask,
 * under a short bound, and installs it under the snapshot's own read time, so the
 * freshness bound is the same minute a local read has. #3355 already decided a confirm
 * may wait, within a short bound, for the grouping before its line key (items 1 and 2,
 * which this supersedes); before that, a confirm never read anything before its line.
 *
 * OVER-GROUPING IS THE ONE FAILURE THIS MUST NOT HAVE. A leader's "full" verdict
 * settles only followers whose ladders walk the same pools, so a guessed group could
 * tell a lead a time is taken when it is not. So almost everything here is a REFUSAL,
 * and every refusal leaves the confirm on its code's own line, today's behaviour:
 *
 * - an empty snapshot, or one whose count does not match its entries (a partial one),
 *   is refused by the object on the way in and by the reader on the way out (L215);
 * - a snapshot older than the freshness window is refused (L614): the lane stamps the
 *   read's START, so in each minute's gap between one snapshot expiring and the next
 *   landing, a cold server keeps its code line and says `stale`;
 * - a snapshot of another FORMAT is refused (L1013). Production deploys are gradual, so
 *   for a while one build installs what another published; the directory's name carries
 *   the format, so two formats never share an instance, and this is the second guard;
 * - a snapshot older than what the server holds is not installed, and nor is a local
 *   read older than an installed snapshot: compare and set, newest wins (L751, L443).
 *   The read times come from different servers' clocks, which a Worker keeps close; a
 *   snapshot stamped further than `POOL_GROUPING_FUTURE_TOLERANCE_MS` in the future is
 *   refused, because installing it would keep the grouping fresh past its minute.
 *
 * The entries are `[code, pool digest]` pairs, never a serialised Map (which is `{}`),
 * and a code is never looked up with a bracket on a plain object (L738).
 *
 * Pure apart from what it is handed, relative imports only, so the node suites drive
 * it: the snapshot, a server's store, the reader, and the directory's host.
 */
import { poolKeyDigest } from "./line-key.ts";
import { readWithinDeadline, type ScheduleTimer } from "../read-within-deadline.ts";

/**
 * The derivation a snapshot's entries come from. Raised whenever the pool key
 * (`pool-key.ts`), what `listPoolBuckets` feeds it, the ladder (`tierLadder`) or the
 * digest changes, which `scripts/test-pool-grouping.ts` enforces by pinning a fixture's
 * values and the sources under each format.
 */
export const POOL_GROUPING_FORMAT = 1;
/** The directory's own message version, apart from the line's (`CONFIRM_LINE_PROTOCOL`). */
export const POOL_GROUPING_DIRECTORY_PROTOCOL = 1;
/**
 * The directory's group name. It carries the format, so a build of another format
 * talks to another instance during a gradual deploy. `keyKindOf` reads it as no real
 * line kind, and no real line key can be built equal to it.
 */
export const POOL_GROUPING_DIRECTORY = `directory:pool-grouping:v${POOL_GROUPING_FORMAT}`;
/** The directory the daily proof writes into, never the live one (#3460). */
export const POOL_GROUPING_VERIFY_DIRECTORY = "directory:pool-grouping:verify";
/** Every group name in the directory space starts with this. */
export const DIRECTORY_GROUP_PREFIX = "directory:";

/**
 * How long a grouping stands, from when its read STARTED, wherever it came from: the
 * same minute a server's own read has always had (`slot-cache.ts`), so the snapshot
 * extends nothing `docs/confirm-line.md` accepted about an admin's edit.
 */
export const POOL_GROUPING_FRESH_MS = 60_000;
/**
 * How long a confirm waits for the snapshot before keying on its code's own line.
 * #3325's measurement put a new object's first call at p95 323ms and worst 452ms cross
 * country, and an existing one under 105ms, so 500ms waits out a cold object and no
 * more. Every confirm that fetched records `grouping_fetch_ms`, so the next load run
 * measures this rather than taking it on trust (L172, L743).
 */
export const POOL_GROUPING_FETCH_MS = 500;
/**
 * How long a server's ONE fetch is waited on before it is given up, apart from each
 * confirm's own bound above. An answer that arrives after a confirm moved on still
 * installs, for the next confirm; one that never arrives must not hold the request that
 * started it (kept alive past its response so others can join it) until the platform
 * cuts it.
 */
export const POOL_GROUPING_FETCH_GIVE_UP_MS = 2_000;
/** How long a publish may take, the lane's or a server's own; neither has a lead waiting on it. */
export const POOL_GROUPING_PUBLISH_MS = 2_000;
/** How far in the future a snapshot's read time may be before it is refused. */
export const POOL_GROUPING_FUTURE_TOLERANCE_MS = 5_000;
/** The most entries a snapshot may carry: sixty today, and the object refuses more. */
export const POOL_GROUPING_MAX_ENTRIES = 500;
/** The longest code or digest an entry may carry, the object's string cap. */
const MAX_PART = 200;

/** One bucket code and its pool's digest. */
export type GroupingEntry = readonly [code: string, pool: string];

/** What the directory holds and a server installs. */
export interface GroupingSnapshot {
  format: number;
  /** When the read it came from STARTED, on the publishing server's clock. */
  readAtMs: number;
  /** How many entries it carries, so a truncated one is refused rather than read as gaps. */
  count: number;
  entries: GroupingEntry[];
}

/** One object, as a client talks to it: a JSON message in, a JSON answer out. */
export interface DirectoryStub {
  send(message: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * Every bucket code and its pool's digest, in code order, from the buckets grouped by
 * pool (`groupByPool`). The ONE derivation both routes use: a server's own read
 * installs these entries and the lane publishes them, so the two cannot disagree.
 */
export function groupingEntriesOf(groups: ReadonlyMap<string, readonly { code: string }[]>): GroupingEntry[] {
  const out: [string, string][] = [];
  for (const [poolKey, members] of groups) {
    const digest = poolKeyDigest(poolKey);
    for (const m of members) out.push([m.code, digest]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function groupingSnapshotOf(entries: readonly GroupingEntry[], readAtMs: number): GroupingSnapshot {
  return { format: POOL_GROUPING_FORMAT, readAtMs, count: entries.length, entries: entries.map(([c, p]) => [c, p] as const) };
}

export type SnapshotReading =
  | { kind: "snapshot"; snapshot: GroupingSnapshot }
  | { kind: "format-mismatch"; format: number }
  | { kind: "refused"; why: string };

const isPart = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= MAX_PART;

/**
 * A snapshot as it arrived, or why it cannot be one. `expectFormat` is the reader's own
 * format; the object passes null and judges the shape alone, so a build of another
 * format can still publish to its own instance.
 */
export function readGroupingSnapshot(raw: unknown, expectFormat: number | null): SnapshotReading {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "refused", why: "not a snapshot" };
  const s = raw as Record<string, unknown>;
  if (typeof s.format !== "number" || !Number.isInteger(s.format) || s.format < 1) return { kind: "refused", why: "no format" };
  if (expectFormat !== null && s.format !== expectFormat) return { kind: "format-mismatch", format: s.format };
  if (typeof s.readAtMs !== "number" || !Number.isFinite(s.readAtMs) || s.readAtMs <= 0) return { kind: "refused", why: "no read time" };
  if (!Array.isArray(s.entries)) return { kind: "refused", why: "no entries" };
  if (s.entries.length === 0) return { kind: "refused", why: "empty" };
  if (s.entries.length > POOL_GROUPING_MAX_ENTRIES) return { kind: "refused", why: "too many entries" };
  if (s.count !== s.entries.length) return { kind: "refused", why: `count ${String(s.count)} against ${s.entries.length} entries` };
  const seen = new Set<string>();
  const entries: GroupingEntry[] = [];
  for (const e of s.entries as unknown[]) {
    if (!Array.isArray(e) || e.length !== 2 || !isPart(e[0]) || !isPart(e[1])) return { kind: "refused", why: "an entry is not a code and a pool" };
    if (seen.has(e[0])) return { kind: "refused", why: "a code in two pools" };
    seen.add(e[0]);
    entries.push([e[0], e[1]]);
  }
  return { kind: "snapshot", snapshot: { format: s.format, readAtMs: s.readAtMs, count: entries.length, entries } };
}

/** Where a server's grouping came from. */
export type GroupingOrigin = "read" | "snapshot";

export interface GroupingStore {
  /** A code's pool digest, null for a code with no bucket, undefined when nothing fresh is held. */
  peek(code: string): string | null | undefined;
  /** What is held, fresh or not, or null when nothing ever was. */
  held(): { readAtMs: number; origin: GroupingOrigin } | null;
  fresh(): boolean;
  /** Install entries read at `readAtMs` only when newer than what is held. Answers whether it did. */
  install(entries: readonly GroupingEntry[], readAtMs: number, origin: GroupingOrigin): boolean;
  /** For tests: forget everything. */
  reset(): void;
}

/** One server's grouping: compare and set, newest wins, fresh for a minute from its read. */
export function makeGroupingStore(deps: { now: () => number; freshMs: number }): GroupingStore {
  let held: { readAtMs: number; byCode: Map<string, string>; origin: GroupingOrigin } | null = null;
  const fresh = () => held !== null && deps.now() - held.readAtMs <= deps.freshMs;
  return {
    peek(code) {
      if (!held || !fresh()) return undefined;
      return held.byCode.get(code) ?? null;
    },
    held() {
      return held ? { readAtMs: held.readAtMs, origin: held.origin } : null;
    },
    fresh,
    install(entries, readAtMs, origin) {
      // Never empty: an empty grouping would answer every code as a gap.
      if (entries.length === 0) return false;
      if (held && held.readAtMs >= readAtMs) return false;
      held = { readAtMs, byCode: new Map(entries.map(([c, p]) => [c, p])), origin };
      return true;
    },
    reset() {
      held = null;
    },
  };
}

/** The directory's messages, in its own version. */
export function groupingGetMessage(): Record<string, unknown> {
  return { dv: POOL_GROUPING_DIRECTORY_PROTOCOL, op: "grouping-get" };
}
export function groupingPutMessage(snapshot: GroupingSnapshot): Record<string, unknown> {
  return { dv: POOL_GROUPING_DIRECTORY_PROTOCOL, op: "grouping-put", snapshot };
}
/** The ops only the directory honours. */
export const GROUPING_OPS: ReadonlySet<string> = new Set(["grouping-get", "grouping-put"]);
/** Whether a message is the directory's rather than a line's. */
export function isGroupingMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const m = message as Record<string, unknown>;
  return "dv" in m || (typeof m.op === "string" && GROUPING_OPS.has(m.op));
}

/**
 * The directory, as its object runs it: the newest snapshot it was handed, memory only
 * like the line. A put is judged by its shape alone (never empty, never a count its
 * entries do not match) and kept only when newer than what is held; a get hands back
 * what is held, or null.
 */
export function makeGroupingDirectoryHost(): { handle(message: unknown): string } {
  let stored: GroupingSnapshot | null = null;
  const bad = (why: string) => JSON.stringify({ kind: "bad", why });
  return {
    handle(message) {
      if (!message || typeof message !== "object" || Array.isArray(message)) return bad("not a message");
      const m = message as Record<string, unknown>;
      if (m.dv !== POOL_GROUPING_DIRECTORY_PROTOCOL) return bad("directory version");
      if (m.op === "grouping-get") return JSON.stringify({ kind: "grouping", snapshot: stored });
      if (m.op === "grouping-put") {
        const read = readGroupingSnapshot(m.snapshot, null);
        if (read.kind !== "snapshot") return bad(read.kind === "refused" ? read.why : "format");
        if (stored && stored.readAtMs >= read.snapshot.readAtMs) return JSON.stringify({ kind: "kept", readAtMs: stored.readAtMs });
        stored = read.snapshot;
        return JSON.stringify({ kind: "stored", readAtMs: stored.readAtMs });
      }
      return bad("unknown directory op");
    },
  };
}

/** How a confirm's fetch of the snapshot ended. */
export type GroupingFetch =
  /** The server already held a fresh grouping, so nothing was fetched. */
  | "held"
  /** A fresh snapshot was fetched and installed. */
  | "installed"
  | "stale"
  | "timeout"
  /** The directory answered something no snapshot can be read from: malformed, empty, partial, or an older object's refusal. */
  | "refused"
  /** The directory holds no snapshot (a new instance before the lane's next publish). */
  | "absent"
  | "format-mismatch"
  /** The call to the directory failed. */
  | "unreachable"
  /** No binding: off the Workers runtime, or a deployment without the object. */
  | "unbound";

export interface GroupingReading {
  source: GroupingFetch;
  /** How long this confirm waited for it, or null when it did not fetch. */
  waitedMs: number | null;
  /** How old the snapshot it read was, when it read one. */
  ageMs: number | null;
}

/** What the coalesced fetch settles to, before a caller adds its own wait. */
type Fetched = { source: GroupingFetch; ageMs: number | null };

/**
 * Ensure this server holds a fresh grouping, from the directory when it does not.
 *
 * One fetch per server however many confirms ask at once, and each confirm waits at
 * most `boundMs` of its own. A fetch older than the bound is never joined: on the
 * platform, a fetch started by a request that has since ended can be left pending for
 * ever, and joining it would turn every later confirm on this server into a timeout.
 * Never rejects: every way of not getting a snapshot is a named reading.
 */
export function makeGroupingReader(deps: {
  store: GroupingStore;
  /** The directory's stub, resolved per fetch, or null when there is no binding. */
  directory: () => DirectoryStub | null;
  now: () => number;
  timer: ScheduleTimer;
  boundMs: number;
  freshMs: number;
  /** Told of every fetch it starts, so the live wiring keeps its invocation alive until it settles. */
  onFetchStarted?: (fetching: Promise<unknown>) => void;
}): { ensure(): Promise<GroupingReading> } {
  let inFlight: { startedAt: number; settled: Promise<Fetched> } | null = null;

  const fetchOnce = async (stub: DirectoryStub): Promise<Fetched> => {
    let failure: unknown = null;
    const answer = await readWithinDeadline(() => stub.send(groupingGetMessage()), POOL_GROUPING_FETCH_GIVE_UP_MS, (err) => (failure = err), deps.timer);
    if (answer === null) {
      const timedOut = failure instanceof Error && /no answer within/.test(failure.message);
      return { source: timedOut ? "timeout" : "unreachable", ageMs: null };
    }
    if (!answer || typeof answer !== "object" || answer.kind !== "grouping") return { source: "refused", ageMs: null };
    if (answer.snapshot === null || answer.snapshot === undefined) return { source: "absent", ageMs: null };
    const read = readGroupingSnapshot(answer.snapshot, POOL_GROUPING_FORMAT);
    if (read.kind === "format-mismatch") return { source: "format-mismatch", ageMs: null };
    if (read.kind === "refused") return { source: "refused", ageMs: null };
    const ageMs = deps.now() - read.snapshot.readAtMs;
    if (ageMs < -POOL_GROUPING_FUTURE_TOLERANCE_MS) return { source: "refused", ageMs };
    if (ageMs > deps.freshMs) return { source: "stale", ageMs };
    if (deps.store.install(read.snapshot.entries, read.snapshot.readAtMs, "snapshot")) return { source: "installed", ageMs };
    // Not newer than what is held: something fresher landed meanwhile (a warm up), so
    // the server holds a grouping at least this fresh.
    return { source: deps.store.fresh() ? "held" : "stale", ageMs };
  };

  return {
    async ensure() {
      const startedAt = deps.now();
      if (deps.store.fresh()) return { source: "held", waitedMs: null, ageMs: null };
      const stub = deps.directory();
      if (!stub) return { source: "unbound", waitedMs: null, ageMs: null };
      let joined = inFlight;
      if (!joined || startedAt - joined.startedAt > deps.boundMs) {
        // Never rejects: a fault in reading the answer is a failed call, said as one.
        const settled = fetchOnce(stub).catch((): Fetched => ({ source: "unreachable", ageMs: null }));
        const mine = { startedAt, settled };
        inFlight = joined = mine;
        void settled.then(() => {
          if (inFlight === mine) inFlight = null;
        });
        deps.onFetchStarted?.(settled);
      }
      const fetching = joined.settled;
      const got = await readWithinDeadline(() => fetching, deps.boundMs, () => {}, deps.timer);
      const waitedMs = deps.now() - startedAt;
      if (got === null) return { source: "timeout", waitedMs, ageMs: null };
      return { source: got.source, waitedMs, ageMs: got.ageMs };
    },
  };
}

/** What a confirm's `confirm answered` line says about where its line key's grouping came from. */
export type LineGroupSource =
  | "local"
  | "snapshot"
  | "own-code-missing"
  | "not-asked"
  | Exclude<GroupingFetch, "held" | "installed">;

/**
 * The source a confirm records, decided when its key is built. A ladder group names
 * where the grouping it came from was read; no ladder names why: the grouping did not
 * list the confirm's own code, or the fetch's own reading, or `stale` for a grouping
 * that was fresh when the confirm began and expired before its key.
 */
export function lineGroupSourceOf(
  read: { group: string } | { group: null; why: "unknown-rung" | "own-code-missing" },
  held: { origin: GroupingOrigin } | null,
  fetched: GroupingReading | null,
): LineGroupSource {
  if (read.group !== null) return held?.origin === "snapshot" ? "snapshot" : "local";
  if (read.why === "own-code-missing") return "own-code-missing";
  if (fetched === null) return "not-asked";
  if (fetched.source === "held" || fetched.source === "installed") return "stale";
  return fetched.source;
}
