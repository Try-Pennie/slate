// #4296: editable reminder emails (migration 0211), proved in a REAL Postgres.
//
// The rules that keep a lead from being emailed twice, or emailed out of order, live in
// the database and nowhere else: `claim_reminder_send` refuses a second claim of one
// key, a claim inside the gap after another email's send, and a claim after a SHORTER
// email went out about the same start, under a per booking lock so two lanes racing
// cannot both win. `save_reminder_email` refuses a save made from a stale editor and
// stamps `effective_from` only when an email is switched on or retimed, writing its
// version and audit row in the same transaction. A fake of any of that agrees with
// whatever it is told (L52), so this replays the migrations into the supabase/postgres
// image, which carries the platform's roles and default grants (L714), and asks
// Postgres itself, including two sessions claiming for one booking at the same moment.
//
// The backfill is proved by stopping the replay BEFORE 0211, seeding bookings that
// carry each shape of the three legacy columns, then applying 0211 and reading what it
// wrote, beside controls that must get nothing (a cancelled booking, a past one, one
// never reminded).
//
// It writes nothing outside that container, which it removes on the way out. Not named
// test-*.ts: it needs Docker. No Docker is exit 2, never a pass (L98). The DB replay
// workflow runs it with every other scripts/verify-*-sql.ts. It imports only from
// scripts/, because that workflow runs it on bare node with no install.
//
// Run: node --experimental-strip-types scripts/verify-reminder-emails-sql.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startThrowawayPostgres, SERVER_ROLE, firstErrorLine } from "./lib/throwaway-postgres.ts";
import { CLI_HISTORY_TABLE_SQL, migrationPlan, replayMigrations } from "./lib/migration-replay.ts";
import { bookingInsertSql, bucketsInsertSql, eventTypesInsertSql } from "./lib/seed-sql.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const IMAGE = process.env.REMINDER_EMAILS_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const NAME = `slate-reminder-emails-${process.pid}`;
/** The migration under test; the replay stops before it so the backfill has rows to read. */
const UNDER_TEST = "0211";

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql, sqlError, verboseError } = pg;

const ORG = "00000000-0000-0000-0000-0000000000a0";
const ET = "00000000-0000-0000-0000-0000000000e1";
const BKT = "00000000-0000-0000-0000-000000000100";
const AGENT = "00000000-0000-0000-0000-00000000000a";
const ADMIN = "00000000-0000-0000-0000-00000000000b";

/** A future day, so a booking is upcoming unless placed in the past on purpose. */
const DAY = "2031-03-04";
const at = (hhmm: string) => `${DAY}T${hhmm}:00Z`;

let seq = 0;
/** One booking on the test agent, twenty minutes long, at a time of its own. */
function book(opts: { status?: string; past?: boolean } = {}): { id: string; start: string } {
  seq++;
  const id = `10000000-0000-0000-0000-${String(seq).padStart(12, "0")}`;
  // Each booking its own half hour, so the active overlap constraint (0120) never fires.
  const startMs = opts.past ? Date.now() - (seq + 2) * 3_600_000 : Date.parse(at("00:00")) + seq * 30 * 60_000;
  const start = new Date(startMs).toISOString();
  const end = new Date(startMs + 20 * 60_000).toISOString();
  sql(bookingInsertSql({ id, orgId: ORG, bucketId: BKT, eventTypeId: ET, assignedUserId: AGENT, startIso: start, endIso: end, status: opts.status }));
  return { id, start };
}

const emailId = (slug: string) => sql(`select id from reminder_emails where slug = '${slug}';`);
const rowOf = (booking: string, email: string, sentFor: string) =>
  sql(`select status || '|' || coalesce(reason, '') || '|' || (claimed_at is not null)::text || '|' || (sent_at is not null)::text
         from booking_reminder_sends
        where booking_id = '${booking}' and reminder_email_id = '${email}' and sent_for = '${sentFor}';`);

/** The lane's calls, made as the server's own client. */
const claim = (booking: string, email: string, sentFor: string, gap = "2 hours") =>
  sql(`select claim_reminder_send('${booking}', '${email}', '${sentFor}', interval '${gap}');`, SERVER_ROLE);
const markSent = (booking: string, email: string, sentFor: string) =>
  sql(`select mark_reminder_sent('${booking}', '${email}', '${sentFor}');`, SERVER_ROLE);
const release = (booking: string, email: string, sentFor: string) =>
  sql(`select release_reminder_send('${booking}', '${email}', '${sentFor}');`, SERVER_ROLE);
const failSend = (booking: string, email: string, sentFor: string, reason: string) =>
  sql(`select fail_reminder_send('${booking}', '${email}', '${sentFor}', '${reason}');`, SERVER_ROLE);
