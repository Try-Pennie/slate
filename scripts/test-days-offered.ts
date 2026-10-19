// The rules of the Days offered card (#3922), pure.
//
// Two settings: how many open days every lead is offered (stored since #3922, it
// was a fixed 3 in code) and how many extra days the last resort may add. The
// reach the rest of the system reads stays in `horizon_days` as offered plus
// extra, so the server refuses anything that would push it past 7, the ceiling on
// how far ahead availability is computed (D6 in docs/design/days-offered.html).
//
// Run: node --experimental-strip-types scripts/test-days-offered.ts
import {
  DAYS_OFFERED_CEILING,
  OFFERED_OPEN_DAYS_DEFAULT,
  OFFERED_OPEN_DAYS_MIN,
  extraDayChoices,
  extraFromStored,
  furthestDay,
  offeredDayChoices,
  parseDaysOfferedForm,
  resolveOfferedOpenDays,
  restoredChoice,
} from "../src/lib/booking/days-offered.ts";
import { EXTRA_DAYS_LABEL, OFFERED_DAYS_LABEL } from "../src/lib/admin/days-offered-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { readFileSync, readdirSync } from "node:fs";

// The default is what production holds today, so nothing changes on deploy.
eq(OFFERED_OPEN_DAYS_DEFAULT, 3, "the default is three open days, today's value");
eq(OFFERED_OPEN_DAYS_MIN, 1, "at least one day is offered");
eq(DAYS_OFFERED_CEILING, 7, "seven is the ceiling availability is computed to");

// The migration's column default IS the coded default, so a fresh row and a
// missing row read the same number.
{
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const file = readdirSync(dir).find((f) => /_offered_open_days\.sql$/.test(f));
  assert(file !== undefined, "a migration adds offered_open_days");
  const sql = readFileSync(new URL(file!, dir), "utf8");
  const m = /offered_open_days\s+smallint\s+not null\s+default\s+(\d+)/i.exec(sql);
  eq(m ? Number(m[1]) : null, OFFERED_OPEN_DAYS_DEFAULT, "the column defaults to the coded default");
  assert(
    new RegExp(`between ${OFFERED_OPEN_DAYS_MIN} and ${DAYS_OFFERED_CEILING}`).test(sql),
    "and the database refuses a value outside 1 to 7",
  );
}

// Reading the stored value: a missing row is the default; a stored value is used;
// an impossible one is refused loudly rather than replaced by a guess.
eq(resolveOfferedOpenDays(undefined), 3, "no row reads as the default");
eq(resolveOfferedOpenDays(null), 3, "a null reads as the default");
eq(resolveOfferedOpenDays(4), 4, "a stored 4 is 4");
for (const bad of [0, 8, 2.5, "4", Number.NaN]) {
  let threw = false;
  try {
    resolveOfferedOpenDays(bad);
  } catch {
    threw = true;
  }
  assert(threw, `an impossible stored value (${String(bad)}) is refused, not guessed`);
}

// The choices the two dropdowns list (D5, D6).
eq(offeredDayChoices(), [1, 2, 3, 4, 5, 6, 7], "offered lists 1 to 7");
eq(extraDayChoices(3), [0, 1, 2, 3, 4], "extra keeps the sum at 7 or less for 3 offered");
eq(extraDayChoices(6), [0, 1], "and shrinks as offered grows");
eq(extraDayChoices(7), [0], "at 7 offered, 0 is the only extra");

// The extra days a stored reach implies.
eq(extraFromStored(3, 4), 1, "production today: 3 offered, a reach of 4, so 1 extra");
eq(extraFromStored(3, 3), 0, "a reach equal to the offered days is no last resort");
eq(extraFromStored(4, 3), 0, "a reach below the offered days never reads as negative");
eq(extraFromStored(6, 7), 1, "and never past the ceiling");

// A value restored from a save that never arrived (#1994) is used only when it is one
// of the choices the dropdown lists; anything else is dropped, so the control never
// shows its placeholder while its hidden input posts a number nobody can see.
eq(restoredChoice("4", offeredDayChoices()), 4, "a restored 4 offered is kept");
eq(restoredChoice("0", offeredDayChoices()), null, "a restored 0 offered is dropped");
eq(restoredChoice("9", offeredDayChoices()), null, "a restored 9 offered is dropped");
eq(restoredChoice("-3", extraDayChoices(3)), null, "a restored negative extra is dropped");
eq(restoredChoice("2.5", extraDayChoices(3)), null, "a fraction is dropped");
eq(restoredChoice("x", extraDayChoices(3)), null, "text is dropped");
eq(restoredChoice(null, extraDayChoices(3)), null, "nothing restored is nothing");

// The fact line (D3).
eq(furthestDay(3, 1), { day: 4, offered: 3, extra: 1 }, "day 4 from 3 offered and 1 extra");

// The server's refusals, each named by the label a person reads on the card.
{
  const ok = parseDaysOfferedForm("3", "1");
  eq(ok, { offered_open_days: 3, horizon_days: 4, extra_days: 1, errors: [] }, "3 and 1 store a reach of 4");
  eq(parseDaysOfferedForm("7", "0").horizon_days, 7, "7 offered and none extra is allowed");
  eq(parseDaysOfferedForm("4", "0").horizon_days, 4, "no last resort at all is allowed");

  for (const [o, e] of [["", "1"], ["0", "1"], ["8", "0"], ["2.5", "1"], ["abc", "1"]] as const) {
    const r = parseDaysOfferedForm(o, e);
    eq(r.offered_open_days, null, `offered ${JSON.stringify(o)} is refused`);
    assert(r.errors.some((m) => m.includes(OFFERED_DAYS_LABEL)), `and the refusal names ${OFFERED_DAYS_LABEL}`);
  }
  for (const [o, e] of [["3", ""], ["3", "-1"], ["3", "1.5"], ["3", "x"]] as const) {
    const r = parseDaysOfferedForm(o, e);
    eq(r.horizon_days, null, `extra ${JSON.stringify(e)} is refused`);
    assert(r.errors.some((m) => m.includes(EXTRA_DAYS_LABEL)), `and the refusal names ${EXTRA_DAYS_LABEL}`);
  }
  // The sum above 7, which no single field's range can catch.
  for (const [o, e] of [["5", "3"], ["7", "1"], ["3", "5"]] as const) {
    const r = parseDaysOfferedForm(o, e);
    eq(r.horizon_days, null, `${o} offered plus ${e} extra is refused`);
    eq(r.offered_open_days, null, "and nothing is stored from it");
    assert(
      r.errors.some((m) => {
        const low = m.toLowerCase();
        return low.includes(OFFERED_DAYS_LABEL.toLowerCase()) && low.includes(EXTRA_DAYS_LABEL.toLowerCase()) && m.includes("7");
      }),
      "the refusal names both fields and the ceiling",
    );
  }
}

finish();
