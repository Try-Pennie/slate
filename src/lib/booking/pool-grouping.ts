/**
 * The pool grouping snapshot, published to one place every server can reach (#3460).
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
 * with the time its read STARTED, to a reserved instance of the confirm line object (the
 * DIRECTORY), and any server's own read publishes too, as a backup. A server whose
 * grouping is absent or stale fetches it, bounded, before keying its confirm line
 * (`pool-grouping-reader.ts`). The publish is watched by its own heartbeat, and the
 * daily proof reads the live directory.
 *
 * OVER-GROUPING IS THE ONE FAILURE THIS MUST NOT HAVE. A leader's "full" verdict
 * settles only followers whose ladders walk the same pools, so a guessed group could
 * tell a lead a time is taken when it is not. So the snapshot is built to be refused
 * whenever it cannot be trusted:
 *
 * - an empty snapshot, or one whose count does not match its entries (a partial one),
 *   is refused by the object on the way in, and by `readGroupingSnapshot` for any reader
 *   on the way out (L215);
 * - a snapshot of another FORMAT is told apart from a malformed one (L1013). Production
 *   deploys are gradual, so for a while one build may read what another published; the
 *   directory's name carries the format, so two formats never share an instance, and
 *   the format inside the snapshot is the second guard;
 * - the directory keeps the newest snapshot it is handed, by the read time each carries
 *   (L751). Those times come from different servers' clocks, which a Worker keeps close.
 *
 * The entries are `[code, pool digest]` pairs, never a serialised Map (which is `{}`),
 * and a code is never looked up with a bracket on a plain object (L738).
 *
 * Pure apart from what it is handed, relative imports only, so the node suites drive
 * it: the snapshot and the directory's host.
 */
import { poolKeyDigest } from "./line-key.ts";

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

/** How long a publish may take; no lead waits on one. */
export const POOL_GROUPING_PUBLISH_MS = 2_000;
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
 * The object's own storage, as the directory uses it: the platform's `ctx.storage`
 * (SQLite backed since the v2 migration), whose `get` and `put` have exactly this shape.
 */
export interface GroupingDirectoryStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

/** The storage key the directory keeps its snapshot under. */
export const POOL_GROUPING_STORAGE_KEY = "pool-grouping-snapshot";

/**
 * The directory, as its object runs it: the newest snapshot it was handed. A put is judged
 * by its shape alone (never empty, never a count its entries do not match) and kept only
 * when newer than what is held; a get hands back what is held, or null.
 *
 * Held in the object's STORAGE, not only its memory (#3479). The platform hibernates an
 * idle object with no timers after ten seconds and discards its memory, and the lane
 * publishes once a minute, so a memory only directory was empty for most of every minute:
 * load run 37601024392's bursts each arrived 46 to 48 seconds after the last publish and
 * read nothing. A woken instance loads what storage holds once, judged by the same rules
 * as a put (L1013), before answering anything. A put writes storage BEFORE it answers
 * `stored`, and a write that fails is refused, so the publisher, which stamps its
 * heartbeat only on `stored`, is paged rather than believed. A read that fails is refused
 * too, never answered as an empty directory (L215).
 */
export function makeGroupingDirectoryHost(storage: GroupingDirectoryStorage): { handle(message: unknown): Promise<string> } {
  let stored: GroupingSnapshot | null = null;
  // One load per woken instance; a load that failed is forgotten so the next call tries
  // again.
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    const raw = await storage.get(POOL_GROUPING_STORAGE_KEY);
    const read = raw === undefined || raw === null ? null : readGroupingSnapshot(raw, null);
    stored = read?.kind === "snapshot" ? read.snapshot : null;
    loaded = true;
  };
  const bad = (why: string) => JSON.stringify({ kind: "bad", why });
  // One call at a time, so a put's check against what is held and its write can never
  // interleave with another put's. The platform's input gates already hold new calls while
  // the object awaits its storage; this does not lean on that (L82).
  let tail: Promise<unknown> = Promise.resolve();
  const one = async (message: unknown): Promise<string> => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return bad("not a message");
    const m = message as Record<string, unknown>;
    if (m.dv !== POOL_GROUPING_DIRECTORY_PROTOCOL) return bad("directory version");
    if (m.op !== "grouping-get" && m.op !== "grouping-put") return bad("unknown directory op");
    try {
      await load();
    } catch {
      return bad("directory storage could not be read");
    }
    if (m.op === "grouping-get") return JSON.stringify({ kind: "grouping", snapshot: stored });
    const read = readGroupingSnapshot(m.snapshot, null);
    if (read.kind !== "snapshot") return bad(read.kind === "refused" ? read.why : "format");
    if (stored && stored.readAtMs >= read.snapshot.readAtMs) return JSON.stringify({ kind: "kept", readAtMs: stored.readAtMs });
    try {
      await storage.put(POOL_GROUPING_STORAGE_KEY, read.snapshot);
    } catch {
      return bad("directory storage could not be written");
    }
    stored = read.snapshot;
    return JSON.stringify({ kind: "stored", readAtMs: read.snapshot.readAtMs });
  };
  return {
    handle(message) {
      const run = tail.then(() => one(message));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
