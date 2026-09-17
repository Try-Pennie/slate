// #2294: does production hold a table no migration created?
//
// Every guard in this repo enumerates tables from the MIGRATION FILES: the RLS scan, the
// grants scan (#2271), the content lock. So a table that exists only in the database is
// exempt from all of them by construction, and #2271's blanket
// `grant ... on all tables in schema public` reaches it while nothing says whether its RLS
// is right. A guard that enumerates from one side cannot see what the other side holds
// (L96, L456).
//
// Measured 2026-09-17: production holds 41 tables in public, the migrations declare 40, and
// the difference is one backfill snapshot. Default deny today, so this is a blind spot
// rather than an exposure, and a blind spot that can grow with nothing saying so.
//
// This file drives the PURE verdict. The live read is `pnpm verify:table-drift`, because
// only a connection can list what production holds.
import { assert, eq, finish } from "./lib/harness.ts";
import {
  KNOWN_UNDECLARED_TABLES,
  TABLE_DRIFT_EXIT,
  judgeTableDrift,
  tablesFromRootDocument,
} from "./lib/table-drift.ts";

const DECLARED = ["bookings", "users", "busy_blocks"];

// --- the known list is reasoned, not just populated ------------------------------------
{
  assert(KNOWN_UNDECLARED_TABLES.length > 0, "there is at least one recorded artifact to judge");
  for (const k of KNOWN_UNDECLARED_TABLES) {
    assert(
      k.reason.trim().split(/\s+/).length >= 8,
      `${k.table} carries a written reason rather than a label`,
    );
    assert(
      Number.isInteger(k.issue) && k.issue > 0,
      `${k.table} names the issue that removes it, so an artifact cannot sit here forever`,
    );
  }
}

// --- nothing read is never agreement ----------------------------------------------------
{
  eq(
    judgeTableDrift({ live: [], declared: DECLARED, known: [] }).code,
    TABLE_DRIFT_EXIT.nothingRead,
    "an empty live list is a read that did not work, never a database with no tables",
  );
  eq(
    judgeTableDrift({ live: DECLARED, declared: [], known: [] }).code,
    TABLE_DRIFT_EXIT.nothingRead,
    "an empty declared list is a parser that read nothing, never a repo with no migrations",
  );
}

// --- agreement ---------------------------------------------------------------------------
{
  const v = judgeTableDrift({ live: DECLARED, declared: DECLARED, known: [] });
  eq(v.code, TABLE_DRIFT_EXIT.agree, "the same set both sides agrees");
  eq(v.compared, 3, "and it says how many production holds, so agreement cannot read as a broken read");
  eq(v.declaredCount, 3, "and how many the migrations declare, since the two differ once anything is recorded");
}

// --- a table production holds that no migration created ----------------------------------
{
  const v = judgeTableDrift({ live: [...DECLARED, "something_nobody_declared"], declared: DECLARED, known: [] });
  eq(v.code, TABLE_DRIFT_EXIT.undeclared, "an undeclared live table is the finding this exists for");
  eq(v.undeclared.join(","), "something_nobody_declared", "and it is named");
}

// --- and one that is RECORDED is not a finding, but is still reported ---------------------
{
  const known = [{ table: "a_backup_snapshot", reason: "x".repeat(50), issue: 2294 }];
  const v = judgeTableDrift({ live: [...DECLARED, "a_backup_snapshot"], declared: DECLARED, known });
  eq(v.code, TABLE_DRIFT_EXIT.agree, "a recorded artifact does not fail the run");
  eq(v.recorded.join(","), "a_backup_snapshot", "but it is listed, so a recorded artifact is never silent");
}

// --- a record naming a table production no longer holds is stale --------------------------
{
  const known = [{ table: "dropped_long_ago", reason: "x".repeat(50), issue: 2294 }];
  const v = judgeTableDrift({ live: DECLARED, declared: DECLARED, known });
  eq(
    v.code,
    TABLE_DRIFT_EXIT.staleRecord,
    "an entry covering a table that is gone is dead config and says so",
  );
  eq(v.staleRecords.join(","), "dropped_long_ago", "naming it");
}

