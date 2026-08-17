/**
 * Is the edge rate limiter usable in the deployed Worker? (#1529, from #1525)
 *
 * The hot path already reports a fail-open per request (`src/lib/rate-limit.ts`). That
 * report is an INCIDENT and is right to be: it is per IP, per datacenter, throttled to
 * bound a DB round-trip on a hot path, and one colo having a bad minute is a finished
 * event. What it cannot do is tell anybody the limiter is BACK.
 *
 * On 2026-08-17 `rate_limit_broken:availability` paged at 14:44 UTC and then went quiet,
 * and that quiet was produced by three unrelated things at once: a 30 minute cooldown, a
 * raise path that deliberately swallows its own failures, and nothing writing a recovery.
 * So a recovered limiter and a permanently broken one read identically from outside, which
 * is the property that teaches people to stop reading the channel (L36).
 *
 * This is the half that can say. It runs once a minute inside the deployed Worker, so it
 * measures the same predicate the request path uses, and it owns a CONDITION with an
 * all-clear hanging off a MEASURED success (#1151, #1134, #1152).
 *
 * It is also the second route behind the hot path's runtime gate. That gate stops a
 * `next dev` server paging the on-call, and its cost is that a wrong answer would silence
 * a genuine outage. This check is what would still notice, because it reports the runtime
 * marker it actually observed rather than trusting the documentation (L82).
 *
 * Three outcomes, never two. `unmeasured` is the one that matters: a tick that learned
 * nothing must not be scored as health (that is the blindness the whole detector family
 * is about, #1394) and must not be scored as a fault either, since that would page every
 * time this module ran anywhere but production.
 */

/** alert_state key for the condition. One key: the causes differ, the state does not. */
export const EDGE_LIMITER_KEY = "edge_limiter_unusable";

/** What one tick actually observed. Assembled by the caller, judged purely below. */
export interface EdgeLimiterReading {
  /** Whether this tick ran on the Cloudflare Workers runtime at all. */
  onWorkersRuntime: boolean;
  /**
   * The runtime marker we saw, REPORTED and never decided on. If Cloudflare ever stops
   * setting it, a production log line carrying the real value is what reveals that,
   * instead of every limiter alert quietly going silent with nothing to point at.
   */
  runtime: string | null;
  /**
   * Binding names found in the request env, or null when the env itself was unreadable.
   * Null is NOT the same as empty and NOT the same as unmeasured: on the Workers runtime,
   * inside a request handler, an unreadable context means no limiter is reachable for any
   * request being served, which is the fault itself.
   */
  presentBindings: string[] | null;
  /**
   * Did the limiter service answer when actually called? True for both an allowed and a
   * refused call, because a refusal is a working limiter. False means it threw. Null means
   * we never got as far as calling it.
   */
  serviceAnswered: boolean | null;
}

export type EdgeLimiterHealth =
  | { status: "unmeasured"; runtime: string | null; why: string }
  | { status: "healthy"; runtime: string | null; bindingCount: number }
  | {
      status: "unusable";
      runtime: string | null;
      /** Every binding the code expects and the deployment does not have. */
      missing: string[];
      /** The request context could not be read at all. */
      contextUnreadable: boolean;
      /** A binding resolved but the limiter service threw when called. */
      serviceUnreachable: boolean;
    };

/**
 * The verdict. Pure, so every branch including the two that must stay silent is driven
 * offline by `scripts/test-edge-limiter-health.ts`.
 */
export function edgeLimiterHealth(input: {
  expected: readonly string[];
  reading: EdgeLimiterReading;
}): EdgeLimiterHealth {
  const { reading } = input;

  if (!reading.onWorkersRuntime) {
    return {
      status: "unmeasured",
      runtime: reading.runtime,
      why:
        "this tick did not run on the Cloudflare Workers runtime, so there are no rate " +
        "limit bindings to inspect and nothing was measured either way",
    };
  }

  if (reading.presentBindings === null) {
    return {
      status: "unusable",
      runtime: reading.runtime,
      missing: [],
      contextUnreadable: true,
      serviceUnreachable: false,
    };
  }

  const present = new Set(reading.presentBindings);
  const missing = input.expected.filter((name) => !present.has(name));
  const serviceUnreachable = reading.serviceAnswered === false;

  if (missing.length > 0 || serviceUnreachable) {
    return {
      status: "unusable",
      runtime: reading.runtime,
      missing: [...missing],
      contextUnreadable: false,
      serviceUnreachable,
    };
  }

  return { status: "healthy", runtime: reading.runtime, bindingCount: present.size };
}

/** Plain-language names, so the page says which endpoint is unprotected rather than
 *  which internal binding is absent. The reader on call is not the person who named these. */
const ENDPOINT_NAMES: Record<string, string> = {
  AVAIL_RATE_LIMITER: "the public availability lookup",
  BOOKING_RATE_LIMITER: "the public booking confirm",
  ROUTING_RATE_LIMITER: "the routing lookup",
  BOOKINGAPI_RATE_LIMITER: "the booking API write path",
  BOOKINGAPI_IP_RATE_LIMITER: "the booking API per address backstop",
  BOOKINGAPI_READ_RATE_LIMITER: "the booking API read path",
};

