// The diagnostic cold leg (#3354 item 4): deploy a new version, let it settle, send
// ONE confirm, and repeat, so each confirm is a fresh version's first request. A load
// run yields about ten cold confirms; this yields as many as it is asked for, all taken
// the same way, to judge a startup change against. Not a bar.
//
// The decisions (how many, which slots, the order of deploy, settle and confirm) live
// in cold-plan.ts and are pinned by scripts/test-loadtest-cold-plan.ts. This file is
// only the I/O: the availability read, `wrangler deploy`, the confirm, the result file.
//
// It refuses to touch production, and that is the first thing it checks.
//
// Run (from the workflow's cold job, which also streams the tail it is judged from):
//   SLATE_BASE=https://<loadtest>.workers.dev BOOKING_API_KEY=<key> RUN_ID=<run> \
//   COLD_SAMPLES=30 RECOMPUTE_ARM=on OUT=results/cold-0.json \
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/loadtest/cold-after-deploy.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bookingBody, bookingRequestHeaders, externalIdFor, offeredSlots, REQUEST_TIMEOUT_MS } from "./book-plan.ts";
import { MEASURED_CODE_MIX } from "./code-mix.ts";
import { coldLegOutcome, makeColdDeploy, readColdSamples, runColdLeg } from "./cold-plan.ts";
import { PRODUCTION_HOST, PRODUCTION_SUPABASE_REF } from "../../src/lib/loadtest-guard.ts";

function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`FAILED: ${name} is not set, so nothing was attempted.`);
    process.exit(1);
  }
  return v;
}

const SLATE_BASE = need("SLATE_BASE").replace(/\/$/, "");
for (const host of [PRODUCTION_HOST, `${PRODUCTION_SUPABASE_REF}.supabase.co`]) {
  if (SLATE_BASE.includes(host)) {
    console.error(`FAILED: SLATE_BASE points at production (${host}). This leg redeploys and books; point it at the loadtest deployment.`);
    process.exit(1);
  }
}
const API_KEY = need("BOOKING_API_KEY");
const RUN_ID = need("RUN_ID");
const OUT = need("OUT");
const ARM = need("RECOMPUTE_ARM");
const samples = readColdSamples(process.env.COLD_SAMPLES);
if (!samples.ok) {
  console.error(`FAILED: ${samples.why}, so nothing was attempted.`);
  process.exit(1);
}
if (samples.n === 0) {
  console.error("FAILED: COLD_SAMPLES is 0, so there is nothing to take. The workflow runs this job only when it is above 0.");
  process.exit(1);
}
// env-ok: TZ_NAME (optional; the zone every driver books in, defaulting to Eastern)
const TIMEZONE = process.env.TZ_NAME ?? "America/New_York";
/** Its own driver number in the external id, so no row it writes collides with a driver's. */
const COLD_DRIVER = 90;
/** The busiest codes, which offer the most times; read once, before the first deploy. */
const CODES = MEASURED_CODE_MIX.slice(0, 5).map((c) => c.code);

// The load test Worker only, keeping the run's arm, under the deploy's own deadline.
const deploy = makeColdDeploy({
  arm: ARM,
  // Resolved from this file, not from wherever the leg was started.
  wranglerBin: join(import.meta.dirname, "..", "..", "node_modules", ".bin", "wrangler"),
  spawn: (cmd, args, opts) => spawnSync(cmd, args, opts),
});

const leg = await runColdLeg({
  n: samples.n,
  codes: CODES,
  readSlots: async (code) => {
    const res = await fetch(`${SLATE_BASE}/api/availability?bucket=${encodeURIComponent(code)}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // A refused read is said by name rather than read as a bucket offering nothing.
    if (!res.ok) throw new Error(`the availability read for ${code} answered ${res.status}`);
    return offeredSlots(await res.json());
  },
  deploy: async () => {
    const d = await deploy();
    process.stdout.write(d.output);
    return d;
  },
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  confirm: async (slot, i) => {
    try {
      const res = await fetch(`${SLATE_BASE}/api/bookings`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        method: "POST",
        headers: bookingRequestHeaders(API_KEY, "cold"),
        body: JSON.stringify(bookingBody({ code: slot.code, startIso: slot.start, externalId: externalIdFor(RUN_ID, COLD_DRIVER, i), timezone: TIMEZONE })),
      });
      const body = (await res.json().catch(() => null)) as { outcome?: string; code?: string } | null;
      return { status: res.status, outcome: body?.outcome ?? body?.code ?? null };
    } catch (err) {
      // A transport fault is a status of 0 with its name, never a missing answer.
      return { status: 0, outcome: `transport: ${(err as Error).name}` };
    }
  },
  now: () => Date.now(),
});

if (!leg.ok) {
  console.error(`FAILED: ${leg.why}, so no version was deployed.`);
  process.exit(1);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(leg.result, null, 2));
const outcome = coldLegOutcome(leg.result);
console.log(`${outcome.text}; wrote ${OUT}`);
// A lost sample (a failed deploy, or a confirm with no answer) reads red, and the judge names it.
process.exit(outcome.exit);
