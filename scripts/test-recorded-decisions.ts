// Decisions Dan made on 2026-10-03 for the production readiness milestone, each
// pinned where it is written down (#3092, #3107, #3110, #3125, #3127).
//
// A decision recorded only in prose is the first thing to drift: the next reader
// re-derives it, the next sweep re-files it, or the value it explains moves and the
// prose goes on justifying the old one (L32, L407). So each claim is read out of the
// doc and, where the doc describes code or config, compared with that source rather
// than restated here as a string both could drift away from (L41).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-recorded-decisions.ts
import { readFileSync } from "node:fs";
import { assert, finish } from "./lib/harness.ts";
import { PATCH_TARGET, decideAuditAlert } from "./lib/dependency-audit-report.ts";
import { buildPurgeStatements, statementLabel } from "@/lib/snowflake/purge-sql";
import { MIRROR_STALE_BOUNDS_MS } from "@/lib/monitor/health";
import { MAX_EXPORT_LAG_MS } from "@/lib/snowflake/export-lag-core";
import { CRON_ROUTES } from "../worker/cron-routes.ts";

const read = (p: string) => readFileSync(p, "utf8");

/** SQL with every `--` line comment removed, so only what would execute is judged. */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      // A `--` inside a quoted literal is text, not a comment.
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "'") quoted = !quoted;
        else if (!quoted && line[i] === "-" && line[i + 1] === "-") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** The text of one markdown section at the given level, heading included. */
function section(doc: string, heading: string, level = "##"): string {
  const start = doc.indexOf(`\n${level} ${heading}`);
  if (start === -1) return "";
  const next = doc.indexOf(`\n${level} `, start + level.length + 2);
  return doc.slice(start, next === -1 ? undefined : next);
}

const DECIDED = /Dan[^.]{0,40}2026-10-03|2026-10-03[^.]{0,40}Dan/;

// --- #3092: the patch target, in the runbook and in the alert ----------------------
{
  const runbook = section(read("docs/alerts-runbook.md"), "A dependency advisory was found");
  assert(runbook.length > 0, "the alerts runbook has a section for a dependency advisory");
  assert(/patched by the next working day/.test(runbook), "it states the next working day patch target");
  assert(DECIDED.test(runbook), "and records who decided it and when");
  const alert = decideAuditAlert({ prod: "failure", full: "success", runUrl: "u" }).alert ?? "";
  assert(alert.includes(PATCH_TARGET) && /next working day/.test(PATCH_TARGET), "the daily audit's alert states the same target");
  assert(/PATCH TARGET/.test(read(".github/workflows/dependency-audit.yml")), "and the workflow that runs the audit says so too");
}

