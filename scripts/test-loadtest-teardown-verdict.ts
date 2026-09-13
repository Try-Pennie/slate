// The decision behind the load run's teardown confirmation (#2277), driven offline.
// Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/test-loadtest-teardown-verdict.ts
//
// Why this exists. The teardown job deletes the loadtest deployment and then has to
// say whether it is really gone, because a zero exit from `wrangler delete` is not
// the deployment being absent. The first version asked
// `wrangler deployments list --env loadtest`, which ERRORS once the Worker is gone,
// so the step took its "could not list deployments" branch and failed the job for
// having cleaned up correctly (observed 2026-09-11 after #2261). One message was
// answering for two different causes (L11), and a step that is red for doing its job
// is one nobody reads by the second week (L36).
//
// So the three outcomes are separated here, each with its own wording and its own
// exit code, and every one of them is produced from a hand written reply with no
// network and no clock.
import {
  TEARDOWN_EXIT,
  judgeWorkerListing,
  misconfiguredVerdict,
  noAnswerVerdict,
  type TeardownVerdict,
} from "./loadtest/teardown-verdict.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NAME = "slate-loadtest";

/** A Cloudflare success envelope listing the given script names. */
const listing = (...ids: string[]) =>
  JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result: ids.map((id) => ({ id, created_on: "2026-09-11T00:00:00Z" })),
  });

const judge = (status: number, bodyText: string): TeardownVerdict =>
  judgeWorkerListing({ workerName: NAME, status, bodyText });

// --- the Worker is gone: the only pass ---------------------------------------
{
  const v = judge(200, listing("slate", "slate-preview"));
  eq(v.kind, "gone", "a listing without the loadtest Worker is the teardown confirmed");
  eq(v.exitCode, 0, "and it is the only outcome that exits zero");
  assert(v.confirmed, "and it is the only outcome that claims confirmation");
  assert(v.message.includes(NAME), "the message names the Worker it looked for");
}

// --- the Worker is still there ------------------------------------------------
{
  const v = judge(200, listing("slate", NAME));
  eq(v.kind, "still-deployed", "a listing carrying the loadtest Worker is NOT a teardown");
  eq(v.exitCode, TEARDOWN_EXIT.stillDeployed, "and it exits on its own code");
  assert(!v.confirmed, "and it does not claim confirmation");
  assert(v.message.includes(NAME), "the message names the Worker it found");
}

// A name that differs only in case resolves to STILL DEPLOYED, never to gone. The
// safe direction: a spurious "still deployed" is a red step somebody reads, and a
// spurious "gone" is a deployment left running that nobody ever looks at again.
{
  const v = judge(200, listing("slate", "Slate-LoadTest"));
  eq(v.kind, "still-deployed", "a case variant of the name counts as still deployed");
}

// Surrounding whitespace on a listed id does not hide it either.
{
  const v = judge(200, listing("slate", ` ${NAME} `));
  eq(v.kind, "still-deployed", "a padded id in the listing still counts as the Worker");
}

// --- every way the listing cannot be read -------------------------------------
{
  const refused = judge(403, JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }));
  eq(refused.kind, "listing-refused", "a non-200 status is the listing refusing, not an absence");
  eq(refused.exitCode, TEARDOWN_EXIT.listingRefused, "on its own code");
  assert(!refused.confirmed, "and it confirms nothing");
  assert(/403/.test(refused.message), "and it says what Cloudflare answered");

  // The 404 case is the one worth pinning. A 404 from this endpoint is NOT the
  // Worker being absent: this reads the account's whole Worker listing, so a 404
  // means the account id or the route is wrong. Reading it as a teardown would be
  // #1433 wearing new clothes.
  const notFound = judge(404, JSON.stringify({ success: false, errors: [{ code: 7003, message: "Could not route to ..." }] }));
  eq(notFound.kind, "listing-refused", "a 404 on the ACCOUNT listing is a refusal, never a confirmed teardown");
  assert(!notFound.confirmed, "so a wrong account id can never read as a clean teardown");
}

