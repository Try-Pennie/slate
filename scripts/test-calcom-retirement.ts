// The "cal.com retired" switch (#2875). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-calcom-retirement.ts
//
// One stored admin setting retires every cal.com lane at once. This pins the shared
// half: the read, which way each consumer falls when that read fails, and the
// wiring that lives outside TypeScript (the two workflows and the migration). Each
// consumer's own behaviour is driven in its own suite (lane-watchdog.test.ts,
// test-canary-trigger.ts, test-import-write.ts, test-activation-hours.ts,
// calcom-sync.test.ts, test-calcom-override-sweep.ts, test-unset-hours.ts,
// test-parallel-run-readiness.ts), because a switch is only real where it is read.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CALCOM_HEARTBEAT_LANES,
  CALCOM_RETIRED_TTL_MS,
  calcomHoursWriteRefusal,
  calcomOverrideWriteSkip,
  isCalcomLane,
  loadCalcomRetired,
  loadCalcomRetiredCached,
  withoutRetiredCalcomLanes,
  __resetCalcomRetiredCache,
} from "@/lib/calcom/retirement";
import { OUTCOME_CALCOM_RETIRED, OUTCOME_SKIPPED_PREFIX } from "@/lib/calcom/outcomes";
import { isSettled, isFailure } from "@/lib/monitor/calcom-override-sweep";
import { CANARY_STALE_BOUNDS_MS } from "@/lib/monitor/health";
import { GAP_FILL_PASSES } from "@/lib/monitor/canary-trigger";
import { assert, eq, finish } from "./lib/harness.ts";

type Reply = { data: unknown; error: { message: string } | null };

/** A db whose one read answers `reply`, or throws when `reply` is an Error. */
function fakeDb(reply: Reply | Error) {
  const reads: { table: string; cols: string; eq: [string, unknown] | null }[] = [];
  const db = {
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: (col: string, val: unknown) => ({
          maybeSingle: async () => {
            reads.push({ table, cols, eq: [col, val] });
            if (reply instanceof Error) throw reply;
            return reply;
          },
        }),
      }),
    }),
  };
  return { db: db as never, reads };
}

// --- the read: three answers, and a failure is never one of the two real ones ------
{
  const on = fakeDb({ data: { calcom_retired: true }, error: null });
  eq(await loadCalcomRetired(on.db), true, "a stored true reads as retired");
  eq(on.reads[0], { table: "monitor_alert_config", cols: "calcom_retired", eq: ["id", 1] }, "reads the one config row");

  eq(await loadCalcomRetired(fakeDb({ data: { calcom_retired: false }, error: null }).db), false, "a stored false reads as live");
  // No row at all is the state before anybody ever saved the alerts page. The column
  // default is the off value, so the row that does not exist yet means the same.
  eq(await loadCalcomRetired(fakeDb({ data: null, error: null }).db), false, "no config row reads as the default, live");

  eq(
    await loadCalcomRetired(fakeDb({ data: null, error: { message: "column calcom_retired does not exist" } }).db),
    null,
    "a refused read is UNKNOWN, never false (a deploy ahead of its migration must not read as live)",
  );
  eq(await loadCalcomRetired(fakeDb(new Error("fetch failed")).db), null, "a thrown read is unknown too");
  eq(
    await loadCalcomRetired(fakeDb({ data: { calcom_retired: "yes" }, error: null }).db),
    null,
    "a value that is not a boolean is unknown, never coerced",
  );
}

