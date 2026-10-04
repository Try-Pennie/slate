// #3247: the refusal words the reroute hold RPCs return are one vocabulary, held
// in TypeScript and in SQL, and the two must agree in BOTH directions.
//
// place_reroute_hold, claim_reroute_hold and the bucket aware reassign_booking_swap
// return a refusal word rather than raising, so the reroute routes (#3249) can give
// each its own message (L11). A word the SQL returns that the TypeScript list lacks
// would reach the route as an unmapped string and fall to a generic error; a word
// the list carries that no SQL returns is a message for a state that cannot occur
// (L113). So the words are read out of the migration's own function bodies and
// compared against the exported lists.
//
// Run: node --experimental-strip-types scripts/test-reroute-hold-refusals.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  CLAIM_REROUTE_HOLD_REFUSALS,
  PLACE_REROUTE_HOLD_REFUSALS,
  REROUTE_SWAP_REFUSALS,
} from "../src/lib/db/reroute-hold-refusals.ts";

const MIGRATION = "0166_reroute_holds.sql";
const sql = readFileSync(join(import.meta.dirname, "..", "supabase", "migrations", MIGRATION), "utf8");

/** The body of `create function <name>(` up to its closing `$$;`, the Nth definition. */
function functionBody(text: string, name: string, nth = 0): string {
  const re = new RegExp(`create (?:or replace )?function ${name}\\(`, "gi");
  let m: RegExpExecArray | null = null;
  for (let i = 0; i <= nth; i++) {
    m = re.exec(text);
    if (!m) return "";
  }
  const start = m!.index;
  const open = text.indexOf("$$", start);
  const close = text.indexOf("$$", open + 2);
  return open === -1 || close === -1 ? "" : text.slice(start, close + 2);
}

/** Every `'word'::text` a body returns as a refusal, sorted and unique. */
function refusalWords(body: string): string[] {
  return [...new Set([...body.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]))].sort();
}

// --- the extractor reads what it claims to (L1) ------------------------------------
{
  const planted = `create function f(\n) returns table (r text) as $$\nbegin return query select 'one_word'::text; return query select null::text, 'two'::text; end\n$$;`;
  eq(refusalWords(functionBody(planted, "f")), ["one_word", "two"], "the extractor finds each refusal word in a body");
  eq(functionBody(planted, "missing"), "", "and an absent function reads as empty, which the checks below refuse");
}

// --- each function against its list --------------------------------------------------
const cases: { fn: string; nth: number; list: readonly string[] }[] = [
  { fn: "place_reroute_hold", nth: 0, list: PLACE_REROUTE_HOLD_REFUSALS },
  { fn: "claim_reroute_hold", nth: 0, list: CLAIM_REROUTE_HOLD_REFUSALS },
  // The FIRST reassign_booking_swap in the file is the seven argument wrapper, which
  // returns no refusal at all; the SECOND is the bucket aware body.
  { fn: "reassign_booking_swap", nth: 1, list: REROUTE_SWAP_REFUSALS },
];
for (const c of cases) {
  const body = functionBody(sql, c.fn, c.nth);
  assert(body.length > 200, `${c.fn} is defined in ${MIGRATION}`);
  const words = refusalWords(body);
  assert(words.length >= 3, `${c.fn} returns refusal words (${words.length})`);
  eq(words, [...c.list].sort(), `${c.fn}: the SQL returns exactly the words the TypeScript list names`);
}
eq(
  refusalWords(functionBody(sql, "reassign_booking_swap", 0)),
  [],
  "the seven argument wrapper returns no refusal word, so the deployed code reads the shape it always read",
);

finish();
