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
//   5. that a store failure THROWS rather than reporting a clean drop.
import { readFileSync, readdirSync } from "node:fs";
import {
  classifyRegalCall,
  processRegalCall,
  unixSecondsToMs,
  REGAL_CALL_REASONS,
  REGAL_CALL_UNREADABLE_REASONS,
  type RegalCallRow,
  type RegalCallReason,
} from "@/lib/regal/inbound-call";
import { assert, eq, finish } from "./lib/harness.ts";

// Shape of a real body (2026-09-08 samples), values invented. No real lead data.
const COMPLETED_AT = 1788889891;
function body(over: Record<string, unknown> = {}, props: Record<string, unknown> = {}): unknown {
  return {
    traits: { phone: "+15555550100", email: "lead@example.com" },
    name: "call.completed",
    userId: "00Q000000000001",
    eventId: "0123456789abcdef0123456789abcdef",
    properties: {
      agent_email: "Jane.Agent@trypennie.com",
      agent_id: "a-1",
      agent_fullname: "Jane Agent",
      agent_teams: [],
      is_ai_agent: false,
      direction: "OUTBOUND",
      disposition: "Connected",
      notes: "the lead said something private",
      contact_phone: "+15555550100",
      started_at: COMPLETED_AT - 120,
      ended_at: COMPLETED_AT,
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
const first = await processRegalCall(body(), store.deps);
eq(first, { reason: "candidate", duplicate: false }, "a Slate user's call is a candidate");
const again = await processRegalCall(body(), store.deps);
eq(again, { reason: "candidate", duplicate: true }, "the same eventId again is reported as a duplicate");
eq(store.rows.length, 1, "the same eventId twice produces ONE record");
eq(
  Object.keys(store.rows[0]).sort(),
  ["agent_email", "event_id", "occurred_at", "reason"],
  "a candidate row holds the email, the event id, the instant and the reason, nothing else",
);
eq(store.rows[0].occurred_at, new Date(COMPLETED_AT * 1000).toISOString(), "the instant is stored as ISO");
const serialized = JSON.stringify(store.rows);
for (const leak of ["lead@example.com", "5555550100", "00Q000000000001", "private", "Jane Agent"]) {
  assert(!serialized.includes(leak), `nothing of the lead or the call survives the edge (${leak})`);
}

const nobody = await processRegalCall(
  body({ eventId: "ffffffffffffffffffffffffffffffff" }, { agent_email: "new.hire@trypennie.com" }),
  store.deps,
);
eq(nobody.reason, "no_slate_user", "an address on our domain with no Slate row is counted, not stored as a candidate");
const nobodyRow = store.rows.find((r) => r.event_id === "ffffffffffffffffffffffffffffffff");
eq(nobodyRow ? nobodyRow.agent_email : "no row", null, "a non candidate row carries no email");

const ai = await processRegalCall(
  body({ eventId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, { is_ai_agent: true, agent_email: "bot@regal.ai" }),
  store.deps,
);
eq(ai.reason, "ai_agent", "a dropped event is still recorded under its reason");
assert(!fakeStoreLookups.includes("bot@regal.ai"), "a dropped event never costs a user lookup");

const broken1 = await processRegalCall(null, store.deps);
const broken2 = await processRegalCall(null, store.deps);
eq([broken1.reason, broken2.reason], ["body_unreadable", "body_unreadable"], "an unreadable body is counted");
eq(
  store.rows.filter((r) => r.reason === "body_unreadable").length,
  2,
  "two unreadable bodies are two records: with no event id there is nothing to dedupe on",
);

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

finish();
