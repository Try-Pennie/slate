// #3090: the audit chain check is wired everywhere a monitor alert has to be.
//
// scripts/test-audit-chain.ts drives the walk and the runner. This holds the WIRING
// around them, each piece of which the repo's general guards cover only by type or
// by family: the key a person can tune, the classification that lets it send an all
// clear, the runbook section a reader is sent to, the preview a reviewer reads, the
// verdict lane that notices a walk gone blind, and the monitor lane step that runs
// it and stamps that lane. A key present in some of these and missing from another
// is how a page goes out with no cooldown or no procedure (#2656).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-audit-chain-wiring.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { AUDIT_CHAIN_KEY } from "@/lib/monitor/audit-chain";
import { ALERT_FIELDS, ALERT_KEYS, MONITOR_DEFAULTS } from "@/lib/monitor/settings";
import { ALERT_CATALOG } from "@/lib/notify/alert-catalog";
import { alertFamily } from "@/lib/notify/alert-runbook";
import { ALERT_PREVIEWS } from "@/lib/notify/alert-preview";
import { VERDICT_STALE_BOUNDS_MS } from "@/lib/monitor/health";
import { AUDIT_CHAIN_VERDICT_LANE } from "@/lib/monitor/verdict-freshness";

const ROOT = join(import.meta.dirname, "..");

// --- settings: a tunable key with an hourly default ------------------------------
assert((ALERT_KEYS as readonly string[]).includes(AUDIT_CHAIN_KEY), "the key is one of the monitor alert keys");
eq(
  (MONITOR_DEFAULTS.cooldownMs as Record<string, number>)[AUDIT_CHAIN_KEY],
  60 * 60_000,
  "it repeats hourly by default, like the other security pages",
);
const field = ALERT_FIELDS.find((f) => f.key === AUDIT_CHAIN_KEY);
eq(field?.urgency, "page", "the settings screen lists it as a page");

// --- catalog and runbook ----------------------------------------------------------
eq(ALERT_CATALOG.find((e) => e.key === AUDIT_CHAIN_KEY)?.kind, "condition", "it is a condition, so it may send an all clear");
eq(alertFamily(AUDIT_CHAIN_KEY), "the-audit-log-was-changed-after-it-was-written", "it has its own runbook family");
const runbook = readFileSync(join(ROOT, "docs/alerts-runbook.md"), "utf8");
assert(runbook.includes("## The audit log was changed after it was written"), "and that family has a section to read");
assert(runbook.includes("Do not repair the row"), "which tells the reader to keep the evidence first");

// --- preview: every break and the all clear ---------------------------------------
const states = ALERT_PREVIEWS.filter((p) => p.key === AUDIT_CHAIN_KEY);
eq(states.filter((p) => p.channel === "alert").length, 4, "the preview renders each of the four breaks");
eq(states.filter((p) => p.channel === "recovery").length, 1, "and the all clear");

// --- verdict lane -----------------------------------------------------------------
eq(VERDICT_STALE_BOUNDS_MS[AUDIT_CHAIN_VERDICT_LANE], 6 * 60 * 60_000, "a walk that stops concluding is noticed within six hours");

// --- the monitor lane runs it and stamps the lane ----------------------------------
const route = readFileSync(join(ROOT, "src/app/api/cron/monitor/route.ts"), "utf8");
const step = route.indexOf('steps.run("audit_chain"');
assert(step > 0, "the monitor lane runs the walk inside its own step boundary");
const body = route.slice(step, route.indexOf("\n    );\n", step));
assert(body.includes("runAuditChainCheck("), "the step calls the runner");
assert(body.includes(" details::text,"), "it reads details as Postgres's own text, which is what the hash is over");
assert(body.includes('.order("chain_seq", { ascending: true })') && body.includes(".limit(limit)"), "in chain order, one bounded page");
assert(body.includes("cooldownMs.audit_log_chain_broken"), "with the tunable cooldown");
assert(
  route.includes("recordDetectorVerdict(AUDIT_CHAIN_VERDICT_LANE, auditChainReachedVerdict(auditChain))"),
  "and stamps the verdict lane from the step's own result",
);

finish();
