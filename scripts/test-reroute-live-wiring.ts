// #3251: `pnpm verify:reroute-live` wires its offline-tested helpers in where it must
// (scripts/lib/scan-reroute-live-wiring.ts says which and why). The command can only
// run against production, so this reads its source, and proves the scan rejects each
// way the wiring can break, on copies of the real file with that break planted (L1).
//
// Run: node --experimental-strip-types scripts/test-reroute-live-wiring.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rerouteLiveWiringProblems, stripComments } from "./lib/scan-reroute-live-wiring.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const source = readFileSync(join(import.meta.dirname, "verify-reroute-live.ts"), "utf8");

eq(rerouteLiveWiringProblems(source), [], "the live command wires every helper in where it must");

/** The real source with one change planted, failing loudly if the change matched nothing (L100). */
function planted(from: string, to: string): string {
  assert(source.includes(from), `the planted change finds its target: ${from.slice(0, 60)}`);
  return source.replace(from, to);
}
const has = (problems: string[], part: string) => problems.some((p) => p.includes(part));

// --- each break the scan exists to catch ---------------------------------------------------------
{
  const extra = planted("const summary = ", "await service.adminConfirmReroute(b1.id, keepInput(\"SMOKE\"), actor);\n  const summary = ");
  assert(has(rerouteLiveWiringProblems(extra), "every confirm must go through confirmAndNote"), "a confirm outside the helper is caught");
}
{
  const body = source.slice(source.indexOf("async function confirmAndNote"));
  const noteLine = body.slice(body.indexOf("noteEventAfter("), body.indexOf(";", body.indexOf("noteEventAfter(")) + 1);
  const unnoted = planted(noteLine, "null;");
  assert(has(rerouteLiveWiringProblems(unnoted), "does not record the calendar event"), "a helper that stops recording the event is caught");
}
{
  const unchecked = planted("if (lost) differ(lost);", "void lost;");
  assert(has(rerouteLiveWiringProblems(unchecked), "rerouteLostEvent"), "noteEventAfter that no longer fails the step is caught");
}
{
  const unguarded = planted('if (windowProblem) exit("testWorldDiffers", windowProblem);', "void windowProblem;");
  assert(has(rerouteLiveWiringProblems(unguarded), "publicBucketWindowProblem"), "a dropped buffer check is caught");
}

{
  const body = source.slice(source.indexOf("async function confirmAndNote"));
  const catchStart = body.indexOf("} catch (err) {");
  const rethrow = body.indexOf("throw err;", catchStart);
  assert(catchStart !== -1 && rethrow !== -1, "the real helper has a catch that rethrows");
  const unnotedOnFailure = planted(body.slice(catchStart, rethrow), "} catch (err) {\n    ");
  assert(has(rerouteLiveWiringProblems(unnotedOnFailure), "a confirm that fails partway"), "a helper that stops recording the event when a confirm fails is caught");
}
{
  const reused = planted("testCallIdentity(startMs, RUN_STARTED_MS, n)", "{ idempotencyKey: `x-${n}`, externalId: `x-${n}` }");
  assert(has(rerouteLiveWiringProblems(reused), "testCallIdentity"), "a booking that stops using the run's own identity is caught");
}

// --- comments never satisfy it ---------------------------------------------------------------------
eq(stripComments('a(); // b()\n/* c() */ d("// not a comment");'), 'a(); \n d("// not a comment");', "comments go, strings stay");
{
  const onlyInComment = planted('if (windowProblem) exit("testWorldDiffers", windowProblem);', '// if (windowProblem) exit("testWorldDiffers", windowProblem);');
  assert(has(rerouteLiveWiringProblems(onlyInComment), "publicBucketWindowProblem"), "a check left only in a comment is caught");
}

finish();