// --- the cache the every minute watchdog reads through ----------------------------
{
  __resetCalcomRetiredCache();
  let calls = 0;
  let answer: Reply | Error = { data: { calcom_retired: true }, error: null };
  const counting = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            calls++;
            if (answer instanceof Error) throw answer;
            return answer;
          },
        }),
      }),
    }),
  } as never;
  const t0 = 1_000_000;
  eq(await loadCalcomRetiredCached(t0, counting), true, "the first read goes to the database");
  eq(await loadCalcomRetiredCached(t0 + CALCOM_RETIRED_TTL_MS - 1, counting), true, "inside the TTL it is served from memory");
  eq(calls, 1, "one read per TTL, not one per tick");
  answer = { data: { calcom_retired: false }, error: null };
  eq(await loadCalcomRetiredCached(t0 + CALCOM_RETIRED_TTL_MS + 1, counting), false, "past the TTL an edit lands");
  answer = new Error("fetch failed");
  eq(
    await loadCalcomRetiredCached(t0 + 3 * CALCOM_RETIRED_TTL_MS, counting),
    null,
    "a failed refresh is unknown, never the last value: every consumer decides for itself what unknown means",
  );
  eq(calls, 3, "a failure is not cached, so the next tick asks again");
  __resetCalcomRetiredCache();
}

// --- which lanes belong to cal.com ----------------------------------------------
for (const lane of CALCOM_HEARTBEAT_LANES) {
  assert(lane in CANARY_STALE_BOUNDS_MS, `${lane} is a watched canary lane, so retiring it has something to retire`);
}
{
  const live = withoutRetiredCalcomLanes(CANARY_STALE_BOUNDS_MS, false);
  eq(Object.keys(live), Object.keys(CANARY_STALE_BOUNDS_MS), "live: every canary lane is watched, as today");
  const unknown = withoutRetiredCalcomLanes(CANARY_STALE_BOUNDS_MS, null);
  eq(Object.keys(unknown), Object.keys(CANARY_STALE_BOUNDS_MS), "unknown: the watchdog keeps today's behaviour");
  const retired = withoutRetiredCalcomLanes(CANARY_STALE_BOUNDS_MS, true);
  for (const lane of CALCOM_HEARTBEAT_LANES) assert(!(lane in retired), `retired: ${lane} is no longer watched`);
  assert("smoke-canary" in retired && "smoke-canary-full" in retired, "retired: the booking canary is still watched");
}
// Every gap fill that re fires a cal.com workflow is one of these lanes, so the
// re-dispatch table and the watchdog cannot disagree about what cal.com owns.
for (const [pass, cfg] of Object.entries(GAP_FILL_PASSES)) {
  const calcomWorkflow = /schedule-parity|router-replay/.test(cfg.workflow);
  eq(isCalcomLane(cfg.lane), calcomWorkflow, `gap fill ${pass} is a cal.com lane exactly when it fires a cal.com workflow`);
}

// --- per consumer: which way a failed read falls ----------------------------------
eq(calcomHoursWriteRefusal(false), null, "live: the cal.com hours import may write");
assert(
  typeof calcomHoursWriteRefusal(true) === "string" && /retired/i.test(calcomHoursWriteRefusal(true) ?? ""),
  "retired: the hours import is refused, and says why",
);
assert(
  typeof calcomHoursWriteRefusal(null) === "string" && /could not/i.test(calcomHoursWriteRefusal(null) ?? ""),
  "unknown: the hours import is refused too, because overwriting a Slate week is the one irreversible direction",
);
assert(calcomHoursWriteRefusal(true) !== calcomHoursWriteRefusal(null), "retired and unreadable are two sentences (L11)");

eq(calcomOverrideWriteSkip(false), null, "live: the time off dual write goes ahead");
eq(
  calcomOverrideWriteSkip(null),
  null,
  "unknown: the dual write goes ahead, because a missing block lets cal.com book somebody who is away",
);
eq(calcomOverrideWriteSkip(true), OUTCOME_CALCOM_RETIRED, "retired: the dual write records its own skip");
assert(OUTCOME_CALCOM_RETIRED.startsWith(OUTCOME_SKIPPED_PREFIX), "the retired outcome is a skip");
// #2890 reversed #2875 here: the retired skip used to be settled, which left every
// time off approved during retirement missing from cal.com once it was put back.
// It is retried by a LIVE sweep (a retired sweep returns before reading any row).
assert(!isSettled(OUTCOME_CALCOM_RETIRED) && isFailure(OUTCOME_CALCOM_RETIRED), "a live sweep retries a retired skip, and pages if it stays missing");

