// The gate that turns repeated failures into ONE page, and a single failure into none (#3670).
//
// `rate_limit_broken:landing:h` paged on 2026-10-13 for one hourly count that failed, and the
// counter answered again minutes later (`pnpm verify:burst-counter` passed). Dan's direction:
// "we probably shouldn't alert on one instance". The rule this pins: a failure is counted per
// key inside a window on one isolate, and only `pageAfter` of them inside that window page,
// once per cooldown. The same gate is what the shared confirm line already used by hand
// (#3325), so both read one implementation.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-sustained-failure-gate.ts
import { makeSustainedFailureGate } from "../src/lib/notify/sustained-failure.ts";
import { createAsserter } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const WINDOW = 10 * 60_000;
const COOLDOWN = 30 * 60_000;
const gate = (maxKept?: number) =>
  makeSustainedFailureGate<string>({ pageAfter: 5, windowMs: WINDOW, cooldownMs: COOLDOWN, ...(maxKept ? { maxKept } : {}) });

// --- one failure is counted, never paged ---------------------------------------------
{
  const g = gate();
  const r = g.record("landing:h", 1_000, "x");
  assert(r.page === false, "one: a single failure does not page");
  assert(r.inWindow === 1, `one: it is still counted (got ${r.inWindow})`);
}

// --- one short of the threshold does not page ----------------------------------------
{
  const g = gate();
  let paged = 0;
  for (let i = 0; i < 4; i++) if (g.record("landing:h", 1_000 + i, "x").page) paged++;
  assert(paged === 0, `four of five inside the window page nothing (got ${paged})`);
}

// --- the threshold inside the window pages once, with what it measured ---------------
{
  const g = gate();
  const results = Array.from({ length: 5 }, (_, i) => g.record("landing:h", 1_000 + i * 1_000, `f${i}`));
  const pages = results.filter((r) => r.page);
  assert(pages.length === 1, `five inside the window page exactly once (got ${pages.length})`);
  assert(results[4]!.page, "the page is raised by the failure that makes the run sustained");
  assert(results[4]!.recent().join(",") === "f0,f1,f2,f3,f4", `the page carries every failure it is about (got ${results[4]!.recent().join(",")})`);
  assert(results[4]!.truncated === false, "nothing was dropped, so the count is exact");
  const more = g.record("landing:h", 7_000, "f5");
  assert(more.page === false, "a sixth inside the cooldown does not page again");
  assert(more.inWindow === 6, `but it is still counted (got ${more.inWindow})`);
}

// --- failures spread wider than the window never add up to a page ---------------------
{
  const g = gate();
  let paged = 0;
  for (let i = 0; i < 50; i++) if (g.record("landing:h", i * WINDOW, "x").page) paged++;
  assert(paged === 0, `fifty failures a window apart never page (got ${paged})`);
}

// --- the window is strict at its edge -------------------------------------------------
{
  const g = gate();
  for (let i = 0; i < 4; i++) g.record("k", i, "x");
  // The first one is exactly a window old here, so it has left it.
  const r = g.record("k", WINDOW, "x");
  assert(r.page === false && r.inWindow === 4, `a failure exactly one window old no longer counts (inWindow ${r.inWindow})`);
}

// --- a separate run after the cooldown pages again ------------------------------------
{
  const g = gate();
  for (let i = 0; i < 5; i++) g.record("k", i, "x");
  let paged = 0;
  for (let i = 0; i < 5; i++) if (g.record("k", COOLDOWN - 1, "x").page) paged++;
  assert(paged === 0, "a run inside the cooldown does not page again");
  let later = 0;
  for (let i = 0; i < 5; i++) if (g.record("k", COOLDOWN + WINDOW + i, "x").page) later++;
  assert(later === 1, `a separate run after the cooldown pages once more (got ${later})`);
}

// --- keys are counted apart ---------------------------------------------------------
{
  const g = gate();
  let paged = 0;
  for (let i = 0; i < 4; i++) if (g.record("a", i, "x").page) paged++;
  for (let i = 0; i < 4; i++) if (g.record("b", i, "x").page) paged++;
  assert(paged === 0, "four on one key and four on another are not one run of eight");
  assert(g.record("a", 10, "x").page, "the fifth on the first key pages");
}

// --- memory is bounded under a flood, and the result says so --------------------------
{
  const g = gate(20);
  let last = g.record("k", 0, "x");
  for (let i = 1; i < 100; i++) last = g.record("k", i, "x");
  assert(last.inWindow === 20, `a flood keeps at most maxKept entries (got ${last.inWindow})`);
  assert(last.truncated === true, "and reports that older entries inside the window were dropped");
  assert(last.recent().join(",") === Array(20).fill("x").join(","), "and holds exactly the kept entries");
  // The oldest kept entry is at 80; once it leaves the window so has everything dropped before it.
  const later = g.record("k", 80 + WINDOW, "x");
  assert(later.truncated === false, "the count is exact again once the dropped entries have left the window");
}

// --- a long flood keeps the newest entries, in order, through every compaction ---------
// The run advances a head index rather than shifting, and compacts once the dead prefix is the
// larger half (the review on #3670: a copy or a shift per record is O(n) on the hot path during
// exactly the flood this counts). This drives many compactions and checks what survives them.
{
  const g = makeSustainedFailureGate<number>({ pageAfter: 5, windowMs: WINDOW, cooldownMs: COOLDOWN, maxKept: 7 });
  let last = g.record("k", 0, 0);
  const early = last;
  for (let i = 1; i < 10_000; i++) last = g.record("k", i, i);
  assert(last.inWindow === 7, `a long flood still holds maxKept (got ${last.inWindow})`);
  assert(last.recent().join(",") === "9993,9994,9995,9996,9997,9998,9999", `the newest seven survive, in order (got ${last.recent().join(",")})`);
  assert(early.recent().join(",") === "0", `a verdict read late still describes its own moment (got ${early.recent().join(",")})`);
  // And expiry still works after compaction: one more, a full window later, is alone.
  const after = g.record("k", 9_999 + WINDOW, -1);
  assert(after.inWindow === 1 && after.truncated === false, `after the window everything expires (inWindow ${after.inWindow})`);
}

// --- a threshold of one would be the defect itself -------------------------------------
{
  let threw = false;
  try {
    makeSustainedFailureGate({ pageAfter: 1, windowMs: WINDOW, cooldownMs: COOLDOWN });
  } catch {
    threw = true;
  }
  assert(threw, "a gate that would page on a single failure is refused at construction");
}

finish();
