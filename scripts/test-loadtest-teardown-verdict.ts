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
// So the outcomes are separated here, each with its own wording and its own exit
// code, and every one of them is produced from a hand written reply with no network
// and no clock.
//
// The case worth naming on its own is TRUNCATION. An absence from the account's
// Worker listing is a verdict only if that listing is complete, and nothing here has
// measured that it is (L82). If it ever truncated, a Worker that is still deployed
// would fall off the page and read as a CONFIRMED teardown over a live deployment,
// which is worse than the bug this fixes. So the check confirms an absence with a
// second read by name, and the truncation scenario (absent from the listing, present
// by name) is pinned below as its own outcome that is neither gone nor still-deployed.
import {
  TEARDOWN_EXIT,
  byNameNoAnswerVerdict,
  judgeByName,
  misconfiguredVerdict,
  noAnswerVerdict,
  readWorkerListing,
  workerByNameUrl,
  workerListingUrl,
  type ListingReading,
  type TeardownVerdict,
} from "./loadtest/teardown-verdict.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

const NAME = "slate-loadtest";

/** A Cloudflare success envelope listing the given script names. */
const listing = (...ids: string[]) =>
  JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result: ids.map((id) => ({ id, created_on: "2026-09-11T00:00:00Z" })),
  });

const read = (status: number, bodyText: string): ListingReading =>
  readWorkerListing({ workerName: NAME, status, bodyText });

/** The listing verdict, for the readings this file expects to be settled by it. */
function settled(reading: ListingReading, what: string): TeardownVerdict {
  if (reading.kind === "decided") return reading.verdict;
  fail(`${what}: expected the listing read to settle it, got name-absent`);
  return misconfiguredVerdict(["(unreachable)"]);
}

const byName = (status: number, bodyText = "") =>
  judgeByName({ workerName: NAME, listedCount: 12, status, bodyText });

// --- the two reads agree that it is gone: the only pass ----------------------
{
  const reading = read(200, listing("slate", "slate-preview"));
  eq(reading.kind, "name-absent", "a readable listing without the Worker does not settle it alone");
  if (reading.kind !== "name-absent") throw new Error("unreachable");
  eq(reading.listedCount, 2, "and it carries how many Workers it did read");

  const v = judgeByName({ workerName: NAME, listedCount: reading.listedCount, status: 404, bodyText: "" });
  eq(v.kind, "gone", "absent from the listing AND 404 by name is the teardown confirmed");
  eq(v.exitCode, 0, "and it is the only outcome that exits zero");
  assert(v.confirmed, "and it is the only outcome that claims confirmation");
  assert(v.message.includes(NAME), "the message names the Worker it looked for");
  assert(
    /404/.test(v.message) && /listing|Workers on this account/.test(v.message),
    "and it claims only what it measured: BOTH reads, not one (L11)",
  );
}

// --- THE TRUNCATION CASE ------------------------------------------------------
//
// Absent from the listing, present by name. This is the state that would exist if the
// listing ever truncated, and it must never be `gone`: that would be a confirmed
// teardown over a live deployment. It is not `still-deployed` either, because the
// reader has to be told the listing is untrustworthy as well.
{
  const reading = read(200, listing("slate", "another-worker"));
  eq(reading.kind, "name-absent", "the listing does not name it");
  if (reading.kind !== "name-absent") throw new Error("unreachable");

  const v = judgeByName({ workerName: NAME, listedCount: reading.listedCount, status: 200, bodyText: "export default{}" });
  assert(v.kind !== "gone", "absent from the listing but PRESENT by name is NEVER gone");
  assert(!v.confirmed, "and it confirms nothing");
  assert(v.exitCode !== 0, "and it cannot exit zero");
  eq(v.kind, "listing-incomplete", "it is its own outcome, neither gone nor still-deployed");
  eq(v.exitCode, TEARDOWN_EXIT.listingIncomplete, "on its own code");
  assert(
    /STILL deployed/.test(v.message) && /incomplete/.test(v.message),
    "and the message says BOTH things the reader needs: still there, and the listing lies",
  );
}

