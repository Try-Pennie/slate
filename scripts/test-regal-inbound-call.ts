// The inbound Regal call feed (#2090). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-regal-inbound-call.ts
//
// Regal posts one `call.completed` body per call to /api/regal/calls. Almost none
// of them are about a person Slate routes to: most are the AI agent or a
// progressive dialer attempt that never reached anybody. So the edge filter does
// the heavy lifting, and a filter that stores nothing on a quiet day reads exactly
// like one that is broken or one nobody is posting to (L98, L506). Every event is
// therefore recorded under exactly ONE named reason, and the reasons that mean
// "Regal changed its contract" are their own buckets rather than a quiet drop.
//
// This file pins:
//   1. each filter condition, in both directions, and absent vs null vs false;
//   2. the unix SECONDS conversion, and a refusal rather than a guess;
//   3. that nothing about the lead survives the edge (only email, id, instant);
//   4. idempotency: the same event id twice is one record, driven through a fake
//      that enforces the unique constraint the migration declares, and the
//      migration really declaring it;
//   5. that a store failure THROWS rather than reporting a clean drop;
//   6. the call OUTCOME row (#2944): the lead, the talk time and the start,
//      each refused by name rather than read as zero, and the outcome row's
//      own idempotency and failure boundary beside the detector row's.
import { readFileSync, readdirSync } from "node:fs";
import {
  classifyRegalCall,
  extractCallOutcome,
  processRegalCall,
  processRegalCallDelivery,
  processRegalCallOutcome,
  unixSecondsToMs,
  REGAL_CALL_REASONS,
  REGAL_CALL_UNREADABLE_REASONS,
  REGAL_OUTCOME_REFUSALS,
  type RegalCallOutcomeRow,
  type RegalCallOutcomeRefusal,
  type RegalCallRow,
  type RegalCallReason,
} from "@/lib/regal/inbound-call";
import { assert, eq, finish } from "./lib/harness.ts";

// Shape of a real body (2026-09-08 samples, widened with the call outcome fields
// captured from Regal on 2026-10-01 for #2944), values invented. No real lead data.
const COMPLETED_AT = 1788889891;
const LEAD_ID_18 = "00QUi000010C2C1MAK";
function body(over: Record<string, unknown> = {}, props: Record<string, unknown> = {}): unknown {
  return {
    traits: { phone: "+15555550100", email: "lead@example.com" },
    name: "call.completed",
    userId: LEAD_ID_18,
    eventId: "0123456789abcdef0123456789abcdef",
    properties: {
      agent_email: "Jane.Agent@trypennie.com",
      agent_id: "a-1",
      agent_fullname: "Jane Agent",
      agent_teams: [],
      is_ai_agent: false,
      direction: "OUTBOUND",
      disposition: "1.1A - No Show - First Call",
      type: "Manual Outbound Call",
      talk_time: 32,
      conversation_happened: false,
      handle_time: 81,
      wrapup_time: 49,
      call_id: "WTxxxx",
      sip_response_code: "200",
      notes: "the lead said something private",
      contact_phone: "+15555550100",
      started_at: COMPLETED_AT - 81,
      ended_at: COMPLETED_AT - 49,
      completed_at: COMPLETED_AT,
      ...props,
    },
    originalTimestamp: String(COMPLETED_AT),
    eventSource: "Regal Voice",
    ...over,
  };
}

function withoutProp(key: string): unknown {
  const b = body() as { properties: Record<string, unknown> };
  delete b.properties[key];
  return b;
}

// --- 1. the filter, one condition at a time ---------------------------------

const human = classifyRegalCall(body());
eq(human.kind, "pending", "a human agent's completed call on our domain goes on to the user lookup");
if (human.kind === "pending") {
  eq(human.agentEmail, "jane.agent@trypennie.com", "the email is normalised the way users.email is stored");
  eq(human.eventId, "0123456789abcdef0123456789abcdef", "the top level eventId is the key");
  eq(human.occurredAtMs, COMPLETED_AT * 1000, "completed_at is unix SECONDS, multiplied explicitly");
}