const skip = (booking: string, email: string, sentFor: string, reason: string) =>
  sql(`select skip_reminder_send('${booking}', '${email}', '${sentFor}', '${reason}');`, SERVER_ROLE);

interface SaveArgs {
  id?: string | null;
  loadedUpdatedAt?: string | null;
  slug: string;
  name: string;
  minutesBefore: number;
  lateBooking: string;
  enabled: boolean;
  subject: string;
  body: string;
  cardBlock?: boolean;
  placeholderSends?: boolean;
  restoredFromVersion?: number | null;
}
const lit = (v: string | null | undefined) => (v == null ? "null" : `'${v.replace(/'/g, "''")}'`);
function saveSql(a: SaveArgs): string {
  return `select save_reminder_email(
      p_id => ${a.id ? `'${a.id}'::uuid` : "null::uuid"},
      p_loaded_updated_at => ${a.loadedUpdatedAt ? `'${a.loadedUpdatedAt}'::timestamptz` : "null::timestamptz"},
      p_slug => ${lit(a.slug)}, p_name => ${lit(a.name)}, p_minutes_before => ${a.minutesBefore},
      p_late_booking => ${lit(a.lateBooking)}, p_enabled => ${a.enabled},
      p_subject => ${lit(a.subject)}, p_body => ${lit(a.body)},
      p_card_block => ${a.cardBlock ?? true}, p_placeholder_sends => ${a.placeholderSends ?? true},
      p_restored_from_version => ${a.restoredFromVersion ?? "null::integer"},
      p_actor_id => '${ADMIN}', p_org_id => '${ORG}')::text;`;
}
const save = (a: SaveArgs) => JSON.parse(sql(saveSql(a), SERVER_ROLE)) as Record<string, unknown>;
const current = (id: string) =>
  JSON.parse(sql(`select row_to_json(r)::text from (select * from reminder_emails where id = '${id}') r;`)) as Record<string, string | number | boolean>;
const auditCount = () => Number(sql("select count(*) from audit_log where action like 'reminder_email.%';"));
const lastAudit = () =>
  JSON.parse(sql(`select row_to_json(r)::text from (select action, actor_id, target_id, details, chain_seq from audit_log
                   where action like 'reminder_email.%' order by chain_seq desc limit 1) r;`)) as {
    action: string;
    actor_id: string;
    target_id: string | null;
    details: { reminder_email_id: string; old: Record<string, unknown> | null; new: Record<string, unknown>; version: number | null; restored_from_version?: number | null };
    chain_seq: number | null;
  };
const versionCount = (id: string) => Number(sql(`select count(*) from reminder_email_versions where reminder_email_id = '${id}';`));