// --- #3107: one CPU limit for crons and requests ------------------------------------
{
  const jsonc = read("wrangler.jsonc");
  const m = /"limits"\s*:\s*\{\s*"cpu_ms"\s*:\s*(\d+)\s*\}/.exec(jsonc);
  assert(m !== null, "read limits.cpu_ms out of wrangler.jsonc");
  const ms = Number(m?.[1] ?? 0);
  const before = jsonc.slice(Math.max(0, (m?.index ?? 0) - 900), m?.index ?? 0);
  assert(/#3107/.test(before) && /web requests/.test(before) && /separate Worker/.test(before), "the reason for one limit sits directly above the value");
  const notes = section(read("docs/cloudflare-platform-notes.md"), "One limit for crons and requests, by decision (#3107)", "###");
  assert(notes.length > 0, "the platform notes record the decision");
  assert(notes.includes(`${ms / 1000}s`), `the notes name the limit wrangler.jsonc actually sets (${ms / 1000}s)`);
  assert(DECIDED.test(notes), "and who decided it and when");
  for (const reason of [/CPU used, not the limit/, /45s/, /5s/, /separate Worker/]) {
    assert(reason.test(notes), `the notes carry the reason ${reason}`);
  }
}

// --- #3125: the Snowflake spend guard warns and never suspends ----------------------
{
  const raw = read("docs/snowflake-setup.sql");
  const warehouse = /"SNOWFLAKE_WAREHOUSE"\s*:\s*"([^"]+)"/.exec(read("wrangler.jsonc"))?.[1] ?? "";
  assert(warehouse.length > 0, "read the deployed warehouse name out of wrangler.jsonc");
  // Judged on the STATEMENTS only (L178): a commented out line does nothing in
  // Snowsight, so it must not satisfy a check about what the warehouse is given.
  const judge = (sqlText: string): string[] => {
    const sql = stripSqlComments(sqlText);
    const problems: string[] = [];
    if (!new RegExp(`CREATE WAREHOUSE IF NOT EXISTS ${warehouse}[^;]*STATEMENT_TIMEOUT_IN_SECONDS = 600[^;]*;`).test(sql)) problems.push("a fresh warehouse is created with the 600s timeout");
    if (!new RegExp(`ALTER WAREHOUSE IF EXISTS ${warehouse} SET STATEMENT_TIMEOUT_IN_SECONDS = 600;`).test(sql)) problems.push("an existing warehouse is given the 600s timeout");
    // RM_SLATE is the monitor the data team attached, kept by Dan on 2026-10-28.
    const monitor = /CREATE RESOURCE MONITOR IF NOT EXISTS RM_SLATE[^;]*;/.exec(sql)?.[0] ?? "";
    if (!/FREQUENCY = MONTHLY/.test(monitor)) problems.push("the resource monitor is monthly");
    if (!/CREDIT_QUOTA = 100\b/.test(monitor)) problems.push("the monitor's quota is 100 credits");
    if (!(/ON 75 PERCENT DO NOTIFY/.test(monitor) && /ON 100 PERCENT DO NOTIFY/.test(monitor))) problems.push("the monitor notifies at 75% and 100%");
    if (!new RegExp(`ALTER WAREHOUSE IF EXISTS ${warehouse} SET GENERATION = '1';`).test(sql)) problems.push("the warehouse is set to Gen1");
    // The whole point of the decision: suspending stops the booking mirror.
    if (/DO\s+(SUSPEND|SUSPEND_IMMEDIATE)\b/.test(sql)) problems.push("no trigger suspends the warehouse");
    if (!new RegExp(`ALTER WAREHOUSE ${warehouse} SET RESOURCE_MONITOR = RM_SLATE;`).test(sql)) problems.push("the monitor is attached to the warehouse");
    return problems;
  };
  const found = judge(raw);
  assert(found.length === 0, `the spend guard statements are live SQL: ${found.join("; ") || "all present"}`);
  // Positive controls: each way of quietly losing the decision must be caught.
  const commented = raw.replace(/^ALTER WAREHOUSE IF EXISTS .*STATEMENT_TIMEOUT_IN_SECONDS = 600;$/m, (l) => `-- ${l}`);
  assert(commented !== raw && judge(commented).length > 0, "control: the timeout ALTER commented out is caught");
  const monitorOff = raw.replace(/^(CREATE RESOURCE MONITOR[\s\S]*?;)$/m, (b) => b.replace(/^/gm, "-- "));
  assert(monitorOff !== raw && judge(monitorOff).length > 0, "control: the monitor block commented out is caught");
  const suspending = raw.replace("ON 100 PERCENT DO NOTIFY", "ON 100 PERCENT DO SUSPEND");
  assert(suspending !== raw && judge(suspending).length > 0, "control: a suspend trigger is caught");
  const spend = section(read("DEPLOY.md"), "Spend and usage alerts (#1052)");
  assert(/#3125/.test(spend) && DECIDED.test(spend), "DEPLOY.md's spend section records the decision");
  assert(/never suspending/.test(spend) && /booking backup/.test(spend), "with the reason it never suspends");
  assert(/WAREHOUSE_METERING_HISTORY/.test(spend) && spend.includes(`'${warehouse}'`), "it carries the usage query, on the deployed warehouse");
  assert(/RM_SLATE/.test(spend) && /Dan[^.]{0,40}2026-10-28|2026-10-28[^.]{0,40}Dan/.test(spend), "and names the monitor Dan kept on 2026-10-28");
  assert(/Cap: \*\*`RM_SLATE`, 100 credits/.test(spend), "and states the live cap as RM_SLATE's 100 credits");
}