// --- the Worker is still there, settled by the listing alone ------------------
{
  const v = settled(read(200, listing("slate", NAME)), "a listing carrying the Worker");
  eq(v.kind, "still-deployed", "a listing carrying the loadtest Worker is NOT a teardown");
  eq(v.exitCode, TEARDOWN_EXIT.stillDeployed, "and it exits on its own code");
  assert(!v.confirmed, "and it does not claim confirmation");
  assert(v.message.includes(NAME), "the message names the Worker it found");
}

// A name that differs only in case resolves to STILL DEPLOYED, never to absent. The
// safe direction: a spurious "still deployed" is a red step somebody reads, and a
// spurious "gone" is a deployment left running that nobody ever looks at again.
{
  const v = settled(read(200, listing("slate", "Slate-LoadTest")), "a case variant");
  eq(v.kind, "still-deployed", "a case variant of the name counts as still deployed");
}

// Surrounding whitespace on a listed id does not hide it either.
{
  const v = settled(read(200, listing("slate", ` ${NAME} `)), "a padded id");
  eq(v.kind, "still-deployed", "a padded id in the listing still counts as the Worker");
}

// --- every way the listing cannot be read -------------------------------------
{
  const refused = settled(
    read(403, JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] })),
    "a 403",
  );
  eq(refused.kind, "listing-refused", "a non-200 status is the listing refusing, not an absence");
  eq(refused.exitCode, TEARDOWN_EXIT.listingRefused, "on its own code");
  assert(!refused.confirmed, "and it confirms nothing");
  assert(/403/.test(refused.message), "and it says what Cloudflare answered");

  // A 404 on the ACCOUNT listing is not the Worker being absent: this path is the
  // account's whole listing, so a 404 means the account id or the route is wrong. It
  // never reaches the by-name read at all.
  const notFound = settled(
    read(404, JSON.stringify({ success: false, errors: [{ code: 7003, message: "Could not route" }] })),
    "a 404 on the listing",
  );
  eq(notFound.kind, "listing-refused", "a 404 on the ACCOUNT listing is a refusal, never a confirmed teardown");
  assert(!notFound.confirmed, "so a wrong account id can never read as a clean teardown");
}

{
  const html = settled(read(200, "<html><body>we are having trouble</body></html>"), "an HTML body");
  eq(html.kind, "listing-unreadable", "a 200 whose body is not JSON is unreadable");
  eq(html.exitCode, TEARDOWN_EXIT.listingUnreadable, "on its own code");
  assert(!html.confirmed, "and it confirms nothing");

  const notEnvelope = settled(read(200, JSON.stringify({ result: [{ id: "slate" }] })), "no success flag");
  eq(notEnvelope.kind, "listing-unreadable", "a 200 with no success flag is not a Cloudflare envelope");

  const failedEnvelope = settled(
    read(200, JSON.stringify({ success: false, errors: [{ code: 10000, message: "nope" }], result: [] })),
    "success:false",
  );
  eq(failedEnvelope.kind, "listing-unreadable", "a 200 saying success:false is not a listing either");

  const notAnArray = settled(read(200, JSON.stringify({ success: true, errors: [], result: { id: "slate" } })), "no array");
  eq(notAnArray.kind, "listing-unreadable", "a result that is not an array carries no listing");

  const unnamed = settled(read(200, JSON.stringify({ success: true, errors: [], result: [{ created_on: "x" }] })), "no name");
  eq(unnamed.kind, "listing-unreadable", "a listing whose entries carry no name cannot be searched");
}

// An EMPTY listing is not an account with no Workers, it is a read that returned
// nothing useful: this account runs Slate in production, so zero Workers is the
// shape of a broken read and never a healthy one (L98). It gets its own wording so
// nobody reads it as the teardown having worked.
{
  const v = settled(read(200, listing()), "an empty listing");
  eq(v.kind, "listing-empty", "an empty listing is refused rather than read as an absence");
  eq(v.exitCode, TEARDOWN_EXIT.listingEmpty, "on its own code");
  assert(!v.confirmed, "and it confirms nothing");
}

