// #3304: who has LEFT the bookable pool, decided once.
//
// The pool exit prune and its every minute backstop (`reconcileOrphanedPoolExits`)
// delete an out of pool agent's busy_blocks, booking write throughs included. The
// reconcile missing sweep used to scan the same agent's bookings, find them with no
// block, re-create one and page about "a missed write", which the backstop then
// deleted again on the same self heal tick. So the two sweeps must agree about
// whose busy time matters, and they can only agree if they ask ONE question.
//
// The question exists in two forms, because the backstop judges rows in code and
// the reconcile loader has to filter in SQL (a page budget is spent on every row
// it fetches, #778). This suite pins the code form's truth table and then proves
// the SQL form selects EXACTLY its complement, for every combination of the three
// columns it reads, through a strict PostgREST evaluator that refuses any filter
// shape it does not understand rather than guessing at it.
import { hasLeftPool, whereStillInPool, type PoolStateRow } from "../src/lib/bookable/left-pool.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const STAMP = "2026-10-05T14:43:27.000Z";

/** Every combination of the three columns the predicate reads. */
const ROWS: PoolStateRow[] = [];
for (const bookable of [true, false]) {
  for (const deactivated_at of [null, STAMP]) {
    for (const bookable_pending_since of [null, STAMP]) {
      ROWS.push({ bookable, deactivated_at, bookable_pending_since });
    }
  }
}

function label(r: PoolStateRow): string {
  return `bookable=${r.bookable} deactivated=${r.deactivated_at ? "set" : "null"} pending=${r.bookable_pending_since ? "set" : "null"}`;
}

// ---------------------------------------------------------------------------
// 1. The predicate itself, written out case by case rather than derived, so a
//    change to the rule has to change this table on purpose.
// ---------------------------------------------------------------------------
const EXPECTED_LEFT: Record<string, boolean> = {
  "bookable=true deactivated=null pending=null": false, // in the pool
  "bookable=true deactivated=null pending=set": false, // in the pool, a stale mark
  "bookable=true deactivated=set pending=null": true, // departed
  "bookable=true deactivated=set pending=set": true, // departed, whatever the mark says
  "bookable=false deactivated=null pending=null": true, // taken out of the pool
  "bookable=false deactivated=null pending=set": false, // an activation is owed (#2302)
  "bookable=false deactivated=set pending=null": true, // departed
  "bookable=false deactivated=set pending=set": true, // departed, whatever the mark says
};
eq(ROWS.length, 8, "the fixture covers all eight combinations");
for (const r of ROWS) {
  eq(hasLeftPool(r), EXPECTED_LEFT[label(r)], `hasLeftPool: ${label(r)}`);
}

// ---------------------------------------------------------------------------
// 2. The SQL form, recorded and evaluated with PostgREST's semantics.
// ---------------------------------------------------------------------------
type Call =
  | { op: "is"; column: string; value: null }
  | { op: "or"; filters: string; referencedTable: string };

class Recorder {
  calls: Call[] = [];
  is(column: string, value: null): Recorder {
    this.calls.push({ op: "is", column, value });
    return this;
  }
  or(filters: string, options: { referencedTable: string }): Recorder {
    this.calls.push({ op: "or", filters, referencedTable: options.referencedTable });
    return this;
  }
}

/**
 * One `column.[not.]op.literal` term of an `or` list, judged as Postgres would.
 * THROWS on anything else, so a filter this cannot read fails the suite instead of
 * being scored as a match or a miss (L98).
 */
function evalTerm(row: PoolStateRow, term: string): boolean {
  const m = /^([a-z_]+)\.(not\.)?(eq|is)\.(true|false|null)$/.exec(term.trim());
  if (!m) throw new Error(`evaluator: unsupported filter term "${term}"`);
  const [, column, negated, op, literal] = m;
  if (!(column in row)) throw new Error(`evaluator: unknown column "${column}"`);
  const value = row[column as keyof PoolStateRow];
  if (op === "eq") {
    if (literal === "null") throw new Error(`evaluator: "${term}" compares with NULL`);
    // SQL: a comparison with NULL is unknown, which neither eq nor not.eq satisfies.
    if (value === null) return false;
    const hit = value === (literal === "true");
    return negated ? !hit : hit;
  }
  const hit = literal === "null" ? value === null : value === (literal === "true");
  return negated ? !hit : hit;
}

/**
 * Whether a parent row survives the recorded filters. Every filter must be on the
 * embed the caller named: `users!inner` is what makes an embedded filter drop the
 * parent row, so a filter on any other path would mean something else entirely.
 */
function keeps(calls: Call[], embed: string, row: PoolStateRow): boolean {
  if (calls.length === 0) throw new Error("evaluator: no filter was applied at all");
  return calls.every((c) => {
    if (c.op === "is") {
      const prefix = `${embed}.`;
      if (!c.column.startsWith(prefix)) throw new Error(`evaluator: is() on "${c.column}", not on ${embed}`);
      const column = c.column.slice(prefix.length);
      if (!(column in row)) throw new Error(`evaluator: unknown column "${column}"`);
      return row[column as keyof PoolStateRow] === null;
    }
    if (c.referencedTable !== embed) {
      throw new Error(`evaluator: or() on "${c.referencedTable}", not on ${embed}`);
    }
    return c.filters.split(",").some((t) => evalTerm(row, t));
  });
}

type Apply = (q: Recorder, embed: string) => Recorder;

/** The rows where a candidate SQL form disagrees with "not hasLeftPool". */
function disagreements(apply: Apply, embed: string): string[] {
  const q = apply(new Recorder(), embed);
  return ROWS.filter((r) => keeps(q.calls, embed, r) !== !hasLeftPool(r)).map(label);
}

const shipped: Apply = (q, embed) => whereStillInPool(q, embed);
eq(disagreements(shipped, "users"), [], "whereStillInPool keeps exactly the rows hasLeftPool calls still in the pool");

// The embed name reaches BOTH halves, so a caller embedding under an alias filters
// the alias rather than a table it did not join.
{
  const q = whereStillInPool(new Recorder(), "assignee");
  assert(
    q.calls.length > 0 &&
      q.calls.every((c) => (c.op === "is" ? c.column.startsWith("assignee.") : c.referencedTable === "assignee")),
    "whereStillInPool applies every filter to the embed it was given",
  );
}

// ---------------------------------------------------------------------------
// 3. Positive controls (L1): the agreement check above must be able to fail.
// ---------------------------------------------------------------------------
const onlyDeactivated: Apply = (q, embed) => q.is(`${embed}.deactivated_at`, null);
eq(
  disagreements(onlyDeactivated, "users"),
  ["bookable=false deactivated=null pending=null"],
  "control: a filter on deactivation alone keeps somebody taken out of the pool",
);

const forgetsOwedActivation: Apply = (q, embed) =>
  q.is(`${embed}.deactivated_at`, null).or("bookable.eq.true", { referencedTable: embed });
eq(
  disagreements(forgetsOwedActivation, "users"),
  ["bookable=false deactivated=null pending=set"],
  "control: a filter that forgets the owed activation drops somebody the backstop leaves alone",
);

let threw = false;
try {
  evalTerm(ROWS[0], "bookable.gt.0");
} catch {
  threw = true;
}
assert(threw, "control: the evaluator refuses a filter term it cannot read");

finish();
