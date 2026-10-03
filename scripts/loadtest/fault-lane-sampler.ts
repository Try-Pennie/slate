// The cron lanes, sampled for the whole time the fault leg's deployment is faulted
// (#3104). It starts beside the fault driver, keeps reading after the driver has
// finished for a tail of minutes (the deployment stays faulted until the restore step
// that follows), and writes what it saw for `run-judge.ts` to score through the pure
// judge in `fault-lanes.ts`.
//
// It reads the BRANCH database directly, never through the Worker: the Worker is the
// thing being faulted, and a reading taken through it would fail exactly when the
// lanes were most worth watching.
//
// It writes nothing to the database. A failed reading is counted and left out rather
// than ending the run, because the judge already calls a series with a hole in it
// incomplete, and a sampler that died on the first refusal would leave no evidence at
// all.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  LANE_SAMPLER_MAX_MS,
  LANE_SAMPLE_INTERVAL_MS,
  type FaultLaneEvidence,
  type LaneSample,
} from "./fault-lanes.ts";
import { PRODUCTION_SUPABASE_REF } from "../../src/lib/loadtest-guard.ts";

function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`FAILED: ${name} is not set, so nothing was sampled.`);
    process.exit(1);
  }
  return v;
}

const SUPA_URL = need("SUPABASE_URL");
const SUPA_KEY = need("SUPABASE_SECRET_KEY");
const RUN_ID = need("RUN_ID");
const OUT = need("OUT");
const STOP_FILE = need("STOP_FILE");
// env-ok: FAULT_LANE_TAIL_MINUTES (optional; defaults to 3, how long to keep sampling
// after the fault driver finishes, so the window is long enough for the sync page's
// two consecutive failing ticks and a stale lane has time to show)
const TAIL_MINUTES = Number((process.env.FAULT_LANE_TAIL_MINUTES ?? "3").trim());
if (!Number.isFinite(TAIL_MINUTES) || TAIL_MINUTES < 0) {
  console.error("FAILED: FAULT_LANE_TAIL_MINUTES is not a number of minutes.");
  process.exit(1);
}
if (SUPA_URL.includes(PRODUCTION_SUPABASE_REF)) {
  console.error("FAILED: SUPABASE_URL points at production. The lanes are sampled on the branch.");
  process.exit(1);
}

const SUPA = `${SUPA_URL.replace(/\/$/, "")}/rest/v1`;
const H = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

/** Paginated. Both tables are roster bounded, and a capped read would still under
 *  report the moment either outgrew one page (the #725 shape). */
async function listAll(pathAndFilter: string): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${SUPA}/${pathAndFilter}`, {
      headers: { ...H, Range: `${from}-${from + PAGE - 1}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`read ${pathAndFilter} -> ${res.status}`);
    const page = (await res.json()) as Record<string, unknown>[];
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

async function sample(): Promise<LaneSample> {
  const atMs = Date.now();
  const [beats, alerts] = await Promise.all([
    listAll("lane_heartbeats?select=lane,last_ran_at&order=lane"),
    listAll("alert_state?select=key,last_sent_at&order=key"),
  ]);
  const heartbeats: Record<string, string> = {};
  for (const r of beats) heartbeats[String(r.lane)] = String(r.last_ran_at);
  const sent: Record<string, string> = {};
  for (const r of alerts) sent[String(r.key)] = String(r.last_sent_at);
  return { atMs, heartbeats, alerts: sent };
}

const startedAtMs = Date.now();
const samples: LaneSample[] = [];
let failedReads = 0;
let stopSeenAtMs: number | null = null;

for (;;) {
  const tickMs = Date.now();
  try {
    samples.push(await sample());
  } catch (err) {
    failedReads++;
    console.error(`note: a lane reading failed (${(err as Error).message}); counted and left out`);
  }
  if (stopSeenAtMs === null && existsSync(STOP_FILE)) stopSeenAtMs = Date.now();
  const now = Date.now();
  if (stopSeenAtMs !== null && now - stopSeenAtMs >= TAIL_MINUTES * 60_000) break;
  if (now - startedAtMs >= LANE_SAMPLER_MAX_MS) {
    console.error(
      `note: stopped at the ${Math.round(LANE_SAMPLER_MAX_MS / 60_000)} minute ceiling` +
        (stopSeenAtMs === null ? " without the fault driver having finished" : ""),
    );
    break;
  }
  await new Promise((r) => setTimeout(r, Math.max(0, LANE_SAMPLE_INTERVAL_MS - (Date.now() - tickMs))));
}

const evidence: FaultLaneEvidence = {
  kind: "fault-lanes",
  runId: RUN_ID,
  startedAtMs,
  finishedAtMs: Date.now(),
  intervalMs: LANE_SAMPLE_INTERVAL_MS,
  samples,
  failedReads,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(evidence, null, 2), "utf8");
console.log(`lane sampler: ${samples.length} readings (${failedReads} failed) written to ${OUT}`);