// --- every way the SECOND read cannot be read ---------------------------------
//
// None of these may borrow the listing's wording: the listing succeeded in all of
// them, and a reader sent to check a token would be looking at the wrong read (L11).
{
  const refused = byName(403, JSON.stringify({ success: false, errors: [{ code: 10000 }] }));
  eq(refused.kind, "by-name-unreadable", "a by-name status that is neither 200 nor 404 is its own outcome");
  eq(refused.exitCode, TEARDOWN_EXIT.byNameUnreadable, "on its own code");
  assert(!refused.confirmed, "and it confirms nothing");
  assert(/403/.test(refused.message), "and it says what the SECOND read answered");
  assert(
    !/account's Worker listing, so whether/.test(refused.message),
    "and it does not borrow the listing refusal's sentence",
  );

  const serverError = byName(500, "upstream failure");
  eq(serverError.kind, "by-name-unreadable", "and so is a 5xx");
  assert(/upstream failure/.test(serverError.message), "which quotes what came back, to diagnose from");

  const emptyBody = byName(500, "   ");
  assert(
    /empty body/.test(emptyBody.message) && !/undefined/.test(emptyBody.message),
    "an empty body is said in words rather than leaking a blank",
  );

  const noReply = byNameNoAnswerVerdict(NAME, "fetch failed");
  eq(noReply.kind, "by-name-no-answer", "a second read that got no reply is its own outcome");
  eq(noReply.exitCode, TEARDOWN_EXIT.byNameNoAnswer, "on its own code");
  assert(!noReply.confirmed, "and it confirms nothing");
  assert(
    noReply.message.includes("fetch failed") && noReply.message.includes(NAME),
    "and it carries what went wrong and which Worker it was about",
  );
}

// --- the two outcomes that never reach a reply at all -------------------------
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
  eq(noAnswer.kind, "no-answer", "a listing request that never got a reply is its own outcome");
  eq(noAnswer.exitCode, TEARDOWN_EXIT.noAnswer, "on its own code");
  assert(!noAnswer.confirmed, "and it confirms nothing");
  assert(noAnswer.message.includes("fetch failed"), "and it carries what went wrong");
}

// --- the two URLs are siblings, so the listing's 200 really does vouch ---------
//
// The whole argument for trusting the by-name 404 is that the listing proved the
// token, the account and the route a moment earlier. That only holds while the second
// URL is the first one plus a name.
{
  const account = "acc 123/x";
  assert(
    workerByNameUrl(account, NAME).startsWith(`${workerListingUrl(account)}/`),
    "the by-name URL is the listing URL plus the name, so one read vouches for the other",
  );
  assert(
    !workerListingUrl(account).includes(" ") && !workerByNameUrl(account, "a b").includes(" "),
    "and both encode what they interpolate",
  );
}

// --- no two outcomes share a message or a code --------------------------------
//
// The defect this fixes was two causes sharing one sentence, so the guard against it
// is that every outcome the command can reach says something different. Enumerated
// against the exit table rather than a hand written list beside it, so an outcome
// added later without its own wording fails here rather than being exempt (L96).
{
  const every: TeardownVerdict[] = [
    judgeByName({ workerName: NAME, listedCount: 3, status: 404, bodyText: "" }),
    settled(read(200, listing("slate", NAME)), "still deployed"),
    settled(read(403, "{}"), "refused"),
    settled(read(200, "<html>"), "unreadable"),
    settled(read(200, listing()), "empty"),
    byName(200, "export default{}"),
    byName(500, "upstream failure"),
    byNameNoAnswerVerdict(NAME, "fetch failed"),
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
  eq(
    every.filter((v) => v.confirmed).length,
    1,
    "and exactly one claims the teardown is confirmed",
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
