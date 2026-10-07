// #3495: the one webhook fan out, proved in a REAL Postgres.
//
// Every booking webhook used to reach the database twice or more: one read of the
// subscribed endpoints, then one insert per endpoint. Request COUNT is what limits a
// crowd (#3492), so `enqueue_webhook_deliveries` does the read and the inserts in one
// call, and it is the only place the subscription rule and the exactly once dedupe
// live. The offline suite has no database and a fake agrees with whatever it is told
// (L52), so this replays EVERY migration into the supabase/postgres image, which
// carries the platform's roles and default grants (L714), and calls the function as
// service_role, the role the server's client uses.
//
// Both directions everywhere (L1): who is sent to beside who is not; a repeat that
// writes nothing beside a different key that writes again; a refused call that
// writes nothing beside the same call that succeeds.
//
// It also holds the function's ANSWER to the committed fixture the TypeScript reader
// is tested against (scripts/fixtures/webhook-enqueue-answer.json, L26), so the
// reader and the function cannot drift apart while each passes its own tests.
//
// It writes nothing outside that container, which it removes on the way out. Not
// named test-*.ts: it needs Docker. No Docker is exit 2, never a pass (L98).
//
// Run: node --experimental-strip-types scripts/verify-webhook-enqueue-sql.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replayEveryMigration, startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { readEnqueueAnswer } from "../src/lib/webhooks/enqueue-answer.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const FIXTURE = join(import.meta.dirname, "fixtures", "webhook-enqueue-answer.json");
const IMAGE = process.env.WEBHOOK_ENQUEUE_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const NAME = `slate-webhook-enqueue-${process.pid}`;

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql } = pg;

const ORG = "00000000-0000-0000-0000-0000000000a0";
const ORG2 = "00000000-0000-0000-0000-0000000000b0";
const GENERIC = "00000000-0000-0000-0000-0000000000e1";
const REGAL = "00000000-0000-0000-0000-0000000000e2";
const INACTIVE = "00000000-0000-0000-0000-0000000000e3";
const UNSUBSCRIBED = "00000000-0000-0000-0000-0000000000e4";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000e5";

const PAYLOAD = `'{"booking_id":"bk-1","bucket_code":"411","starts_at":"2031-03-04T15:00:00+00:00"}'::jsonb`;
const BOTH_SENT = `'{"generic":null,"regal":null}'::jsonb`;

/** Call the function as the server does, and return its answer parsed. */
function enqueue(opts: { event?: string; dedupe?: string | null; suppression?: string; payload?: string; role?: string } = {}): unknown {
  const dedupe = opts.dedupe === undefined ? "'bk-1'" : opts.dedupe === null ? "null" : `'${opts.dedupe}'`;
  const out = sql(
    `select enqueue_webhook_deliveries(
       p_org_id => '${ORG}', p_event => '${opts.event ?? "booking.created"}', p_payload => ${opts.payload ?? PAYLOAD},
       p_dedupe_key => ${dedupe}, p_suppression => ${opts.suppression ?? BOTH_SENT})::text;`,
    opts.role ?? "service_role",
  );
  return JSON.parse(out);
}

/** The formats this suite seeded its endpoints with, which the reader accepts. */
const SEEDED_FORMATS = ["generic", "regal"];
const read = (answer: unknown) => readEnqueueAnswer(answer, SEEDED_FORMATS);

const deliveries = (where = "true") => sql(`select count(*) from webhook_deliveries where ${where};`);

