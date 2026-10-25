/**
 * 60-second cross-invocation cache for eligibleAgentIds (#421).
 *
 * Use ONLY in monitoring/precompute cron lanes so every lane in a tick shares
 * one eligibility read per bucket rather than each re-querying the DB.
 *
 * The live booking path (booking/orchestration.ts) and routing API
 * (resolveRouting in service.ts) do NOT use this; they always call
 * eligibleAgentIds directly so a stale cache can never mis-route a real booking.
 *
 * Every entry records WHEN its answer was read (#3388), because a cached list
 * is only as fresh as that read, not as the moment somebody uses it. The
 * recompute lane stamps its slot rows from it, so a row built from a list read
 * 50 seconds ago cannot overwrite a row a live path wrote 20 seconds ago (L751).
 *
 * Best-effort: any cache read/write failure falls through to the live
 * computation. Never throws.
 */

import type { Bucket } from "@/lib/db/types";
import { appUrl } from "@/lib/env";
import { eligibleAgentIds, type EligibleAgents, type EligibleResolver } from "./service.ts";
import { eligibleCacheKey, ELIGIBLE_TTL_SECONDS } from "./eligible-cache-key.ts";

export { eligibleCacheKey, ELIGIBLE_TTL_SECONDS } from "./eligible-cache-key.ts";

type CfCache = {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
};

function eligibleCache(): CfCache | null {
  return (
    (globalThis as unknown as { caches?: { default?: CfCache } }).caches?.default ?? null
  );
}

function keyRequest(bucketId: string): Request {
  return new Request(
    `${appUrl()}/__eligible-cache/${encodeURIComponent(eligibleCacheKey(bucketId))}`,
  );
}

/** The cached shape. It also carried whether a legal restriction had been dropped
 *  to find the pool (#2158), which #2218 removed along with the criterion that
 *  made a widening possible. */
type EligibleResult = EligibleAgents;

/** A bucket's eligible agents together with when that answer was read from the
 *  database (#3388). For a cache hit that is the original read, not the hit. */
export interface EligibleRead {
  agents: EligibleResult;
  /** Epoch ms at which the live read that produced `agents` BEGAN. */
  readAtMs: number;
}

/** A resolver that also says when its answer was read. */
export type DatedEligibleResolver = (bucket: Bucket) => Promise<EligibleRead>;

/**
 * The stored entry, or null when it cannot be read as one. An entry this code
 * cannot date is a MISS, never an answer with an invented read time: guessing
 * the time would put the guess into the slot row's stamp (L50, L11).
 */
function parseEntry(text: string): EligibleRead | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { agents, readAtMs } = raw as { agents?: unknown; readAtMs?: unknown };
  if (typeof readAtMs !== "number" || !Number.isFinite(readAtMs)) return null;
  if (!agents || typeof agents !== "object" || !Array.isArray((agents as { ids?: unknown }).ids)) {
    return null;
  }
  return { agents: agents as EligibleResult, readAtMs };
}

/**
 * Eligible agents for `bucket` and when they were read, served from the
 * 60-second Cloudflare Cache API when available, falling through to the live DB
 * read on a miss, an unreadable entry, or in test/non-Worker environments where
 * `caches.default` is absent.
 *
 * On a live read the time is taken BEFORE the resolver runs: the answer was true
 * at some instant during the read, and the start is the older, so the safe, end.
 *
 * @param opts.resolver - Injectable live resolver; defaults to the real DB call.
 * @param opts.nowMs - Injectable clock, so a test can date the read.
 */
export async function readEligibleCached(
  bucket: Bucket,
  opts: { resolver?: EligibleResolver; nowMs?: () => number } = {},
): Promise<EligibleRead> {
  const resolver = opts.resolver ?? eligibleAgentIds;
  const nowMs = opts.nowMs ?? Date.now;
  const cache = eligibleCache();

  if (cache) {
    try {
      const hit = await cache.match(keyRequest(bucket.id));
      if (hit) {
        const entry = parseEntry(await hit.text());
        // Past its lifetime is a miss even if the platform served it (#3388): the
        // lane's rows may sit at most one lifetime before their compute's start, and
        // the scheduling anchor (`scheduleAnchorMs`) relies on that bound.
        if (entry && nowMs() - entry.readAtMs <= ELIGIBLE_TTL_SECONDS * 1000) return entry;
      }
    } catch {
      // Best-effort: a cache read error is not fatal; fall through to live.
    }
  }

  const readAtMs = nowMs();
  const agents = await resolver(bucket);
  const entry: EligibleRead = { agents, readAtMs };

  if (cache) {
    try {
      await cache.put(
        keyRequest(bucket.id),
        new Response(JSON.stringify(entry), {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${ELIGIBLE_TTL_SECONDS}`,
          },
        }),
      );
    } catch {
      // Best-effort: a cache write failure is silent.
    }
  }

  return entry;
}

/**
 * Eligible agents for `bucket` through the same cache, for a caller that does
 * not store anything stamped from the answer (the monitor lane's counts, the
 * empty window explanation). A caller that WRITES from it uses
 * `readEligibleCached`, so the read time reaches its stamp.
 *
 * @param resolver - Injectable live resolver; defaults to the real DB call.
 *                   Override in tests to avoid hitting the DB.
 */
export async function eligibleAgentIdsCached(
  bucket: Bucket,
  resolver: EligibleResolver = eligibleAgentIds,
): Promise<EligibleResult> {
  return (await readEligibleCached(bucket, { resolver })).agents;
}

/**
 * Wrap a dated resolver as the plain resolver the availability compute takes,
 * remembering the OLDEST read it handed out (#3388). A compute is only as fresh
 * as the oldest list it used, so that is the instant its rows may claim.
 *
 * `oldestReadAtMs` is null until something has been read, never a made up time.
 */
export function trackEligibleReads(read: DatedEligibleResolver): {
  resolve: EligibleResolver;
  oldestReadAtMs: () => number | null;
} {
  let oldest: number | null = null;
  return {
    resolve: async (bucket) => {
      const { agents, readAtMs } = await read(bucket);
      oldest = oldest === null ? readAtMs : Math.min(oldest, readAtMs);
      return agents;
    },
    oldestReadAtMs: () => oldest,
  };
}