function reasonOf(b: unknown): RegalCallReason | "pending" {
  const c = classifyRegalCall(b);
  return c.kind === "pending" ? "pending" : c.reason;
}

eq(reasonOf(body({ name: "call.started" })), "not_call_completed", "another event type is its own reason");
eq(reasonOf(body({ name: undefined })), "not_call_completed", "no name is not a completed call");
eq(reasonOf(body({}, { is_ai_agent: true })), "ai_agent", "an AI agent call is dropped by the coded rule");
eq(reasonOf(withoutProp("is_ai_agent")), "ai_flag_unreadable", "an ABSENT is_ai_agent is unreadable, never a human");
eq(reasonOf(body({}, { is_ai_agent: "false" })), "ai_flag_unreadable", "a string is not the boolean false");
eq(reasonOf(body({}, { is_ai_agent: null })), "ai_flag_unreadable", "a null flag is not the boolean false");
eq(reasonOf(body({}, { agent_email: null })), "agent_email_null", "an explicit null agent is the ordinary dialer attempt");
eq(reasonOf(withoutProp("agent_email")), "agent_email_unreadable", "an ABSENT agent_email is not the same as null");
eq(reasonOf(body({}, { agent_email: 42 })), "agent_email_unreadable", "a non string agent_email is unreadable");
eq(reasonOf(body({}, { agent_email: "   " })), "agent_email_unreadable", "a blank agent_email is unreadable");
eq(
  reasonOf(body({}, { agent_email: "agent_pennie-mgmt_12@regal.ai", is_ai_agent: false })),
  "foreign_domain",
  "an address off our domain can never be a Slate user",
);
eq(
  reasonOf(body({}, { agent_email: "someone@trypennie.com.evil.com" })),
  "foreign_domain",
  "a suffix is not our domain",
);
eq(reasonOf(body({ eventId: undefined })), "event_id_unreadable", "no eventId means no idempotency key");
eq(reasonOf(body({ eventId: "" })), "event_id_unreadable", "an empty eventId is unreadable");
eq(reasonOf(body({ eventId: 12345 })), "event_id_unreadable", "a numeric eventId is unreadable");
eq(reasonOf(body({ eventId: "x".repeat(200) })), "event_id_unreadable", "an absurd eventId is unreadable");
eq(reasonOf(null), "body_unreadable", "a null body is unreadable");
eq(reasonOf("call.completed"), "body_unreadable", "a string body is unreadable");
eq(reasonOf([body()]), "body_unreadable", "an array body is unreadable");
eq(reasonOf(body({ properties: "x" })), "body_unreadable", "properties that are not an object are unreadable");

// The drop order matters in one place: an AI call must never reach the email
// checks, because its email is on regal.ai and would otherwise be counted as a
// foreign address, which is a different remedy (L11).
eq(
  reasonOf(body({}, { is_ai_agent: true, agent_email: "agent_pennie-mgmt_12@regal.ai" })),
  "ai_agent",
  "an AI agent on regal.ai is counted as an AI agent, not as a foreign address",
);

// --- 2. the timestamp -------------------------------------------------------

eq(unixSecondsToMs(COMPLETED_AT), COMPLETED_AT * 1000, "a number of seconds converts");
eq(unixSecondsToMs(String(COMPLETED_AT)), COMPLETED_AT * 1000, "a string of digits converts (originalTimestamp)");
eq(unixSecondsToMs(null), null, "null is refused");
eq(unixSecondsToMs(undefined), null, "absent is refused");
eq(unixSecondsToMs("2026-09-08T12:00:00Z"), null, "an ISO string is refused rather than guessed at");
eq(unixSecondsToMs(COMPLETED_AT * 1000), null, "milliseconds read as seconds would be year 58000, refused");
eq(unixSecondsToMs(12), null, "a value in 1970 is refused");
eq(unixSecondsToMs(Number.NaN), null, "NaN is refused");
eq(unixSecondsToMs("17888898.91"), null, "a fractional string is refused");