try {
  // --- every migration, from empty, as db push applies them ----------------------------
  const applied = replayEveryMigration(pg, DIR);
  assert(applied > 170, `the schema for the webhook fan out: every migration applied to an empty database (${applied})`);

  sql(`
    insert into organizations (id, name) values ('${ORG}', 'Webhook org'), ('${ORG2}', 'Other org');
    insert into webhook_endpoints (id, org_id, url, format, active, events, created_at) values
      ('${GENERIC}', '${ORG}', 'https://generic.example/hook', 'generic', true,
        array['booking.created','booking.rescheduled','booking.cancelled'], '2031-03-01 00:00:00+00'),
      ('${REGAL}', '${ORG}', 'https://regal.example/hook', 'regal', true,
        array['booking.created','booking.rescheduled','booking.cancelled'], '2031-03-01 00:00:01+00'),
      ('${INACTIVE}', '${ORG}', 'https://inactive.example/hook', 'generic', false,
        array['booking.created'], '2031-03-01 00:00:02+00'),
      ('${UNSUBSCRIBED}', '${ORG}', 'https://unsubscribed.example/hook', 'generic', true,
        array['booking.cancelled'], '2031-03-01 00:00:03+00'),
      ('${OTHER_ORG}', '${ORG2}', 'https://other-org.example/hook', 'generic', true,
        array['booking.created'], '2031-03-01 00:00:04+00');
  `);

  // --- one call: every active subscriber of this org, and nobody else -----------------------
  const first = read(enqueue());
  eq(first.subscribers, 2, "the two active endpoints of this org subscribed to the event are its subscribers");
  eq(first.deliveries.map((d) => d.endpoint.id), [GENERIC, REGAL], "and each gets one delivery, in the order they were added");
  eq(deliveries(), "2", "two rows were written, and no more");
  eq(deliveries(`endpoint_id in ('${INACTIVE}', '${UNSUBSCRIBED}', '${OTHER_ORG}')`), "0",
    "an inactive endpoint, one not subscribed to the event, and another org's endpoint get nothing");
  eq(
    sql(`select string_agg(status || ':' || suppressed || ':' || coalesce(last_response, '-') || ':' || dedupe_key, ',' order by endpoint_id)
         from webhook_deliveries;`),
    "pending:false:-:bk-1,pending:false:-:bk-1",
    "each row is pending, not suppressed, and carries the dedupe key",
  );
  eq(sql(`select count(distinct payload) from webhook_deliveries where payload = ${PAYLOAD};`), "1", "each row stores the payload exactly as given");
  eq(JSON.stringify(first.deliveries[0]!.payload), JSON.stringify(JSON.parse(sql(`select ${PAYLOAD}::text;`))),
    "the answer hands back the STORED payload, which is what the first send posts and every retry posts");

  // --- exactly once: a repeat of the same logical event writes nothing (#436) ----------------
  const repeat = read(enqueue());
  eq(repeat.subscribers, 2, "a repeat still counts the subscribers");
  eq(repeat.deliveries.length, 0, "but hands back no delivery, so nothing is sent twice");
  eq(deliveries(), "2", "and writes no second row");
  const other = read(enqueue({ dedupe: "bk-2" }));
  eq(other.deliveries.length, 2, "control: a DIFFERENT booking's key is written for both subscribers");
  eq(deliveries(), "4", "two more rows");
  // A null key opts out of the dedupe (the partial index ignores nulls): at least once.
  enqueue({ dedupe: null, event: "booking.cancelled" });
  enqueue({ dedupe: null, event: "booking.cancelled" });
  eq(deliveries("dedupe_key is null"), "6", "a null key writes every time: two subscribers of the cancel plus the endpoint subscribed only to it, twice");

  // --- suppression, decided per format by the caller ---------------------------------------
  const suppressed = read(
    enqueue({ dedupe: "bk-3", suppression: `'{"generic":"suppressed: is_test bucket","regal":null}'::jsonb` }),
  );
  eq(suppressed.deliveries.map((d) => `${d.endpoint.format}:${d.suppressed}`), ["generic:true", "regal:false"],
    "the answer says which deliveries were suppressed, so the caller sends only the rest");
  eq(
    sql(`select status || ':' || suppressed || ':' || last_response from webhook_deliveries where dedupe_key = 'bk-3' and endpoint_id = '${GENERIC}';`),
    "success:true:suppressed: is_test bucket",
    "a suppressed delivery is recorded in a TERMINAL state with its reason, so the retry sweep can never send it",
  );
  eq(sql(`select status from webhook_deliveries where dedupe_key = 'bk-3' and endpoint_id = '${REGAL}';`), "pending",
    "control: the other format, not suppressed, is pending as usual");

  // --- refused: nothing is written, and the same call with the gap filled succeeds ------------
  const before = deliveries();
  const unmapped = pg.verboseError(`select enqueue_webhook_deliveries(p_org_id => '${ORG}', p_event => 'booking.created',
      p_payload => ${PAYLOAD}, p_dedupe_key => 'bk-4', p_suppression => '{"generic":null}'::jsonb);`);
  assert(unmapped !== null && /22023/.test(unmapped) && /regal/.test(unmapped),
    `a format with no suppression decision is refused by name, never read as not suppressed (got ${unmapped?.split("\n")[0] ?? "a result"})`);
  eq(deliveries(), before, "and NOTHING was written, not even the generic endpoint's row");
  eq(read(enqueue({ dedupe: "bk-4" })).deliveries.length, 2, "control: the same call with both formats decided writes both");
  for (const [label, call] of [
    ["a null event", `p_event => null, p_payload => ${PAYLOAD}, p_suppression => ${BOTH_SENT}`],
    ["an empty event", `p_event => '', p_payload => ${PAYLOAD}, p_suppression => ${BOTH_SENT}`],
    ["a payload that is not an object", `p_event => 'booking.created', p_payload => '[1]'::jsonb, p_suppression => ${BOTH_SENT}`],
    ["no suppression map", `p_event => 'booking.created', p_payload => ${PAYLOAD}, p_suppression => null`],
  ] as const) {
    const err = pg.verboseError(`select enqueue_webhook_deliveries(p_org_id => '${ORG}', ${call}, p_dedupe_key => 'bk-5');`);
    assert(err !== null && /22023/.test(err), `${label} is refused (got ${err?.split("\n")[0] ?? "a result"})`);
  }
  eq(deliveries("dedupe_key = 'bk-5'"), "0", "and none of those refusals wrote a row");

  // --- nobody subscribed is an answer, said as zero ------------------------------------------
  const none = read(enqueue({ event: "booking.reassigned", dedupe: "bk-6" }));
  eq(none.subscribers, 0, "an event nobody subscribes to answers zero subscribers, which the caller logs (#1459)");
  eq(none.deliveries.length, 0, "and no deliveries");

  // --- the answer has the shape the reader is tested against (L26) -----------------------------
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    deliveries: { endpoint: Record<string, unknown> }[];
  } & Record<string, unknown>;
  const real = enqueue({ dedupe: "bk-7" }) as typeof fixture;
  const keys = (o: Record<string, unknown>) => Object.keys(o).sort().join(",");
  eq(keys(real), keys(fixture), "the answer's top level keys are the fixture's");
  eq(keys(real.deliveries[0] as unknown as Record<string, unknown>), keys(fixture.deliveries[0] as unknown as Record<string, unknown>),
    "a delivery's keys are the fixture's");
  eq(keys(real.deliveries[0]!.endpoint), keys(fixture.deliveries[0]!.endpoint), "an endpoint's keys are the fixture's, which are the table's");

  // --- who may call it -------------------------------------------------------------------------
  for (const role of ["anon", "authenticated"]) {
    const err = pg.verboseError(`select enqueue_webhook_deliveries(p_org_id => '${ORG}', p_event => 'booking.created',
        p_payload => ${PAYLOAD}, p_dedupe_key => 'bk-8', p_suppression => ${BOTH_SENT});`, role);
    assert(err !== null && /permission denied/.test(err), `${role} cannot execute it (got ${err?.split("\n")[0] ?? "a result"})`);
  }
  // Every call above ran as service_role, so a missing grant to the server's own role
  // fails this suite rather than every webhook in production (L159).
  eq(deliveries("dedupe_key = 'bk-8'"), "0", "and neither browser role wrote anything");
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
}

if (process.exitCode === 1) process.exit(1);
finish();