// --- drift the other way: declared and not there ------------------------------------------
{
  const v = judgeTableDrift({ live: ["bookings", "users"], declared: DECLARED, known: [] });
  eq(
    v.code,
    TABLE_DRIFT_EXIT.missing,
    "a table the migrations declare and production does not have is its own finding",
  );
  eq(v.missing.join(","), "busy_blocks", "and it is named");
}

// --- the worst finding names the run, and every finding is still carried ------------------
{
  const known = [{ table: "gone_now", reason: "x".repeat(50), issue: 2294 }];
  const v = judgeTableDrift({ live: ["bookings", "users", "undeclared_one"], declared: DECLARED, known });
  eq(v.code, TABLE_DRIFT_EXIT.undeclared, "the undeclared table outranks the missing one and the stale record");
  assert(
    v.missing.length === 1 && v.staleRecords.length === 1,
    "and the other two are still reported, so one finding does not hide the rest",
  );
}

// --- no two outcomes share an exit code ----------------------------------------------------
{
  const codes = Object.values(TABLE_DRIFT_EXIT);
  eq(new Set(codes).size, codes.length, "every outcome has its own exit code, so a caller can branch");
  assert(!codes.includes(1), "1 is reserved for having no credentials, decided before anything is read");
}

// --- the live read: every way of learning nothing is its own answer ---------------------
//
// The read is an EXTERNAL response, so the body is treated as hostile. What matters is that
// a refused request and a payload whose shape changed stay apart, and that neither is
// reported as a database with no tables (L10, L11).
{
  const good = tablesFromRootDocument({
    status: 200,
    body: { definitions: { bookings: {}, users: {}, availability_rules_backup_1255: {} } },
  });
  assert(good.ok && good.tables.join(",") === "availability_rules_backup_1255,bookings,users",
    "the root document's definitions are the table list, sorted");

  const refused = tablesFromRootDocument({ status: 401, body: { message: "no" } });
  assert(!refused.ok && /refused/.test(refused.why), "a refused request says it was refused");

  const notAnObject = tablesFromRootDocument({ status: 200, body: "<html>" });
  assert(!notAnObject.ok && /not an object/.test(notAnObject.why),
    "a reply that is not an object says so, rather than reading as no tables");

  const noDefs = tablesFromRootDocument({ status: 200, body: { paths: {} } });
  assert(!noDefs.ok && /no definitions/.test(noDefs.why),
    "a payload whose shape changed says THAT, which is a different place to look from a refusal");

  const nulled = tablesFromRootDocument({ status: 200, body: null });
  assert(!nulled.ok, "a null body is a failed read, never an empty database");

  const arrayBody = tablesFromRootDocument({ status: 200, body: [] });
  assert(!arrayBody.ok, "an array body is a failed read too");

  // The one case that is a real answer rather than a failure: the read WORKED and the
  // database exposes nothing. It comes back ok, and the judge is what scores it as nothing
  // read, so the network is never blamed for it.
  const reallyEmpty = tablesFromRootDocument({ status: 200, body: { definitions: {} } });
  assert(reallyEmpty.ok && reallyEmpty.tables.length === 0,
    "an empty definitions object is a successful read of nothing, judged downstream");
  eq(
    judgeTableDrift({ live: reallyEmpty.ok ? reallyEmpty.tables : [], declared: DECLARED, known: [] }).code,
    TABLE_DRIFT_EXIT.nothingRead,
    "and the judge scores it as nothing read rather than as every declared table having vanished",
  );

  // No two failures share a sentence, or one answers for another (L11).
  const whys = [refused, notAnObject, noDefs].map((r) => (r.ok ? "" : r.why));
  eq(new Set(whys).size, whys.length, "no two failed reads say the same thing");
}

finish();
