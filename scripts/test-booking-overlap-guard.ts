// The guard that makes two overlapping bookings on one agent unstorable (#2274).
//
// The defect it closes was found by the first load run to confirm bookings
// concurrently: three pairs of CONFIRMED bookings overlapping on one agent, for
// example 17:50 to 18:10 against 18:00 to 18:20, each pair created about 200ms
// apart by two different leads. The appointment is 20 minutes long on a 10 minute
// grid, copied from production, so every adjacent offered time overlaps by ten,
// and `bookings_active_slot_uniq` is unique on `(assigned_user_id, starts_at)`:
// two different starts are two different rows to it, and both insert.
//
// This suite is the OFFLINE half. It reads the migration and pins the two things
// that make the guard correct rather than merely present: that it is scoped to
// exactly the rows the existing unique index is scoped to, and that the save maps
// its refusal to a slot clash rather than to a server error.
//
// The BEHAVIOURAL half is the load run's preflight, which plants an OVERLAPPING
// pair against a live branch and requires the database to refuse it, beside the
// identical pair it already plants for the unique index. The judge reads both and
// fails the run when either was not seen to enforce, because an absence of
// overlaps only means something if the things preventing them were working.
//
// That sentence was FALSE when this file first shipped: it claimed the preflight
// carried the behavioural half while the preflight only ever planted an identical
// window, which the unique index refuses and which says nothing about overlap. A
// comment asserting coverage that does not exist is worse than no comment, because
// it is believed. Fixed by making it true rather than by softening it.
//
// Run: node --experimental-strip-types scripts/test-booking-overlap-guard.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const DIR = "supabase/migrations";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const sql = (name: string) => readFileSync(join(DIR, name), "utf8");

/** Collapse whitespace so a filter can be compared regardless of how it is wrapped. */
const flat = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// --- the migration exists and creates the guard -------------------------------

const guardFile = files.find((f) => /overlap/.test(f));
assert(guardFile !== undefined, "a migration adds the overlap guard");
const guard = guardFile ? sql(guardFile) : "";

{
  assert(
    /create\s+extension\s+if\s+not\s+exists\s+btree_gist/i.test(guard),
    "it installs btree_gist, which is what lets one constraint mix an equality on the agent with an overlap on the range",
  );
  assert(
    /exclude\s+using\s+gist/i.test(guard),
    "it adds an EXCLUDE constraint rather than another unique index, because uniqueness cannot express overlap",
  );
  assert(
    /tstzrange\s*\(\s*starts_at\s*,\s*ends_at\s*(,\s*'\[\)'\s*)?\)\s*with\s*&&/i.test(flat(guard).replace(/ /g, " ")) ||
      /tstzrange\([^)]*\)\s*with\s*&&/i.test(flat(guard)),
    "it overlaps the booking's own range",
  );
  assert(
    /assigned_user_id\s*with\s*=/i.test(flat(guard)),
    "and only ever compares bookings belonging to the SAME agent",
  );
}

{
  // HALF OPEN, so a booking ending at 18:00 and one starting at 18:00 do not
  // overlap. Back to back bookings are the normal case on a 10 minute grid and
  // refusing them would break ordinary booking far more visibly than the defect
  // this fixes (L159: the other direction matters as much as the one that fails).
  assert(
    /'\[\)'/.test(guard),
    "the range is half open, so a booking that ends when another starts is not an overlap",
  );
}

// --- it guards exactly the rows the unique index guards ------------------------

{
  // The two guards answer the same question about the same rows, so a row one
  // protects and the other does not is a hole nobody would see. The filter is
  // compared against the SHIPPED unique index rather than against a copy written
  // here, so the day somebody changes one, this fails rather than drifting (L70).
  const uniqueFile = files.find((f) => /reassign_double_book/.test(f))!;
  const unique = sql(uniqueFile);
  // The PREDICATE, not the whole clause: `create index ... where <p>` takes it bare
  // and `alter table ... exclude ... where (<p>)` requires the parentheses, so
  // comparing the clauses would report two identical scopes as different.
  const filterOf = (text: string): string | null => {
    const m = text.match(
      /where\s*\(?\s*(status\s+in\s*\([^)]*\)\s*and\s+allow_double_book\s*=\s*false)/i,
    );
    return m ? flat(m[1]!) : null;
  };
  const uniqueFilter = filterOf(unique);
  const guardFilter = filterOf(guard);
  assert(uniqueFilter !== null, "the shipped unique index really carries the filter this compares against");
  assert(guardFilter !== null, "and the new constraint carries one too");
  eq(guardFilter, uniqueFilter, "the two guards cover exactly the same rows");
}

{
  // `allow_double_book` is not decoration: the reassign path deliberately books an
  // advisor onto a lead they already own even when busy, and sets that flag. A
  // guard that ignored it would refuse the reassign feature outright.
  assert(
    /allow_double_book\s*=\s*false/i.test(flat(guard)),
    "the deliberate double booking path stays exempt",
  );
}

// --- the save maps the refusal to a clash, not a server error ------------------

{
  // The half that decides what a LEAD sees. An exclusion constraint raises 23P01,
  // and an insert path that read only 23505 as a slot clash would answer a real race
  // with a 500 instead of "pick another time". Since #3495 the save is one database
  // function, and it is the function that tells a clash from a failure: it must
  // catch BOTH conditions, by name, and nothing else. What each does in a real
  // database, both directions, is proved by scripts/verify-commit-fresh-booking-sql.ts.
  const save = sql(files.find((f) => /_commit_fresh_booking\.sql$/.test(f)) ?? "");
  assert(
    /exception when unique_violation or exclusion_violation then/.test(save),
    "the fresh booking save catches the start index's 23505 AND the overlap guard's 23P01 as a clash",
  );
  assert(!/exception when others then\s+select \* into v_winner/.test(save), "and no catch all is read as one");
}

finish();