try {
  // --- replay every migration before the one under test --------------------------------------
  const plan = migrationPlan(readdirSync(DIR));
  if (!plan.ok) throw new Error(plan.error);
  const before = plan.files.filter((f) => f.version < UNDER_TEST);
  const rest = plan.files.filter((f) => f.version >= UNDER_TEST);
  assert(rest[0]?.version === UNDER_TEST, `migration ${UNDER_TEST} is on disk (found ${rest.map((f) => f.file).join(", ") || "nothing"})`);
  sql(CLI_HISTORY_TABLE_SQL);
  const runBatch = (batch: string) => void sql(batch, undefined, { singleTransaction: true });
  const read = (file: string) => readFileSync(join(DIR, file), "utf8");
  const appliedBefore = replayMigrations(before, read, runBatch);
  assert(appliedBefore > 200, `every migration before ${UNDER_TEST} applied to an empty database (${appliedBefore})`);

  sql(`
    insert into organizations (id, name) values ('${ORG}', 'Reminder org');
    insert into users (id, org_id, email, role, bookable) values
      ('${AGENT}', '${ORG}', 'agent@example.com', 'agent', true),
      ('${ADMIN}', '${ORG}', 'admin@example.com', 'admin', false);
    ${eventTypesInsertSql([{ id: ET, orgId: ORG, name: "Call", durationMin: 20 }])}
    ${bucketsInsertSql([{ id: BKT, orgId: ORG, code: "100", name: "Low", eventTypeId: ET }])}
  `);

  // --- the legacy shapes the backfill reads ---------------------------------------------------
  const daySent = book(); // 24 hour email sent and its send time known
  const dayClaimed = book({ status: "rescheduled" }); // 24 hour email claimed, no send time
  const both = book(); // 24 hour sent, then the 1 hour email recorded
  const hourOnly = book(); // 1 hour email recorded, no 24 hour record
  const moved = book(); // reminded about an EARLIER start, then moved
  const cancelled = book({ status: "cancelled" });
  const past = book({ past: true });
  const never = book();
  const sentAt = "2031-03-03T01:00:00Z";
  sql(`
    update bookings set reminder_sent_for = starts_at, reminder_sent_at = '${sentAt}' where id = '${daySent.id}';
    update bookings set reminder_sent_for = starts_at, reminder_sent_at = null where id = '${dayClaimed.id}';
    update bookings set reminder_sent_for = starts_at, reminder_sent_at = '${sentAt}', hour_reminder_sent_for = starts_at
     where id in ('${both.id}', '${cancelled.id}', '${past.id}');
    update bookings set hour_reminder_sent_for = starts_at where id = '${hourOnly.id}';
    update bookings set reminder_sent_for = '2031-03-01T15:00:00Z', reminder_sent_at = '${sentAt}' where id = '${moved.id}';
  `);
  const legacyColumns = () =>
    sql(`select string_agg(id || '|' || coalesce(reminder_sent_for::text, '') || '|' || coalesce(reminder_sent_at::text, '') || '|' || coalesce(hour_reminder_sent_for::text, ''), ',' order by id) from bookings;`);
  const legacyBefore = legacyColumns();

  // --- apply the migration under test ---------------------------------------------------------
  const appliedRest = replayMigrations(rest, read, runBatch);
  eq(appliedRest, rest.length, `${UNDER_TEST} and everything after it applied`);

  // --- seeds ----------------------------------------------------------------------------------
  eq(
    sql(`select string_agg(slug || '|' || name || '|' || minutes_before || '|' || late_booking || '|' || enabled || '|' || (effective_from < '2001-01-01')::text
           || '|' || card_block || '|' || placeholder_sends, ',' order by minutes_before) from reminder_emails;`),
    "hour|1 hour reminder|60|skip|true|true|true|true,day|24 hour reminder|1440|send_now|true|true|true|true",
    "seeds the 24 hour and 1 hour emails, on, effective long before any booking",
  );
  eq(sql("select count(*) from reminder_emails where length(subject) = 0 or length(body) = 0;"), "0", "each seed carries a subject and a body");
  eq(
    sql("select string_agg(e.slug || ':' || v.version || ':' || (v.snapshot->>'subject' = e.subject and v.snapshot->>'body' = e.body)::text, ',' order by e.slug) from reminder_email_versions v join reminder_emails e on e.id = v.reminder_email_id;"),
    "day:1:true,hour:1:true",
    "each seed has version 1 holding its own copy, so the original can be restored",
  );
  const DAY_ID = emailId("day");
  const HOUR_ID = emailId("hour");

  // --- backfill -------------------------------------------------------------------------------
  eq(legacyColumns(), legacyBefore, "the three legacy bookings columns are left exactly as they were");
  eq(rowOf(daySent.id, DAY_ID, daySent.start), "sent||true|true", "a 24 hour email with a send time becomes sent");
  eq(sql(`select sent_at = '${sentAt}' from booking_reminder_sends where booking_id = '${daySent.id}';`), "t", "carrying the recorded send time");
  eq(rowOf(dayClaimed.id, DAY_ID, dayClaimed.start), "legacy_claimed||false|false", "a 24 hour record with no send time becomes legacy_claimed, sent_at null");
  eq(rowOf(both.id, DAY_ID, both.start), "sent||true|true", "a booking with both: the 24 hour row is sent");
  eq(rowOf(both.id, HOUR_ID, both.start), "legacy_claimed||false|false", "and the 1 hour row legacy_claimed");
  eq(rowOf(hourOnly.id, HOUR_ID, hourOnly.start), "legacy_claimed||false|false", "every 1 hour record becomes legacy_claimed");
  eq(rowOf(moved.id, DAY_ID, "2031-03-01T15:00:00Z"), "sent||true|true", "a moved booking keeps its record about the earlier start");
  eq(sql(`select count(*) from booking_reminder_sends where booking_id = '${moved.id}' and sent_for = '${moved.start}';`), "0", "and nothing about its new start");
  for (const [b, what] of [[cancelled, "a cancelled booking"], [past, "a booking already past"], [never, "a booking never reminded"]] as const) {
    eq(sql(`select count(*) from booking_reminder_sends where booking_id = '${b.id}';`), "0", `${what} gets no row`);
  }
  eq(sql("select count(*) from booking_reminder_sends;"), "6", "six rows in all, no more");

  // --- shape: definer, pinned, closed to the browser roles ------------------------------------
  const FUNCTIONS = ["save_reminder_email", "claim_reminder_send", "release_reminder_send", "mark_reminder_sent", "fail_reminder_send", "skip_reminder_send"];
  for (const fn of FUNCTIONS) {
    eq(sql(`select prosecdef::text || '|' || array_to_string(proconfig, ',') from pg_proc where proname = '${fn}';`), "true|search_path=public, pg_catalog", `${fn} is security definer with a pinned search_path`);
    for (const role of ["anon", "authenticated"]) {
      eq(sql(`select has_function_privilege('${role}', p.oid, 'execute') from pg_proc p where proname = '${fn}';`), "f", `${role} cannot execute ${fn}`);
    }
    eq(sql(`select has_function_privilege('${SERVER_ROLE}', p.oid, 'execute') from pg_proc p where proname = '${fn}';`), "t", `the server can execute ${fn}`);
  }
  for (const table of ["reminder_emails", "reminder_email_versions", "booking_reminder_sends"]) {
    eq(sql(`select relrowsecurity from pg_class where relname = '${table}';`), "t", `RLS is on for ${table}`);
    eq(sql(`select count(*) from pg_policies where tablename = '${table}';`), "0", `${table} has no policy (default deny)`);
    for (const role of ["anon", "authenticated"]) eq(sql(`select count(*) from ${table};`, role), "0", `${role} reads nothing from ${table}`);
  }

  // --- check constraints ----------------------------------------------------------------------
  const base: SaveArgs = { slug: "bounds", name: "Bounds", minutesBefore: 30, lateBooking: "skip", enabled: false, subject: "S", body: "B" };
  for (const [over, what] of [
    [{ minutesBefore: 29 }, "under the 30 minute minimum"],
    [{ minutesBefore: 2881 }, "over 48 hours"],
    [{ lateBooking: "later" }, "a late booking choice outside the two"],
    [{ subject: "" }, "an empty subject"],
    [{ body: "" }, "an empty body"],
  ] as const) {
    const refused = verboseError(saveSql({ ...base, ...over }));
    assert(/23514/.test(refused ?? ""), `${what} is refused by a check constraint (${firstErrorLine(refused)})`);
  }
  eq(sql("select count(*) from reminder_emails where slug = 'bounds';"), "0", "and none of them was written");
  eq(save({ ...base, slug: "lo", minutesBefore: 30 }).status, "saved", "control: exactly 30 minutes is accepted");
  eq(save({ ...base, slug: "hi", minutesBefore: 2880 }).status, "saved", "control: exactly 48 hours is accepted");

  // --- save: create, stale, edit, toggle, retime, restore -------------------------------------
  const auditsAtStart = auditCount();
  const created = save({ slug: "mid", name: "3 hour reminder", minutesBefore: 180, lateBooking: "send_now", enabled: false, subject: "Soon", body: "Your call is soon" });
  eq(created.status, "saved", "creating an email saves");
  eq(created.version, 1, "as version 1");
  const MID = String(created.id);
  let row = current(MID);
  const loadedAtCreate = String(row.updated_at);
  eq(versionCount(MID), 1, "with one version row");
  eq(row.updated_by, ADMIN, "stamped with who saved it");
  let audit = lastAudit();
  eq(audit.action, "reminder_email.created", "audited as created");
  eq([audit.actor_id, audit.target_id, audit.details.reminder_email_id, audit.details.old], [ADMIN, null, MID, null], "by the actor, about no user, naming the email, with no old values");
  eq(audit.details.new.subject, "Soon", "with the new values");
  assert(audit.chain_seq !== null, "the audit row is chained by the 0160 trigger");

  // A stale editor: the updated_at it loaded is not the row's.
  const auditsBeforeStale = auditCount();
  const stale = save({ id: MID, loadedUpdatedAt: "2020-01-01T00:00:00Z", slug: "mid", name: "3 hour reminder", minutesBefore: 180, lateBooking: "send_now", enabled: false, subject: "Overwritten", body: "Overwritten" });
  eq(stale.status, "stale", "a save from an editor that loaded an older version is refused as stale");
  eq(stale.updated_at, row.updated_at, "and answers the version it would have overwritten");
  eq(current(MID).subject, "Soon", "nothing was written");
  eq([auditCount(), versionCount(MID)], [auditsBeforeStale, 1], "no audit row and no version");
  eq(save({ id: MID, loadedUpdatedAt: null, slug: "mid", name: "x", minutesBefore: 180, lateBooking: "send_now", enabled: false, subject: "x", body: "x" }).status, "stale", "an update that names no loaded version is stale too");
  eq(save({ id: "00000000-0000-0000-0000-00000000dead", loadedUpdatedAt: String(row.updated_at), slug: "mid", name: "x", minutesBefore: 180, lateBooking: "send_now", enabled: false, subject: "x", body: "x" }).status, "missing", "an update of an email that does not exist says so");

  // An edit of the copy only.
  const effectiveAtCreate = row.effective_from;
  const edited = save({ id: MID, loadedUpdatedAt: String(row.updated_at), slug: "mid", name: "3 hour reminder", minutesBefore: 180, lateBooking: "send_now", enabled: false, subject: "Coming up", body: "Your call is soon" });
  eq([edited.status, edited.version], ["saved", 2], "an edit from the current version saves, as version 2");
  row = current(MID);
  eq([row.subject, row.effective_from], ["Coming up", effectiveAtCreate], "the copy changed and effective_from did not");
  audit = lastAudit();
  eq([audit.action, audit.details.old, audit.details.new], ["reminder_email.updated", { subject: "Soon" }, { subject: "Coming up" }], "audited as updated with only what changed, old and new");
  eq(auditCount(), auditsAtStart + 2, "one audit row per save");
  const reused = save({ id: MID, loadedUpdatedAt: loadedAtCreate, slug: "mid", name: "x", minutesBefore: 180, lateBooking: "send_now", enabled: false, subject: "x", body: "x" });
  eq(reused.status, "stale", "the version an editor loaded before that save is now stale");

  // Switched on: effective_from moves, no new copy version.
  const toggled = save({ id: MID, loadedUpdatedAt: String(row.updated_at), slug: "mid", name: "3 hour reminder", minutesBefore: 180, lateBooking: "send_now", enabled: true, subject: "Coming up", body: "Your call is soon" });
  eq([toggled.status, toggled.version], ["saved", null], "switching it on saves without a copy version (the copy did not change)");
  const onRow = current(MID);
  assert(Date.parse(String(onRow.effective_from)) > Date.parse(String(row.effective_from)), "switching it on stamps effective_from");
  eq([lastAudit().action, lastAudit().details.new], ["reminder_email.toggled", { enabled: true }], "audited as toggled");
  eq(versionCount(MID), 2, "still two versions");

  // Retimed: effective_from moves again.
  const retimed = save({ id: MID, loadedUpdatedAt: String(onRow.updated_at), slug: "mid", name: "3 hour reminder", minutesBefore: 150, lateBooking: "send_now", enabled: true, subject: "Coming up", body: "Your call is soon" });
  eq(retimed.status, "saved", "retiming saves");
  const retimedRow = current(MID);
  assert(Date.parse(String(retimedRow.effective_from)) > Date.parse(String(onRow.effective_from)), "retiming stamps effective_from");
  eq([lastAudit().action, lastAudit().details.old, lastAudit().details.new], ["reminder_email.updated", { minutes_before: 180 }, { minutes_before: 150 }], "audited with the old and new timing");

  // Switched off, and a late booking change: effective_from stays.
  const off = save({ id: MID, loadedUpdatedAt: String(retimedRow.updated_at), slug: "mid", name: "3 hour reminder", minutesBefore: 150, lateBooking: "skip", enabled: false, subject: "Coming up", body: "Your call is soon" });
  eq(off.status, "saved", "switching it off saves");
  const offRow = current(MID);
  eq(offRow.effective_from, retimedRow.effective_from, "switching off, or changing the late booking choice, leaves effective_from alone");

  // Restore version 1's copy.
  const restoreBase = { id: MID, loadedUpdatedAt: String(offRow.updated_at), slug: "mid", name: "3 hour reminder", minutesBefore: 150, lateBooking: "skip", enabled: false };
  const mismatch = sqlError(saveSql({ ...restoreBase, subject: "Not version 1", body: "Your call is soon", restoredFromVersion: 1 }), SERVER_ROLE);
  assert(/does not match version 1/.test(mismatch ?? ""), `a restore whose copy is not the version's is refused (${firstErrorLine(mismatch)})`);
  const retimedRestore = sqlError(saveSql({ ...restoreBase, minutesBefore: 60, subject: "Soon", body: "Your call is soon", restoredFromVersion: 1 }), SERVER_ROLE);
  assert(/copy only/.test(retimedRestore ?? ""), `a restore that also changes the timing is refused (${firstErrorLine(retimedRestore)})`);
  const missingVersion = sqlError(saveSql({ ...restoreBase, subject: "Soon", body: "Your call is soon", restoredFromVersion: 9 }), SERVER_ROLE);
  assert(/no version 9/.test(missingVersion ?? ""), `a restore of a version that does not exist is refused (${firstErrorLine(missingVersion)})`);
  eq(current(MID).subject, "Coming up", "none of the refused restores wrote anything");
  const restored = save({ ...restoreBase, subject: "Soon", body: "Your call is soon", restoredFromVersion: 1 });
  eq([restored.status, restored.version], ["saved", 3], "restoring version 1 saves its copy as version 3");
  eq(current(MID).subject, "Soon", "with version 1's subject");
  audit = lastAudit();
  eq([audit.action, audit.details.restored_from_version, audit.details.new], ["reminder_email.restored", 1, { subject: "Soon" }], "audited as restored, naming the version");

  const slugChange = sqlError(saveSql({ ...restoreBase, loadedUpdatedAt: String(current(MID).updated_at), slug: "renamed", subject: "Soon", body: "Your call is soon" }), SERVER_ROLE);
  assert(/slug/.test(slugChange ?? ""), `a save cannot change an email's slug (${firstErrorLine(slugChange)})`);
  const dupe = verboseError(saveSql({ ...base, slug: "day", minutesBefore: 300 }));
  assert(/23505/.test(dupe ?? ""), `creating a second email with a slug in use is refused (${firstErrorLine(dupe)})`);

  // --- claim: one per key ---------------------------------------------------------------------
  // MID is now 150 minutes before; switch it back on for the claim rules (it is shorter
  // than the day email and longer than the hour one).
  save({ ...restoreBase, loadedUpdatedAt: String(current(MID).updated_at), enabled: true, subject: "Soon", body: "Your call is soon" });

  const g = book();
  eq(claim(g.id, DAY_ID, g.start), "claimed", "the first claim of a key wins");
  eq(claim(g.id, DAY_ID, g.start), "taken", "a second claim of the same key loses");
  eq(rowOf(g.id, DAY_ID, g.start), "claimed||true|false", "leaving one claimed row");

  // --- the gap: another email claimed or sent about this start, recently ----------------------
  eq(claim(g.id, HOUR_ID, g.start), "gap", "a claim while another email for this start is claimed, inside the gap, waits");
  eq(markSent(g.id, DAY_ID, g.start), "t", "the claimed email is marked sent");
  eq(markSent(g.id, DAY_ID, g.start), "f", "only once: a second mark moves nothing");
  eq(rowOf(g.id, DAY_ID, g.start), "sent||true|true", "sent, with its send time");
  eq(claim(g.id, HOUR_ID, g.start), "gap", "a claim inside the gap after another email's send waits");
  eq(sql(`select count(*) from booking_reminder_sends where booking_id = '${g.id}' and reminder_email_id = '${HOUR_ID}';`), "0", "and writes nothing (the gap is a wait, never a stored skip)");
  eq(claim(g.id, HOUR_ID, g.start, "0 seconds"), "claimed", "control: with no gap the same claim wins");
  const other = book();
  sql(`update booking_reminder_sends set sent_at = now() - interval '3 hours' where booking_id = '${g.id}' and reminder_email_id = '${DAY_ID}';`);
  sql(`insert into booking_reminder_sends (booking_id, reminder_email_id, sent_for, status, claimed_at, sent_at)
       values ('${other.id}', '${DAY_ID}', '${other.start}', 'sent', now() - interval '3 hours', now() - interval '3 hours');`);
  eq(claim(other.id, HOUR_ID, other.start), "claimed", "a send three hours ago is outside a two hour gap");
  const unknownTime = book();
  sql(`insert into booking_reminder_sends (booking_id, reminder_email_id, sent_for, status) values ('${unknownTime.id}', '${DAY_ID}', '${unknownTime.start}', 'legacy_claimed');`);
  eq(claim(unknownTime.id, MID, unknownTime.start), "claimed", "a legacy record with no send time never starts a gap (an unknown time does not hold an email back)");
  const otherStart = book();
  eq(claim(otherStart.id, DAY_ID, "2031-03-01T15:00:00Z"), "claimed", "a claim about an earlier start of a booking");
  eq(claim(otherStart.id, HOUR_ID, otherStart.start), "claimed", "does not gap a claim about its current start");

  // --- never after a SHORTER email about the same start ---------------------------------------
  const h = book();
  eq(claim(h.id, HOUR_ID, h.start), "claimed", "the 1 hour email is claimed first");
  eq(claim(h.id, DAY_ID, h.start, "0 seconds"), "superseded", "a longer email after a shorter one was claimed is superseded");
  eq(markSent(h.id, HOUR_ID, h.start), "t", "the shorter one is sent");
  eq(claim(h.id, DAY_ID, h.start, "0 seconds"), "superseded", "and the longer one is still superseded after it was sent");
  eq(claim(h.id, MID, h.start, "0 seconds"), "superseded", "as is any email longer than it");
  eq(claim(dayClaimed.id, MID, dayClaimed.start, "0 seconds"), "claimed", "control: a LONGER email's legacy record does not supersede a shorter one");
  eq(claim(hourOnly.id, DAY_ID, hourOnly.start, "0 seconds"), "superseded", "a shorter email's legacy_claimed record supersedes a longer one");
  const rel = book();
  eq(claim(rel.id, HOUR_ID, rel.start), "claimed", "a shorter email claimed");
  eq(release(rel.id, HOUR_ID, rel.start), "t", "and released after a failed attempt");
  eq(claim(rel.id, DAY_ID, rel.start, "0 seconds"), "claimed", "control: a RELEASED shorter email does not supersede");

  // --- release and reclaim ---------------------------------------------------------------------
  const j = book();
  eq(claim(j.id, DAY_ID, j.start), "claimed", "claimed");
  eq(release(j.id, DAY_ID, j.start), "t", "released");
  eq(release(j.id, DAY_ID, j.start), "f", "a release only moves a claimed row");
  eq(rowOf(j.id, DAY_ID, j.start), "released||true|false", "the row reads released");
  eq(claim(j.id, DAY_ID, j.start), "claimed", "a released key can be claimed again");
  eq(rowOf(j.id, DAY_ID, j.start), "claimed||true|false", "and reads claimed");
  eq(markSent(j.id, DAY_ID, j.start), "t", "then sent");
  eq(release(j.id, DAY_ID, j.start), "f", "a sent row cannot be released");
  eq(claim(j.id, DAY_ID, j.start), "taken", "and a sent key cannot be claimed again");

  // --- failure and skip -----------------------------------------------------------------------
  const k = book();
  const emptyFail = sqlError(`select fail_reminder_send('${k.id}', '${DAY_ID}', '${k.start}', '');`, SERVER_ROLE);
  assert(emptyFail !== null, "a failure must carry a reason");
  eq(failSend(k.id, DAY_ID, k.start, "gmail_rejected"), "f", "a failure records nothing on a key nobody claimed");
  eq(claim(k.id, DAY_ID, k.start), "claimed", "claimed");
  eq(failSend(k.id, DAY_ID, k.start, "gmail_rejected"), "t", "a claimed send fails with a reason");
  eq(rowOf(k.id, DAY_ID, k.start), "failed|gmail_rejected|true|false", "stored as failed with its reason");
  eq(claim(k.id, DAY_ID, k.start), "taken", "a failed key is not claimed again");
  eq(markSent(k.id, DAY_ID, k.start), "f", "nor marked sent");

  const s = book();
  eq(skip(s.id, DAY_ID, s.start, "late_booking"), "t", "a permanent skip is recorded with its reason");
  eq(rowOf(s.id, DAY_ID, s.start), "skipped|late_booking|true|false", "as skipped, stamped when it was decided");
  eq(skip(s.id, DAY_ID, s.start, "too_close"), "f", "a second skip changes nothing");
  eq(rowOf(s.id, DAY_ID, s.start), "skipped|late_booking|true|false", "the first reason stands");
  eq(claim(s.id, DAY_ID, s.start), "taken", "a skipped key is not claimed");
  eq(skip(j.id, DAY_ID, j.start, "too_close"), "f", "a skip never overwrites a sent row");
  const r2 = book();
  eq(claim(r2.id, DAY_ID, r2.start), "claimed", "claimed");
  eq(skip(r2.id, DAY_ID, r2.start, "too_close"), "f", "a skip never overwrites a claimed row");
  eq(release(r2.id, DAY_ID, r2.start), "t", "released");
  eq(skip(r2.id, DAY_ID, r2.start, "too_close"), "t", "a released key that will not be retried is skipped");
  eq(rowOf(r2.id, DAY_ID, r2.start), "skipped|too_close|true|false", "and reads skipped");
  const emptySkip = sqlError(`select skip_reminder_send('${s.id}', '${HOUR_ID}', '${s.start}', ' ');`, SERVER_ROLE);
  assert(emptySkip !== null, "a skip must carry a reason");

  // --- status and column checks on the table itself --------------------------------------------
  for (const [stmt, what] of [
    [`insert into booking_reminder_sends (booking_id, reminder_email_id, sent_for, status) values ('${never.id}', '${DAY_ID}', '${never.start}', 'pending');`, "a status outside the six"],
    [`insert into booking_reminder_sends (booking_id, reminder_email_id, sent_for, status, claimed_at) values ('${never.id}', '${DAY_ID}', '${never.start}', 'sent', now());`, "a sent row with no send time"],
    [`insert into booking_reminder_sends (booking_id, reminder_email_id, sent_for, status) values ('${never.id}', '${DAY_ID}', '${never.start}', 'claimed');`, "a claimed row with no claim time"],
    [`insert into booking_reminder_sends (booking_id, reminder_email_id, sent_for, status, claimed_at) values ('${never.id}', '${DAY_ID}', '${never.start}', 'skipped', now());`, "a skipped row with no reason"],
    [`insert into booking_reminder_sends (booking_id, reminder_email_id, sent_for, status, claimed_at) values ('${never.id}', '${DAY_ID}', '${never.start}', 'failed', now());`, "a failed row with no reason"],
  ] as const) {
    const refused = verboseError(stmt);
    assert(/23514/.test(refused ?? ""), `${what} is refused by a check constraint (${firstErrorLine(refused)})`);
  }

  // --- two lanes racing for one booking --------------------------------------------------------
  // Each session claims inside an open transaction and holds it past the other's claim.
  // Without the per booking lock both read no other claim and both win; with it the
  // second waits, then sees the first's committed claim. Results go to a table, since a
  // session reports only its exit code.
  sql("create table race_results (who text, outcome text);");
  const racer = (who: string, booking: string, email: string, sentFor: string) =>
    pg.session(`begin;
      insert into race_results select '${who}', claim_reminder_send('${booking}', '${email}', '${sentFor}', interval '2 hours');
      select pg_sleep(1);
      commit;`);
  const race1 = book();
  const [a1, b1] = await Promise.all([racer("day", race1.id, DAY_ID, race1.start), racer("mid", race1.id, MID, race1.start)]);
  eq([a1.code, b1.code], [0, 0], `both racing sessions finished (${firstErrorLine(a1.stderr || b1.stderr || null)})`);
  // Whichever commits first wins. If the longer (day) wins, the shorter waits on the gap;
  // if the shorter (mid) wins, the longer is superseded. Never both claimed.
  const outcomes1 = sql("select string_agg(who || ':' || outcome, ',' order by who) from race_results;");
  assert(
    outcomes1 === "day:claimed,mid:gap" || outcomes1 === "day:superseded,mid:claimed",
    `of two emails claimed for one booking at once, exactly one wins and the other is held back (${outcomes1})`,
  );
  eq(sql(`select count(*) from booking_reminder_sends where booking_id = '${race1.id}' and status = 'claimed';`), "1", "leaving one claim");
  sql("truncate race_results;");
  const race2 = book();
  const [a2, b2] = await Promise.all([racer("x", race2.id, DAY_ID, race2.start), racer("y", race2.id, DAY_ID, race2.start)]);
  eq([a2.code, b2.code], [0, 0], "both racing sessions on one key finished");
  eq(sql("select string_agg(outcome, ',' order by outcome) from race_results;"), "claimed,taken", "of two claims of one key at once, exactly one wins");
  const race3 = book();
  sql("truncate race_results;");
  const [a3, b3] = await Promise.all([racer("p", race3.id, HOUR_ID, race3.start), racer("q", race3.id, DAY_ID, race3.start)]);
  eq([a3.code, b3.code], [0, 0], "both racing sessions, shorter and longer, finished");
  const outcomes3 = sql("select string_agg(who || ':' || outcome, ',' order by who) from race_results;");
  assert(outcomes3 === "p:gap,q:claimed" || outcomes3 === "p:claimed,q:superseded", `a shorter and a longer email raced: one wins (${outcomes3})`);

  // --- RESTRICT: an email that has sent cannot be deleted ---------------------------------------
  const restrict = verboseError(`delete from reminder_emails where id = '${DAY_ID}';`);
  assert(/23503/.test(restrict ?? ""), `deleting an email with a send record is refused by the foreign key (${firstErrorLine(restrict)})`);
  eq(sql(`select count(*) from reminder_emails where id = '${DAY_ID}';`), "1", "and the email is still there");
  const LO = emailId("lo");
  eq(sql(`with d as (delete from reminder_emails where id = '${LO}' returning 1) select count(*) from d;`, SERVER_ROLE), "1", "control: an email that never sent can be deleted");
  eq(sql(`select count(*) from reminder_email_versions where reminder_email_id = '${LO}';`), "0", "taking its versions with it");
  const sendsOfJ = sql(`select count(*) from booking_reminder_sends where booking_id = '${j.id}';`);
  assert(sendsOfJ !== "0", "a booking has send rows");
  sql(`delete from bookings where id = '${j.id}';`);
  eq(sql(`select count(*) from booking_reminder_sends where booking_id = '${j.id}';`), "0", "deleting a booking removes its send rows");

  // --- the per email status read is indexed --------------------------------------------------
  eq(
    sql("select indexdef from pg_indexes where tablename = 'booking_reminder_sends' and indexdef like '%(reminder_email_id, claimed_at)%';") !== "",
    true,
    "the per email status counts read through an index on (reminder_email_id, claimed_at)",
  );
  eq(
    sql("select indexdef from pg_indexes where indexname = 'booking_reminder_sends_pkey';").includes("(booking_id, reminder_email_id, sent_for)"),
    true,
    "the primary key leads with booking_id, so the rows for a set of bookings read through it",
  );
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
}

if (process.exitCode === 1) process.exit(1);
finish();