// --- #3127: mirrored webhook payloads keep the 24 month window ------------------------
{
  const doc = read("docs/pii-retention.md");
  const positions = section(doc, "9. Confirmed legal positions (2026-07-29)");
  const p5 = /\n5\. \*\*Mirrored `webhook_deliveries` keep the 24 month warehouse lifetime\*\*[\s\S]*?(?=\n\d+\. |\n## |$)/.exec(positions)?.[0] ?? "";
  assert(p5.length > 0, "the positions section records the webhook_deliveries warehouse lifetime");
  assert(DECIDED.test(p5) && /#3127/.test(p5), "as Dan's decision of 2026-10-03");
  assert(/erasure/.test(p5) && /at once/.test(p5), "and says what it means for erasure");
  // The claim the position rests on: the warehouse lane clears webhook payloads WITH
  // the booking, through the shared purge. Checked against the statements the purge
  // actually EXECUTES for a booking id, not against text anywhere in the file.
  const statements = buildPurgeStatements(["booking-1"]);
  const webhook = statements.filter((s) => statementLabel(s) === "webhook_deliveries");
  assert(webhook.length === 1, `the shared purge runs exactly one webhook_deliveries statement (${webhook.length})`);
  const stmt = (webhook[0] ?? "").replace(/\s+/g, " ");
  assert(/^update SLATE\.PUBLIC\.webhook_deliveries set /i.test(stmt), "it rewrites the mirrored delivery rows");
  assert(/payload = object_construct\('booking_id', payload:booking_id\)/.test(stmt), "it clears the payload down to the booking id alone");
  assert(/last_response = null/.test(stmt), "and clears the response body, which can echo contact data");
  assert(/ where payload:booking_id::string in \('booking-1'\)/.test(stmt), "keyed by the BOOKING it belongs to");
  const purgeTs = read("src/lib/snowflake/purge.ts");
  const run = /export async function runPurgeAndVerify[\s\S]*?\n}\n/.exec(purgeTs)?.[0] ?? "";
  assert(/for \(const sql of buildPurgeStatements\(ids\)\)/.test(run), "runPurgeAndVerify executes those statements");
  assert(/await runPurgeAndVerify\(/.test(read("src/lib/snowflake/warehouse-retention.ts")), "and the 24 month warehouse lane calls runPurgeAndVerify");
  assert(!/`webhook_deliveries` payloads and `routing_decisions` have no warehouse/.test(doc), "the old claim that webhook payloads have no warehouse window is gone");
}

// --- #3110: every rotation slot the code reads is in the procedure --------------------
{
  const rotation = section(read("DEPLOY.md"), "Rotating a credential (#3110)");
  assert(rotation.length > 0, "DEPLOY.md has the rotation section");
  const env = read("src/lib/env.ts");
  const slots = [...env.matchAll(/process\.env\.([A-Z0-9_]+_(?:2|PREVIOUS))\b/g)].map((m) => m[1]);
  assert(slots.length >= 8, `read the rotation slots out of src/lib/env.ts (${slots.length})`);
  for (const slot of slots) {
    const base = slot.replace(/_(2|PREVIOUS)$/, "");
    assert(rotation.includes(base), `the rotation section covers ${base}, which has the ${slot} slot`);
  }
  for (const name of [
    "CRON_SECRET",
    "SUPABASE_SECRET_KEY",
    "GOOGLE_SA_PRIVATE_KEY",
    "GOOGLE_CLIENT_SECRET",
    "SF_CLIENT_SECRET",
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "REGAL_INBOUND_KEY",
    "UPTIME_HEARTBEAT_KEY",
    "GOOGLE_CHANNEL_TOKEN",
    "BOOKING_API_KEY_REGAL",
    "SNOWFLAKE_PRIVATE_KEY",
  ]) {
    assert(rotation.includes(name), `the rotation section covers ${name}`);
  }
  const sa = /\*\*`GOOGLE_SA_PRIVATE_KEY`\.\*\*[^\n]*\n[^\n]*/.exec(rotation)?.[0] ?? "";
  assert(/only if leaked/.test(sa) && DECIDED.test(sa), "the service account key is rotated only if leaked, by Dan's decision");
}

// --- staff sign in: the Google client is Internal (measured 2026-10-03) ------------
{
  const signIn = section(read("DEPLOY.md"), "Staff sign in: Google only (#3082, #3085)");
  assert(/\*\*Internal\*\*/.test(signIn) && /org_internal/.test(signIn), "the sign in section records the Internal OAuth client");
  assert(/2026-10-03/.test(signIn) && /personal Google account/.test(signIn), "and how and when it was verified");
  // The live test stopped at Google, so it proves nothing about the hook; the doc
  // must not let it read as if it did.
  assert(/never reached the Supabase hook/.test(signIn) && /pnpm verify:auth-domain-hook/.test(signIn), "and that the hook is still proven only by its own command");
}

// --- #4349: the booking mirror runs every 30 minutes (Dan, 2026-10-28) -------------
// Dan traded a 10 minute booking RPO for about 60% of SLATE_WH's credits. Every
// bound keyed to the export's cadence moves with it, or the watchdog pages on
// ordinary waiting and the retention gate refuses on a healthy mirror (L614).
{
  const MIN = 60_000;
  const exportCrons = Object.entries(CRON_ROUTES)
    .filter(([, r]) => (Array.isArray(r) ? r : [r]).includes("/api/cron/snowflake-export"))
    .map(([cron]) => cron);
  assert(exportCrons.length === 1 && exportCrons[0] === "14,44 * * * *", `the export runs at :14 and :44 on its own expression (found ${exportCrons.join(", ") || "none"})`);
  const cadence = 30 * MIN;
  assert(MIRROR_STALE_BOUNDS_MS["snowflake-export"] === 3 * cadence, "the watchdog pages after three missed runs (90 minutes)");
  assert(MAX_EXPORT_LAG_MS === 4 * cadence, "the retention gate refuses after four missed runs (2 hours)");
  const runbook = read("docs/dr-runbook.md");
  const rpo = /\| \*\*RPO, bookings\*\*[^\n]*/.exec(runbook)?.[0] ?? "";
  assert(/\*\*About 30 minutes\*\*/.test(rpo) && /every 30 minutes/.test(rpo) && /90 minutes/.test(rpo), "the DR runbook's booking RPO says 30 minutes and the 90 minute page");
  assert(/2026-10-28[^.]{0,60}Dan|Dan[^.]{0,60}2026-10-28/.test(runbook) && /#4349/.test(runbook), "and records Dan's 2026-10-28 decision");
  const setup = stripSqlComments(read("docs/snowflake-setup.sql"));
  assert(/ALTER WAREHOUSE IF EXISTS SLATE_WH SET AUTO_SUSPEND = 30;/.test(setup), "the setup SQL gives an existing warehouse the 30 second auto suspend");
}

finish();
