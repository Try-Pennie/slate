// #2369: Regal may cancel a lead's earlier call ONLY when Slate can establish it is
// a real duplicate.
//
// Two halves, because the decision runs in PL/pgSQL and nothing in this repo has a
// database:
//
//  1. the MODEL (`scripts/lib/duplicate-cancel-rules.ts`) is driven through every
//     outcome, both directions wherever there are two;
//  2. the migration's SQL TEXT is read and required to carry each rule the model
//     implements, with a mutation control proving those assertions can fail (L1).
//
// Plus the pure HTTP contract and the handoff detail, which are what the route maps
// the answer onto.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-duplicate-cancel.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  decideDuplicateCancel,
  emailMatchKey,
  phoneMatchKey,
  type DuplicateRow,
} from "./lib/duplicate-cancel-rules.ts";
import {
  DUPLICATE_CANCEL_CODE,
  DUPLICATE_CANCEL_MESSAGE,
  DUPLICATE_CANCEL_STAGES,
  DUPLICATE_CANCEL_STATUS,
  DUPLICATE_FINDINGS,
  DUPLICATE_OUTCOMES,
  DuplicateCancelUnavailableError,
  duplicateFindingFor,
  duplicateHandoffDetail,
  isDuplicateOutcome,
  parseDuplicateCancelResult,
  type DuplicateOutcome,
} from "@/lib/booking/duplicate-cancel";
import { readDuplicateDetail } from "@/lib/handoffs/kinds";
import { cancelOutboxSteps } from "@/lib/booking/orchestration";

const ROOT = join(import.meta.dirname, "..");