function describe(names: string[]): string {
  const friendly = names.map((n) => ENDPOINT_NAMES[n] ?? n);
  if (friendly.length === 1) return friendly[0]!;
  const last = friendly[friendly.length - 1]!;
  return `${friendly.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * The Slack text, or "" when there is nothing to say. A builder rather than a literal at
 * the send site, so `pnpm preview:alerts` renders exactly what ships (L41).
 *
 * Each cause gets its own sentence and its own remedy, because they are not the same job:
 * a missing binding is a deploy, an unreadable context is a code fault, and a service that
 * throws is Cloudflare's side. One shared sentence would send the reader to the wrong
 * place two times out of three (L11, L111).
 */
export function formatEdgeLimiterUnusableAlert(health: EdgeLimiterHealth): string {
  if (health.status !== "unusable") return "";

  // The impact sentence has to AGREE with the case. An earlier draft shared one plural
  // sentence across every branch, so a single missing binding read as "those endpoints are
  // open to unlimited traffic" while five of the six were fine, which overstates the fault
  // and is the kind of mismatch only a cold read of the rendered line catches (L21, L118).
  const everything = health.contextUnreadable || health.serviceUnreachable;
  const impact = everything
    ? "So no public endpoint has a ceiling right now, and a single source can send any of " +
      "them unlimited traffic."
    : health.missing.length > 1
      ? "While this lasts those endpoints have no ceiling at all, so a single source can " +
        "send them unlimited traffic."
      : "While this lasts that endpoint has no ceiling at all, so a single source can send " +
        "it unlimited traffic.";
  // Say plainly that nothing is broken for a customer. Without it the reader reasonably
  // assumes bookings are failing and treats it as a page to drop everything for.
  const notBroken =
    "Nothing is failing for a real customer, which is why this is quiet from every other " +
    "angle.";

  if (health.contextUnreadable) {
    return (
      "The running Worker cannot read its own request context, so every rate limit binding " +
      `is unreachable. ${impact} ` +
      `${notBroken} This is a code or platform fault rather than a configuration one, so ` +
      "redeploying the current build is the first thing to try, and the server logs under " +
      "tag=edge-limiter carry the runtime it observed."
    );
  }

  if (health.missing.length > 0 && health.serviceUnreachable) {
    return (
      `The request ceiling on ${describe(health.missing)} is missing from the running ` +
      "deployment, and the rate limit service also refused a test call, so more than one " +
      `thing is wrong at once. ${impact} ${notBroken} Check the ratelimits block in ` +
      "wrangler.jsonc against the bindings the deployed version reports, then redeploy."
    );
  }

  if (health.missing.length > 0) {
    const plural = health.missing.length > 1;
    return (
      `The request ${plural ? "ceilings" : "ceiling"} on ${describe(health.missing)} ` +
      `${plural ? "are" : "is"} missing from the running deployment. ${impact} ` +
      `${notBroken} The bindings are declared in the ratelimits block of wrangler.jsonc, ` +
      `so this is a deploy that shipped without ${plural ? "them" : "it"}: compare that ` +
      "block against what the deployed version reports and redeploy."
    );
  }

  return (
    "The rate limit service refused a test call, so the request ceilings are present but " +
    `not answering. ${impact} ${notBroken} This is on Cloudflare's side rather than ours, ` +
    "so check their status page before redeploying anything."
  );
}

/** The all-clear. A builder for the same reason as the alert above (L41). */
export function formatEdgeLimiterRecovery(): string {
  return (
    "The request rate limits are being enforced again. Every ceiling is present in the " +
    "running deployment and the rate limit service answered a test call."
  );
}

/**
 * The monitor-cron step. IO is injected so all three outcomes, including the two that must
 * send nothing, are exercised offline.
 *
 * The all-clear hangs off a MEASURED healthy result and nothing else: a tick that could
 * not read the runtime or the bindings clears nothing, because it learned nothing
 * (#1134, #1152).
 */
export async function runEdgeLimiterCheck(deps: {
  expected: readonly string[];
  read: () => Promise<EdgeLimiterReading>;
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  // Promise<unknown>: resolveAlert reports whether it settled anything and this check
  // does not branch on that, so the dep accepts either shape.
  resolve: (key: string, text: string) => Promise<unknown>;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<EdgeLimiterHealth> {
  // A throwing read is unmeasured, not a fault: it is caught here rather than left to the
  // step boundary so the check still returns a typed verdict the lane can report, instead
  // of the step's own fallback standing in for one.
  let reading: EdgeLimiterReading | null;
  try {
    reading = await deps.read();
  } catch {
    reading = null;
  }

  const health: EdgeLimiterHealth =
    reading === null
      ? {
          status: "unmeasured",
          runtime: null,
          why: "the request context could not be inspected at all this tick",
        }
      : edgeLimiterHealth({ expected: deps.expected, reading: reading });

  if (health.status === "unmeasured") {
    deps.log?.(`monitor edge-limiter: unmeasured, ${health.why}`);
    return health;
  }

  if (health.status === "unusable") {
    await deps
      .notify(EDGE_LIMITER_KEY, deps.cooldownMs, formatEdgeLimiterUnusableAlert(health))
      .catch(() => {});
    deps.log?.(
      `monitor edge-limiter: UNUSABLE runtime=${health.runtime ?? "unknown"} ` +
        `missing=${health.missing.length} contextUnreadable=${health.contextUnreadable} ` +
        `serviceUnreachable=${health.serviceUnreachable}`,
    );
    return health;
  }

  await deps.resolve(EDGE_LIMITER_KEY, formatEdgeLimiterRecovery()).catch(() => {});
  // The runtime marker is logged on the HEALTHY path too, deliberately. It is the only
  // place the assumption behind the hot path's gate can be read back off production.
  deps.log?.(
    `monitor edge-limiter: healthy runtime=${health.runtime ?? "unknown"} ` +
      `bindings=${health.bindingCount}`,
  );
  return health;
}
