// #1492: the canary's failed checks reach the Slack alert.
//
// Every canary failure posted the same sentence: "either booking is broken, or a
// smoke key or seeded test fixture is misconfigured". That covers every possible
// cause, so it told the reader nothing, and three pages in ten days (#1489) were all
// the same benign fixture collision with no way to tell them from a real outage by
// reading Slack.
//
// The two states that must never collapse into each other:
//   failures  the run checked things and some failed. Name them.
//   none      no check reported at all, so the run died first. A DIFFERENT message,
//             pointing at a crash or a missing key rather than a booking regression.
//             That is what 2026-08-14 actually was.
//
// Run: node --experimental-strip-types scripts/test-smoke-failure-log.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  failureLogPath,
  nodeSmokeFailureIo,
  readFailures,
  recordFailure,
  type FailureLogIo,
} from "./lib/smoke-failure-log.ts";

/** In-memory io, so the pure decisions are driven without touching a disk. */
function fakeIo(initial: Record<string, string> = {}): FailureLogIo & { files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    append: (path, line) => {
      files[path] = (files[path] ?? "") + line;
    },
    read: (path) => files[path] ?? null,
  };
}

// --- the path is opt in ---
{
  eq(failureLogPath({}), null, "no SMOKE_FAILURE_FILE means no log (a hand run is unchanged)");
  eq(failureLogPath({ SMOKE_FAILURE_FILE: "  " }), null, "a blank path is no log, not a path of spaces");
  eq(failureLogPath({ SMOKE_FAILURE_FILE: " f.txt " }), "f.txt", "a real path is trimmed");
}

// --- recording ---
{
  const io = fakeIo();
  assert(recordFailure(io, null, "anything") === false, "with no path, recording is a no-op");
  eq(Object.keys(io.files).length, 0, "and writes nothing");

  assert(recordFailure(io, "f.txt", "book -> created (got 409)"), "records a failure");
  assert(recordFailure(io, "f.txt", "dedupe -> deduped (got created)"), "records a second");
  const log = readFailures(io, "f.txt");
  eq(log.kind, "failures", "both are readable back");
  eq(log.kind === "failures" ? log.lines.length : -1, 2, "as two separate lines");

  // A multi-line message must not read back as several failures.
  const io2 = fakeIo();
  recordFailure(io2, "f.txt", "a check failed\n  with a wrapped detail");
  const log2 = readFailures(io2, "f.txt");
  eq(log2.kind === "failures" ? log2.lines.length : -1, 1, "a wrapped message is ONE failure");
  assert(
    log2.kind === "failures" && log2.lines[0]!.includes("with a wrapped detail"),
    "and keeps its detail on that one line",
  );

  // An empty message is not a failure.
  const io3 = fakeIo();
  assert(!recordFailure(io3, "f.txt", "   "), "an empty message is not recorded");
}

// --- a write that fails must not change the run it describes ---
{
  const io: FailureLogIo = {
    append: () => {
      throw new Error("disk full");
    },
    read: () => null,
  };
  let threw = false;
  try {
    assert(recordFailure(io, "f.txt", "a failure") === false, "a failed write reports false");
  } catch {
    threw = true;
  }
  assert(!threw, "recording never throws: the log must not change the run's own outcome");
}

// --- reading: none, failures and unreadable are three different answers ---
{
  eq(readFailures(fakeIo(), null).kind, "none", "no path configured reads as none");
  eq(readFailures(fakeIo(), "missing.txt").kind, "none", "an absent file reads as none");
  eq(readFailures(fakeIo({ "e.txt": "" }), "e.txt").kind, "none", "an empty file reads as none");
  eq(
    readFailures(fakeIo({ "w.txt": "\n  \n\n" }), "w.txt").kind,
    "none",
    "a whitespace-only file reads as none, not as blank failures",
  );

  // Unreadable is NOT none. Collapsing them would let "we could not read it" render
  // as "the run died before any check", which sends the reader somewhere else (L11).
  const angry: FailureLogIo = {
    append: () => {},
    read: () => {
      throw new Error("EACCES: permission denied");
    },
  };
  const bad = readFailures(angry, "x.txt");
  eq(bad.kind, "unreadable", "a read error is its own outcome");
  assert(
    bad.kind === "unreadable" && bad.reason.includes("EACCES"),
    "and carries the reason, so the message can name it",
  );
}

// --- the real filesystem io, end to end ---
{
  // The fake agrees with my assumption about the interface by construction (L52), so
  // the shipping io is exercised once against a real directory: append creates the
  // file, appends rather than truncates, and a missing file reads as none.
  const dir = mkdtempSync(join(tmpdir(), "slate-smoke-failures-"));
  const path = join(dir, "smoke-failures.txt");
  try {
    eq(readFailures(nodeSmokeFailureIo, path).kind, "none", "real io: a file not yet written reads as none");

    assert(recordFailure(nodeSmokeFailureIo, path, "first failure"), "real io: records a failure");
    assert(recordFailure(nodeSmokeFailureIo, path, "second failure"), "real io: records a second");

    const onDisk = readFileSync(path, "utf8");
    assert(
      onDisk.includes("first failure") && onDisk.includes("second failure"),
      "real io: APPENDS rather than truncating, so a failure survives a later crash",
    );
    const log = readFailures(nodeSmokeFailureIo, path);
    eq(log.kind === "failures" ? log.lines.length : -1, 2, "real io: reads both back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

finish();
