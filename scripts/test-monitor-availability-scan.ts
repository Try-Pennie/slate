// The availability-scan ORCHESTRATION (#1158): the glue that was inline in the
// monitor route. The pieces it composes (classifyEmptyBuckets, classifyDeadEndCause,
// reportAvailabilityHealth, selfHealDataAnomalies) each have their own suite; this
// one pins the decisions the composition makes end to end: what pages, what
// whispers, what self-heals, and what stays silent when the scan could not look.
// Run: node --experimental-strip-types scripts/test-monitor-availability-scan.ts
import {
  runAvailabilityScan,
  BOOKED_SOLID_INFO_KEY,
  FALLBACK_COVERED_INFO_KEY,
  type ScanBucket,
} from "../src/lib/monitor/availability-scan.ts";
import { DATA_ANOMALY_ALERT_KEY } from "../src/lib/monitor/availability-health.ts";
import { assert, finish } from "./lib/harness.ts";

const NOW = Date.UTC(2026, 5, 23, 18, 0, 0); // a Tuesday 14:00 ET
const FRESH_WINDOW_MS = 6 * 60_000;
/** A rule set that has an agent on shift at NOW in America/New_York. */
const ON_SHIFT = { timezone: "America/New_York", rules: [{ weekday: 2, start_minute: 8 * 60, end_minute: 20 * 60 }] };
const OFF_SHIFT = { timezone: "America/New_York", rules: [] };

/** One configurable fake world. Each bucket config declares its slot count,
 *  eligible agents, whether they are on shift, and what a live recompute finds. */
function harness(config: {
  buckets: Record<
    string,
    {
      slotCount?: number; // default 0
      computedAgoMs?: number; // default 60s (fresh)
      noRow?: boolean; // no cached bucket_slots row at all
      eligible?: number; // eligible agent count, default 1
      onShift?: boolean; // default true
      isTest?: boolean;
      recompute?: number | null; // live recompute count; null = fails; default 0
      recomputeThrows?: boolean;
    }
  >;
  ladder?: Record<string, string[]>;
  claimDenied?: string[]; // codes whose self-heal window is already used
  healThrows?: string[];
  deadlineMs?: number;
  infoThrows?: boolean;
}) {
  const notified: { key: string; text: string }[] = [];
  const infoed: { key: string; text: string }[] = [];
  const resolved: string[] = [];
  const healed: string[] = [];
  const healErrors: string[] = [];

  const codes = Object.keys(config.buckets);
  const buckets: ScanBucket[] = codes.map((code) => ({
    code,
    isTest: config.buckets[code].isTest ?? false,
  }));
  const slotByCode = new Map(
    codes
      .filter((c) => !config.buckets[c].noRow)
      .map((c) => [
        c,
        {
          slotCount: config.buckets[c].slotCount ?? 0,
          computedAtMs: NOW - (config.buckets[c].computedAgoMs ?? 60_000),
        },
      ]),
  );

  const run = () =>
    runAvailabilityScan({
      nowMs: NOW,
      freshWindowMs: FRESH_WINDOW_MS,
      probeConcurrency: 2,
      // The deadline is judged against the REAL clock inside mapWithConcurrency,
      // not against the synthetic nowMs used for shift/freshness math, so an
      // un-truncated run needs real-now headroom (and the truncation case uses 0).
      deadlineMs: config.deadlineMs ?? Date.now() + 120_000,
      buckets,
      slotByCode,
      ladder: (code) => config.ladder?.[code] ?? [code],
      nameOf: (code) => `Tier ${code}`,
      eligibleIds: async (code) => {
        const n = config.buckets[code].eligible ?? 1;
        return Array.from({ length: n }, (_, i) => `${code}-agent-${i}`);
      },
      shiftFor: (userId) => {
        const code = userId.split("-agent-")[0];
        return (config.buckets[code].onShift ?? true) ? ON_SHIFT : OFF_SHIFT;
      },
      recomputeSlots: async (code) => {
        if (config.buckets[code].recomputeThrows) throw new Error("recompute boom");
        // Explicit undefined check, not `??`: a configured null means "the
        // recompute failed" and must reach the scan as null, not collapse to 0.
        const count = config.buckets[code].recompute;
        return count === undefined ? 0 : count;
      },
      claimHeal: async (code) => !(config.claimDenied ?? []).includes(code),
      heal: async (code) => {
        if ((config.healThrows ?? []).includes(code)) throw new Error("heal boom");
        healed.push(code);
      },
      onHealError: (code) => healErrors.push(code),
      notify: async (key, _cooldownMs, text) => {
        notified.push({ key, text });
      },
      info: async (key, _cooldownMs, text) => {
        if (config.infoThrows) throw new Error("slack down");
        infoed.push({ key, text });
      },
      resolve: async (key) => {
        resolved.push(key);
        return true;
      },
      cooldownMs: { dataAnomaly: 60_000, bookedSolid: 60_000, fallbackCovered: 60_000 },
      log: () => {},
    });

  return { run, notified, infoed, resolved, healed, healErrors };
}

// A healthy tick (buckets showing times): nothing pages, the outstanding
// data-anomaly page is all-cleared.
{
  const h = harness({ buckets: { "411": { slotCount: 5 } } });
  const res = await h.run();
  assert(res.page.length === 0, "a bucket with slots is not a dead-end");
  assert(h.notified.length === 0, "a healthy tick pages nothing");
  assert(
    h.resolved[0] === DATA_ANOMALY_ALERT_KEY && res.cleared,
    "a healthy complete scan all-clears the data-anomaly page",
  );
}

