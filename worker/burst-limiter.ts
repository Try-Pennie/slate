/**
 * The shared per-address request counter behind `/api/availability` (#1536).
 *
 * A Durable Object is the only primitive here that can hold ONE count for an address across
 * isolates and datacenters, which is exactly what Cloudflare's native rate limiter cannot do
 * and why a 60-request parallel burst sailed through a 30-a-minute ceiling.
 *
 * Deliberately a shell. All the arithmetic lives in `@/lib/rate-limit-burst`
 * (`bumpSharedWindow`), because `worker/` is excluded from `tsconfig.json` and is reachable
 * from neither test harness: anything decided in this file would be neither typechecked nor
 * tested. What is left here is storage and a request envelope.
 *
 * It is asked only about addresses that have already crossed the escalation threshold in some
 * isolate, so an ordinary lead's page load never reaches it and the hot path keeps its
 * no-round-trip property.
 */
import { bumpSharedWindow, BURST_WINDOW_MS } from "@/lib/rate-limit-burst";

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

  constructor(state: DurableState) {
    this.state = state;
  }

  /**
   * `POST` with `{ bump }`; answers `{ count }` for this address's current window.
   *
   * The alarm is what stops an object for a one-off flood living for ever: every write pushes a
   * deletion two windows out, so an address that stops being hot cleans itself up. Without it
   * the storage bill would grow with the number of addresses ever seen, which for an abuse
   * control is the number of attackers ever seen.
   */
  async fetch(request: Request): Promise<Response> {
    let bump = 1;
    try {
      const body = (await request.json()) as { bump?: unknown };
      if (typeof body?.bump === "number") bump = body.bump;
    } catch {
      // A body we cannot read counts as one request rather than as none: undercounting is the
      // direction that favours a flood.
      bump = 1;
    }
    const stored =
      (await this.state.storage.get<{ windowStartMs: number; count: number }>(STORAGE_KEY)) ??
      null;
    const next = bumpSharedWindow(stored, bump, Date.now());
    await this.state.storage.put(STORAGE_KEY, next);
    await this.state.storage.setAlarm(Date.now() + 2 * BURST_WINDOW_MS);
    return Response.json({ count: next.count });
  }

  /** Nothing has reported for two windows, so this address is no longer hot. */
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
