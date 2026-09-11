// The code mix a booking load run drives (#2243).
//
// Real lead traffic is enormously lopsided: 112 alone carried 31 percent of the
// routed leads in the 30 days to 2026-09-11, and the whole Beyond family together
// under 1.5 percent. An even spread over sixty codes would be a different test,
// and an easier one: the hot codes are where the pools are largest and the slot
// cache is contended, and the cold ones are where a one agent pool makes every
// second booking a conflict.
//
// Run: node --experimental-strip-types scripts/test-loadtest-code-mix.ts
import { MEASURED_CODE_MIX, codeSequence, BURST_CODE } from "./loadtest/code-mix.ts";
import { bucketSpecForXbc } from "../src/lib/xbc.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the measured mix is real ------------------------------------------------

{
  for (const m of MEASURED_CODE_MIX) {
    assert(bucketSpecForXbc(m.code) !== null, `${m.code} is a code Slate can route`);
    assert(m.leads > 0, `${m.code} carried leads`);
  }
  const codes = MEASURED_CODE_MIX.map((m) => m.code);
  eq(new Set(codes).size, codes.length, "no code appears twice in the mix");
  const total = MEASURED_CODE_MIX.reduce((s, m) => s + m.leads, 0);
  assert(total > 20000, `the mix is measured over real traffic; got ${total} leads`);
  // The lopsidedness is the property worth pinning, because losing it is how this
  // quietly becomes an even spread.
  const top = MEASURED_CODE_MIX[0]!;
  assert(top.leads / total > 0.25, `the busiest code carries a quarter of the traffic or more`);
  assert(
    MEASURED_CODE_MIX[MEASURED_CODE_MIX.length - 1]!.leads < total / 1000,
    "and the quietest carries a thousandth or less",
  );
}

// --- the sequence keeps the proportions --------------------------------------

{
  const seq = codeSequence(1000);
  eq(seq.length, 1000, "one code per request");
  const counts = new Map<string, number>();
  for (const c of seq) counts.set(c, (counts.get(c) ?? 0) + 1);
  const total = MEASURED_CODE_MIX.reduce((s, m) => s + m.leads, 0);
  for (const m of MEASURED_CODE_MIX.slice(0, 6)) {
    const want = (m.leads / total) * 1000;
    const got = counts.get(m.code) ?? 0;
    assert(
      Math.abs(got - want) <= 2,
      `${m.code} appears in proportion (wanted about ${want.toFixed(0)}, got ${got})`,
    );
  }
  // An even spread would give every code about 34. The busiest must be far above it.
  assert(
    (counts.get("112") ?? 0) > 250,
    `the busiest code really dominates the sequence; got ${counts.get("112")}`,
  );
}

{
  // Any PREFIX is representative, because a run judged minute by minute (or cut
  // short) must not be measuring one pool. Blocked ordering would spend the first
  // minutes entirely on 112.
  const seq = codeSequence(1000);
  const first50 = new Set(seq.slice(0, 50));
  assert(
    first50.size >= 10,
    `the first 50 requests span many codes; got ${first50.size}`,
  );
}

{
  // Deterministic, so a run that passed and a run that failed differ by the code
  // rather than by the dice. The SLOT is what is random.
  eq(codeSequence(200).join(","), codeSequence(200).join(","), "the sequence is deterministic");
  eq(codeSequence(0).length, 0, "asking for nothing gives nothing");
  eq(codeSequence(-5).length, 0, "and so does asking for less than nothing");
  eq(codeSequence(3).length, 3, "a tiny run still gets exactly what it asked for");
  // A mix with no leads at all cannot produce a sequence, and says so by producing
  // none rather than dividing by zero and yielding NaN codes.
  eq(codeSequence(10, [{ code: "111", leads: 0 }]).length, 0, "a mix carrying no leads yields nothing");
}

// --- the burst code is the one agent pool ------------------------------------

{
  const spec = bucketSpecForXbc(BURST_CODE);
  assert(spec !== null, "the burst code is one Slate routes");
  eq(
    spec?.criteria.backend_service,
    "beyond",
    "the burst code demands the Beyond backend, which two agents in the whole roster carry, " +
      "so its pool is exactly one deep and 'exactly one 200' is a real control",
  );
  assert(
    MEASURED_CODE_MIX.some((m) => m.code === BURST_CODE),
    "and it is a code real leads actually arrive on, not a fixture nobody uses",
  );
}

finish();
