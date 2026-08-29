// The pre-push gate runs the Cloudflare build alongside lint and the tests, and
// that overlap has three properties nothing else would notice losing (#1594).
//
// 1. tsc runs BEFORE the build starts, and never beside it. `next build`
//    generates `.next/types`, and tsconfig.json includes `.next/types/**/*.ts`,
//    so an overlapping build has tsc reading a directory the build is writing.
//    That is the same coupling the hook's `rm -rf .next/types` exists for, and
//    reintroducing it would make the gate fail at random. A gate that fails at
//    random is worse than a slow one: the response to it is to re-run, not to
//    look.
// 2. The build is WAITED ON. Backgrounding a check and forgetting the `wait`
//    leaves the gate passing while that check is never judged, which is this
//    repo's most repeated defect class: a check that verifies nothing.
// 3. Lint and the tests are safe beside it only because neither READS what it
//    writes. That rests on two facts in two other files, so they are asserted
//    from those files rather than restated here (L41): a change to either would
//    otherwise silently make the overlap unsafe while this file still passed.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//   scripts/test-prepush-overlap.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const hook = readFileSync(join(ROOT, ".githooks", "pre-push"), "utf8");

// --- the build is backgrounded, and it is the ONLY thing that is ---------------
const lines = hook.split("\n");
const backgrounded = lines
  .map((l, i) => ({ line: l, n: i + 1 }))
  .filter(({ line }) => {
    const t = line.trim();
    if (t.startsWith("#") || t.length === 0) return false;
    // A trailing bare `&`. `&&` is a conjunction and `2>&1` is a redirect, so
    // neither counts; only a line that ENDS in a lone ampersand detaches a job.
    return /(^|[^&])&$/.test(t);
  });
assert(
  backgrounded.length === 1,
  `exactly one command in the hook is backgrounded (found ${backgrounded.length}: ${backgrounded
    .map((b) => `line ${b.n}`)
    .join(", ")}); anything else running detached would never be judged`,
);
const buildLine = backgrounded[0];
assert(
  buildLine !== undefined && /cf:build/.test(buildLine.line),
  `the backgrounded command is the Cloudflare build (got: ${buildLine?.line.trim()})`,
);

// --- tsc runs before it, not beside it ----------------------------------------
const tscAt = hook.indexOf("pnpm exec tsc --noEmit");
assert(tscAt >= 0, "the hook still runs tsc");
const buildAt = hook.indexOf(buildLine.line);
assert(
  tscAt < buildAt,
  "tsc runs BEFORE the build is started, so it never reads .next/types while the build is writing it",
);
// tsc must not itself be the backgrounded line, which the count above already
// forbids, and must not be piped into the background some other way.
assert(
  !/pnpm exec tsc --noEmit[^\n]*&$/m.test(hook),
  "tsc is not itself backgrounded (it is the one step that cannot overlap the build)",
);

// --- the build's verdict is actually read -------------------------------------
assert(
  /wait "\$build_pid"/.test(hook),
  "the hook waits on the build, so its exit status is judged rather than discarded",
);
assert(
  /if ! wait "\$build_pid"; then[\s\S]{0,400}?exit 1/.test(hook),
  "a failed build exits non-zero (a build whose failure only reached a log file would be a gate that checked nothing)",
);
assert(
  /cat "\$build_log"/.test(hook),
  "and its captured output is printed, so the reader is not sent to find a temp file",
);
// An early exit from a failing lint or test leaves the build writing into a
// worktree that is about to be removed.
assert(
  /kill_build/.test(hook) && /cleanup\(\)[\s\S]{0,200}kill_build/.test(hook),
  "the EXIT trap stops a build still running, so a failing check does not leave one writing into a removed worktree",
);
assert(
  /kill -TERM -- -"\$build_pid"/.test(hook),
  "the build is killed as a process group (pnpm spawns the real builder, so killing only the wrapper leaves it running)",
);

// --- the two facts in other files the overlap rests on -------------------------
{
  const eslintConfig = readFileSync(join(ROOT, "eslint.config.mjs"), "utf8");
  for (const ignored of [".next/**", ".open-next/**"]) {
    assert(
      eslintConfig.includes(`"${ignored}"`),
      `eslint still ignores ${ignored}; without that, lint reads the build's output while the build is writing it`,
    );
  }
}
{
  const vitestConfig = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
  const include = vitestConfig.match(/include:\s*\[([^\]]*)\]/)?.[1] ?? "";
  assert(include.trim().length > 0, "vitest's include list is readable");
  assert(
    !/\.next|\.open-next/.test(include),
    `vitest collects nothing from the build's output (include: ${include.trim()})`,
  );
}

// --- why tsc is the exception, asserted from the config that makes it one ------
//
// Conditional on purpose. If tsconfig.json stops including .next/types, tsc stops
// being coupled to the build and the serialisation could be revisited. Asserting
// the include unconditionally would fail that legitimate change; asserting the
// ORDER only while the coupling exists says what the rule actually is.
{
  const tsconfig = readFileSync(join(ROOT, "tsconfig.json"), "utf8");
  const couplesToBuildOutput = /\.next\/types/.test(tsconfig);
  if (couplesToBuildOutput) {
    assert(
      tscAt < buildAt,
      "tsconfig.json includes .next/types, which `next build` generates, so tsc must run before the build starts",
    );
  } else {
    assert(
      true,
      "tsconfig.json no longer includes .next/types, so the tsc/build serialisation in the hook can be revisited (see #1594)",
    );
  }
}

// --- positive control: the checks above can fail ------------------------------
//
// Every assertion on a file's text is satisfied by a file that happens to
// contain the right words, so the two that carry the most weight are re-run
// against text where the answer is known to be wrong (L1).
{
  const noWait = hook.replace(/if ! wait "\$build_pid"; then/, "if false; then");
  assert(
    !/if ! wait "\$build_pid"; then[\s\S]{0,400}?exit 1/.test(noWait),
    "the wait assertion fails on a hook whose build is never waited on",
  );
  const overlapped = "pnpm lint\npnpm cf:build &\npnpm exec tsc --noEmit\n";
  assert(
    overlapped.indexOf("pnpm exec tsc --noEmit") > overlapped.indexOf("pnpm cf:build"),
    "the ordering assertion fails on a hook that starts the build before tsc",
  );
}

finish();