eq(
  reasonOf(body({ originalTimestamp: undefined }, { completed_at: null })),
  "timestamp_unreadable",
  "no readable instant at all is its own reason",
);
{
  const c = classifyRegalCall(body({}, { completed_at: null }));
  eq(c.kind === "pending" ? c.occurredAtMs : -1, COMPLETED_AT * 1000, "falls back to originalTimestamp");
}
eq(
  reasonOf(body({}, { completed_at: "2026-09-08T12:00:00Z" })),
  "timestamp_unreadable",
  "an unreadable completed_at is refused, never replaced by a neighbouring field",
);

// --- 3. the vocabulary ------------------------------------------------------

assert(REGAL_CALL_REASONS.includes("candidate"), "candidate is a reason");
for (const r of REGAL_CALL_UNREADABLE_REASONS) {
  assert(REGAL_CALL_REASONS.includes(r), `unreadable reason ${r} is in the vocabulary`);
}
eq(new Set(REGAL_CALL_REASONS).size, REGAL_CALL_REASONS.length, "no reason is listed twice");

// The migration's CHECK constraint must be the same list, in both directions, or a
// new reason in code is refused by the database and lost (L41).
const migrationsDir = "supabase/migrations";
const migration = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(`${migrationsDir}/${f}`, "utf8"))
  .find((sql) => /create table regal_call_events/.test(sql));
