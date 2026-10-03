// The operational claims the production readiness docs make, checked against the
// code they describe (#3097, #3124, #3129, #3130, #3131).
//
// Docs state testable claims (L32), and a claim nothing checks drifts the moment the
// code moves: DEPLOY.md said for weeks that there was no kill switch while one
// shipped and was proven nightly (#3129). So each claim below is read out of the doc
// and compared with the source it names, rather than restated here as a string the
// doc and the code could both drift away from.
//
// Run: node --experimental-strip-types scripts/test-ops-doc-claims.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const read = (p: string) => readFileSync(p, "utf8");

/** The text of one `## ` section of a markdown doc, heading included. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n## ${heading}`);
  if (start === -1) return "";
  const next = doc.indexOf("\n## ", start + 4);
  return doc.slice(start, next === -1 ? undefined : next);
}

/** Every setting name DEFINED by .env.example (`NAME=`) or DEPLOY.md (`wrangler secret put NAME`). */
function definedSettings(envExample: string, deploy: string): Set<string> {
  const out = new Set<string>();
  for (const m of envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) out.add(m[1]);
  for (const m of deploy.matchAll(/^#?\s*wrangler secret put ([A-Z][A-Z0-9_]*)\b/gm)) out.add(m[1]);
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

// --- #3124: the Worker holds no database connection of its own ------------------
// DEPLOY.md's capacity note rests the connection argument on this: every query goes
// through PostgREST over HTTPS, so a burst of isolates cannot multiply connections.
{
  const DRIVER = /(?:from\s+|require\(\s*|import\(\s*)["'](pg|postgres|pg-pool|@neondatabase\/serverless|@vercel\/postgres)["']/;
  const offenders = [...walk("src"), ...walk("worker")].filter((f) => DRIVER.test(read(f)));
  assert(
    offenders.length === 0,
    `nothing under src/ or worker/ imports a Postgres driver (DEPLOY.md capacity note): ${offenders.join(", ") || "none"}`,
  );
  assert(DRIVER.test('import { Client } from "pg";'), "control: a pg import is recognised");
  assert(DRIVER.test("const sql = require('postgres');"), "control: a postgres require is recognised");
  const capacity = section(read("DEPLOY.md"), "Capacity: the database and the Google quota (#3124)");
  assert(capacity.includes("scripts/test-ops-doc-claims.ts"), "the capacity note names the check that keeps it true");
}

// --- #3129: DEPLOY.md names the public booking switch as it really is ----------
{
  const text = section(read("DEPLOY.md"), "Feature flags and the kill switch (#1052)");
  assert(text.length > 0, "DEPLOY.md has its kill switch section");
  assert(!/there is no kill switch/i.test(text), "DEPLOY.md no longer says there is no kill switch");

  const catalog = read("src/lib/notify/alert-catalog.ts");
  assert(/key:\s*"public_booking_stopped"/.test(catalog), "public_booking_stopped is a catalogued alert key");
  assert(text.includes("`public_booking_stopped`"), "DEPLOY.md names the public_booking_stopped alert");

  assert(text.includes("`/admin/business-hours`"), "DEPLOY.md says where the switch is");
  const page = read("src/app/admin/business-hours/page.tsx");
  assert(/<PublicBookingSwitch\b/.test(page), "the switch is rendered on /admin/business-hours");
  const control = read("src/components/admin/PublicBookingSwitch.tsx");
  for (const label of ["Stop online booking", "Start online booking"]) {
    assert(control.includes(label), `the switch's button reads "${label}"`);
    assert(text.includes(`**${label}**`), `DEPLOY.md names the "${label}" button`);
  }

  const copy = /bookingsPaused:\s*\n?\s*"([^"]+)"/.exec(read("src/lib/booking/booker-copy.ts"))?.[1];
  assert(!!copy, "the paused booker copy is readable");
  assert(!!copy && text.replace(/\s+/g, " ").includes(copy), "DEPLOY.md quotes the sentence a paused lead reads");
  assert(existsSync(".github/workflows/kill-switch.yml"), "the nightly kill switch proof DEPLOY.md names exists");
}

// --- #3097: local dev is warned off production ---------------------------------
{
  const setup = section(read("README.md"), "Setup");
  assert(/\[!WARNING\]/.test(setup), "README Setup carries a boxed warning");
  for (const key of ["SUPABASE_SECRET_KEY", "SLACK_BOT_TOKEN"]) {
    assert(setup.includes(`\`${key}\``), `README's warning names ${key}`);
  }
  const env = read(".env.example");
  const warnBefore = (key: string) => {
    const at = env.indexOf(`\n${key}=`);
    const block = env.slice(Math.max(0, env.lastIndexOf("# ---", at)), at);
    return /WARNING \(#3097\)/.test(block);
  };
  assert(warnBefore("SUPABASE_SECRET_KEY"), ".env.example warns in the Supabase block");
  assert(warnBefore("SLACK_BOT_TOKEN"), ".env.example warns in the Slack block");
}

// --- #3130: every ADR is indexed, and a PR is asked whether it needs one --------
{
  const index = read("docs/adr/README.md");
  const files = readdirSync("docs/adr").filter((f) => /^\d{4}-.+\.md$/.test(f));
  assert(files.length >= 10, `docs/adr holds the backfilled records (found ${files.length})`);
  for (const f of files) assert(index.includes(`(./${f})`), `docs/adr/README.md links ${f}`);
  for (const m of index.matchAll(/\(\.\/(\d{4}-[^)]+\.md)\)/g)) {
    assert(files.includes(m[1]), `docs/adr/README.md links a record that exists: ${m[1]}`);
  }
  assert(/## When to write one/.test(index), "docs/adr/README.md says when a record is due");
  assert(/^## Decision record$/m.test(read(".github/pull_request_template.md")), "the PR template asks about a decision record");
  assert(read("docs/review-process.md").includes("docs/adr/"), "review-process.md points at docs/adr");
}

// --- #3132: the erasure reply discloses every copy the positions memo keeps --------
{
  const runbook = read("docs/pii-erasure-runbook.md");
  const reply = /<!-- runbook-reference: the text of a reply to a data subject[^>]*-->\s*```\n([\s\S]*?)```/.exec(runbook)?.[1] ?? "";
  assert(reply.length > 0, "the erasure reply template is readable");
  // Each residual the memo records, by the words the reply must use for it. Position 3
  // keeps the Salesforce lead reference on the erased booking, so a reply that left it
  // out would be an incomplete disclosure (L440).
  for (const [residual, words] of [
    ["backups", /backups/i],
    ["the agent's calendar", /calendar/i],
    ["Regal and Cadence", /Regal and Cadence/],
    ["the Salesforce lead reference (position 3)", /reference/i],
  ] as const) {
    assert(words.test(reply), `the erasure reply names ${residual}`);
  }
  const memo = read("docs/pii-legal-positions.md");
  assert(/Salesforce lead\s+reference stays/.test(memo), "position 3 still keeps the Salesforce reference");

  // Positions 5 to 7 are engineering's proposal, not Dan's 2026-07-29 decision, and the
  // memo must say so where it attributes decisions (L249).
  const header = memo.slice(0, memo.indexOf("## What we need from you"));
  assert(/Decided by:\*\* Dan Wright, 2026-07-29, positions 1 to 4/.test(header), "the memo scopes Dan's decision to positions 1 to 4");
  assert(/Proposed by:\*\* Engineering \(Slate\), 2026-10-03, positions 5 to 7/.test(header), "the memo dates and attributes positions 5 to 7 as proposed");
  const row = (n: number) => new RegExp(`^\\| ${n}\\. (.*)$`, "m").exec(memo)?.[1] ?? "";
  for (const n of [5, 6, 7]) {
    assert(row(n).includes("(proposed by engineering, 2026-10-03, not yet decided)"), `sign-off row ${n} is marked proposed, not decided`);
  }
  // Each statement the reply rests on has a row of its own: the two residuals the
  // memo's own section lists, then the reply wording itself.
  assert(/backups/i.test(row(5)) && /residual 1/.test(row(5)), "sign-off row 5 is the backups statement (residual 1)");
  assert(/calendar/i.test(row(6)) && /residual 2/.test(row(6)), "sign-off row 6 is the calendar copy (residual 2)");
  assert(/reply to the requester/i.test(row(7)), "sign-off row 7 is the reply wording");
  const residuals = section(memo, "Two residuals the positions above do not cover");
  assert(/backups as position 5, the agent's calendar as position 6/.test(residuals.replace(/\s+/g, " ")), "the residuals intro maps each residual to its own row");
  assert(read("docs/pii-erasure-runbook.md").includes("(positions 5 to 7)"), "the erasure runbook cites the proposed rows by number");
}

// --- #3131: the system context diagram, and the credential table it links -------
{
  const arch = read("docs/architecture.md");
  const ctx = section(arch, "System context: everything Slate talks to");
  assert(/```mermaid/.test(ctx), "architecture.md has a system context diagram");
  for (const system of [
    "Supabase", "Google Calendar", "Salesforce", "Twilio", "Regal", "Cadence",
    "Slack", "Snowflake", "cal.com", "trypennie", "Supabase Auth",
  ]) {
    assert(ctx.includes(system), `the system context diagram shows ${system}`);
  }
  // noodge sends a key on its health checks to stamp the uptime heartbeat (#1228), so
  // its arrow names that key rather than reading as unauthenticated.
  const noodge = /noodge -->\|"([^"]*)"\|/.exec(ctx)?.[1] ?? "";
  assert(noodge.includes("UPTIME_HEARTBEAT_KEY"), `the noodge arrow names the key it sends (got "${noodge}")`);
  assert(ctx.includes("./api.md#credentials-and-auth-models"), "the diagram links the credentials table");
  assert(/^## Credentials and auth models$/m.test(read("docs/api.md")), "docs/api.md has the heading that anchor names");

  // Every secret the diagram names is a DEFINED setting, matched as a whole name: a
  // `NAME=` line in .env.example, or a `wrangler secret put NAME` line in DEPLOY.md's
  // secrets list. A substring test would pass a misspelling that happens to sit
  // inside a longer real name, or any name merely mentioned in prose.
  const defined = definedSettings(read(".env.example"), read("DEPLOY.md"));
  assert(defined.size > 20, `the defined settings are readable (found ${defined.size})`);
  for (const m of ctx.matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g)) {
    assert(defined.has(m[1]), `the diagram's ${m[1]} is a defined setting`);
  }
  // Positive controls (L1): a misspelt name and a truncated real one are refused.
  assert(!defined.has("SLACK_BOT_TOKN"), "control: a misspelt setting is not defined");
  assert(!defined.has("BOOKING_API_KEY_TRYPEN"), "control: a truncation of a real setting is not itself defined");
  assert(
    definedSettings("FOO_BAR=1\n# BAZ_QUX=2\n", "wrangler secret put ZIP_ZAP  # x\n").size === 2,
    "control: only NAME= lines and secret put lines define a setting",
  );
}

finish();
