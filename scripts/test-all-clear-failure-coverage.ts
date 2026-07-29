// Repo invariant (#1152): every module that can post an all-clear must own a test
// proving it stays SILENT when the thing it measured could not be read.
//
// Why this guard exists rather than a code scanner. The defect it protects against
// is not a shape in the source, it is an absence in the tests: a recovery notice
// whose healthy verdict came from a read that failed. Twice now that shipped green.
// #1134 caught `loadFailingAgents` returning [] on a read error and announcing that
// calendar sync had recovered. #1152 found the same thing in the three self-heal
// sweeps, where an unread worklist became a count of zero, which read as "under the
// cap", which posted "the backlog has cleared, no action is needed" and reset the
// streak that would otherwise have paged. In both cases the data flow crossed three
// files and a shared helper, which no text scanner can follow, and in both cases
// the tests were green because they only ever asked what happens when things work.
//
// So: derive the list of all-clear surfaces from the source (never a hand-kept
// list, which drifts silently), and require each one to carry the missing question
// as an executable assertion.
//
// The reverse direction is not checked: a test asserting no-all-clear in a module
// that sends none is harmless, unlike the heartbeat guard (#1123) where a bound
// watching a lane nobody stamps silently disables an alert forever.
//
// Run: node --experimental-strip-types scripts/test-all-clear-failure-coverage.ts
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, dirname, basename } from "node:path";
import {
  callsResolveAlert,
  provesNoAllClear,
  nodeProvesNoAllClear,
  declaredProofPaths,
  ALL_CLEAR_DEFINITION,
  NODE_PROOF_SHAPE_HELP,
} from "./lib/scan-all-clear-coverage.ts";
import { assert, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");
const SRC = join(ROOT, "src");

// A surface satisfies the guard one of two ways:
//
//   1. its own companion suite asserts `resolveAlert` is NOT called on some path
//      (auto-detected, the strongest signal, and how five of the six surfaces are
//      covered today); or
//   2. it points at the file holding the proof with an in-source
//      `// all-clear-proof: <path> - <why>` comment, and that file exists AND
//      itself pins the silent path (#1160).
//
// Mode 2 exists because Slate runs two harnesses. A node script proves the silent
// path with `assert(resolved.length === 0, ...)` rather than a spy, and a lane
// that injects `resolve` into a helper is rightly tested at the helper. The guard
// READS the named file (#1160) and requires it to pin the silent path in either
// harness's shape; it still cannot know the scenario driving the assertion is a
// genuinely failed read, which stays a review call. Stated plainly because a
// check that overstates what it verified is this repo's most repeated defect.
//
// A surface that deliberately ships with NO silent-path test at all. Empty on
// purpose: an exemption must be an argued decision recorded here, not a gap nobody
// noticed.
const EXEMPT: Record<string, string> = {};

// --- positive control: the detector must catch a surface with no silent test ---

const SURFACE = `
  import { resolveAlert } from "@/lib/notify/dispatch";
  export async function tick(healthy: boolean) {
    if (healthy) await resolveAlert("k", "all better");
  }
`;
const NAMESPACED = `
  import * as dispatch from "@/lib/notify/dispatch";
  export const tick = async () => { await dispatch.resolveAlert("k", "all better"); };
`;
const NOT_A_SURFACE = `
  // resolveAlert is sent by the watchdog, not here.
  import { resolveAlert } from "@/lib/notify/dispatch";
  export const KEYS = ["k"];
`;
const COMMENTED_OUT = `
  export async function tick() {
    // await resolveAlert("k", "all better");
  }
`;

assert(callsResolveAlert(SURFACE), "positive control: a direct resolveAlert call is a surface");
assert(callsResolveAlert(NAMESPACED), "positive control: a namespaced resolveAlert call is a surface");
assert(
  !callsResolveAlert(NOT_A_SURFACE),
  "an import plus a comment mentioning resolveAlert is NOT a surface",
);
assert(!callsResolveAlert(COMMENTED_OUT), "a commented-out resolveAlert call is NOT a surface");

const PROVES = `expect(resolveAlert).not.toHaveBeenCalled();`;
const PROVES_NAMESPACED = `expect(dispatch.resolveAlert).not.toHaveBeenCalled();`;
const HAPPY_PATH_ONLY = `expect(resolveAlert).toHaveBeenCalledWith("k", "all better");`;
const COMMENTED_PROOF = `// expect(resolveAlert).not.toHaveBeenCalled();`;

assert(provesNoAllClear(PROVES), "positive control: a not-called assertion is a silent-path proof");
assert(
  provesNoAllClear(PROVES_NAMESPACED),
  "positive control: a namespaced not-called assertion is a silent-path proof",
);
assert(
  !provesNoAllClear(HAPPY_PATH_ONLY),
  "positive control: a happy-path-only test is NOT a silent-path proof",
);
assert(
  !provesNoAllClear(COMMENTED_PROOF),
  "a commented-out not-called assertion is NOT a silent-path proof",
);

const INJECTED = `
  import { resolveAlert } from "@/lib/notify/dispatch";
  export const tick = () => runDriftCheck({ resolve: resolveAlert });
`;
assert(
  callsResolveAlert(INJECTED),
  "positive control: handing resolveAlert to a helper is a surface too",
);

const POINTED = `
  // all-clear-proof: scripts/test-migration-drift.ts - unverified never all-clears.
  resolve: resolveAlert,
`;
assert(
  declaredProofPaths(POINTED)[0] === "scripts/test-migration-drift.ts",
  "positive control: an all-clear-proof pointer is read off the wiring",
);
assert(
  declaredProofPaths(SURFACE).length === 0,
  "a surface with no pointer declares no proof",
);

// The node harness's proof shape (#1160): an `assert` whose subject is a
// resolve/recovery collection being empty. This is what lets pointer mode READ
// the file it is pointed at instead of trusting that it exists.
const NODE_PROOF = `
  const { run, resolved } = harness({ readThrows: true });
  await run();
  assert(resolved.length === 0, "an unreadable applied set never announces recovery");
`;
const NODE_PROOF_QUALIFIED = `
  assert(
    truncated.resolved.length === 0,
    "a truncated scan sends NO all-clear: it never looked at every bucket",
  );
`;
const NODE_HAPPY_ONLY = `
  assert(resolved.length === 1, "an in-sync run clears the outstanding page");
`;
const NODE_WRONG_COLLECTION = `
  assert(rows.length === 0, "no rows are left behind");
`;
const NODE_COMMENTED = `
  // assert(resolved.length === 0, "an unreadable applied set never announces recovery");
`;
// #1163: the shared harness also offers eq(actual, expected, msg) sugar, and a
// suite written with it proves exactly the same thing. The detector must read it,
// or an author who used the harness's own helper gets told their real proof is
// not a proof.
const NODE_PROOF_EQ = `
  const { run, resolved } = harness({ readThrows: true });
  await run();
  eq(resolved.length, 0, "an unreadable applied set never announces recovery");
`;
const NODE_PROOF_EQ_QUALIFIED = `
  eq(
    truncated.resolved.length,
    0,
    "a truncated scan sends NO all-clear: it never looked at every bucket",
  );
`;
const NODE_EQ_HAPPY_ONLY = `
  eq(resolved.length, 1, "an in-sync run clears the outstanding page");
`;
const NODE_EQ_WRONG_COLLECTION = `
  eq(rows.length, 0, "no rows are left behind");
`;
const NODE_EQ_COMMENTED = `
  // eq(resolved.length, 0, "an unreadable applied set never announces recovery");
`;

assert(
  nodeProvesNoAllClear(NODE_PROOF),
  "positive control: a node assert on an empty resolved collection is a silent-path proof",
);
assert(
  nodeProvesNoAllClear(NODE_PROOF_QUALIFIED),
  "positive control: a qualified subject (result.resolved) still counts, across lines",
);
assert(
  !nodeProvesNoAllClear(NODE_HAPPY_ONLY),
  "a resolved-length-one assert is a happy path, NOT a silent-path proof",
);
assert(
  !nodeProvesNoAllClear(NODE_WRONG_COLLECTION),
  "an emptiness assert on an unrelated collection is NOT a silent-path proof",
);
assert(
  !nodeProvesNoAllClear(NODE_COMMENTED),
  "a commented-out node proof does not count",
);
assert(
  nodeProvesNoAllClear(NODE_PROOF_EQ),
  "positive control: the harness's eq() sugar on an empty resolved collection is a silent-path proof",
);
assert(
  nodeProvesNoAllClear(NODE_PROOF_EQ_QUALIFIED),
  "positive control: a qualified eq() subject still counts, across lines",
);
assert(
  !nodeProvesNoAllClear(NODE_EQ_HAPPY_ONLY),
  "an eq(resolved.length, 1) is a happy path, NOT a silent-path proof",
);
assert(
  !nodeProvesNoAllClear(NODE_EQ_WRONG_COLLECTION),
  "an eq() emptiness check on an unrelated collection is NOT a silent-path proof",
);
assert(
  !nodeProvesNoAllClear(NODE_EQ_COMMENTED),
  "a commented-out eq() proof does not count",
);

// #1163: the failure message tells a rejected author what to write, so it is a
// claim about the detector and has to stay true. Each shape it names is fed back
// through the detector here, so a message that drifts from what is accepted
// fails the build rather than sending someone off to write a proof that will be
// rejected again.
for (const shape of [
  { named: "assert(", src: `assert(resolved.length === 0, "sends no all-clear");` },
  { named: "eq(", src: `eq(resolved.length, 0, "sends no all-clear");` },
]) {
  assert(
    NODE_PROOF_SHAPE_HELP.includes(shape.named),
    `the failure message names the ${shape.named} node shape`,
  );
  assert(
    nodeProvesNoAllClear(shape.src),
    `the ${shape.named} shape the failure message advertises is actually accepted`,
  );
}
assert(
  NODE_PROOF_SHAPE_HELP.includes("toHaveBeenCalled") &&
    provesNoAllClear(`expect(resolveAlert).not.toHaveBeenCalled();`),
  "the failure message names the vitest shape, and that shape is actually accepted",
);

// A pointer at a real file that tests something ELSE entirely must be rejected:
// that pass-by-existence hole is the whole reason for #1160.
const UNRELATED_SUITE = readFileSync(join(HERE, "test-vitest-environment.ts"), "utf8");
assert(
  !provesNoAllClear(UNRELATED_SUITE) && !nodeProvesNoAllClear(UNRELATED_SUITE),
  "positive control: a pointer at an unrelated real suite is rejected",
);

// --- the real source tree must be covered ------------------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** The companion test for a module: `<name>.test.ts` / `.test.tsx` beside it. */
function companionTests(path: string): string[] {
  const stem = join(dirname(path), basename(path).replace(/\.tsx?$/, ""));
  return [`${stem}.test.ts`, `${stem}.test.tsx`].filter(existsSync);
}

const surfaces = walk(SRC)
  .filter((path) => relative(ROOT, path) !== ALL_CLEAR_DEFINITION)
  .filter((path) => callsResolveAlert(readFileSync(path, "utf8")));

// The guard is worthless if the walk finds nothing, which is exactly how a broken
// path or a renamed directory would present: green, having checked zero files.
assert(surfaces.length > 0, `found all-clear surfaces to check (${surfaces.length})`);

for (const path of surfaces) {
  const rel = relative(ROOT, path);
  if (EXEMPT[rel]) {
    console.log(`skip: ${rel} (exempt: ${EXEMPT[rel]})`);
    continue;
  }
  const source = readFileSync(path, "utf8");
  const proven = companionTests(path).some((t) => provesNoAllClear(readFileSync(t, "utf8")));
  if (proven) {
    assert(true, `${rel} proves in its own suite that a failed read sends no all-clear`);
    continue;
  }

  const declared = declaredProofPaths(source);
  if (declared.length === 0) {
    assert(
      false,
      `${rel} proves it sends no all-clear when its health signal cannot be read ` +
        `(assert resolveAlert is not called on the failed path, or point at the ` +
        `suite that does with "// all-clear-proof: <path> - <why>"); ` +
        `accepted shapes: ${NODE_PROOF_SHAPE_HELP}`,
    );
    continue;
  }
  for (const proof of declared) {
    const proofPath = join(ROOT, proof);
    if (!existsSync(proofPath)) {
      assert(false, `${rel} names an all-clear-proof suite that exists (${proof})`);
      continue;
    }
    // Read the proof, don't trust it (#1160): the named file must itself pin the
    // silent path, in either harness's shape.
    const proofSource = readFileSync(proofPath, "utf8");
    assert(
      provesNoAllClear(proofSource) || nodeProvesNoAllClear(proofSource),
      `${rel}'s declared proof really pins the silent path (${proof}); ` +
        `accepted shapes: ${NODE_PROOF_SHAPE_HELP}`,
    );
  }
}

// --- real-file mutation control ----------------------------------------------
//
// Fixtures prove the detector reads text correctly; this proves it reaches the
// real tree. Strip the silent-path assertions out of a real surface's test and the
// guard must catch it, so a green run means something about real files.

const REAL_TEST = join(SRC, "lib", "monitor", "sweep-saturation.test.ts");
const realTestSrc = readFileSync(REAL_TEST, "utf8");
assert(provesNoAllClear(realTestSrc), "the real sweep-saturation suite proves the silent path");
const stripped = realTestSrc
  .split("\n")
  .filter((line) => !/resolveAlert\s*\)\s*\.\s*not\s*\.\s*toHaveBeenCalled/.test(line))
  .join("\n");
assert(
  !provesNoAllClear(stripped),
  "mutation control: removing sweep-saturation's not-called assertions is caught",
);

// Same control for the node shape: strip the silent-path asserts out of a real
// pointed-at suite and the tightened pointer mode must stop accepting it.
const REAL_NODE_PROOF = join(HERE, "test-migration-drift.ts");
const realNodeProofSrc = readFileSync(REAL_NODE_PROOF, "utf8");
assert(
  nodeProvesNoAllClear(realNodeProofSrc),
  "the real migration-drift suite proves the silent path node-natively",
);
const strippedNode = realNodeProofSrc
  .split("\n")
  .filter((line) => !/resolved\.length\s*===\s*0/.test(line))
  .join("\n");
assert(
  !nodeProvesNoAllClear(strippedNode),
  "mutation control: removing migration-drift's silent-path asserts is caught",
);

finish();
