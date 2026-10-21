// #4006: proving Marcia's Salesforce Lead contact fill against the real org, LIVE.
//
// #4001 fills a move's missing name, email or phone from the lead's earlier Slate
// bookings and then the Salesforce Lead (`attendeeFor` in
// `src/lib/mcp-booking/operations.ts`, `src/lib/salesforce/lead-contact.ts`). Every
// suite drives that read through fakes, so nobody had seen the deployed Worker ask the
// real org and get an answer inside its 2.5 second cap while a lead is on the call
// (L52, L82). This asks the outside systems, never Slate's own record of them:
//
//   1. Salesforce, from here, for the Lead's Email and Phone (refused unless the Email
//      is a Pennie address: the moved call's invite goes to whatever the fill writes);
//   2. Slate, for the lead's earlier TEST bookings: if any holds an email or a phone the
//      move uses it before asking Salesforce, so the run would prove the wrong source;
//   3. the DEPLOYED booking MCP, with test tokens this run signs: find_times on the
//      partner test bucket, then a test call booked here with a name only, then a move
//      through the MCP with a token carrying no name, email or phone;
//   4. the moved booking row against the Lead: both filled, both the Lead's. With no
//      earlier booking holding either, Salesforce is the only place they could be from.
// Then, always, the test call is cancelled and the run proves it is.
//
// It WRITES to production (one test call on the partner test bucket, which sends no
// webhook and no text, moved once and cancelled), so it needs
// `VERIFY_MARCIA_FILL_APPLY=1`. It signs with Marcia's token key, read from the file
// `MARCIA_TOKEN_KEY_FILE` names (or `MARCIA_TOKEN_KEY_A`), which it never prints.
// Not named test-*.ts, because that glob is the offline suite; its decisions are
// pinned by `scripts/test-marcia-lead-fill-check.ts`.
//
// Run, from a checkout of current main with the production credentials beside it:
//   VERIFY_MARCIA_FILL_APPLY=1 VERIFY_MARCIA_LEAD_ID=<00Q lead id> MARCIA_TOKEN_KEY_FILE=<path> \
//     node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/verify-marcia-lead-fill-live.ts
// Exit codes and what each means: docs/verify-commands.md, "Proving Marcia's Salesforce
// Lead contact fill".
import { readFileSync } from "node:fs";
import { loadEnvFiles } from "./smoke-env.ts";
import { liveTestWorldPreflight } from "./lib/live-test-world-preflight.ts";
import {
  BOOKING_MCP_URL,
  LEAD_FILL_OUTCOMES,
  RUN_TIME_ZONE,
  fillVerdict,
  finalOutcome,
  leadFillClaims,
  leadIdProblem,
  leadProblem,
  readToolAnswer,
  runNonce,
  slateAnswersFirst,
  tokenKeyFrom,
  toolCall,
  type LeadFillOutcome,
} from "./lib/marcia-lead-fill-check.ts";
import { signMachineToken } from "../src/lib/mcp-booking/machine-token.ts";
import { leadIdSpellings } from "../src/lib/salesforce/lead-xbc.ts";
import { PARTNER_BUCKET_CODE } from "../src/lib/embed/public-test-bucket.ts";

loadEnvFiles([".env.local", ".dev.vars"]);
const RUN_STARTED_MS = Date.now();

function exit(outcome: LeadFillOutcome, detail?: string): never {
  const o = LEAD_FILL_OUTCOMES[outcome];
  const line = `${outcome === "proven" ? "PROVEN" : "FAIL"} (${o.exit}): ${o.says}${detail ? `. ${detail}` : ""}`;
  (outcome === "proven" ? console.log : console.error)(line);
  process.exit(o.exit);
}
const step = (msg: string) => console.log(`  ${msg}`);

// --- what the run needs, before it touches anything --------------------------------------
if (process.env.VERIFY_MARCIA_FILL_APPLY !== "1") exit("notConfigured", "set VERIFY_MARCIA_FILL_APPLY=1 to let it book, move and cancel one test call");
const idProblem = leadIdProblem(process.env.VERIFY_MARCIA_LEAD_ID);
if (idProblem) exit("notConfigured", idProblem);
const LEAD = process.env.VERIFY_MARCIA_LEAD_ID!.trim();
let keyFile: string | null = null;
if (process.env.MARCIA_TOKEN_KEY_FILE) {
  try {
    keyFile = readFileSync(process.env.MARCIA_TOKEN_KEY_FILE, "utf8");
  } catch {
    exit("notConfigured", "MARCIA_TOKEN_KEY_FILE names a file this run cannot read");
  }
}
const keyRead = tokenKeyFrom(keyFile, process.env.MARCIA_TOKEN_KEY_A);
if ("problem" in keyRead) exit("notConfigured", keyRead.problem);
const KEY = keyRead.key;
// The partner test bucket is smoketest@'s, whom the smoke canary also books.
const preflight = liveTestWorldPreflight(process.env, Date.now());
if (preflight) exit(preflight.outcome, preflight.detail);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { unwrap } = await import("@/lib/db/result");
const service = await import("@/lib/booking/service");
const { readLeadContactLive } = await import("@/lib/salesforce/lead-contact");
const { validateReason, CANCEL_REASONS } = await import("@/lib/booking/core");
const db = supabaseAdmin();
const spellings = leadIdSpellings(LEAD);
const identity = { externalId: LEAD, salesforceId: LEAD };

// --- 1. the Lead, asked of Salesforce ------------------------------------------------------
let lead: { email: string | null; phone: string | null } | null;
try {
  lead = await readLeadContactLive(LEAD);
} catch (err) {
  exit("salesforceUnreadable", err instanceof Error ? err.name : "the read threw");
}
const lp = leadProblem(lead);
if (lp) exit("leadUnsuitable", lp);
step("the Lead holds an email at a Pennie address and a phone");

