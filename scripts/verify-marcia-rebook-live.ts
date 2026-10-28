// #3616: proving Marcia's booking MCP can book a time, cancel it, and book the SAME time
// again, LIVE, each booking with its own Google Calendar event.
//
// The ramp from 50% to 100% (#3616) waits on "a verified cancel, and a rebook of the same
// slot after it, each live with its own calendar event". Every suite drives the booking
// MCP through fakes, and the 2026-10-21 live tests moved and cancelled calls but never
// booked a freed time again, which is where a cancel that left its event on the calendar,
// or a nonce read as a retry of the first book, would show (L1, L82). This asks the
// outside systems, never Slate's own record of them alone:
//
//   1. Salesforce, for the test Lead's email and phone (refused unless the email is a
//      Pennie address: both invites go to it), and Slate, for any test call it holds;
//   2. the DEPLOYED booking MCP, with test tokens this run signs: find_times on the
//      partner test bucket, book the first time offered, cancel it, then book THAT SAME
//      slot again and cancel that;
//   3. after every write, the booking row AND Google, for the advisor's event.
// Then, always, every call the run made is cancelled and read back as cancelled.
//
// It WRITES to production (two test calls on the partner test bucket, which sends no
// webhook and no text, both cancelled), so it needs `VERIFY_MARCIA_REBOOK_APPLY=1`. It
// signs with Marcia's token key, read from the file `MARCIA_TOKEN_KEY_FILE` names (or
// `MARCIA_TOKEN_KEY_A`), which it never prints. Not named test-*.ts, because that glob is
// the offline suite; its decisions are pinned by `scripts/test-marcia-rebook-check.ts`.
//
// Run, from a checkout of current main with the production credentials beside it:
//   VERIFY_MARCIA_REBOOK_APPLY=1 VERIFY_MARCIA_LEAD_ID=<00Q lead id> MARCIA_TOKEN_KEY_FILE=<path> pnpm verify:marcia-rebook
// Exit codes and what each means: docs/verify-commands.md, "Proving Marcia can book a
// cancelled time again".
import { readFileSync } from "node:fs";
import { loadEnvFiles } from "./smoke-env.ts";
import { liveTestWorldPreflight } from "./lib/live-test-world-preflight.ts";
import { askBookingMcp, leadIdProblem, leadProblem, tokenKeyFrom } from "./lib/marcia-lead-fill-check.ts";
import {
  REBOOK_OUTCOMES,
  bookVerdict,
  cancelVerdict,
  rebookClaims,
  rebookFinalOutcome,
  rebookNonce,
  sameSlotVerdict,
  type CallFacts,
  type RebookOutcome,
} from "./lib/marcia-rebook-check.ts";
import { signMachineToken } from "../src/lib/mcp-booking/machine-token.ts";
import { leadIdSpellings } from "../src/lib/salesforce/lead-xbc.ts";
import { PARTNER_BUCKET_CODE } from "../src/lib/embed/public-test-bucket.ts";

loadEnvFiles([".env.local", ".dev.vars"]);
const RUN_STARTED_MS = Date.now();

function exit(outcome: RebookOutcome, detail?: string): never {
  const o = REBOOK_OUTCOMES[outcome];
  const line = `${outcome === "proven" ? "PROVEN" : "FAIL"} (${o.exit}): ${o.says}${detail ? `. ${detail}` : ""}`;
  (outcome === "proven" ? console.log : console.error)(line);
  process.exit(o.exit);
}
const step = (msg: string) => console.log(`  ${msg}`);
const tagged = (outcome: RebookOutcome, message: string) => Object.assign(new Error(message), { outcome });

// --- what the run needs, before it touches anything --------------------------------------
if (process.env.VERIFY_MARCIA_REBOOK_APPLY !== "1") exit("notConfigured", "set VERIFY_MARCIA_REBOOK_APPLY=1 to let it book and cancel two test calls");
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
const { getEventOnPrimary } = await import("@/lib/google/calendar");
const { validateReason, CANCEL_REASONS } = await import("@/lib/booking/core");
const db = supabaseAdmin();
const spellings = leadIdSpellings(LEAD);

// --- 1. the Lead, and any test call Slate already holds for it ------------------------------
let lead: { email: string | null; phone: string | null } | null;
try {
  lead = await readLeadContactLive(LEAD);
} catch (err) {
  exit("salesforceUnreadable", err instanceof Error ? err.name : "the read threw");
}
const lp = leadProblem(lead);
if (lp) exit("leadUnsuitable", lp);
const CONTACT = { name: "Rebook Check", email: lead!.email!, phone: lead!.phone! };
let held: number;
try {
  held = (await service.lookupPersonBookings({ externalId: spellings.short, salesforceId: spellings.long })).filter((b) => b.isTest).length;
} catch (err) {
  exit("slateUnreadable", err instanceof Error ? err.name : "the read threw");
}
if (held > 0) exit("leadHoldsCall", `${held} active test call(s); cancel them or use another test lead`);
step("the Lead holds a Pennie email and a phone, and no test call");