/**
 * The migration that defines the function TODAY, derived rather than named (#2433).
 *
 * 0124 wrote `cancel_duplicate_booking` and 0127 replaced it, and a later change can
 * replace it again. A hardcoded path would go on judging a superseded definition and
 * keep passing while the live function drifted, which is the failure this suite is
 * here to catch in the first place (L41, L454).
 */
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const DEFINES = /create\s+or\s+replace\s+function\s+cancel_duplicate_booking\s*\(/i;
const definingMigrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .filter((f) => DEFINES.test(readFileSync(join(MIGRATIONS_DIR, f), "utf8")));
assert(
  definingMigrations.length > 0,
  "a migration defines cancel_duplicate_booking (an empty list would make every rule below vacuous)",
);
const MIGRATION_NAME = definingMigrations[definingMigrations.length - 1];
const MIGRATION = join(MIGRATIONS_DIR, MIGRATION_NAME);

/**
 * TWO readings, because two different questions are being asked.
 *
 * `SQL` is every migration that defines any part of this function, concatenated in
 * order: the rules below ask whether the shipped behaviour carries each guarantee, and
 * some of those live in pieces written once and never restated (the phone match key,
 * the `double_booking` reason row). Reading only the newest file would report those as
 * missing the moment a later migration replaces the outer function alone.
 *
 * `SQL_LATEST` is the newest defining file alone, and the outbox step list is compared
 * against THAT, because a step array is a thing the newest definition REPLACES. Read
 * from the concatenation it would see both copies at once and agree with whichever
 * order they happened to appear in (L336).
 */
const SQL_LATEST = readFileSync(MIGRATION, "utf8");
const SQL = definingMigrations
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
  .join("\n");

const NOW = Date.parse("2026-09-16T12:00:00.000Z");
const SOON = "2026-09-16T15:00:00.000Z";
const LATER = "2026-09-17T15:00:00.000Z";
const PAST = "2026-09-16T09:00:00.000Z";

let seq = 0;
const row = (over: Partial<DuplicateRow> = {}): DuplicateRow => ({
  id: `bk-${String(++seq).padStart(3, "0")}`,
  createdAt: "2026-09-10T10:00:00.000Z",
  startsAt: SOON,
  status: "confirmed",
  isTestBucket: false,
  salesforceId: "SF-1",
  externalId: null,
  attendeeEmail: "lead@example.com",
  attendeePhone: "+12035615295",
  ...over,
});

const decide = (named: DuplicateRow | null, others: DuplicateRow[], extra = {}) =>
  decideDuplicateCancel({ named, others, nowMs: NOW, ...extra });

// --- the normalisation the SQL applies ---------------------------------------

eq(emailMatchKey("  Lead@Example.COM "), "lead@example.com", "email key trims and lowercases");
eq(emailMatchKey("   "), null, "a blank email is no key at all, so it matches nothing");
eq(emailMatchKey(null), null, "a null email is no key");
eq(phoneMatchKey("(203) 561-5295"), "+12035615295", "the manage page's stored format normalises");
eq(phoneMatchKey("+1 203 561 5295"), "+12035615295", "an E.164 with spaces normalises");
eq(phoneMatchKey("2035615295"), "+12035615295", "ten bare digits normalise");
eq(phoneMatchKey("12035615295"), "+12035615295", "eleven digits beginning with 1 normalise");
eq(phoneMatchKey("+442071838750"), "+442071838750", "a number that is not ten or eleven digits is compared as written");
eq(phoneMatchKey(""), null, "a blank phone is no key at all");

// --- the named booking's own state -------------------------------------------

eq(decide(null, []).outcome, "not-found", "a booking Slate does not hold is not-found");
eq(
  decide(row({ status: "cancelled" }), [], { namedCancelledAsDuplicate: true }).outcome,
  "already-cancelled",
  "a retry after a successful cancel is already-cancelled, not a refusal",
);
eq(
  decide(row({ status: "cancelled" }), [], { namedCancelledAsDuplicate: false }).outcome,
  "not-active",
  "a booking cancelled for any OTHER reason is not-active, never already-cancelled",
);
eq(decide(row({ status: "completed" }), []).outcome, "not-active", "a completed call is not-active");
eq(decide(row({ startsAt: PAST }), []).outcome, "started", "a call that has begun is never cancelled");
eq(
  decide(row({ startsAt: "2026-09-16T12:00:00.000Z" }), []).outcome,
  "started",
  "a call starting exactly now has started: the boundary refuses",
);

// --- who counts as the same person -------------------------------------------

{
  const named = row({ id: "bk-named", createdAt: "2026-09-10T10:00:00.000Z" });
  const later = row({ id: "bk-later", createdAt: "2026-09-12T10:00:00.000Z", startsAt: LATER });
  const d = decide(named, [later]);
  eq(d.outcome, "cancelled", "a later BOOKED call under the same Salesforce id authorises the cancel");
  eq(d.candidateIds.join(","), "bk-later", "the candidate it judged is reported");
}
{
  const named = row({ id: "bk-named", salesforceId: null, externalId: "EXT-9" });
  const later = row({
    id: "bk-later",
    salesforceId: null,
    externalId: "EXT-9",
    createdAt: "2026-09-12T10:00:00.000Z",
    attendeeEmail: "other@example.com",
    attendeePhone: null,
  });
  eq(decide(named, [later]).outcome, "cancelled", "an external id match alone is a strong match");
}
{
  const named = row({ id: "bk-named", salesforceId: null });
  const later = row({
    id: "bk-later",
    salesforceId: null,
    createdAt: "2026-09-12T10:00:00.000Z",
    attendeeEmail: "LEAD@example.com",
    attendeePhone: "(203) 561-5295",
  });
  eq(
    decide(named, [later]).outcome,
    "cancelled",
    "email AND phone together are a medium match, across both stored phone formats",
  );
}
{
  const named = row({ id: "bk-named", salesforceId: null });
  const later = row({
    id: "bk-later",
    salesforceId: null,
    createdAt: "2026-09-12T10:00:00.000Z",
    attendeePhone: "+15550001111",
  });
  const d = decide(named, [later]);
  eq(d.outcome, "no-other-call", "email alone never authorises a cancel");
  eq(d.weakerMatch, "email-only", "and the near miss is reported as what it is");
}
{
  const named = row({ id: "bk-named", salesforceId: null });
  const later = row({
    id: "bk-later",
    salesforceId: null,
    createdAt: "2026-09-12T10:00:00.000Z",
    attendeeEmail: "someone.else@example.com",
  });
  const d = decide(named, [later]);
  eq(d.outcome, "no-other-call", "phone alone never authorises a cancel");
  eq(d.weakerMatch, "phone-only", "and the near miss is reported as what it is");
}
{
  const named = row({ id: "bk-named", salesforceId: null });
  const byEmail = row({ id: "bk-a", salesforceId: null, attendeePhone: "+15550001111" });
  const byPhone = row({ id: "bk-b", salesforceId: null, attendeeEmail: "nope@example.com" });
  eq(
    decide(named, [byEmail, byPhone]).weakerMatch,
    "email-only",
    "with both kinds of near miss the address is the one the reader is told about",
  );
}

// --- the identity conflict veto ----------------------------------------------

{
  const named = row({ id: "bk-named", salesforceId: "SF-1" });
  const clash = row({
    id: "bk-clash",
    salesforceId: "SF-2",
    createdAt: "2026-09-12T10:00:00.000Z",
  });
  const d = decide(named, [clash]);
  eq(d.outcome, "identity-conflict", "same email and phone under two Salesforce ids refuses");
  eq(d.candidateIds.length, 0, "and the clashing row is not counted as the same person");
}
{
  const named = row({ id: "bk-named", salesforceId: "SF-1" });
  const clash = row({ id: "bk-clash", salesforceId: "SF-2", createdAt: "2026-09-12T10:00:00.000Z" });
  const good = row({ id: "bk-good", salesforceId: "SF-1", createdAt: "2026-09-13T10:00:00.000Z" });
  eq(
    decide(named, [clash, good]).outcome,
    "identity-conflict",
    "the conflict is a HARD veto: a third call that would have authorised it does not lift it",
  );
}
{
  const named = row({ id: "bk-named", salesforceId: "SF-1", externalId: "EXT-1" });
  const other = row({
    id: "bk-other",
    salesforceId: "SF-1",
    externalId: "EXT-2",
    createdAt: "2026-09-12T10:00:00.000Z",
  });
  eq(
    decide(named, [other]).outcome,
    "cancelled",
    "a MATCHING Salesforce id settles identity, so a differing external id is not a conflict",
  );
}

// --- which rows are considered at all ----------------------------------------

{
  const named = row({ id: "bk-named" });
  const cancelled = row({ id: "bk-x", status: "cancelled", createdAt: "2026-09-12T10:00:00.000Z" });
  eq(decide(named, [cancelled]).outcome, "no-other-call", "a cancelled call is not another call");
}
{
  const named = row({ id: "bk-named" });
  const past = row({ id: "bk-x", startsAt: PAST, createdAt: "2026-09-12T10:00:00.000Z" });
  eq(decide(named, [past]).outcome, "no-other-call", "a call that has already started is not another call");
}
{
  const named = row({ id: "bk-named", isTestBucket: false });
  const smoke = row({ id: "bk-x", isTestBucket: true, createdAt: "2026-09-12T10:00:00.000Z", startsAt: LATER });
  eq(
    decide(named, [smoke]).outcome,
    "no-other-call",
    "a smoke test booking can never authorise cancelling a real one",
  );
  const namedTest = row({ id: "bk-named", isTestBucket: true });
  const real = row({ id: "bk-x", isTestBucket: false, createdAt: "2026-09-12T10:00:00.000Z", startsAt: LATER });
  eq(
    decide(namedTest, [real]).outcome,
    "no-other-call",
    "and a real booking can never authorise cancelling a smoke test one",
  );
  const otherSmoke = row({ id: "bk-y", isTestBucket: true, createdAt: "2026-09-12T10:00:00.000Z", startsAt: LATER });
  eq(
    decide(namedTest, [otherSmoke]).outcome,
    "cancelled",
    "two smoke bookings still judge each other, so the canary can exercise this path",
  );
}
{
  const named = row({ id: "bk-named" });
  eq(decide(named, [named]).outcome, "no-other-call", "the named booking is never its own duplicate");
}

// --- the newest test ----------------------------------------------------------

{
  const named = row({ id: "bk-named", createdAt: "2026-09-12T10:00:00.000Z" });
  const earlier = row({ id: "bk-old", createdAt: "2026-09-10T10:00:00.000Z", startsAt: LATER });
  const d = decide(named, [earlier]);
  eq(d.outcome, "named-is-newest", "Slate only cancels the EARLIER of two calls");
  eq(d.candidateIds.join(","), "bk-old", "and still says which call it compared against");
}
{
  const named = row({ id: "bk-named", createdAt: "2026-09-12T10:00:00.000Z" });
  const same = row({ id: "bk-same", createdAt: "2026-09-12T10:00:00.000Z", startsAt: LATER });
  eq(
    decide(named, [same]).outcome,
    "named-is-newest",
    "booked at the same instant is not booked AFTER, so it refuses",
  );
}
{
  // A, B, C: naming B cancels B when C was booked after it.
  const a = row({ id: "bk-a", createdAt: "2026-09-10T10:00:00.000Z" });
  const b = row({ id: "bk-b", createdAt: "2026-09-11T10:00:00.000Z", startsAt: LATER });
  const c = row({ id: "bk-c", createdAt: "2026-09-12T10:00:00.000Z", startsAt: LATER });
  eq(decide(b, [a, c]).outcome, "cancelled", "naming the middle of three cancels it: one was booked after");
  eq(decide(c, [a, b]).outcome, "named-is-newest", "naming the newest of three refuses");
}

// --- the HTTP contract --------------------------------------------------------

for (const outcome of DUPLICATE_OUTCOMES) {
  assert(
    Number.isInteger(DUPLICATE_CANCEL_STATUS[outcome]),
    `${outcome} has a status`,
  );
  assert(!!DUPLICATE_CANCEL_CODE[outcome], `${outcome} has a machine readable code`);
  assert(!!DUPLICATE_CANCEL_MESSAGE[outcome], `${outcome} has a message`);
}
eq(DUPLICATE_CANCEL_STATUS.cancelled, 200, "a cancel is 200");
eq(DUPLICATE_CANCEL_STATUS["already-cancelled"], 200, "a retry after success is 200");
for (const outcome of DUPLICATE_OUTCOMES) {
  if (outcome === "cancelled" || outcome === "already-cancelled") continue;
  eq(DUPLICATE_CANCEL_STATUS[outcome], 409, `${outcome} is a 409 refusal`);
}
{
  const codes = new Set(DUPLICATE_OUTCOMES.map((o) => DUPLICATE_CANCEL_CODE[o]));
  eq(codes.size, DUPLICATE_OUTCOMES.length, "no two outcomes share a code");
  const messages = new Set(DUPLICATE_OUTCOMES.map((o) => DUPLICATE_CANCEL_MESSAGE[o]));
  eq(messages.size, DUPLICATE_OUTCOMES.length, "no two outcomes share a message");
}
assert(!isDuplicateOutcome("refused"), "a word the function cannot say is not an outcome");
assert(isDuplicateOutcome("no-other-call"), "and one it can say is");

// --- the handoff detail -------------------------------------------------------

{
  const findings = DUPLICATE_OUTCOMES.map(duplicateFindingFor).filter((f) => f !== null);
  eq(
    [...findings].sort().join(","),
    [...DUPLICATE_FINDINGS].sort().join(","),
    "every declared finding is produced by an outcome, and no outcome invents one",
  );
  for (const outcome of ["cancelled", "already-cancelled", "not-found", "not-active", "started"] as DuplicateOutcome[]) {
    eq(duplicateFindingFor(outcome), null, `${outcome} leaves nobody waiting on a person`);
  }
}
{
  const detail = duplicateHandoffDetail({
    outcome: "no-other-call",
    weakerMatch: "phone-only",
    laterBookingStartsAt: LATER,
  });
  assert(detail !== null, "a finding produces a detail");
  eq(detail?.finding, "no-other-call", "the detail names the finding");
  eq(detail?.weakerMatch, "phone-only", "the detail carries the near miss");
  eq(detail?.laterBookingStartsAt, LATER, "the detail carries the time the caller reported");
  const readBack = readDuplicateDetail(detail);
  assert(readBack !== null, "the stored detail is a shape the notice builder can read");
  eq(readBack?.finding, "no-other-call", "and it reads back the same finding");
  eq(readBack?.weakerMatch, "phone-only", "and the same near miss");
  eq(readBack?.laterBookingStartsAt, LATER, "and the same reported time");
}
{
  const detail = duplicateHandoffDetail({
    outcome: "identity-conflict",
    weakerMatch: null,
    laterBookingStartsAt: null,
  });
  eq(detail?.weakerMatch, null, "no near miss is recorded as none, never as a guess");
  eq(detail?.laterBookingStartsAt, null, "and a caller that reported no time leaves it null");
}
eq(
  duplicateHandoffDetail({ outcome: "cancelled", weakerMatch: null, laterBookingStartsAt: null }),
  null,
  "a cancel records no handoff",
);

// --- reading the function's reply ---------------------------------------------

eq(parseDuplicateCancelResult(null), null, "a null reply is unreadable, never an outcome");
eq(parseDuplicateCancelResult("cancelled"), null, "a bare string reply is unreadable");
eq(parseDuplicateCancelResult({ outcome: "nope" }), null, "a word outside the vocabulary is unreadable");
eq(
  parseDuplicateCancelResult({ outcome: "cancelled" }),
  null,
  "a cancel with no outbox row is unreadable: the side effects were never enqueued",
);
{
  const r = parseDuplicateCancelResult({
    outcome: "cancelled",
    outboxId: "ob-1",
    candidateIds: ["bk-a", 7, "", "bk-b"],
    weakerMatch: "nonsense",
  });
  assert(r !== null, "a well formed cancel reads");
  eq(r?.outboxId, "ob-1", "the outbox row is carried");
  eq(r?.candidateIds.join(","), "bk-a,bk-b", "unusable candidate entries are dropped, not guessed at");
  eq(r?.weakerMatch, null, "a near miss outside the vocabulary reads as none");
}
{
  const r = parseDuplicateCancelResult({ outcome: "no-other-call", weakerMatch: "email-only" });
  eq(r?.outcome, "no-other-call", "a refusal with no outbox row reads fine");
  eq(r?.outboxId, null, "and carries no outbox row");
  eq(r?.weakerMatch, "email-only", "and carries the near miss");
}

// --- the unavailable error ----------------------------------------------------

{
  const seen = new Set<string>();
  for (const stage of DUPLICATE_CANCEL_STAGES) {
    const err = new DuplicateCancelUnavailableError(stage);
    eq(err.stage, stage, `the ${stage} failure keeps which stage it was`);
    assert(!seen.has(err.message), `the ${stage} failure has a message of its own`);
    seen.add(err.message);
  }
}

// --- the SQL carries the rules the model describes ----------------------------
//
// The model and the function are two statements of one rule, and only these read the
// thing that actually runs. Each assertion names the rule rather than matching a line
// (L103), and the mutation control below proves they can fail.

interface SqlRule {
  name: string;
  holds: (sql: string) => boolean;
}

const norm = (s: string) => s.replace(/\s+/g, " ");

const SQL_RULES: SqlRule[] = [
  {
    name: "the function is security definer with a pinned search_path",
    holds: (s) => /security\s+definer/i.test(s) && /set\s+search_path\s*=/i.test(s),
  },
  {
    name: "execute is revoked from public, anon and authenticated",
    holds: (s) => /revoke\s+execute\s+on\s+function\s+cancel_duplicate_booking[\s\S]*?from\s+public,\s*anon,\s*authenticated/i.test(s),
  },
  {
    name: "the named booking row is locked for update",
    holds: (s) => /for\s+update/i.test(s),
  },
  {
    name: "a missing booking answers not-found",
    holds: (s) => /'not-found'/.test(s),
  },
  {
    name: "a booking already cancelled AS a duplicate answers already-cancelled",
    holds: (s) =>
      /'already-cancelled'/.test(s) && /double_booking/.test(s),
  },
  {
    name: "any other terminal status answers not-active",
    holds: (s) => /'not-active'/.test(s),
  },
  {
    name: "a call that has begun answers started",
    holds: (s) => /'started'/.test(s) && /starts_at\s*<=\s*p_now/.test(norm(s)),
  },
  {
    name: "candidates are active only",
    holds: (s) => /status\s+in\s*\(\s*'confirmed'\s*,\s*'rescheduled'\s*\)/i.test(norm(s)),
  },
  {
    name: "candidates are in the future only",
    holds: (s) => /starts_at\s*>\s*p_now/.test(norm(s)),
  },
  {
    name: "candidates share the named booking's test space, read from the bucket",
    holds: (s) => /buckets/.test(s) && /is_test/.test(s),
  },
  {
    name: "identity is matched on salesforce_id, external_id, email and phone",
    holds: (s) =>
      /salesforce_id/.test(s) &&
      /external_id/.test(s) &&
      /attendee_email/.test(s) &&
      /attendee_phone/.test(s),
  },
  {
    name: "email is normalised by lowercasing a trimmed value, blank to null",
    holds: (s) => /nullif\s*\(\s*lower\s*\(\s*btrim\s*\(/i.test(norm(s)),
  },
  {
    name: "phone is normalised by the digit rule the model implements",
    holds: (s) =>
      /slate_phone_match_key/.test(s) &&
      /regexp_replace\s*\(\s*[^,]+,\s*'\[\^0-9\]'\s*,\s*''\s*,\s*'g'\s*\)/.test(norm(s)),
  },
  {
    name: "a differing strong id vetoes with identity-conflict",
    holds: (s) => /'identity-conflict'/.test(s),
  },
  {
    name: "no candidate at all answers no-other-call",
    holds: (s) => /'no-other-call'/.test(s),
  },
  {
    name: "no candidate booked after the named one answers named-is-newest",
    holds: (s) => /'named-is-newest'/.test(s) && /created_at\s*>/.test(norm(s)),
  },
  {
    name: "the cancel flips the status and inserts the outbox row in one function",
    holds: (s) =>
      /update\s+bookings\s+set\s+status\s*=\s*'cancelled'/i.test(norm(s)) &&
      /insert\s+into\s+booking_outbox/i.test(norm(s)),
  },
  {
    name: "the outbox row carries reason double_booking and initiator system",
    holds: (s) => /'reasonCode'\s*,\s*'double_booking'/.test(norm(s)) && /'initiator'\s*,\s*'system'/.test(norm(s)),
  },
  {
    name: "the reply names the outbox row it wrote",
    holds: (s) => /'outboxId'/.test(s),
  },
  {
    name: "the reply names the candidates it judged and any weaker match",
    holds: (s) => /'candidateIds'/.test(s) && /'weakerMatch'/.test(s),
  },
  {
    name: "double_booking is added to the cancel reasons as a system only, locked row",
    holds: (s) =>
      /reason_options/.test(s) &&
      /system_only/.test(s) &&
      /'double_booking'/.test(s),
  },
];

for (const rule of SQL_RULES) {
  assert(rule.holds(SQL), `${MIGRATION_NAME}: ${rule.name}`);
}

// The outbox step names are written out in SQL and must be the ones the executor
// registers, in the order the code path enqueues them. Two copies of one list is what
// this holds together (L41): the SQL cannot import the constant.
//
// One step is deliberately absent from the SQL copy, and it is NAMED here rather than
// achieved by loosening the comparison (L129): an unnamed omission reads as drift, and
// a comparison relaxed to tolerate it would stop catching the drift it exists for.
const NOT_ENQUEUED_BY_SQL: { step: string; why: string }[] = [
  // Deliberately EMPTY since #2433. The list existed for one deploy window: #2371
  // shipped the `cancel:owner_alert_delete` handler, and a migration enqueueing a step
  // whose handler is not deployed yet FAILS its outbox row (L640), so the SQL copy was
  // updated in 0127 only after that code was live. An empty list is the proof the two
  // copies agree; an entry here is a debt with a name and a reason on it (L129).
];

{
  const registered = cancelOutboxSteps().map((s) => s.name);
  const exempt = new Set(NOT_ENQUEUED_BY_SQL.map((e) => e.step));
  for (const e of NOT_ENQUEUED_BY_SQL) {
    assert(
      registered.includes(e.step) && e.why.trim().length > 0,
      `the exemption names a step the executor really registers, with a reason: ${e.step}`,
    );
  }
  const expected = registered.filter((n) => !exempt.has(n));
  const inSql = [...SQL_LATEST.matchAll(/'name'\s*,\s*'([^']+)'/g)].map((m) => m[1]);
  eq(
    inSql.join(","),
    expected.join(","),
    "the SQL enqueues exactly the cancel steps the executor registers, in order, " +
      "apart from the named exemptions",
  );
}

// Positive control: a rule assertion that cannot fail is not an assertion. Break each
// rule in a COPY of the SQL and require the check to notice.
{
  const mutations: { name: string; sql: string }[] = [
    { name: "the started guard removed", sql: SQL.replace(/starts_at\s*<=\s*p_now/g, "false") },
    { name: "the future filter removed", sql: SQL.replace(/starts_at\s*>\s*p_now/g, "true") },
    { name: "the outbox insert removed", sql: SQL.replace(/insert\s+into\s+booking_outbox/gi, "-- gone") },
    { name: "the revoke removed", sql: SQL.replace(/revoke\s+execute\s+on\s+function/gi, "select 1 from") },
    { name: "the reason code changed", sql: SQL.replace(/'double_booking'/g, "'other'") },
  ];
  for (const m of mutations) {
    const broke = SQL_RULES.some((r) => r.holds(SQL) && !r.holds(m.sql));
    assert(broke, `control: ${m.name} is caught by at least one rule assertion`);
  }
  const exempt = new Set(NOT_ENQUEUED_BY_SQL.map((e) => e.step));
  const registered = cancelOutboxSteps().map((s) => s.name).filter((n) => !exempt.has(n));
  const stepMutant = SQL.replace(/'cancel:notify'/g, "'cancel:notify_v2'");
  const mutantSteps = [...stepMutant.matchAll(/'name'\s*,\s*'([^']+)'/g)].map((m) => m[1]);
  assert(
    mutantSteps.join(",") !== registered.join(","),
    "control: renaming a step in the SQL alone is caught",
  );
  // And the exemption list cannot quietly swallow a real drift: a step the SQL
  // DROPPED while still being registered and unexempted must still fail.
  const dropMutant = SQL.replace(/jsonb_build_object\('name', 'cancel:recompute'[^)]*\),\s*/g, "");
  const droppedSteps = [...dropMutant.matchAll(/'name'\s*,\s*'([^']+)'/g)].map((m) => m[1]);
  assert(
    droppedSteps.join(",") !== registered.join(","),
    "control: a step the SQL stops enqueueing is still caught while it is not exempted",
  );
}

finish();