// --- the stored default is the OFF value (L72) --------------------------------------
{
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/0147_calcom_retired.sql"), "utf8");
  assert(
    /add column calcom_retired boolean not null default false/.test(sql),
    "the column is NOT NULL DEFAULT false, so the parallel run is what a fresh row means",
  );
}

// --- #3896: when it was retired is stamped by the database, at every writer ----------
{
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/0203_calcom_retired_at.sql"), "utf8");
  assert(/add column calcom_retired_at timestamptz;/.test(sql), "the stamp is a nullable timestamptz: null means cal.com is live");
  const backfill = sql.indexOf("update monitor_alert_config c");
  const trigger = sql.indexOf("create trigger monitor_alert_config_stamp_calcom_retired");
  assert(backfill > 0 && trigger > backfill, "a row already retired is backfilled BEFORE the trigger exists, which would otherwise keep its null");
  assert(/before insert or update on monitor_alert_config/.test(sql), "every write to the row passes the trigger, the admin action and hand SQL alike (L593)");
  assert(/old\.calcom_retired then\s+[^\n]*\n\s*new\.calcom_retired_at := coalesce\(new\.calcom_retired_at, old\.calcom_retired_at, now\(\)\)/.test(sql), "pressing retire again keeps the first stamp, so the overlap is not restarted");
  assert(/else\s+new\.calcom_retired_at := null;/.test(sql), "putting cal.com back clears the stamp");
}

// --- the two workflows ask before they touch cal.com ---------------------------------
/** The `if:` of the step whose `- name:` line matches, read out of the workflow file. */
function stepIf(file: string, name: RegExp): string | null {
  const lines = readFileSync(join(process.cwd(), ".github/workflows", file), "utf8").split("\n");
  const start = lines.findIndex((l) => /^\s*- name:/.test(l) && name.test(l));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length && !/^\s*- name:/.test(lines[i]); i++) {
    const m = lines[i].match(/^\s*if:\s*(.+)$/);
    if (m) return m[1];
  }
  return null;
}
{
  const check = stepIf("schedule-parity.yml", /Is cal\.com retired/);
  assert(check === null || !/retired/.test(check), "the parity workflow's retirement check runs on every run");
  const apply = stepIf("schedule-parity.yml", /Correct drifted hours/) ?? "";
  assert(
    apply.includes("steps.retired.outputs.retired == '0'"),
    "the hours apply runs ONLY on a measured live answer, so an unreadable setting writes nothing",
  );
  for (const step of [/Compare Slate against cal\.com/, /Report the result/, /Stamp the parity heartbeat/, /Slack alert when the sweep/]) {
    const cond = stepIf("schedule-parity.yml", step) ?? "";
    assert(cond.includes("steps.retired.outputs.retired != '1'"), `parity: ${step.source} is skipped once cal.com is retired`);
  }
  for (const step of [/Replay cal\.com/, /Say what the replay found/, /Stamp the replay heartbeat/]) {
    const cond = stepIf("router-replay.yml", step) ?? "";
    assert(cond.includes("steps.retired.outputs.retired != '1'"), `replay: ${step.source} is skipped once cal.com is retired`);
  }
  for (const file of ["schedule-parity.yml", "router-replay.yml"]) {
    const text = readFileSync(join(process.cwd(), ".github/workflows", file), "utf8");
    assert(/- name: Is cal\.com retired\?/.test(text), `${file} has the retirement check step`);
    assert(/id: retired\b/.test(text), `${file} names it so later steps can read its output`);
    assert(
      /id: retired\n(\s*#.*\n)*\s*continue-on-error: true/.test(text),
      `${file}: a crash in the check reads as unknown rather than failing the job before the comparison and its alert`,
    );
    assert(/scripts\/calcom-retired-check\.ts/.test(text), `${file} runs the shared retirement check`);
  }
}

finish();