// --- 2. the deployed booking MCP --------------------------------------------------------
let calls = 0;
async function mcp(name: string, args: Record<string, unknown>, refused: RebookOutcome = "mcpRefused"): Promise<Record<string, unknown>> {
  const n = ++calls;
  const token = await signMachineToken(rebookClaims(LEAD, Date.now(), rebookNonce(RUN_STARTED_MS, n), CONTACT), KEY);
  const read = await askBookingMcp(token, n, name, args);
  if (!read.ok) throw tagged(refused, read.why);
  return read.body;
}

/** The facts one step is judged on: the MCP's answer, the row, and Google's own event. */
async function factsFor(answerData: unknown): Promise<CallFacts> {
  const d = answerData as { outcome?: string; booking?: { booking_id?: string; starts_at?: string } } | undefined;
  const answer = d?.booking?.booking_id ? { outcome: String(d.outcome), booking_id: d.booking.booking_id, starts_at: String(d.booking.starts_at) } : null;
  if (!answer) return { answer: null, row: null, event: null };
  try {
    const row = unwrap(
      await db.from("bookings").select("id, status, starts_at, gcal_event_id, agent_email").eq("id", answer.booking_id).single(),
      "rebook check row",
    ) as NonNullable<CallFacts["row"]>;
    const event = row.gcal_event_id && row.agent_email ? await getEventOnPrimary(row.agent_email, row.gcal_event_id) : null;
    return { answer, row, event };
  } catch (err) {
    throw tagged("rowUnreadable", `booking ${answer.booking_id}: ${err instanceof Error ? err.name : "the read threw"}`);
  }
}

function judged(verdict: { ok: true } | { ok: false; why: string }, what: string): void {
  if (!verdict.ok) throw tagged("notProven", `${what}: ${verdict.why}`);
  step(what);
}

const made: string[] = [];
function remember(answerData: unknown): void {
  const id = (answerData as { booking?: { booking_id?: string } } | undefined)?.booking?.booking_id;
  if (id && !made.includes(id)) made.push(id);
}
const reason = validateReason({ code: "other", detail: "rebook check" }, CANCEL_REASONS);
let outcome: { outcome: RebookOutcome; detail?: string } = { outcome: "proven" };
try {
  if (!reason.ok) throw new Error("the cancel reason this run sends is not one of Slate's");
  const found = await mcp("find_times", {});
  const times = ((found.data as { times?: { slot_id: string; starts_at: string }[] } | undefined)?.times ?? []);
  if (times.length < 1) exit("noTimes", "0 offered");
  const slot = times[0]!;
  step(`find_times offered ${times.length} times on ${PARTNER_BUCKET_CODE}; using ${slot.starts_at}`);

  // Every booking the MCP names is recorded BEFORE it is read back, so a read that throws
  // still leaves it for cleanup to cancel.
  const firstData = (await mcp("book", { slot_id: slot.slot_id })).data;
  remember(firstData);
  const first = await factsFor(firstData);
  judged(bookVerdict(first), `first book: booking ${first.answer?.booking_id} confirmed, with a live calendar event`);

  const firstCancel = await factsFor((await mcp("cancel", { reason_code: reason.reason.code, reason_detail: reason.reason.detail })).data);
  judged(cancelVerdict(firstCancel), `cancel: booking ${first.answer!.booking_id} cancelled, and its calendar event gone`);

  // The point of the run: THE SAME slot, booked again now that the cancel freed it.
  const secondData = (await mcp("book", { slot_id: slot.slot_id }, "rebookRefused")).data;
  remember(secondData);
  const second = await factsFor(secondData);
  judged(bookVerdict(second), `rebook: booking ${second.answer?.booking_id} confirmed, with a live calendar event`);
  judged(sameSlotVerdict(first, second), "the rebook holds the same time as a new booking with its own event");

  const secondCancel = await factsFor((await mcp("cancel", { reason_code: reason.reason.code, reason_detail: reason.reason.detail })).data);
  judged(cancelVerdict(secondCancel), `cancel: booking ${second.answer!.booking_id} cancelled, and its calendar event gone`);
} catch (err) {
  // A throw no step tagged is the run's own fault, never claimed as a refusal.
  const o = (err as { outcome?: RebookOutcome }).outcome ?? "unexpected";
  outcome = { outcome: o, detail: err instanceof Error ? err.message : String(err) };
}

// --- always: every call this run made is cancelled, and read back as cancelled ----------------
const cleanup: { outcome: "residue" | "cleanupUnverified"; detail: string }[] = [];
for (const id of made) {
  try {
    const status = (unwrap(await db.from("bookings").select("status").eq("id", id).single(), "cleanup read") as { status: string }).status;
    if (status === "cancelled") continue;
    if (reason.ok) await service.cancelDirectBooking({ bookingId: id, identity: { externalId: LEAD, salesforceId: LEAD }, reason: reason.reason });
    const after = (unwrap(await db.from("bookings").select("status").eq("id", id).single(), "cleanup read") as { status: string }).status;
    if (after !== "cancelled") cleanup.push({ outcome: "residue", detail: `booking ${id} is ${after}; cancel it by hand` });
    else step(`cleanup cancelled booking ${id}`);
  } catch {
    cleanup.push({ outcome: "cleanupUnverified", detail: `read booking ${id} and cancel it by hand if it is active` });
  }
}
const end = rebookFinalOutcome(outcome, cleanup);
exit(end.outcome, end.detail);