{
  const html = judge(200, "<html><body>we are having trouble</body></html>");
  eq(html.kind, "listing-unreadable", "a 200 whose body is not JSON is unreadable");
  eq(html.exitCode, TEARDOWN_EXIT.listingUnreadable, "on its own code");
  assert(!html.confirmed, "and it confirms nothing");

  const notEnvelope = judge(200, JSON.stringify({ result: [{ id: "slate" }] }));
  eq(notEnvelope.kind, "listing-unreadable", "a 200 with no success flag is not a Cloudflare envelope");

  const failedEnvelope = judge(200, JSON.stringify({ success: false, errors: [{ code: 10000, message: "nope" }], result: [] }));
  eq(failedEnvelope.kind, "listing-unreadable", "a 200 saying success:false is not a listing either");

  const notAnArray = judge(200, JSON.stringify({ success: true, errors: [], result: { id: "slate" } }));
  eq(notAnArray.kind, "listing-unreadable", "a result that is not an array carries no listing");

  const unnamed = judge(200, JSON.stringify({ success: true, errors: [], result: [{ created_on: "x" }] }));
  eq(unnamed.kind, "listing-unreadable", "a listing whose entries carry no name cannot be searched");
}

// An EMPTY listing is not an account with no Workers, it is a read that returned
// nothing useful: this account runs Slate in production, so zero Workers is the
// shape of a broken read and never a healthy one (L98). It gets its own wording so
// nobody reads it as the teardown having worked.
{
  const v = judge(200, listing());
  eq(v.kind, "listing-empty", "an empty listing is refused rather than read as an absence");
  eq(v.exitCode, TEARDOWN_EXIT.listingEmpty, "on its own code");
  assert(!v.confirmed, "and it confirms nothing");
}

// --- the two outcomes that never reach a reply --------------------------------
{
  const v = misconfiguredVerdict(["CLOUDFLARE_ACCOUNT_ID", "LOADTEST_WORKER_NAME"]);
  eq(v.kind, "misconfigured", "missing credentials are their own outcome");
  eq(v.exitCode, TEARDOWN_EXIT.misconfigured, "on their own code");
  assert(!v.confirmed, "and nothing was attempted, so nothing is confirmed");
  assert(
    v.message.includes("CLOUDFLARE_ACCOUNT_ID") && v.message.includes("LOADTEST_WORKER_NAME"),
    "and the message names every setting that is missing",
  );

  const noAnswer = noAnswerVerdict("fetch failed");
  eq(noAnswer.kind, "no-answer", "a request that never got a reply is its own outcome");
  eq(noAnswer.exitCode, TEARDOWN_EXIT.noAnswer, "on its own code");
  assert(!noAnswer.confirmed, "and it confirms nothing");
  assert(noAnswer.message.includes("fetch failed"), "and it carries what went wrong");
}

// --- no two outcomes share a message or a code --------------------------------
//
// The defect this fixes was two causes sharing one sentence, so the guard against it
// is that every outcome the command can reach says something different. Enumerated
// from the exit table rather than from a hand written list beside it, so an outcome
// added later without its own wording fails here rather than being exempt (L96).
{
  const every: TeardownVerdict[] = [
    judge(200, listing("slate")),
    judge(200, listing("slate", NAME)),
    judge(403, JSON.stringify({ success: false, errors: [] })),
    judge(200, "<html>"),
    judge(200, listing()),
    misconfiguredVerdict(["CLOUDFLARE_API_TOKEN"]),
    noAnswerVerdict("fetch failed"),
  ];

  const kinds = every.map((v) => v.kind);
  eq(new Set(kinds).size, kinds.length, "every outcome sampled here is a different kind");
  eq(
    new Set(kinds).size,
    Object.keys(TEARDOWN_EXIT).length,
    "and every outcome the exit table declares is one of them, so none is untested",
  );

  const messages = every.map((v) => v.message);
  eq(new Set(messages).size, messages.length, "no two outcomes say the same thing (L11)");

  const codes = every.map((v) => v.exitCode);
  eq(new Set(codes).size, codes.length, "and no two outcomes exit on the same code");

  const tableCodes = Object.values(TEARDOWN_EXIT);
  eq(new Set(tableCodes).size, tableCodes.length, "the exit table itself has no duplicate code");
  eq(
    every.filter((v) => v.exitCode === 0).length,
    1,
    "exactly one outcome exits zero, so finding nothing is never a pass (L98)",
  );
  assert(
    every.every((v) => v.confirmed === (v.exitCode === 0)),
    "and the confirmed flag and the exit code can never disagree",
  );

  // Each message has to be readable on its own, because it is the whole report: the
  // step prints it and exits. A message that named no Worker and no cause would send
  // the reader back to the log they are already looking at.
  for (const v of every) {
    assert(v.message.trim().length > 20, `the ${v.kind} message says something (${v.message})`);
    assert(!/undefined|NaN|\[object Object\]/.test(v.message), `the ${v.kind} message leaks nothing`);
  }
}

finish();
