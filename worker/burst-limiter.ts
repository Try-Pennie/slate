/**
 * The shared request counter behind the edge limiters (#1536, #1556), and since #3416 behind the
 * booking API's exact hourly ceilings too.
 *
 * A Durable Object is the only primitive here that can hold ONE count for an address across
 * isolates and datacenters, which is exactly what Cloudflare's native rate limiter cannot do
 * and why a 60-request parallel burst sailed through a 30-a-minute ceiling.
 *
 * Deliberately a shell. All the arithmetic lives in `@/lib/rate-limit-burst`
 * (`readCounterRequest` and `applyCounterRequest`), because `worker/` is excluded from
 * `tsconfig.json`: anything decided in this file would be neither typechecked by the app nor
 * reachable from the vitest suites. What is left here is storage and a request envelope, and
 * `scripts/test-exact-ceiling.ts` drives this class itself with a fake storage.
 *
 * Two kinds of caller, in disjoint key spaces so no object ever holds both. The burst tracker
 * asks only about addresses that have already crossed the escalation threshold in some isolate,
 * so an ordinary lead's page load never reaches it. The exact ceilings (`exactCeilingKey`) send
 * one hit per booking API request, which replaced one `rate_limit_hit` round trip to Supabase
 * per request.
 */
import { applyCounterRequest, readCounterRequest } from "@/lib/rate-limit-burst";

interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAll(): Promise<void>;
}

interface DurableState {
  storage: DurableStorage;
}

const STORAGE_KEY = "window";

export class BurstLimiter {
  private readonly state: DurableState;
  /**
   * #3529: the window as last written, held between requests so a hit is decided with no
   * await between reading it and writing the next. `undefined` until this instance has read
   * storage once; `null` once it has and found nothing.
   */
  private window: { windowStartMs: number; count: number } | null | undefined = undefined;
  /** #3529: the alarm this instance last set, so it is moved only when it falls behind. */
  private alarmAtMs: number | null = null;
  /** The one storage read a fresh instance makes, shared by every request that needs it. */
  private loading: Promise<void> | null = null;

  constructor(state: DurableState) {
    this.state = state;
  }

  /**
   * `POST` with `{ bump }` (the burst tracker) or `{ hit: { windowMs } }` (an exact ceiling);
   * answers `{ count, windowStartMs }` for this object's current window, and a hit's answer also
   * names the window it counted.
   *
   * The alarm is what stops an object for a one-off flood living for ever: every write pushes a
   * deletion two windows out, so an address that stops being hot cleans itself up. Without it
   * the storage bill would grow with the number of addresses ever seen, which for an abuse
   * control is the number of attackers ever seen.
   *
   * The window is read from storage once per instance and then held in memory; from there to
   * writing the next one nothing is awaited at all, so no concurrent request can interleave
   * and every hit is counted exactly once, which is the property the exact ceilings rest on.
   * A request arriving while that one read is in flight awaits the same read.
   */
  async fetch(request: Request): Promise<Response> {
    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      // Read below as the burst tracker's unreadable report, which counts as one request
      // rather than as none: undercounting is the direction that favours a flood.
      body = null;
    }
    const asked = readCounterRequest(body);
    if (asked.kind === "unreadable") {
      // Nothing is counted for a hit whose window cannot be read. The caller reads the refusal
      // as an unreachable counter and fails open, loudly, as it does on any other failure.
      return Response.json({ error: asked.detail }, { status: 400 });
    }
    // #3529: a crowd of one caller's hits queued here at three awaited storage calls a hit
    // (load run 37854326187: 1.4 to 1.75s each for a hundred at once). Storage is read once
    // per instance; after that the window lives in memory, and everything from reading it to
    // writing the next is synchronous, so no request can interleave and each hit is counted
    // exactly once. The write is not awaited: the platform holds this response until it is
    // durable (the output gate) and coalesces a burst's writes into one, so an eviction
    // resumes from the last count answered.
    if (this.window === undefined) {
      // A read that fails is forgotten, so the next request reads again rather than every
      // later one awaiting the same rejection until the instance is evicted.
      this.loading ??= this.state.storage.get<{ windowStartMs: number; count: number }>(STORAGE_KEY).then(
        (got) => {
          if (this.window === undefined) this.window = got ?? null;
        },
        (err: unknown) => {
          this.loading = null;
          throw err;
        },
      );
      await this.loading;
    }
    const now = Date.now();
    const step = applyCounterRequest(this.window ?? null, asked, now);
    this.window = step.next;
    this.state.storage.put(STORAGE_KEY, step.next).catch(() => this.forget());
    // The alarm deletes an idle count. It is moved only when it would fire less than one
    // and a half windows after this hit, so it always fires between one and a half and two
    // windows after the last one: never while a window is open, and set about once a window
    // rather than once a hit.
    const window = step.alarmAtMs - now;
    if (this.alarmAtMs === null || this.alarmAtMs < now + 0.75 * window) {
      this.alarmAtMs = step.alarmAtMs;
      this.state.storage.setAlarm(step.alarmAtMs).catch(() => this.forget());
    }
    // The window is reported alongside the count for the verification command (#1564), which
    // proves the counter ANSWERS by reporting twice and requiring the count to rise. Two
    // reports either side of a boundary are two separate counts, and without the object saying
    // which window each belongs to the command would have to guess: either accusing a healthy
    // counter at the top of a minute, or forgiving a genuinely broken one as "probably a
    // rollover", which is the failure it exists to catch. The tracker on the hot path reads
    // only `count` and is unaffected.
    return Response.json(step.reply);
  }

  /**
   * A write or an alarm that failed: forget what this instance holds, so the next request
   * reads the stored count again and sets its alarm again rather than trusting either. The
   * reply that counted the lost hit is withheld by the platform's output gate, so no caller
   * was told a count that was never kept.
   */
  private forget(): void {
    this.window = undefined;
    this.loading = null;
    this.alarmAtMs = null;
  }

  /** Nothing has reported for two windows, so this address is no longer hot. */
  async alarm(): Promise<void> {
    this.window = null;
    this.alarmAtMs = null;
    await this.state.storage.deleteAll();
  }
}
