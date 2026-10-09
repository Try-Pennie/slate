/**
 * The pool grouping a server holds to key its confirm line, and the bounded read that
 * fills it from the snapshot the recompute lane publishes (#3460).
 *
 * A server whose grouping is absent or stale fetches the snapshot (`pool-grouping.ts`),
 * once however many confirms ask, under a short bound, and installs it under the
 * snapshot's own read time, so the freshness bound is the same minute a local read has.
 * #3355 already decided a confirm may wait, within a short bound, for the grouping before
 * its line key (items 1 and 2, which this supersedes); before that, a confirm never read
 * anything before its line.
 *
 * Every refusal leaves the confirm on its code's own line, today's behaviour, because
 * over grouping is the one failure this must not have:
 *
 * - a snapshot older than the freshness window is refused (L614): the lane stamps the
 *   read's START, so in each minute's gap between one snapshot expiring and the next
 *   landing, a cold server keeps its code line and says `stale`;
 * - an empty, partial, malformed or other format snapshot is refused by
 *   `readGroupingSnapshot` (L215, L1013);
 * - a snapshot older than what the server holds is not installed, and nor is a local
 *   read older than an installed snapshot: compare and set, newest wins (L751, L443).
 *   The read times come from different servers' clocks, which a Worker keeps close; a
 *   snapshot stamped further than `POOL_GROUPING_FUTURE_TOLERANCE_MS` in the future is
 *   refused, because installing it would keep the grouping fresh past its minute.
 *
 * Pure apart from what it is handed, relative imports only, so the node suites drive it.
 */
import {
  POOL_GROUPING_FORMAT,
  POOL_GROUPING_FUTURE_TOLERANCE_MS,
  groupingGetMessage,
  readGroupingSnapshot,
  type DirectoryStub,
  type GroupingEntry,
} from "./pool-grouping.ts";
import { readWithinDeadline, NoAnswerWithinError, type ScheduleTimer } from "../read-within-deadline.ts";

/**
 * How long a grouping stands, from when its read STARTED, wherever it came from: the
 * same minute a server's own read has always had (`slot-cache.ts`), so the snapshot
 * extends nothing `docs/confirm-line.md` accepted about an admin's edit.
 */
export const POOL_GROUPING_FRESH_MS = 60_000;
/**
 * How long a confirm waits for the snapshot before keying on its code's own line,
 * counted from when it reaches its line key; the fetch itself began at authentication,
 * so the work in between overlaps it for free. #3325's measurement put a new object's first call at p95 323ms and worst 452ms cross
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
/** How far in the future a snapshot's read time may be before it is refused: the directory's own bound, one constant (#3483). */
export { POOL_GROUPING_FUTURE_TOLERANCE_MS };
/**
 * How long a server waits, after a fetch that installed nothing, before it fetches again.
 * The fetch starts as soon as a confirm's key authenticates, before the per key and per
 * address ceilings answer, so a caller with a good key over its ceiling starts it too.
 * Without this, a directory with nothing usable to hand back (a new instance, a lane
 * that has stopped publishing) would cost one call per request for as long as the flood
 * lasted. With it, the cost is per SERVER: at most one fetch a second while the directory
 * has nothing, and none while the grouping is fresh. A second is short beside the
 * minute a grouping stands, so a snapshot published meanwhile is picked up a second
 * later at worst.
 */
export const POOL_GROUPING_RETRY_MS = 1_000;

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

/** How a confirm's fetch of the snapshot ended. */
export type GroupingFetch =
  /** The server already held a fresh grouping, so nothing was fetched. */
  | "held"
  /** A fresh snapshot was fetched and installed. */
  | "installed"
  /**
   * #3529: the directory had nothing fresh, so this server read the grouping itself and
   * installed it, inside the confirm's wait (`readOwn`).
   */
  | "read"
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
  | "unbound"
  /** A fetch found nothing usable less than `POOL_GROUPING_RETRY_MS` ago, so this confirm did not ask again. */
  | "backoff";

export interface GroupingReading {
  source: GroupingFetch;
  /**
   * How long this confirm itself waited for it, counted from when it needed the
   * grouping (`wait`), never from when the fetch was started; null when it did not fetch.
   */
  waitedMs: number | null;
  /** How old the snapshot it read was, when it read one. */
  ageMs: number | null;
}

/** What the coalesced fetch settles to, before a caller adds its own wait. */
type Fetched = { source: GroupingFetch; ageMs: number | null };

/**
 * A fetch begun early (#3460's prelude) and not yet waited on: either already decided,
 * because the server holds a fresh grouping or did not ask, or a fetch in flight.
 */
export type GroupingStart = { decided: GroupingReading } | { fetching: Promise<Fetched> };

