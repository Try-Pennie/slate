// `inIdChunks`, the shared way to spend a list of ids across several PostgREST
// requests instead of one refused URL (#2388).
//
// `chunkIdsByUrlBudget` already answers "how many ids fit in one request". What it
// cannot answer is what happens when the third of five requests fails, and that is
// the half that decides whether a retention lane is trustworthy. A loop that sums
// the counts and lets the throw escape reports nothing about the work already done:
// on a redaction lane the rows in the finished chunks are irreversibly blanked, and
// the operator reading the page has no way to tell a sweep that touched nothing from
// one that got two thirds of the way.
//
// So the two properties pinned here are: every chunk is inside the measured byte
// budget, and a mid sweep failure is reported AS a partial sweep, naming what
// completed. Finishing some of the work and raising a bare error is the shape that
// reads as a completed sweep to everything downstream.
import {
  MAX_IN_FILTER_BYTES,
  idFilterBytes,
  chunkIdsByUrlBudget,
  inIdChunks,
  PartialIdSweepError,
} from "../src/lib/db/id-batch.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A batch of the size the retention lanes actually read (`MAX_VERIFY_BATCH`). */
const uuids = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

await (async () => {
  // Positive control for the whole file: 500 uuids, the number every retention lane
  // hands up today, must not fit in one request. If this ever passes, the rest of
  // the file is measuring a single chunk and proves nothing about chunking.
  const five_hundred = uuids(500);
  assert(
    idFilterBytes(five_hundred) > MAX_IN_FILTER_BYTES,
    `500 uuids (${idFilterBytes(five_hundred)} bytes) is over the byte ceiling, so the lanes really do need splitting`,
  );
  assert(
    chunkIdsByUrlBudget(five_hundred).length > 1,
    "500 uuids splits into more than one request",
  );

  // --- every chunk fits, and every id is spent exactly once ---
  {
    const seen: string[][] = [];
    const out = await inIdChunks("control", five_hundred, async (chunk) => {
      seen.push(chunk);
      return chunk.length;
    });
    assert(seen.length > 1, "the runner really did split the work");
    assert(
      seen.every((c) => idFilterBytes(c) <= MAX_IN_FILTER_BYTES),
      "every chunk the runner handed out is inside the byte ceiling",
    );
    eq(seen.flat().length, 500, "every id was spent");
    eq(new Set(seen.flat()).size, 500, "no id was spent twice");
    eq(
      out.reduce((a, b) => a + b, 0),
      500,
      "the caller gets one result per chunk, in order, so it can sum them",
    );
  }

  // --- nothing to do is not a request ---
  {
    let calls = 0;
    const out = await inIdChunks("empty", [], async () => {
      calls += 1;
      return 1;
    });
    eq(calls, 0, "an empty id list asks the database nothing");
    eq(out.length, 0, "and answers no results");
  }

  // --- THE FAILURE CASE: a chunk that throws partway is reported as a PARTIAL sweep ---
  {
    let calls = 0;
    let caught: unknown;
    try {
      await inIdChunks("partial", five_hundred, async (chunk) => {
        calls += 1;
        if (calls === 2) throw new Error("PostgREST refused the request");
        return chunk.length;
      });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof PartialIdSweepError, "a failing chunk throws, rather than answering a short result");
    const partial = caught as PartialIdSweepError;
    eq(partial.chunksCompleted, 1, "it names how many requests finished");
    assert(partial.chunksTotal > 1, "and how many there were in total");
    assert(
      partial.idsCompleted > 0 && partial.idsCompleted < 500,
      `it names how many ids were already spent (${partial.idsCompleted} of 500)`,
    );
    eq(partial.idsTotal, 500, "and how many there were");
    assert(
      partial.message.includes("PostgREST refused the request"),
      "the underlying refusal is still in the message, so the cause is not lost",
    );
    assert(
      /\b1 of \d+\b/.test(partial.message),
      `the message itself says the sweep was partial, since a log line is all an operator reads (${partial.message})`,
    );
    assert(partial.cause instanceof Error, "the original error is kept as the cause");
    eq(partial.completed.length, 1, "the results of the finished chunks are kept for the caller to account for");
    assert(calls === 2, "it stopped at the failure rather than carrying on");
  }

  // --- a FIRST chunk failure is still a partial sweep report, naming zero ---
  {
    let caught: unknown;
    try {
      await inIdChunks("first", five_hundred, async () => {
        throw new Error("refused");
      });
    } catch (err) {
      caught = err;
    }
    const partial = caught as PartialIdSweepError;
    assert(caught instanceof PartialIdSweepError, "the first chunk failing reports through the same shape");
    eq(partial.chunksCompleted, 0, "nothing completed");
    eq(partial.idsCompleted, 0, "and no id was spent");
  }

  // --- a single chunk is not exempt: one request that fails is still reported ---
  {
    let caught: unknown;
    try {
      await inIdChunks("single", uuids(3), async () => {
        throw new Error("refused");
      });
    } catch (err) {
      caught = err;
    }
    assert(
      caught instanceof PartialIdSweepError,
      "a list small enough for one request reports through the same shape, so no caller has two error types to handle",
    );
    eq((caught as PartialIdSweepError).chunksTotal, 1, "and says there was one request");
  }

  // --- the runner does not swallow a non Error throw ---
  {
    let caught: unknown;
    try {
      await inIdChunks("weird", uuids(3), async () => {
        throw "a string";
      });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof PartialIdSweepError, "a thrown non Error is still wrapped rather than escaping raw");
    eq((caught as PartialIdSweepError).cause, "a string", "and kept as the cause exactly as thrown");
  }

  finish();
})();
