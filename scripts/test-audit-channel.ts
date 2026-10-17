// #3542: the channel a write came through is recorded on its audit row, in
// `details.channel`, and Marcia's machine writes carry it.
//
// Four things are pinned here, offline:
//
//   - `auditInsertRow` (the one row builder `recordAudit` writes) puts the channel
//     in `details.channel` and nowhere else, and lets the field win over any
//     `channel` key a caller left in `details`, so the fact has ONE home (L83);
//   - `marciaAuditEntry` builds the row the plan describes: a null actor (the
//     column is nullable, and Marcia is not a Slate user), the org of the booking's
//     bucket (the column is NOT NULL), and the lead's 00Q id, the channel and the
//     test mark in `details`;
//   - how the admin trail reads such a row: the actor is the channel plus the lead's
//     00Q id (worded per channel, walked over the whole channel list), and the test
//     mark is read only on a row a channel wrote;
//   - `details.channel` is inside what the 0160 hash chain hashes, so editing it
//     changes the link (the database half of that, against a real Postgres with the
//     append only trigger disabled for the edit only, is `pnpm verify:audit-chain-sql`).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-audit-channel.ts
import { AUDIT_ACTIONS, AUDIT_CHANNELS, auditInsertRow } from "../src/lib/audit.ts";
import { MARCIA_AUDIT_ACTIONS, marciaAuditEntry } from "../src/lib/mcp-booking/audit-entry.ts";
import { auditActionLabel, auditActorText, auditDetailText } from "../src/lib/audit-display.ts";
import { AUDIT_CHAIN_GENESIS, chainLink, type AuditChainRow } from "../src/lib/monitor/audit-chain.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const BOOKING = { id: "00000000-0000-4000-8000-0000000000bb", org_id: ORG };

// --- the row builder ------------------------------------------------------------
{
  const row = auditInsertRow({
    orgId: ORG,
    actorId: null,
    action: "booking.created",
    channel: "marcia",
    details: { booking_id: BOOKING.id },
  });
  eq(row.details, { booking_id: BOOKING.id, channel: "marcia" }, "the channel lands in details.channel beside the caller's details");
  eq(row.actor_id, null, "a null actor stays null");
  eq(row.org_id, ORG, "the org is the one given");

  const plain = auditInsertRow({ orgId: ORG, actorId: "u1", action: "role.set", details: { from: "agent", to: "admin" } });
  eq(plain.details, { from: "agent", to: "admin" }, "a write that names no channel gains no channel key, so existing rows are unchanged");

  // A caller that smuggles its own `channel` into details cannot override the field:
  // the field is the one home of the fact.
  const smuggled = auditInsertRow({
    orgId: ORG,
    actorId: null,
    action: "booking.cancelled",
    channel: "marcia",
    details: { channel: "web" } as unknown as Record<string, unknown>,
  });
  eq(smuggled.details.channel, "marcia", "the channel field wins over a channel key left in details");
  const smuggledAlone = auditInsertRow({
    orgId: ORG,
    actorId: "u1",
    action: "role.set",
    details: { channel: "marcia" } as unknown as Record<string, unknown>,
  });
  eq("channel" in smuggledAlone.details, false, "a channel key in details with no channel field is dropped, never recorded as a channel");
}

// --- Marcia's rows --------------------------------------------------------------
{
  const entry = marciaAuditEntry({
    action: "booking.created",
    booking: BOOKING,
    salesforceId: "00Q5f00000AbCdEFGH",
    isTest: false,
  });
  eq(entry.actorId, null, "Marcia's row has a null actor: she is not a Slate user");
  eq(entry.orgId, ORG, "the org is the booking's (the bucket's) org, since org_id is NOT NULL");
  eq(entry.channel, "marcia", "the channel is marcia");
  eq(entry.details?.salesforce_id, "00Q5f00000AbCdEFGH", "the lead's 00Q id is in details");
  eq(entry.details?.test, false, "the test mark is explicit, false for a real booking");
  eq(entry.details?.booking_id, BOOKING.id, "the booking the write touched is named");
  eq(entry.targetUserId ?? null, null, "no target user: target_id is a users FK and a lead is not one");

  const test = marciaAuditEntry({ action: "booking.cancelled", booking: BOOKING, salesforceId: "00Q5f00000AbCdEFGH", isTest: true });
  eq(test.details?.test, true, "a test booking is marked as one");

  // Every Marcia action is a real action of the trail, with a label.
  for (const action of MARCIA_AUDIT_ACTIONS) {
    assert((AUDIT_ACTIONS as readonly string[]).includes(action), `${action} is in the audit vocabulary`);
    assert(auditActionLabel(action) !== action, `${action} has a readable label`);
  }
  assert(MARCIA_AUDIT_ACTIONS.length === 3, "book, move and cancel each have an action");
  assert((AUDIT_CHANNELS as readonly string[]).includes("marcia"), "marcia is a declared channel");
}

// --- how the trail reads a Marcia row ---------------------------------------------
{
  const nameOf = (id: string | null) => (id ? `Name(${id})` : "unassigned");
  const row = { action: "booking.created", actor_id: null, details: { channel: "marcia", salesforce_id: "00Q5f00000AbCdEFGH", test: false } };
  eq(auditActorText(row, nameOf), "Marcia, for lead 00Q5f00000AbCdEFGH", "Marcia's actor is the bot plus the lead's 00Q id, never 'unassigned'");
  eq(auditActorText({ ...row, details: { channel: "marcia" } }, nameOf), "Marcia, for an unrecorded lead", "a row missing its 00Q id says so");
  eq(auditDetailText({ ...row, details: { ...row.details, test: true } }), "test booking", "a test row says it is one");
  eq(auditDetailText(row), "", "a real row adds no test note");
  eq(auditDetailText({ action: "webhook.test_sent", actor_id: "u1", details: { test: true } }), "", "another action's own test key is not read as a test booking");
  // Walked over the whole channel vocabulary, so a channel added without wording is
  // caught here as well as by tsc.
  for (const channel of AUDIT_CHANNELS) {
    const text = auditActorText({ action: "booking.created", actor_id: null, details: { channel, salesforce_id: "00Q1" } }, nameOf);
    assert(text !== "unassigned" && text.endsWith("for lead 00Q1"), `a ${channel} row names its channel and lead (${text})`);
  }
  // An unknown channel value is not a channel: it reads as an ordinary null actor.
  eq(auditActorText({ action: "booking.created", actor_id: null, details: { channel: "nobody" } }, nameOf), "unassigned", "an undeclared channel string is not rendered as a channel");
  // A web row with a null actor and no channel still reads as before.
  eq(auditActorText({ action: "role.set", actor_id: null, details: {} }, nameOf), "unassigned", "a channel-less row is untouched");
}

// --- the chain hashes details.channel ----------------------------------------------
{
  const base: AuditChainRow = {
    id: "00000000-0000-4000-8000-000000000001",
    org_id: ORG,
    actor_id: null,
    action: "booking.created",
    target_id: null,
    details: '{"test": false, "channel": "marcia", "booking_id": "b1", "salesforce_id": "00Q5f00000AbCdEFGH"}',
    created_at: "2026-10-16T01:00:00.000001+00:00",
    chain_seq: 1,
    chain_hash: "",
  };
  const real = await chainLink(AUDIT_CHAIN_GENESIS, base);
  const edited = await chainLink(AUDIT_CHAIN_GENESIS, { ...base, details: base.details.replace('"marcia"', '"web"') });
  assert(real !== null && edited !== null, "both rows hash");
  assert(real !== edited, "editing details.channel changes the chain link, so the walk catches it as altered");
}

finish();