/**
 * Ensure this server holds a fresh grouping, from the directory when it does not.
 *
 * `start` begins the fetch and `wait` waits for it; `ensure` is both at once. They are
 * apart so a confirm can start the fetch at authentication and wait only where it needs
 * the grouping, before its line key, with the bound counted from THERE (review of #3471,
 * L440): counted from the start, slow ceilings and a slow body read would spend it
 * before the confirm reached its line, and it would key by code with the answer on its
 * way.
 *
 * One fetch per server however many confirms ask at once, and each confirm waits at
 * most `boundMs` of its own. A fetch older than the bound is never joined: on the
 * platform, a fetch started by a request that has since ended can be left pending for
 * ever, and joining it would turn every later confirm on this server into a timeout.
 * After a fetch that installed nothing, none is started for `retryMs`, so the calls a
 * server makes are bounded by the clock and never by how many requests arrive.
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
  /** How long after a fetch that installed nothing before another is started. */
  retryMs: number;
  /** Told of every fetch it starts, so the live wiring keeps its invocation alive until it settles. */
  onFetchStarted?: (fetching: Promise<unknown>) => void;
  /**
   * #3529: this server's own read of the grouping, installing it into `store`, coalesced
   * however many ask and rejecting when it fails (`warmPoolKeys`). Run as soon as the
   * directory answers with nothing fresh, so a confirm in the minute's gap between one
   * snapshot expiring and the next landing keys by ladder rather than by code. It is the
   * read a server already made after the response; started here, it is the same read,
   * earlier, and a local read's own minute bounds it, so it extends no staleness.
   */
  readOwn?: () => Promise<void>;
}): { start(): GroupingStart; wait(started: GroupingStart): Promise<GroupingReading>; ensure(): Promise<GroupingReading> } {
  let inFlight: { startedAt: number; settled: Promise<Fetched> } | null = null;
  // When the last fetch that installed nothing settled, or null after one that did.
  let fruitlessAt: number | null = null;

  const fetchOnce = async (stub: DirectoryStub): Promise<Fetched> => {
    let failure: unknown = null;
    const answer = await readWithinDeadline(() => stub.send(groupingGetMessage()), POOL_GROUPING_FETCH_GIVE_UP_MS, (err) => (failure = err), deps.timer);
    if (answer === null) {
      return { source: failure instanceof NoAnswerWithinError ? "timeout" : "unreachable", ageMs: null };
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

  const start = (): GroupingStart => {
    const startedAt = deps.now();
    if (deps.store.fresh()) return { decided: { source: "held", waitedMs: null, ageMs: null } };
    const stub = deps.directory();
    if (!stub) return { decided: { source: "unbound", waitedMs: null, ageMs: null } };
    let joined = inFlight;
    if (!joined || startedAt - joined.startedAt > deps.boundMs) {
      if (fruitlessAt !== null && startedAt - fruitlessAt < deps.retryMs) return { decided: { source: "backoff", waitedMs: null, ageMs: null } };
      // Never rejects: a fault in reading the answer is a failed call, said as one.
      const settled = fetchOnce(stub)
        .catch((): Fetched => ({ source: "unreachable", ageMs: null }))
        .then(async (got): Promise<Fetched> => {
          if (got.source === "installed" || got.source === "held" || !deps.readOwn) return got;
          try {
            await deps.readOwn();
          } catch {
            return got;
          }
          const held = deps.store.held();
          return deps.store.fresh() && held ? { source: "read", ageMs: deps.now() - held.readAtMs } : got;
        });
      const mine = { startedAt, settled };
      inFlight = joined = mine;
      void settled.then((got) => {
        if (inFlight === mine) inFlight = null;
        fruitlessAt = got.source === "installed" || got.source === "held" || got.source === "read" ? null : deps.now();
      });
      deps.onFetchStarted?.(settled);
    }
    return { fetching: joined.settled };
  };

  const wait = async (started: GroupingStart): Promise<GroupingReading> => {
    if ("decided" in started) return started.decided;
    const waitingFrom = deps.now();
    const fetching = started.fetching;
    const got = await readWithinDeadline(() => fetching, deps.boundMs, () => {}, deps.timer);
    const waitedMs = deps.now() - waitingFrom;
    if (got === null) return { source: "timeout", waitedMs, ageMs: null };
    return { source: got.source, waitedMs, ageMs: got.ageMs };
  };

  return { start, wait, ensure: () => wait(start()) };
}

/** What a confirm's `confirm answered` line says about where its line key's grouping came from. */
export type LineGroupSource =
  | "local"
  | "snapshot"
  | "own-code-missing"
  | "not-asked"
  | Exclude<GroupingFetch, "held" | "installed" | "read">;

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
  if (fetched.source === "held" || fetched.source === "installed" || fetched.source === "read") return "stale";
  return fetched.source;
}
