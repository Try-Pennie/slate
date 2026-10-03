// The daily off platform database backup workflow (#3076) keeps the promises the
// runbook and the staleness page make about it. Each rule below is checked against the
// real workflow file AND against a copy broken in exactly that way, so a checker that
// stopped reading the file cannot pass (L1).
//
// Run: node --experimental-strip-types scripts/test-db-backup-workflow.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { DUMP_FILES } from "./lib/db-dump-check.ts";

const root = join(import.meta.dirname, "..");
const workflow = readFileSync(join(root, ".github/workflows/db-backup.yml"), "utf8");
const heartbeatRoute = readFileSync(join(root, "src/app/api/smoke/heartbeat/route.ts"), "utf8");
const health = readFileSync(join(root, "src/lib/monitor/health.ts"), "utf8");

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** The GitHub lateness a successful scheduled run must be allowed without paging. */
const LATENESS_ALLOWANCE_MS = 60 * MIN;

/** Each step's text, keyed by its name (or its `uses` for an unnamed step). */
function steps(text: string): { name: string; body: string }[] {
  const chunks = text.split(/\n      - (?=name:|uses:)/).slice(1);
  return chunks.map((c) => {
    const name = /^name:\s*(.+)$/m.exec(c)?.[1]?.trim() ?? /^uses:\s*(\S+)/.exec(c)?.[1] ?? "";
    return { name, body: c };
  });
}

/** The 26 hour bound, read out of health.ts rather than imported, because health.ts
 *  pulls in the app through the alias and this suite runs on bare node. */
