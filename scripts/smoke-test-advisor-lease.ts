// The smoke canary's hold on the two smoke test advisors (#4180). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/smoke-test-advisor-lease.ts take
//   SMOKE_LEASE_TOKEN=<token> node ... scripts/smoke-test-advisor-lease.ts release
//
// WHY. The daily reroute drill books on the same two advisors as the canary's full pass, and on
// 2026-10-23 at 15:34 UTC the two overlapped and BOTH failed. So the full pass takes one server
// side lease (`POST /api/smoke/test-advisor-lease`) before its booking steps and hands it back
// after (`DELETE`), and the drill's endpoint takes the same lease for the drill's run.
//
// take   asks for the lease, again every 15 seconds while the drill holds it, for up to six
//        minutes (longer than the drill's longest run). Held: exit 0, and `held=1` plus
//        `token=<claim>` on GITHUB_OUTPUT. Still held elsewhere at the bound: exit 7, NOT
//        MEASURED, `held=0`, and nothing recorded as a failure; the workflow books nothing,
//        stamps nothing and pages nobody. Every other ending is a real fault (a refused key, no
//        reply) on its own exit, recorded in SMOKE_FAILURE_FILE so the canary's alert names it.
// release hands back the claim SMOKE_LEASE_TOKEN names. Idempotent: a claim already gone answers
//        fine and says so. A release that fails costs at most the lease's ten minute TTL.
//
// The exits are `scripts/lib/test-advisor-lease-client.ts`, pinned offline by
// `scripts/test-test-advisor-lease-wait.ts`.
//
// Env:
//   BOOKING_API_KEY_CANARY  the canary's Bearer key (from .env.local / .dev.vars, or the environment)
//   SLATE_BASE_URL          the deployment (default https://slate.trypennie.app)
//   SMOKE_FAILURE_FILE      where the canary's alerter reads failed checks (unset: nowhere)
//   SMOKE_LEASE_TOKEN       release only: the token take wrote
import { appendFileSync } from "node:fs";
import { canaryProofTarget, loadEnvFiles } from "./smoke-env.ts";
import { SMOKE_NAMES, failureLogPath, nodeSmokeFailureIo, recordFailure, recordPass } from "./lib/smoke-failure-log.ts";
import { realSleep } from "./lib/test-advisor-lease-wait.ts";
import {
  TEST_ADVISOR_LEASE_EXIT,
  readReleaseReply,
  takeLeaseWhenFree,
  type LeaseReading,
} from "./lib/test-advisor-lease-client.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const REQUEST_DEADLINE_MS = 30_000;
const mode = process.argv[2];
const target = canaryProofTarget(process.env.BOOKING_API_KEY_CANARY, process.env.SLATE_BASE_URL);
const canaryKey = target.canaryKey;
const deployment = target.deployment;
const failureLog = failureLogPath(process.env);
const endpoint = `${deployment}/api/smoke/test-advisor-lease`;

function output(lines: string[]): void {
  // env-ok: GITHUB_OUTPUT (set by the runner for every step; absent on a hand run, which writes nowhere)
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, lines.map((l) => `${l}\n`).join(""), "utf8");
}

function finishTake(r: LeaseReading): never {
  if (r.exit === TEST_ADVISOR_LEASE_EXIT.ok && r.token) {
    output(["held=1", `token=${r.token}`]);
    recordPass(nodeSmokeFailureIo, failureLog, SMOKE_NAMES.testAdvisorLease);
    console.log(r.detail);
  } else {
    output(["held=0"]);
    if (r.exit === TEST_ADVISOR_LEASE_EXIT.notMeasured) {
      console.log(`NOT MEASURED (exit ${r.exit}): ${r.detail}`);
    } else {
      recordFailure(nodeSmokeFailureIo, failureLog, `${SMOKE_NAMES.testAdvisorLease} could not be taken: ${r.detail}`);
      console.error(`FAILED (exit ${r.exit}): ${r.detail}`);
    }
  }
  process.exit(r.exit);
}

async function send(method: "POST" | "DELETE", body?: string): Promise<{ status: number; body: string }> {
  const res = await fetch(endpoint, {
    method,
    headers: { authorization: `Bearer ${canaryKey}`, ...(body ? { "content-type": "application/json" } : {}) },
    body,
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  });
  return { status: res.status, body: await res.text() };
}

if (mode !== "take" && mode !== "release") {
  console.error("Usage: smoke-test-advisor-lease.ts take|release");
  process.exit(TEST_ADVISOR_LEASE_EXIT.misconfigured);
}
if (!canaryKey) {
  const r = { exit: TEST_ADVISOR_LEASE_EXIT.misconfigured, detail: "BOOKING_API_KEY_CANARY is not set." } as const;
  if (mode === "take") finishTake(r);
  console.error(r.detail);
  process.exit(r.exit);
}

if (mode === "take") {
  console.log(`Taking the smoke test advisors' lease on ${deployment}`);
  finishTake(await takeLeaseWhenFree(() => send("POST"), { now: Date.now, sleep: realSleep }));
} else {
  const token = process.env.SMOKE_LEASE_TOKEN ?? "";
  if (!token) {
    console.error("SMOKE_LEASE_TOKEN is empty, so there is no claim to release.");
    process.exit(TEST_ADVISOR_LEASE_EXIT.misconfigured);
  }
  let r: LeaseReading;
  try {
    const reply = await send("DELETE", JSON.stringify({ token }));
    r = readReleaseReply(reply.status, reply.body);
  } catch (err) {
    r = { exit: TEST_ADVISOR_LEASE_EXIT.noAnswer, detail: `The lease endpoint did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (r.exit === TEST_ADVISOR_LEASE_EXIT.ok) console.log(r.detail);
  // A GitHub annotation, so a release that did not land is visible on the run page.
  else console.log(`::warning title=Test advisor lease not released::${r.detail} It lapses on its own within ten minutes.`);
  process.exit(r.exit);
}
