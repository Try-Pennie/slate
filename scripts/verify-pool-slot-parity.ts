// Do the bucket codes that share a POOL offer the same times? (#2245)
// Run: pnpm verify:pool-slot-parity
//
// Reads production and the deployed app, writes NOTHING. Deliberately not named
// `test-*.ts`, because that glob is the offline unit suite and this needs the
// Supabase secret key from `.env.local` plus a live deployment.
//
// Run it BEFORE the pooled recompute ships and AFTER. Before, it proves the
// premise: sixty codes were already producing fifteen distinct answers, which is
// why computing each one separately was waste. After, it proves the pooled write
// did not put one pool's times under another pool's code, which is the one way
// this change can go wrong and stay invisible.
//
// The question holds at any instant, on purpose. A before and after diff of each
// code's own slots cannot work: the booking window walks forward with the clock,
// so the two runs legitimately differ and nobody can tell that from a regression.
//
// Test buckets are skipped: SMOKE and SMOKE2 are each their own pool, so they
// have nothing to be compared against, and reading them needs the booking key.
//
// Exit codes are the judge's (scripts/lib/pool-slot-parity.ts), plus 1 for "no
// credentials here", decided before anything is read so it can never be confused
// with a finding.
import { requireSupabaseCredentials } from "./lib/supabase-credentials.ts";

const creds = requireSupabaseCredentials();
if (!creds) process.exit(1);

const { listPoolBuckets } = await import("@/lib/availability/precompute");
const { groupByPool } = await import("@/lib/availability/pool-key");
const { judgePoolParity } = await import("./lib/pool-slot-parity.ts");
type CodeSample = import("./lib/pool-slot-parity.ts").CodeSample;
type ComparedPool = import("./lib/pool-slot-parity.ts").ComparedPool;

const BASE = (process.env.SLATE_BASE_URL || "https://slate.trypennie.app").replace(/\/$/, "");

const buckets = await listPoolBuckets();
const real = buckets.filter((b) => !b.bucket.is_test);
const pools: ComparedPool[] = [...groupByPool(real)].map(([key, members]) => ({
  key,
  codes: members.map((m) => m.code).sort(),
}));

console.log(
  `${real.length} real bucket codes in ${pools.length} pools, read from ${BASE}`,
);

/**
 * One code's offer, as the deployed app serves it. Every way of not getting an
 * answer is kept apart, because "the app is down", "something else replied" and
 * "this code no longer resolves" send three different people to do three
 * different things (L11).
 */
async function sample(code: string): Promise<CodeSample> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/availability?bucket=${encodeURIComponent(code)}`, {
      headers: { accept: "application/json" },
    });
  } catch (err) {
    return { code, kind: "no-answer", detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 404) return { code, kind: "not-found" };
  if (!res.ok) return { code, kind: "no-answer", detail: `HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { code, kind: "unreadable", detail: "the reply was not JSON" };
  }
  const slots = (body as { slots?: unknown }).slots;
  if (!Array.isArray(slots)) {
    return { code, kind: "unreadable", detail: "the reply carried no slots array" };
  }
  return { code, kind: "slots", slots: slots.map(String) };
}

/**
 * Sampled POOL BY POOL, with every code in a pool requested together and the
 * pacing spent BETWEEN pools.
 *
 * That ordering is the whole reason this is trustworthy. `/api/availability`
 * carries an edge throttle of 30 requests a minute per IP
 * (`AVAIL_RATE_LIMITER` in wrangler.jsonc), so sixty codes cannot be read in one
 * burst, and a paced sweep takes minutes. Spreading the pacing inside a pool
 * would put minutes between two codes that are about to be compared, and a slot
 * crossing the minimum notice boundary in that gap is a difference with nothing
 * wrong behind it. Codes are only ever compared against others in their own
 * pool, so a gap between pools costs nothing.
 */
const PACE_MS = Number(process.env.POOL_PARITY_PACE_MS ?? "");
/** The limit the deployment actually enforces, so the pacing is derived from it
 *  rather than from a number somebody guessed. */
const LIMIT_PER_MINUTE = 30;

async function sampleByPool(toRead: ComparedPool[]): Promise<Map<string, CodeSample>> {
  const out = new Map<string, CodeSample>();
  for (const [i, pool] of toRead.entries()) {
    for (const s of await Promise.all(pool.codes.map(sample))) out.set(s.code, s);
    if (i === toRead.length - 1) break;
    // 15% of headroom over the stated limit, because the window is the
    // deployment's and not ours, and a 429 costs a whole re-run.
    const waitMs = Number.isFinite(PACE_MS) && PACE_MS > 0
      ? PACE_MS
      : Math.ceil((pool.codes.length / LIMIT_PER_MINUTE) * 60_000 * 1.15);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return out;
}

console.log(
  `pacing to the deployment's ${LIMIT_PER_MINUTE} a minute throttle, so this takes a few minutes`,
);
const samples = await sampleByPool(pools);
let verdict = judgePoolParity(pools, samples);

// A difference gets ONE re-read before it is reported, and only the pools that
// disagreed. The window moves: a slot can cross the minimum notice boundary
// between two requests seconds apart, which makes two codes in one pool
// genuinely differ for a moment with nothing wrong. A difference that survives a
// second sweep is not that.
if (verdict.outcome === "slots-differ") {
  const suspect = pools.filter((p) => {
    const sets = p.codes
      .map((c) => samples.get(c))
      .filter((s): s is Extract<CodeSample, { kind: "slots" }> => s?.kind === "slots")
      .map((s) => [...s.slots].sort().join(","));
    return new Set(sets).size > 1;
  });
  console.log(
    `re-reading ${suspect.length} pool(s) that disagreed, in case the window moved mid sweep`,
  );
  const recheck = await sampleByPool(suspect);
  for (const [code, s] of recheck) samples.set(code, s);
  verdict = judgePoolParity(pools, samples);
}

for (const finding of verdict.findings) console.log(`  ${finding}`);

console.log(
  `\n${verdict.outcome.toUpperCase()}: compared ${verdict.comparedCodes} codes across ` +
    `${verdict.comparedPools} pools`,
);
if (verdict.outcome === "agree") {
  console.log("every code that shares a pool offers the same times");
}
process.exit(verdict.exitCode);