// A data anomaly (cache empty, live recompute finds times): pages, self-heals,
// and the page still fires AFTER the heal so the root cause is not masked.
{
  const h = harness({ buckets: { "411": { recompute: 4 } } });
  const res = await h.run();
  assert(res.cause.dataAnomaly[0] === "411", "cache empty but recompute found times is a data anomaly");
  assert(h.healed[0] === "411" && res.selfHeal.healed[0] === "411", "the anomaly bucket is self-healed");
  assert(h.notified[0]?.key === DATA_ANOMALY_ALERT_KEY, "the anomaly still pages after the heal");
  assert(h.notified[0]?.text.includes("411") === true, "the page names the bucket");
  assert(h.resolved.length === 0, "a paging tick does not also all-clear");
}

// Booked solid (recompute agrees with the empty cache): a quiet info whisper,
// never a page, and it does NOT hold the anomaly page open.
{
  const h = harness({ buckets: { "411": { recompute: 0 } } });
  const res = await h.run();
  assert(res.cause.bookedSolid[0] === "411", "recompute agreeing with empty cache is booked solid");
  assert(h.notified.length === 0, "booked solid never pages");
  assert(h.infoed[0]?.key === BOOKED_SOLID_INFO_KEY, "booked solid whispers on the info channel");
  assert(h.resolved.length === 1, "a booked-solid week does not suppress the all-clear");
  assert(h.healed.length === 0, "booked solid is not healed: there is nothing to rewrite");
}

// A failed recompute: unverified, which PAGES (erring toward flagging) and is
// never healed (we do not rewrite a cache off an answer we do not have).
{
  const h = harness({ buckets: { "411": { recompute: null } } });
  const res = await h.run();
  assert(res.cause.unverified[0] === "411", "a failed recompute is unverified");
  assert(h.notified[0]?.key === DATA_ANOMALY_ALERT_KEY, "unverified pages");
  assert(h.healed.length === 0, "unverified is never self-healed");
}

// A recompute that THROWS is the same as one that failed: unverified, tick alive.
{
  const h = harness({ buckets: { "411": { recomputeThrows: true } } });
  const res = await h.run();
  assert(res.cause.unverified[0] === "411", "a throwing recompute degrades to unverified");
}

// A budget-truncated scan proved nothing: it must neither page nor all-clear.
{
  const h = harness({ buckets: { "411": { recompute: 4 } }, deadlineMs: 0 });
  const res = await h.run();
  assert(res.truncated, "a scan past its deadline reports truncated");
  assert(h.notified.length === 0, "a truncated scan with no findings pages nothing");
  assert(h.resolved.length === 0, "a truncated scan sends NO all-clear: it never looked");
}

// An empty tier covered by a lower ladder rung: info whisper with the human tier
// names and both depths, no page, and the healthy all-clear still goes out.
{
  const h = harness({
    buckets: { "411": { eligible: 1 }, "421": { slotCount: 3, eligible: 1 } },
    ladder: { "411": ["411", "421"] },
  });
  const res = await h.run();
  assert(res.page.length === 0, "a covered tier is not a dead-end");
  assert(res.covered[0]?.code === "411" && res.covered[0]?.via === "421", "the covering rung is reported");
  assert(h.infoed[0]?.key === FALLBACK_COVERED_INFO_KEY, "coverage whispers on the info channel");
  assert(h.infoed[0]?.text.includes("Tier 411") === true, "the notice carries the human tier name");
  assert(h.infoed[0]?.text.includes("only one agent deep") === true, "the notice flags thin one-deep coverage");
  assert(h.resolved.length === 1, "a covered tier does not block the all-clear");
}

// A test bucket's slots never masquerade as real coverage.
{
  const h = harness({
    buckets: { "411": {}, "421": { slotCount: 3, isTest: true } },
    ladder: { "411": ["411", "421"] },
  });
  const res = await h.run();
  assert(res.page[0] === "411", "a ladder whose only slots are in a test bucket is still a dead-end");
}

// Nobody on shift: a legitimately closed bucket stays silent.
{
  const h = harness({ buckets: { "411": { onShift: false } } });
  const res = await h.run();
  assert(res.page.length === 0 && h.notified.length === 0, "an off-shift empty bucket is not a fault");
}

// A stale cached row is the recompute lane's concern, not a booker fault.
{
  const h = harness({ buckets: { "411": { computedAgoMs: 30 * 60_000 } } });
  const res = await h.run();
  assert(res.page.length === 0, "a stale row is not a dead-end (the recompute lane owns staleness)");
}

// A heal that throws is reported and the page still fires.
{
  const h = harness({ buckets: { "411": { recompute: 4 } }, healThrows: ["411"] });
  const res = await h.run();
  assert(res.selfHeal.failed[0] === "411" && h.healErrors[0] === "411", "a throwing heal is reported as failed");
  assert(h.notified[0]?.key === DATA_ANOMALY_ALERT_KEY, "the page still fires when the heal fails");
}

// An already-claimed heal window (flapping bucket) is skipped, not re-healed.
{
  const h = harness({ buckets: { "411": { recompute: 4 } }, claimDenied: ["411"] });
  const res = await h.run();
  assert(res.selfHeal.skipped[0] === "411" && h.healed.length === 0, "a claimed window skips the heal");
  assert(h.notified.length === 1, "the skipped bucket still pages");
}

// A flaky info channel must never fail the tick.
{
  const h = harness({ buckets: { "411": { recompute: 0 } }, infoThrows: true });
  const res = await h.run();
  assert(res.cause.bookedSolid.length === 1, "a throwing info channel is swallowed and the scan still reports");
}

finish();
