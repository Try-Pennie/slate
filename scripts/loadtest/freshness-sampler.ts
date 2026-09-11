// Recompute freshness sampled once a minute DURING the booking load run (#2244).
//
// It reuses `runRecomputeSoak`, the sampler the #303 soak already uses, rather
// than measuring freshness once at the end. That distinction is the whole reason
// the sampler exists: the sequential run measured once after the other phases had
// let the buckets age, so it always read "all stale" even when recompute was
// healthy, which is a false alarm rather than a finding.
//
// Sampling it UNDER the booking load is what makes it mean something here: the
// question is not whether recompute keeps up, which #440 answered, but whether it
// keeps up while six hundred bookings are invalidating slots underneath it.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { computeFreshness, runRecomputeSoak } from "./invariants.ts";
import { RUN_MINUTES } from "./book-plan.ts";

const PROD_HOST = "slate.trypennie.app";

function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`FAILED: ${name} is not set, so nothing was sampled.`);
    process.exit(1);
  }
  return v;
}

const SLATE_BASE = need("SLATE_BASE").replace(/\/$/, "");
const CRON_SECRET = need("CRON_SECRET");
const SUPA = `${need("SUPABASE_URL").replace(/\/$/, "")}/rest/v1`;
const SUPA_KEY = need("SUPABASE_SECRET_KEY");
const OUT = need("OUT");
if (SLATE_BASE.includes(PROD_HOST)) {
  console.error("FAILED: SLATE_BASE points at production.");
  process.exit(1);
}

const H = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

/** Paginated, because `bucket_slots` is 60 rows today and a capped read would
 *  under-report the oldest bucket the moment that changes (the #725 shape). */
async function listAll(pathAndFilter: string): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${SUPA}/${pathAndFilter}`, {
      headers: { ...H, Range: `${from}-${from + PAGE - 1}` },
    });
    if (!res.ok) throw new Error(`read ${pathAndFilter} -> ${res.status}`);
    const page = (await res.json()) as Record<string, unknown>[];
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

const result = await runRecomputeSoak(
  {
    driveRecompute: async () => {
      const res = await fetch(`${SLATE_BASE}/api/cron/recompute`, {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });
      return (await res.json().catch(() => ({}))) as Record<string, unknown>;
    },
    freshness: () => computeFreshness(listAll, Date.now()),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    log: (msg) => console.log(msg),
  },
  { minutes: RUN_MINUTES },
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
console.log(
  `sampled ${result.samples.length} minutes; worst oldest-bucket age ${result.maxAgeSec}s ` +
    `(bar ${result.staleSec}s)`,
);
// Deliberately exits ZERO whatever it measured. The JUDGE decides: a sampler that
// failed here would take the whole run down before the judge could report what
// else it found, and the freshness bar is one finding among many.