function backupBoundMs(src: string): number | null {
  const m = /BACKUP_STALE_BOUNDS_MS[^=]*=\s*\{\s*"db-backup":\s*(\d+)\s*\*\s*60\s*\*\s*MIN/.exec(src);
  return m ? Number(m[1]) * 60 * MIN : null;
}

function problems(text: string, route = heartbeatRoute, healthSrc = health): string[] {
  const out: string[] = [];
  const all = steps(text);
  const index = (re: RegExp) => all.findIndex((s) => re.test(s.name));

  // An explicit job timeout (L313), and a daily schedule the bound is derived from.
  const timeout = /timeout-minutes:\s*(\d+)/.exec(text);
  if (!timeout) out.push("the job has no explicit timeout-minutes");
  const cron = /cron:\s*"(\d+) (\d+) \* \* \*"/.exec(text);
  if (!cron) out.push("the schedule is not a once a day cron");
  const bound = backupBoundMs(healthSrc);
  if (bound === null) out.push("BACKUP_STALE_BOUNDS_MS has no db-backup bound");
  if (bound !== null && timeout) {
    const slack = bound - DAY - Number(timeout[1]) * MIN;
    if (slack < LATENESS_ALLOWANCE_MS) {
      out.push(`the bound leaves ${slack / MIN} minutes for GitHub lateness after a day and the timeout, under an hour`);
    }
  }

  // Every file the judge expects is dumped, by the name the judge reads.
  const dump = all[index(/^Dump the database/)];
  if (!dump) out.push("there is no dump step");
  for (const f of DUMP_FILES) {
    if (dump && !dump.body.includes(`"$dir/${f}"`)) out.push(`the dump step does not write ${f}`);
  }

  // The order that makes the stamp mean something: dump, judge, upload, read back, stamp.
  const order = [/^Dump the database/, /^Refuse a dump/, /^Package the dump/, /^Upload to R2/, /^Read the upload back/, /^Stamp the backup heartbeat/];
  const at = order.map(index);
  if (at.some((i) => i < 0)) out.push("a required step is missing (dump, judge, package, upload, read back, stamp)");
  else if (at.some((v, i) => i > 0 && v <= at[i - 1]!)) out.push("the steps are out of order, so the stamp can precede the proof");

  const stamp = all[index(/^Stamp the backup heartbeat/)];
  if (stamp) {
    if (!/if:\s*success\(\)/.test(stamp.body)) out.push("the heartbeat stamp is not gated on success()");
    if (!stamp.body.includes("lane=db-backup")) out.push("the stamp does not name the db-backup lane");
  }
  if (!/"db-backup",/.test(route)) out.push("the heartbeat route does not accept the db-backup lane");

  // Nothing between the dump and the stamp may be allowed to fail quietly.
  for (const s of all.slice(index(/^Dump the database/))) {
    if (/continue-on-error:\s*true/.test(s.body)) out.push(`"${s.name}" carries continue-on-error, so a failure there still stamps`);
  }

  // The secrets the brief names, and the database pair reused from ci.yml.
  for (const name of [
    "R2_BACKUP_ACCESS_KEY_ID",
    "R2_BACKUP_SECRET_ACCESS_KEY",
    "R2_BACKUP_ENDPOINT",
    "R2_BACKUP_BUCKET",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_DB_PASSWORD",
  ]) {
    if (!text.includes(`secrets.${name}`)) out.push(`the workflow never reads the ${name} secret`);
  }

  // Every node step runs on a pinned node, set up BEFORE it (L25): the runner image's
  // own node may predate the type stripping flag, which would fail every run red.
  const setupAt = all.findIndex(
    (s) => /uses:\s*actions\/setup-node@[0-9a-f]{40}\b/.test(s.body) && /node-version:\s*24\b/.test(s.body),
  );
  const firstNode = all.findIndex((s) => /^\s*run:[\s\S]*\bnode\s+--/m.test(s.body));
  if (firstNode >= 0 && (setupAt < 0 || setupAt > firstNode)) {
    out.push("a step runs node before a pinned setup-node (sha pinned, node-version 24) has run");
  }

  // A missing secret fails the run red, never a quiet skip.
  const pre = all[index(/^Preflight/)];
  if (!pre || !/exit 1/.test(pre.body)) out.push("a missing secret does not fail the run");

  // The dump holds customer contact data: R2 only, never a GitHub artifact.
  if (/uses:\s*actions\/upload-artifact/.test(text)) out.push("the dump is uploaded as a GitHub artifact");

  return out;
}

// --- the real workflow keeps every promise ------------------------------------
{
  const found = problems(workflow);
  for (const p of found) console.error(`  ${p}`);
  eq(found.length, 0, "db-backup.yml keeps every promise the runbook and the page make");
  assert(steps(workflow).length >= 9, `parsed the workflow's steps (found ${steps(workflow).length})`);
}

// --- and each rule catches its own breakage ----------------------------------
const broken: [string, string, RegExp][] = [
  ["no timeout", workflow.replace(/timeout-minutes:\s*\d+/, ""), /no explicit timeout/],
  ["a long timeout eats the lateness", workflow.replace(/timeout-minutes:\s*\d+/, "timeout-minutes: 90"), /under an hour/],
  ["the stamp ungated", workflow.replace(/(Stamp the backup heartbeat[^\n]*\n\s*)if: success\(\)\n/, "$1"), /not gated on success/],
  ["the history dump dropped", workflow.replace(/\n.*history_data\.sql.*/, ""), /does not write history_data\.sql/],
  ["the judge removed", workflow.replace(/\n      - name: Refuse a dump[\s\S]*?(?=\n      - name:)/, ""), /a required step is missing/],
  ["the read back moved after the stamp", (() => {
    const all = steps(workflow);
    const rb = all.findIndex((s) => /^Read the upload back/.test(s.name));
    const st = all.findIndex((s) => /^Stamp the backup/.test(s.name));
    const reordered = [...all];
    [reordered[rb], reordered[st]] = [reordered[st]!, reordered[rb]!];
    return workflow.split(/\n      - (?=name:|uses:)/)[0] + reordered.map((s) => "\n      - " + s.body).join("");
  })(), /out of order/],
  ["a quiet upload", workflow.replace("      - name: Upload to R2\n", "      - name: Upload to R2\n        continue-on-error: true\n"), /continue-on-error/],
  ["an R2 setting renamed", workflow.replaceAll("R2_BACKUP_BUCKET }}", "R2_BUCKET }}"), /R2_BACKUP_BUCKET secret/],
  ["a skip instead of a failure", workflow.replace(/exit 1\n          fi\n\n      # #1437/, "exit 0\n          fi\n\n      # #1437"), /does not fail the run/],
  ["no pinned node", workflow.replace(/\n      - uses: actions\/setup-node@[\s\S]*?node-version: 24\n/, "\n"), /before a pinned setup-node/],
  ["a node pinned by tag, not sha", workflow.replace(/setup-node@[0-9a-f]{40}/, "setup-node@v4"), /before a pinned setup-node/],
  ["setup-node after the first node step", (() => {
    const all = steps(workflow);
    const setup = all.findIndex((s) => /setup-node/.test(s.body));
    const judge = all.findIndex((s) => /^Refuse a dump/.test(s.name));
    const moved = [...all];
    const [step] = moved.splice(setup, 1);
    moved.splice(judge, 0, step!);
    return workflow.split(/\n      - (?=name:|uses:)/)[0] + moved.map((s) => "\n      - " + s.body).join("");
  })(), /before a pinned setup-node/],
  ["an artifact upload", workflow + "\n      - uses: actions/upload-artifact@v4\n", /GitHub artifact/],
];
for (const [what, text, expect] of broken) {
  assert(problems(text).some((p) => expect.test(p)), `caught: ${what}`);
}
assert(
  problems(workflow, heartbeatRoute.replace('"db-backup",', "")).some((p) => /does not accept/.test(p)),
  "caught: the heartbeat route no longer accepting the lane",
);
assert(
  problems(workflow, heartbeatRoute, health.replace(/"db-backup":\s*26/, '"db-backup": 24')).some((p) => /under an hour/.test(p)),
  "caught: a bound one late run would cross",
);

finish();
