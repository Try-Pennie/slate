/**
 * The public placement probe (#4189): one ordinary public request per scheduled tick, sent
 * to the Worker's own custom domain, whose `cf-placement` is logged beside the lanes'.
 *
 * WHY. Since 2026-10-16 a rising share of ticks (6% on 10-17, 24% on 10-23) have their SELF
 * lanes come back `local-<colo>`: placement skipped, so the lanes ran wherever the cron fired,
 * far from the database. Public requests to slate.trypennie.app were placed beside the
 * database for every one of 21,475 database calls over the same week. The candidate fix is to
 * send each lane as a public request to the custom domain instead of over SELF, and Dan's
 * decision (2026-10-23) is to measure first: if a public request sent from `scheduled()` is
 * placed every time, the lanes move to that route. This module is that measurement and
 * nothing else; it is meant to be removed once the decision is made.
 *
 * WHAT IT SENDS. A GET to `/api/smoke/version` with no credential. The route refuses it with
 * a 401 at its bearer check and reads no table; the refusal is counted once in the bearer
 * failure throttle (`BEARER_FAILURE_LIMITER`, 60 a minute per address), which a probe a tick
 * stays far inside. The tick id rides in the query string so the probe's own invocation can
 * be found in the Worker's logs.
 *
 * WHAT IT MUST NOT DO is change anything about the lanes. It starts only after every lane has
 * been dispatched, it never throws, its outcome is awaited only after the lanes have settled,
 * and the tick's lane time (and so the cron budget line) is measured to the lanes' end. It
 * waits no longer than `PUBLIC_PROBE_TIMEOUT_MS` for headers, because while it waits it holds
 * one of the invocation's six connection slots, which the placed lanes' own fetches share
 * (Cloudflare: a Worker reached over a service binding shares the top level request's limit).
 * A seventh connection queues rather than fails, so the worst a dead route costs is a lane
 * fetch queued for a few seconds.
 *
 * WHAT CLOUDFLARE SAYS ABOUT THE ROUTE. The Custom Domains page says a custom domain "can be
 * invoked within the same zone via fetch()", but that section is about a DIFFERENT Worker
 * on the zone. For a Worker fetching its OWN hostname, the 522 troubleshooting page says it
 * "will cause a 522 error" unless `global_fetch_strictly_public` is on, and the flag's own
 * page says that without it a same zone fetch goes to the zone's origin, bypassing the
 * Workers on it. This Worker does not set that flag, so the documented outcome is a 522 (or a
 * 1042) with no `cf-placement`, which the probe records as `no_header` with the status and
 * the Cloudflare error code. That is itself the answer the measurement exists for.
 *
 * `worker/index.ts` cannot be imported by a test, so everything here takes its fetch, clock
 * and deadline as arguments and is driven by `scripts/test-public-placement-probe.ts`.
 */
import { ranNearDatabase } from "@/lib/monitor/lane-timing";
import { shortErrorReason } from "@/lib/notify/error-text";
import { CRON_ORIGIN, placementOf, readThrough } from "./lane-run";

/** The route probed: it answers without a credential, reads no table, and its answer still
 *  carries `cf-placement` (`curl -sI https://slate.trypennie.app/api/smoke/version` answered
 *  401 with `cf-placement: remote-SEA` on 2026-10-23). */
export const PUBLIC_PROBE_PATH = "/api/smoke/version";

/** How long the probe waits for response headers. A placed public request's headers arrive
 *  in well under a second; past this the route is not working, and the slot it holds is
 *  better given back. */
export const PUBLIC_PROBE_TIMEOUT_MS = 5_000;

/** How long the probe reads an answer's body, only to find a Cloudflare error code in it. */
export const PUBLIC_PROBE_BODY_MS = 1_000;

export type PublicProbeOutcome =
  | { kind: "skipped"; why: "loadtest" }
  | { kind: "answered"; status: number; placement: string | null; ms: number; cfError: string | null }
  | { kind: "timeout"; ms: number }
  | { kind: "threw"; ms: number; reason: string };

export interface PublicProbeDeps {
  /** The global fetch: a public request, never the SELF binding. */
  fetch(request: Request, init: { signal: AbortSignal }): Promise<Response>;
  now(): number;
  /** Resolves after `ms`; injected so a test never waits a deadline out (L524). */
  wait?: (ms: number) => Promise<void>;
}

/** The Cloudflare error code an error page names (`error code: 1042`, `Error code 522`). */
export function cloudflareErrorCode(body: string): string | null {
  const m = /\berror code:?\s*(\d{3,4})\b/i.exec(body);
  return m ? m[1]! : null;
}

/**
 * Send the probe. Never throws and never rejects: every way it can end is an outcome.
 *
 * The load test Worker has no domain (`routes: []` on `env.loadtest`), so a request to the
 * production host from it would measure production's routing, not its own; it sends nothing
 * and says it skipped.
 */