assert(migration !== undefined, "a migration creates regal_call_events");
const checkList = /reason\s+text\s+not\s+null\s+check\s*\(\s*reason\s+in\s*\(([^)]*)\)/.exec(migration ?? "");
assert(checkList !== null, "the reason column carries a CHECK over a literal list");
const sqlReasons = new Set([...(checkList?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
eq([...sqlReasons].sort(), [...REGAL_CALL_REASONS].sort(), "the CHECK list equals the code's vocabulary");
assert(
  /event_id\s+text\s+unique/.test(migration ?? ""),
  "event_id carries a UNIQUE constraint, which is what makes a redelivery harmless",
);

// --- 4. processing, idempotency, and what is stored -------------------------

/** A store that behaves like the table: event_id unique, NULLs distinct. */
function fakeStore(users: Record<string, string>) {
  const rows: RegalCallRow[] = [];
  return {
    rows,
    deps: {
      findUserId: async (email: string) => {
        (fakeStoreLookups as string[]).push(email);
        return users[email] ?? null;
      },
      insert: async (row: RegalCallRow): Promise<"inserted" | "duplicate"> => {
        if (row.event_id !== null && rows.some((r) => r.event_id === row.event_id)) return "duplicate";
        rows.push(row);
        return "inserted";
      },
    },
  };
}
const fakeStoreLookups: string[] = [];

const store = fakeStore({ "jane.agent@trypennie.com": "user-1" });
/** The reason an outcome was recorded under, or "duplicate" when nothing new was. */
const reasonOf2 = (o: Awaited<ReturnType<typeof processRegalCall>>): string =>
  o.status === "recorded" ? o.reason : "duplicate";

const first = await processRegalCall(body(), store.deps);
eq(first, { status: "recorded", reason: "candidate" }, "a Slate user's call is a candidate");
const again = await processRegalCall(body(), store.deps);
eq(
  again,
  { status: "duplicate", eventId: "0123456789abcdef0123456789abcdef" },
  "the same eventId again is a DUPLICATE outcome, carrying no freshly computed reason",
);
eq(store.rows.length, 1, "the same eventId twice produces ONE record");
eq(
  Object.keys(store.rows[0]).sort(),
  ["agent_email", "event_id", "occurred_at", "reason"],
  "a candidate row holds the email, the event id, the instant and the reason, nothing else",
);
eq(store.rows[0].occurred_at, new Date(COMPLETED_AT * 1000).toISOString(), "the instant is stored as ISO");
const serialized = JSON.stringify(store.rows);
for (const leak of ["lead@example.com", "5555550100", LEAD_ID_18.slice(0, 15), "private", "Jane Agent"]) {
  assert(!serialized.includes(leak), `nothing of the lead or the call survives the edge (${leak})`);
}

const nobody = await processRegalCall(
  body({ eventId: "ffffffffffffffffffffffffffffffff" }, { agent_email: "new.hire@trypennie.com" }),
  store.deps,
);
eq(reasonOf2(nobody), "no_slate_user", "an address on our domain with no Slate row is counted, not stored as a candidate");
const nobodyRow = store.rows.find((r) => r.event_id === "ffffffffffffffffffffffffffffffff");
eq(nobodyRow ? nobodyRow.agent_email : "no row", null, "a non candidate row carries no email");

const ai = await processRegalCall(
  body({ eventId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, { is_ai_agent: true, agent_email: "bot@regal.ai" }),
  store.deps,
);
eq(reasonOf2(ai), "ai_agent", "a dropped event is still recorded under its reason");
assert(!fakeStoreLookups.includes("bot@regal.ai"), "a dropped event never costs a user lookup");

const broken1 = await processRegalCall(null, store.deps);
const broken2 = await processRegalCall(null, store.deps);
eq([reasonOf2(broken1), reasonOf2(broken2)], ["body_unreadable", "body_unreadable"], "an unreadable body is counted");
eq(
  store.rows.filter((r) => r.reason === "body_unreadable").length,
  2,
  "two unreadable bodies are two records: with no event id there is nothing to dedupe on",
);

// A redelivery whose classification would now DIFFER from the stored row: the
// person was created in Slate between the two deliveries. The stored row keeps
// no_slate_user (the constraint ignored the second insert), so the outcome must
// say duplicate rather than report a candidate that was never recorded.
{
  const later = fakeStore({});
  const evt = body({ eventId: "dddddddddddddddddddddddddddddddd" }, { agent_email: "late.hire@trypennie.com" });
  const firstTime = await processRegalCall(evt, later.deps);
  eq(reasonOf2(firstTime), "no_slate_user", "first delivery: no Slate user yet");
  const hired = { ...later.deps, findUserId: async () => "user-late" };
  const redelivered = await processRegalCall(evt, hired);
  eq(redelivered.status, "duplicate", "the redelivery is a duplicate, not a candidate");
  eq(later.rows.map((r) => r.reason), ["no_slate_user"], "and the stored row is unchanged");
}

// --- 5. a failed store throws ------------------------------------------------

let threw = "";
try {
  await processRegalCall(body({ eventId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }), {
    findUserId: async () => {
      throw new Error("users read refused");
    },
    insert: async () => "inserted",
  });
} catch (err) {
  threw = err instanceof Error ? err.message : String(err);
}
eq(threw, "users read refused", "a failed user lookup throws, never counting the event as no_slate_user");

threw = "";
try {
  await processRegalCall(body({ eventId: "cccccccccccccccccccccccccccccccc" }), {
    findUserId: async () => "user-1",
    insert: async () => {
      throw new Error("insert refused");
    },
  });
} catch (err) {
  threw = err instanceof Error ? err.message : String(err);
}
eq(threw, "insert refused", "a failed insert throws rather than reporting a recorded event");

// --- 6. the call outcome row (#2944) ----------------------------------------
//
// Show rate in the Slate vs cal.com split is judged from these rows, so a value
// Slate could not read must be REFUSED by name and never stored as a zero: a
// talk time read as 0 is a no show that never happened.

{
  const x = extractCallOutcome(body());
  eq(x.kind, "row", "a real call.completed body yields an outcome row");
  if (x.kind === "row") {
    eq(
      x.row,
      {
        event_id: "0123456789abcdef0123456789abcdef",
        lead_key: LEAD_ID_18.slice(0, 15),
        started_at: new Date((COMPLETED_AT - 81) * 1000).toISOString(),
        talk_time_s: 32,
        conversation_happened: false,
        direction: "OUTBOUND",
        call_type: "Manual Outbound Call",
        disposition: "1.1A - No Show - First Call",
        is_ai_agent: false,
        agent_email: "jane.agent@trypennie.com",
      },
      "the row holds the lead key, the start, the talk time and the call's labels, nothing else",
    );
    const stored = JSON.stringify(x.row);
    for (const leak of ["lead@example.com", "5555550100", "private", "Jane Agent", "WTxxxx"]) {
      assert(!stored.includes(leak), `no contact data or notes reach the outcome row (${leak})`);
    }
  }
}

function refusalOf(b: unknown): RegalCallOutcomeRefusal | "row" {
  const x = extractCallOutcome(b);
  return x.kind === "row" ? "row" : x.reason;
}

// The lead id: the 18 character form and the 15 character form are one lead.
{
  const fifteen = extractCallOutcome(body({ userId: LEAD_ID_18.slice(0, 15) }));
  eq(fifteen.kind === "row" ? fifteen.row.lead_key : "refused", LEAD_ID_18.slice(0, 15), "a 15 character id keys the same lead");
  const padded = extractCallOutcome(body({ userId: `  ${LEAD_ID_18} ` }));
  eq(padded.kind === "row" ? padded.row.lead_key : "refused", LEAD_ID_18.slice(0, 15), "surrounding space is not part of the id");
}
eq(refusalOf(body({ userId: undefined })), "lead_id_unreadable", "no userId is refused");
eq(refusalOf(body({ userId: null })), "lead_id_unreadable", "a null userId is refused");
eq(refusalOf(body({ userId: "" })), "lead_id_unreadable", "an empty userId is refused");
eq(refusalOf(body({ userId: 42 })), "lead_id_unreadable", "a numeric userId is refused");
eq(refusalOf(body({ userId: "003Ui000010C2C1MAK" })), "not_a_lead", "a Contact id is not a lead, and says so");
eq(refusalOf(body({ userId: "00QUi000010C2C1MA" })), "not_a_lead", "a 17 character id is not a Salesforce id");

// The talk time: absent, null, negative, not a number: refused, never zero.
eq(refusalOf(withoutProp("talk_time")), "talk_time_unreadable", "an ABSENT talk_time is refused, never read as zero");
eq(refusalOf(body({}, { talk_time: null })), "talk_time_unreadable", "a null talk_time is refused");
eq(refusalOf(body({}, { talk_time: -1 })), "talk_time_unreadable", "a negative talk_time is refused");
eq(refusalOf(body({}, { talk_time: "32" })), "talk_time_unreadable", "a string talk_time is refused");
eq(refusalOf(body({}, { talk_time: Number.NaN })), "talk_time_unreadable", "NaN is refused");
eq(refusalOf(body({}, { talk_time: Number.POSITIVE_INFINITY })), "talk_time_unreadable", "infinity is refused");
eq(refusalOf(body({}, { talk_time: 90_000 })), "talk_time_unreadable", "a call longer than a day is not a talk time");
{
  const zero = extractCallOutcome(body({}, { talk_time: 0 }));
  eq(zero.kind === "row" ? zero.row.talk_time_s : -1, 0, "a real zero (nobody spoke) IS a talk time and is kept");
  const frac = extractCallOutcome(body({}, { talk_time: 32.6 }));
  eq(frac.kind === "row" ? frac.row.talk_time_s : -1, 33, "a fractional second rounds to the integer column");
  // The boundary the show rule cares about is NOT judged here: 299 and 300 are
  // both stored exactly, and deciding which is a show is the split's job.
  const at299 = extractCallOutcome(body({}, { talk_time: 299 }));
  const at300 = extractCallOutcome(body({}, { talk_time: 300 }));
  eq(
    [at299.kind === "row" ? at299.row.talk_time_s : -1, at300.kind === "row" ? at300.row.talk_time_s : -1],
    [299, 300],
    "talk times either side of the show threshold are stored as they are, with no show logic here",
  );
}

// The start: unix SECONDS, no fallback to a neighbouring field.
eq(refusalOf(withoutProp("started_at")), "started_at_unreadable", "an absent started_at is refused");
eq(refusalOf(body({}, { started_at: null })), "started_at_unreadable", "a null started_at is refused");
eq(refusalOf(body({}, { started_at: "2026-10-01T12:00:00Z" })), "started_at_unreadable", "an ISO started_at is refused");
eq(refusalOf(body({}, { started_at: (COMPLETED_AT - 81) * 1000 })), "started_at_unreadable", "milliseconds are refused");

// The rest of the shape.
eq(refusalOf(null), "body_unreadable", "a null body yields no outcome");
eq(refusalOf(body({ properties: "x" })), "body_unreadable", "unreadable properties yield no outcome");
eq(refusalOf(body({ name: "call.started" })), "not_call_completed", "only a completed call is an outcome");
eq(refusalOf(body({ eventId: undefined })), "event_id_unreadable", "no eventId means no idempotency key");
eq(refusalOf(body({ eventId: "x".repeat(200) })), "event_id_unreadable", "an absurd eventId is refused");
eq(refusalOf(withoutProp("is_ai_agent")), "ai_flag_unreadable", "an absent AI flag is refused, never read as human");
eq(refusalOf(body({}, { is_ai_agent: "false" })), "ai_flag_unreadable", "a string AI flag is refused");

// AI and dialer calls ARE outcomes: which calls count as a show is decided later,
// over all of them, so the edge must not pre-filter what the split needs.
{
  const ai = extractCallOutcome(body({}, { is_ai_agent: true, agent_email: "agent_pennie-mgmt_12@regal.ai" }));
  eq(
    ai.kind === "row" ? [ai.row.is_ai_agent, ai.row.agent_email] : null,
    [true, "agent_pennie-mgmt_12@regal.ai"],
    "an AI agent call is stored and says so",
  );
  const dialer = extractCallOutcome(body({}, { agent_email: null }));
  eq(dialer.kind === "row" ? dialer.row.agent_email : "refused", null, "an unanswered dialer attempt is stored with no agent");
  const odd = extractCallOutcome(body({}, { conversation_happened: "yes", direction: 7, type: "", disposition: "   " }));
  eq(
    odd.kind === "row" ? [odd.row.conversation_happened, odd.row.direction, odd.row.call_type, odd.row.disposition] : null,
    [null, null, null, null],
    "an unreadable OPTIONAL label is stored as unknown (null), never guessed, and never refuses the row",
  );
}

// The vocabulary is the one the logs speak.
for (const r of [
  "body_unreadable",
  "not_call_completed",
  "event_id_unreadable",
  "lead_id_unreadable",
  "not_a_lead",
  "ai_flag_unreadable",
  "talk_time_unreadable",
  "started_at_unreadable",
] as const) {
  assert(REGAL_OUTCOME_REFUSALS.includes(r), `${r} is a named outcome refusal`);
}
eq(new Set(REGAL_OUTCOME_REFUSALS).size, REGAL_OUTCOME_REFUSALS.length, "no outcome refusal is listed twice");

// The migration: the table, its key, its checks and its RLS.
const outcomeMigration = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(`${migrationsDir}/${f}`, "utf8"))
  .find((sql) => /create table regal_call_outcomes/.test(sql));
assert(outcomeMigration !== undefined, "a migration creates regal_call_outcomes");
const om = outcomeMigration ?? "";
assert(/event_id\s+text\s+not\s+null\s+unique/.test(om), "event_id is NOT NULL and UNIQUE, so a redelivery is one row");
assert(
  /talk_time_s\s+integer\s+not\s+null\s+check\s*\(\s*talk_time_s\s*>=\s*0\s*\)/.test(om),
  "talk_time_s refuses a negative at the database too",
);
assert(/lead_key\s+text\s+not\s+null/.test(om), "every outcome names its lead");
assert(/started_at\s+timestamptz\s+not\s+null/.test(om), "every outcome has a start");
assert(/is_ai_agent\s+boolean\s+not\s+null/.test(om), "every outcome says whether a person placed it");
assert(/alter table regal_call_outcomes enable row level security/.test(om), "RLS is on");
assert(!/create policy/i.test(om), "and no policy opens it to a client");
assert(/on regal_call_outcomes\s*\(\s*lead_key\s*,\s*started_at\s*\)/.test(om), "indexed for the split's lookup by lead and start");
assert(/on regal_call_outcomes\s*\(\s*received_at\s*\)/.test(om), "indexed on arrival for retention and the monitor");
// Every column the code writes is declared, so the insert cannot meet a column
// that does not exist on the first real call.
{
  const x = extractCallOutcome(body());
  for (const col of x.kind === "row" ? Object.keys(x.row) : ["no row"]) {
    assert(new RegExp(`\\n\\s*${col}\\s`).test(om), `the migration declares ${col}`);
  }
}

// --- 7. the outcome store: idempotent, and its own failure boundary ----------

function fakeOutcomeStore() {
  const rows: RegalCallOutcomeRow[] = [];
  return {
    rows,
    deps: {
      insertOutcome: async (row: RegalCallOutcomeRow): Promise<"inserted" | "duplicate"> => {
        if (rows.some((r) => r.event_id === row.event_id)) return "duplicate";
        rows.push(row);
        return "inserted";
      },
    },
  };
}

{
  const os = fakeOutcomeStore();
  const a = await processRegalCallOutcome(body(), os.deps);
  const b = await processRegalCallOutcome(body(), os.deps);
  eq(a, { status: "stored", eventId: "0123456789abcdef0123456789abcdef" }, "the first delivery is stored");
  eq(b, { status: "duplicate", eventId: "0123456789abcdef0123456789abcdef" }, "a redelivery is a duplicate");
  eq(os.rows.length, 1, "a duplicate delivery is a no op: one row");
  const refused = await processRegalCallOutcome(body({}, { talk_time: null }), os.deps);
  eq(
    refused,
    { status: "refused", reason: "talk_time_unreadable", eventId: "0123456789abcdef0123456789abcdef" },
    "a refusal names its reason and writes nothing",
  );
  eq(os.rows.length, 1, "nothing was written for the refusal");
}

// The two rows are written independently: a failed or refused outcome must never
// stop the detector row, and a failed detector row must never stop the outcome.
{
  const det = fakeStore({ "jane.agent@trypennie.com": "user-1" });
  const d = await processRegalCallDelivery(body({ eventId: "e0000000000000000000000000000001" }), {
    detector: det.deps,
    outcome: {
      insertOutcome: async () => {
        throw new Error("outcome insert refused");
      },
    },
  });
  eq(
    d.detector.ok ? d.detector.value : null,
    { status: "recorded", reason: "candidate" },
    "an outcome insert failure leaves the detector row written",
  );
  eq(det.rows.length, 1, "the detector row is in the table");
  eq(
    d.outcome.ok ? "ok" : (d.outcome.error as Error).message,
    "outcome insert refused",
    "and the outcome failure is reported, not swallowed",
  );
}
{
  const os = fakeOutcomeStore();
  const d = await processRegalCallDelivery(body({ eventId: "e0000000000000000000000000000002" }), {
    detector: {
      findUserId: async () => "user-1",
      insert: async () => {
        throw new Error("detector insert refused");
      },
    },
    outcome: os.deps,
  });
  eq(d.outcome.ok ? d.outcome.value.status : "failed", "stored", "a detector insert failure leaves the outcome row written");
  eq(os.rows.length, 1, "the outcome row is in the table");
  eq(
    d.detector.ok ? "ok" : (d.detector.error as Error).message,
    "detector insert refused",
    "and the detector failure is reported",
  );
}
{
  const det = fakeStore({});
  const os = fakeOutcomeStore();
  const d = await processRegalCallDelivery(body({ eventId: "e0000000000000000000000000000003", userId: undefined }), {
    detector: det.deps,
    outcome: os.deps,
  });
  eq(
    d.outcome.ok ? d.outcome.value : null,
    { status: "refused", reason: "lead_id_unreadable", eventId: "e0000000000000000000000000000003" },
    "a refused outcome is a result, not an error",
  );
  eq(det.rows.length, 1, "and the detector row is still written");
}
{
  const det = fakeStore({});
  const os = fakeOutcomeStore();
  const evt = body({ eventId: "e0000000000000000000000000000004" });
  await processRegalCallDelivery(evt, { detector: det.deps, outcome: os.deps });
  const again = await processRegalCallDelivery(evt, { detector: det.deps, outcome: os.deps });
  eq(
    [again.detector.ok ? again.detector.value.status : "x", again.outcome.ok ? again.outcome.value.status : "x"],
    ["duplicate", "duplicate"],
    "a redelivered call is a duplicate on both tables",
  );
  eq([det.rows.length, os.rows.length], [1, 1], "and adds no row to either");
}

finish();
