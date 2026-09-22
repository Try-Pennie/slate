/**
 * The advisor photo backfill's decisions (#2600).
 *
 * This writes to the live roster, so the rules worth pinning are the ones whose
 * failure is somebody LOSING a photo, and the one whose failure is a number
 * nobody can act on.
 *
 * Nothing here waits: the sleep is injected and the test reads back the delays
 * the code ASKED for, which is both instant and a stronger assertion than
 * surviving a real backoff (L524).
 *
 * Run: node --experimental-strip-types scripts/test-backfill-photos.ts
 */
import {
  runBackfill,
  backfillExitCode,
  DEFAULT_TUNING,
  type BackfillUser,
} from "./lib/backfill-photos.ts";
import type { DirectoryPhoto } from "../src/lib/google/directory.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const PHOTO = "https://lh3.googleusercontent.com/a/ACg8ocK_example=s96-c";

function harness(opts: {
  users: BackfillUser[];
  answers: Record<string, DirectoryPhoto[]>;
  apply?: boolean;
  writeFails?: string;
}) {
  const slept: number[] = [];
  const written: { id: string; url: string }[] = [];
  const asked: string[] = [];
  const queue = new Map(Object.entries(opts.answers).map(([k, v]) => [k, [...v]]));
  return {
    slept,
    written,
    asked,
    deps: {
      listUsers: async () => opts.users,
      photoFor: async (email: string) => {
        asked.push(email);
        const q = queue.get(email) ?? [];
        return (q.length > 1 ? q.shift()! : q[0]) ?? { ok: true as const, url: null };
      },
      write: async (id: string, url: string) => {
        if (opts.writeFails) return opts.writeFails;
        written.push({ id, url });
        return null;
      },
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      apply: opts.apply ?? false,
    },
  };
}

const withPhoto: BackfillUser = { id: "u1", email: "has@x.test", avatar_url: PHOTO };
const withBlank: BackfillUser = { id: "u2", email: "blank@x.test", avatar_url: "   " };
const withNone: BackfillUser = { id: "u3", email: "none@x.test", avatar_url: null };

// --- it only ever FILLS -------------------------------------------------------
{
  const h = harness({
    users: [withPhoto, withNone],
    answers: { "none@x.test": [{ ok: true, url: PHOTO }] },
    apply: true,
  });
  const r = await runBackfill(h.deps, DEFAULT_TUNING);
  eq(r.filled, 1, "the agent with no photo is filled");
  eq(h.written.length, 1, "exactly one write");
  eq(h.written[0].id, "u3", "and it is the empty one");
  assert(
    !h.asked.includes("has@x.test"),
    "somebody who already has a photo is never even asked, so it can never be replaced or cleared",
  );
}
{
  const h = harness({
    users: [withBlank],
    answers: { "blank@x.test": [{ ok: true, url: PHOTO }] },
    apply: true,
  });
  const r = await runBackfill(h.deps, DEFAULT_TUNING);
  eq(r.filled, 1, "a blank string counts as having none, not as a photo");
}

// --- no photo is not the same answer as could not read ------------------------
{
  const h = harness({
    users: [withNone, { id: "u4", email: "bad@x.test", avatar_url: null }],
    answers: {
      "none@x.test": [{ ok: true, url: null }],
      "bad@x.test": [{ ok: false, reason: "directory read 403", status: 403 }],
    },
    apply: true,
  });
  const r = await runBackfill(h.deps, DEFAULT_TUNING);
  eq(r.noPhoto, 1, "the agent the directory answered about is counted as having none");
  eq(r.couldNotRead.length, 1, "the one nobody could read is counted separately");
  assert(
    r.couldNotRead[0].includes("bad@x.test"),
    "and is NAMED, so a second run can be pointed at exactly them",
  );
  eq(h.written.length, 0, "neither is written");
}

// --- the rate limit -----------------------------------------------------------
{
  const h = harness({
    users: [withNone],
    answers: {
      "none@x.test": [
        { ok: false, reason: "directory read 429", status: 429 },
        { ok: false, reason: "directory read 429", status: 429 },
        { ok: true, url: PHOTO },
      ],
    },
    apply: true,
  });
  const r = await runBackfill(h.deps, DEFAULT_TUNING);
  eq(r.filled, 1, "a rate limit is ridden out and the photo lands");
  eq(
    h.slept.slice(0, 2).join(","),
    `${DEFAULT_TUNING.backoffMs},${DEFAULT_TUNING.backoffMs * 2}`,
    "the backoff lengthens, asserted on the delays asked for rather than by waiting",
  );
}
{
  const h = harness({
    users: [withNone],
    answers: { "none@x.test": [{ ok: false, reason: "directory read 429", status: 429 }] },
    apply: true,
  });
  const tuning = { ...DEFAULT_TUNING, maxRetries: 2 };
  const r = await runBackfill(h.deps, tuning);
  eq(r.couldNotRead.length, 1, "a rate limit that never clears gives up rather than hanging");
  eq(h.asked.length, 3, "the first attempt plus maxRetries, and no more");
}
{
  const h = harness({
    users: [withNone],
    answers: { "none@x.test": [{ ok: false, reason: "directory read 403", status: 403 }] },
    apply: true,
  });
  await runBackfill(h.deps, DEFAULT_TUNING);
  eq(h.asked.length, 1, "a refusal that is not a rate limit is not retried");
}

// --- the dry run --------------------------------------------------------------
{
  const h = harness({
    users: [withNone],
    answers: { "none@x.test": [{ ok: true, url: PHOTO }] },
    apply: false,
  });
  const r = await runBackfill(h.deps, DEFAULT_TUNING);
  eq(r.filled, 1, "a dry run reports what it would fill");
  eq(h.written.length, 0, "and writes nothing at all");
}

// --- a failed write is not a fill ---------------------------------------------
{
  const h = harness({
    users: [withNone],
    answers: { "none@x.test": [{ ok: true, url: PHOTO }] },
    apply: true,
    writeFails: "permission denied",
  });
  const r = await runBackfill(h.deps, DEFAULT_TUNING);
  eq(r.filled, 0, "a refused write is never counted as a fill");
  eq(r.writeFailed.length, 1, "it is reported");
  eq(backfillExitCode(r, true), 1, "and the command exits non-zero");
}

// --- measuring nothing is not a pass -------------------------------------------
{
  const h = harness({
    users: [withNone, { id: "u5", email: "b@x.test", avatar_url: null }],
    answers: {
      "none@x.test": [{ ok: false, reason: "directory read 500", status: 500 }],
      "b@x.test": [{ ok: false, reason: "directory read 500", status: 500 }],
    },
    apply: true,
  });
  const r = await runBackfill(h.deps, DEFAULT_TUNING);
  eq(
    backfillExitCode(r, true),
    2,
    "a run that read nobody has measured nothing and must not read as a clean sweep (L98)",
  );
}
{
  const h = harness({ users: [withPhoto], answers: {} , apply: true });
  const r = await runBackfill(h.deps, DEFAULT_TUNING);
  eq(
    backfillExitCode(r, true),
    0,
    "but a roster where everybody already has one is a genuine nothing to do",
  );
}

finish();