export function startPublicProbe(
  opts: { loadtest: boolean; tickId: string },
  deps: PublicProbeDeps,
): Promise<PublicProbeOutcome> {
  if (opts.loadtest) return Promise.resolve({ kind: "skipped", why: "loadtest" });
  const startedAt = deps.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = deps.wait
    ? deps.wait(PUBLIC_PROBE_TIMEOUT_MS)
    : new Promise<void>((resolve) => (timer = setTimeout(resolve, PUBLIC_PROBE_TIMEOUT_MS)));
  const headers = (async () => {
    const url = new URL(PUBLIC_PROBE_PATH, CRON_ORIGIN);
    url.searchParams.set("tick", opts.tickId);
    const request = new Request(url.toString(), {
      method: "GET",
      headers: { "user-agent": "slate-placement-probe" },
    });
    return deps.fetch(request, { signal: controller.signal });
  })();
  const raced = Promise.race([
    headers.then((res) => ({ res, ms: deps.now() - startedAt })),
    deadline.then(() => "deadline" as const),
  ]);
  return raced
    .then(async (won): Promise<PublicProbeOutcome> => {
      if (timer !== undefined) clearTimeout(timer);
      if (won === "deadline") {
        controller.abort();
        // The aborted fetch rejects; that rejection is the timeout already recorded.
        headers.catch(() => undefined);
        return { kind: "timeout", ms: deps.now() - startedAt };
      }
      const { res, ms } = won;
      const placement = placementOf(res.headers);
      // Read through either way, so the answer's body is let go; only a refusal that did
      // not come from the app's own bearer check can carry a Cloudflare error code.
      const body = await readThrough(res, PUBLIC_PROBE_BODY_MS, deps.wait);
      const cfError = res.status === 401 ? null : cloudflareErrorCode(body.text);
      return { kind: "answered", status: res.status, placement, ms, cfError };
    })
    .catch((err: unknown): PublicProbeOutcome => {
      if (timer !== undefined) clearTimeout(timer);
      return { kind: "threw", ms: deps.now() - startedAt, reason: shortErrorReason(err) };
    });
}

/**
 * The probe's fields on the `lane timings` line. `public_probe` holds the `cf-placement`
 * value raw (`remote-SEA`, `local-NRT`) when the answer carried one, and otherwise names the
 * outcome: `no_header`, `unreadable`, `timeout`, `threw` or `skipped_loadtest`. Never empty,
 * because an empty value reads as either answer.
 *
 * Deliberately NOT `public_probe_placement`: the #3731 alert reads every `<lane>_placement`
 * field on this line as a lane, and would count the probe as a far lane on every timeout.
 * `public_probe_near_db` is 1 or 0 on every tick that sent one, so it sums beside
 * `lanes_near_db`.
 */
export function publicProbeFields(outcome: PublicProbeOutcome): Record<string, string | number> {
  switch (outcome.kind) {
    case "skipped":
      return { public_probe: "skipped_loadtest" };
    case "timeout":
      return { public_probe: "timeout", public_probe_ms: Math.round(outcome.ms), public_probe_near_db: 0 };
    case "threw":
      return {
        public_probe: "threw",
        public_probe_ms: Math.round(outcome.ms),
        public_probe_near_db: 0,
        public_probe_error: outcome.reason,
      };
    case "answered":
      return {
        public_probe: outcome.placement ?? "no_header",
        public_probe_status: outcome.status,
        public_probe_ms: Math.round(outcome.ms),
        public_probe_near_db: ranNearDatabase(outcome.placement) ? 1 : 0,
        ...(outcome.cfError ? { public_probe_cf_error: outcome.cfError } : {}),
      };
  }
}

/**
 * Dispatch the tick's lanes, then start the probe beside them.
 *
 * The lanes go first, so every lane request is sent before the probe's; `lanesMs` is taken
 * when the lanes settle, so neither the lane time nor the cron budget line can include the
 * probe; and the probe's outcome is awaited only after that, bounded by its own deadline. A
 * probe that throws while starting, or rejects, is recorded as `threw` and the lanes'
 * outcomes are returned exactly as they settled.
 */
export function dispatchWithProbe<T>(
  runLanes: () => Promise<T>,
  startProbe: () => Promise<PublicProbeOutcome>,
  now: () => number,
): { lanesSettled: Promise<T>; done: Promise<{ lanes: T; lanesMs: number; probe: PublicProbeOutcome }> } {
  const startedAt = now();
  const lanesSettled = runLanes();
  const probeStartedAt = now();
  let probe: Promise<PublicProbeOutcome>;
  try {
    probe = startProbe().catch(
      (err: unknown): PublicProbeOutcome => ({ kind: "threw", ms: now() - probeStartedAt, reason: shortErrorReason(err) }),
    );
  } catch (err) {
    probe = Promise.resolve({ kind: "threw", ms: 0, reason: shortErrorReason(err) });
  }
  const done = lanesSettled.then(async (lanes) => {
    const lanesMs = now() - startedAt;
    return { lanes, lanesMs, probe: await probe };
  });
  return { lanesSettled, done };
}