// --- 2. what Slate would answer with before asking Salesforce -------------------------------
let first: string | null;
try {
  const known = await service.readKnownContact([spellings.short, spellings.long], { isTest: true }, "lead fill check");
  const active = await service.lookupPersonBookings({ externalId: spellings.short, salesforceId: spellings.long });
  first = slateAnswersFirst(known ? { email: known.email, phone: known.phone } : null, active.length);
} catch (err) {
  exit("slateUnreadable", err instanceof Error ? err.name : "the read threw");
}
if (first) exit("bookingsAnswerFirst", first);
step("no earlier test booking holds an email or a phone, and the lead holds no active call");

// --- 3. the deployed booking MCP --------------------------------------------------------
let calls = 0;
async function mcp(name: string, args: Record<string, unknown>): Promise<{ body: Record<string, unknown>; ms: number }> {
  const n = ++calls;
  const token = await signMachineToken(leadFillClaims(LEAD, Date.now(), runNonce(RUN_STARTED_MS, n)), KEY);
  const started = Date.now();
  let status = 0;
  let text = "";
  try {
    const res = await fetch(BOOKING_MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: toolCall(n, name, args),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    throw Object.assign(new Error(`${name}: the booking MCP could not be reached (${err instanceof Error ? err.name : "a throw"})`), { outcome: "mcpRefused" as const });
  }
  const ms = Date.now() - started;
  const read = readToolAnswer(status, text);
  if (!read.ok) {
    const keyHint = read.why.includes("token_signature_invalid") ? "; the token key this run holds is not the one production verifies with" : "";
    throw Object.assign(new Error(`${name}: ${read.why}${keyHint}`), { outcome: "mcpRefused" as const });
  }
  return { body: read.body, ms };
}

let made: string | null = null;
let outcome: { outcome: LeadFillOutcome; detail?: string } = { outcome: "proven" };
try {
  const found = await mcp("find_times", {});
  const times = ((found.body.data as { times?: { slot_id: string; starts_at: string }[] } | undefined)?.times ?? []);
  if (times.length < 2) exit("noTimes", `${times.length} offered`);
  step(`find_times offered ${times.length} times in ${found.ms}ms`);

  // The call to move, booked HERE with a name only: a net new booking through Marcia
  // needs an email and a phone on the token, and either would then answer the move.
  try {
    const r = await service.createBooking({
      bucketCode: PARTNER_BUCKET_CODE,
      startIso: times[0]!.starts_at,
      timezone: RUN_TIME_ZONE,
      attendee: { name: "Lead Fill Check" },
      prefill: {},
      externalId: LEAD,
      salesforceId: LEAD,
      idempotencyKey: `LEAD-FILL-CHECK-${RUN_STARTED_MS}`,
      allowTestBuckets: true,
    });
    made = r.booking.id;
  } catch (err) {
    throw Object.assign(new Error(`${err instanceof Error ? err.message : String(err)}`), { outcome: "setupRefused" as const });
  }
  step(`test call ${made} booked on ${PARTNER_BUCKET_CODE} with a name only`);

  const moved = await mcp("move", { slot_id: times[1]!.slot_id });
  const data = moved.body.data as { outcome?: string; booking?: { booking_id?: string } } | undefined;
  if (data?.outcome !== "rescheduled" || data.booking?.booking_id !== made) {
    throw Object.assign(new Error(`move answered ${String(data?.outcome)} for ${String(data?.booking?.booking_id)}, not rescheduled for ${made}`), { outcome: "mcpRefused" as const });
  }
  step(`the move landed through the booking MCP in ${moved.ms}ms (the Lead read's cap is 2500ms of that)`);

  // --- 4. the moved row against the Lead -------------------------------------------------
  let row: { attendee_email: string | null; attendee_phone: string | null };
  try {
    row = unwrap(await db.from("bookings").select("attendee_email, attendee_phone").eq("id", made).single(), "moved booking") as typeof row;
  } catch (err) {
    throw Object.assign(new Error(err instanceof Error ? err.name : "the read threw"), { outcome: "rowUnreadable" as const });
  }
  const verdict = fillVerdict(row, lead!);
  if (!verdict.ok) outcome = { outcome: "notFilled", detail: `${verdict.why}. A timed out or refused Lead read logs "a lead contact lookup failed" on the slate Worker` };
  else step("the moved booking holds the Lead's email and phone");
} catch (err) {
  // A throw no step tagged is the run's own fault, never claimed as an MCP refusal.
  const o = (err as { outcome?: LeadFillOutcome }).outcome ?? "unexpected";
  outcome = { outcome: o, detail: err instanceof Error ? err.message : String(err) };
}

// --- always: cancel the test call, and prove it is cancelled ------------------------------
let cleanup: { outcome: "residue" | "cleanupUnverified"; detail: string } | null = null;
if (made) {
  const reason = validateReason({ code: "other", detail: "lead fill check" }, CANCEL_REASONS);
  try {
    if (reason.ok) await service.cancelDirectBooking({ bookingId: made, identity, reason: reason.reason });
  } catch {
    // Judged by the read below, never by the cancel's own answer.
  }
  try {
    const status = (unwrap(await db.from("bookings").select("status").eq("id", made).single(), "cleanup read") as { status: string }).status;
    if (status !== "cancelled") cleanup = { outcome: "residue", detail: `booking ${made} is ${status}; cancel it by hand` };
    else step(`test call ${made} cancelled`);
  } catch {
    cleanup = { outcome: "cleanupUnverified", detail: `read booking ${made} and cancel it by hand if it is active` };
  }
}
const end = finalOutcome(outcome, cleanup);
exit(end.outcome, end.detail);
