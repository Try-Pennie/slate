// Picks the ONE bucket, the ONE slot and the ONE moment every burst driver uses
// (#2262), and writes them where the workflow's matrix can read them.
//
// It exists because a burst whose drivers each chose their own slot and their own
// moment is not a burst: nothing contends, everything succeeds, and the control it
// is there to be ("exactly one 200 against a pool of one, every other answer
// SLOT_TAKEN") is satisfied by a run that never tested anything.
//
// Finding nothing to burst at is NEVER a pass (L98). Every way of learning nothing
// exits non-zero with the reason, because the alternative is a burst leg that
// produced an empty file and a judge that reads it as a run with no burst.
//
// Run:
//   SLATE_BASE=https://<loadtest>.workers.dev BURST_LEAD_SECONDS=300 \
//   node --experimental-strip-types scripts/loadtest/burst-setup.ts
import { appendFileSync } from "node:fs";
import { chooseBurstSlot, burstStartAt, offeredSlots, DRIVERS } from "./book-plan.ts";
import { BURST_CODE } from "./code-mix.ts";
import { PRODUCTION_SUPABASE_REF, PRODUCTION_HOST } from "../../src/lib/loadtest-guard.ts";

const PROD_HOSTS = [PRODUCTION_HOST, `${PRODUCTION_SUPABASE_REF}.supabase.co`];

function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`FAILED: ${name} is not set, so nothing was chosen.`);
    process.exit(1);
  }
  return v;
}

const SLATE_BASE = need("SLATE_BASE").replace(/\/$/, "");
// env-ok: BURST_CODE_OVERRIDE (optional; defaults to the measured one agent pool,
// and only a deliberate experiment would point the burst at a different code)
const CODE = process.env.BURST_CODE_OVERRIDE ?? BURST_CODE;
// env-ok: BURST_LEAD_SECONDS (optional; defaults to 300, which has to cover a
// runner being queued, checked out and installed)
const LEAD = Number((process.env.BURST_LEAD_SECONDS ?? "300").trim());

for (const host of PROD_HOSTS) {
  if (SLATE_BASE.includes(host)) {
    console.error(`FAILED: SLATE_BASE points at production (${host}).`);
    process.exit(1);
  }
}
if (!Number.isFinite(LEAD) || LEAD <= 0) {
  // Refused by name rather than left as NaN: `burstStartAt` would clamp a NaN lead
  // to now, every driver would wake late, and the run would report a burst nobody
  // attended with the reason being a typo nothing named (L50).
  console.error(`FAILED: BURST_LEAD_SECONDS is not a positive number of seconds.`);
  process.exit(1);
}

const res = await fetch(`${SLATE_BASE}/api/availability?bucket=${CODE}`);
if (!res.ok) {
  console.error(
    `FAILED: availability for bucket ${CODE} answered ${res.status}, so no slot could be chosen.`,
  );
  process.exit(2);
}
// Through the shared reader (#2261), which THROWS on a payload it cannot read
// rather than resolving to an empty list: an unreadable shape would otherwise
// arrive here as "this bucket offers nothing" and refuse the run for the wrong
// reason entirely.
const offered = offeredSlots(await res.json());
const slot = chooseBurstSlot(offered);
if (slot === null) {
  // Its OWN exit code. A bucket offering nothing and an availability read that
  // failed send two different people to two different places (L11): the first is a
  // seed or a roster problem, the second is the deployment.
  console.error(
    `FAILED: bucket ${CODE} offered ${offered.length} usable times, so there is nothing to burst ` +
      `at. The burst's pool is one agent deep by design, so an empty answer here usually means ` +
      `the seed did not staff it.`,
  );
  process.exit(3);
}

const startAt = burstStartAt(Date.now(), LEAD);
console.log(`burst: bucket ${CODE}, slot ${slot}, firing at ${new Date(startAt).toISOString()}`);
console.log(`  (chosen from ${offered.length} offered times, ${Math.round(LEAD)}s from now)`);

// GITHUB_OUTPUT is absent for a hand run, which prints the three values above and
// is the whole point of running it by hand.
// The driver list is emitted from the app's own `DRIVERS`, and the matrix and the
// judge's expectation both read it from here. Two places holding one number is how
// a matrix grows to five while the judge goes on expecting four and calls every run
// incomplete, or shrinks to three while the judge accepts a burst a driver short
// (L41, L70).
const drivers = Array.from({ length: DRIVERS }, (_, i) => i);
console.log(`  (${drivers.length} drivers, from the app's own DRIVERS constant)`);

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(
    out,
    `burst_code=${CODE}\nburst_slot=${slot}\nstart_at=${startAt}\n` +
      `drivers=${JSON.stringify(drivers)}\ndriver_count=${drivers.length}\n`,
    "utf8",
  );
}
