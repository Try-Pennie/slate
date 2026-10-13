// A booking API timeout is recorded and paged by how far the request got (#3663).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-timeout-reach.ts
//
// At 03:37 UTC on 2026-10-13 the canary's dry run ran out of its 12 seconds while
// Google's token mint was in flight. The route's timeout callback recorded it as
// "a dependency timed out before the request was read", bucket '' and is_test false,
// and the page told the reader "The lead saw a retryable error. Check
// booking_reservations for a pending row". The request had been read and
// authenticated, the caller was the canary, and a dry run writes no row (L11).
import { dependencyTimeoutAlert } from "../src/lib/booking/alert-copy.ts";
import {
  newApiRequestProgress,
  timeoutAttemptSource,
  timeoutIsTestTraffic,
  timeoutReach,
} from "../src/lib/booking/api-timeout-facts.ts";
import { createAsserter } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const tokenMint = { dependency: "google token mint", timeoutMs: 8000, budget: null };
const spentConfirm = { dependency: "supabase", timeoutMs: 0, budget: { label: "the booking confirm", totalMs: 12_000 } };
const host = { prefill: null, referrer_origin: null };

// --- the page's words, by reach ---------------------------------------------------
{
  const booking = dependencyTimeoutAlert(tokenMint);
  assert(
    booking.startsWith("A booking failed because google token mint did not answer within 8 seconds"),
    "a booking's page is unchanged when no reach is named",
  );
  assert(booking.includes("booking_reservations"), "a booking's page still sends the reader to its reservation row");
  assert(
    dependencyTimeoutAlert({ ...tokenMint, reach: "booking" }) === booking,
    "naming the booking reach says exactly what the default says",
  );

  const dryRun = dependencyTimeoutAlert({ ...tokenMint, reach: "dry-run" });
  assert(dryRun.startsWith("A dry run booking check failed because google token mint did not answer within 8 seconds"), `a dry run says it was a dry run (got ${dryRun})`);
  assert(!/booking_reservations|pending row|rebook/.test(dryRun), "a dry run never sends the reader to a reservation row");
  assert(!/\blead\b/.test(dryRun), "a dry run never claims a lead saw anything");
  assert(dryRun.endsWith("Check Google Calendar API health."), `a dry run points at the dependency that was in flight (got ${dryRun})`);

  const beforeBody = dependencyTimeoutAlert({ ...spentConfirm, reach: "before-body" });
  assert(beforeBody.startsWith("A booking request failed before Slate had read its body"), `before the body it says so (got ${beforeBody})`);
  assert(!/booking_reservations|\blead\b|not because the slot was full/.test(beforeBody), "before the body there is no slot, lead or row to speak of");
  assert(beforeBody.includes("confirm answered log line"), "a budget spent before Slate asked still sends the reader to the request's own line");

  const beforeBodyUnknown = dependencyTimeoutAlert({ dependency: "the hourly ceiling", timeoutMs: 4000, budget: null, reach: "before-body" });
  assert(
    beforeBodyUnknown.endsWith("Start from that request's confirm answered log line."),
    "a dependency with no health page to name sends the reader to the request's own line",
  );
}

// --- what the tally records, by what the request had established ------------------
{
  const nothing = newApiRequestProgress();
  const source = timeoutAttemptSource(nothing);
  assert(source.by === "unidentifiable" && source.why.includes("before the API key was accepted"), "nothing known: unidentifiable, and says why");
  assert(timeoutReach(nothing) === "before-body", "nothing known: before the body");

  const keyed = { ...newApiRequestProgress(), caller: "regal" as const };
  const keyedSource = timeoutAttemptSource(keyed);
  assert(
    keyedSource.by === "unidentifiable" && keyedSource.why.includes("after the regal key was accepted"),
    "a real key and no body: unidentifiable, naming the caller and the stage",
  );

  const canaryKeyed = { ...newApiRequestProgress(), caller: "canary" as const };
  assert(timeoutAttemptSource(canaryKeyed).by === "canaryCaller", "the canary's key alone makes it the canary's");

  const read = { caller: "regal" as const, request: { bucketCode: "411", dryRun: true, host } };
  const readSource = timeoutAttemptSource(read);
  assert(readSource.by === "bucket" && readSource.code === "411", "a parsed body records its bucket, which decides is_test");
  assert(timeoutReach(read) === "dry-run", "a parsed dry run is a dry run");
  assert(timeoutReach({ ...read, request: { ...read.request, dryRun: false } }) === "booking", "a parsed booking is a booking");

  const canaryRead = { caller: "canary" as const, request: { bucketCode: "SMOKE", dryRun: true, host } };
  assert(timeoutAttemptSource(canaryRead).by === "canaryCaller", "the canary's key decides even once its body named a bucket");
}

// --- whether it pages: the same facts as the tally (L261) ---------------------------
{
  const asked: string[] = [];
  const bucketFlag = (answer: boolean) => async (code: string) => {
    asked.push(code);
    return answer;
  };
  const canary = { caller: "canary" as const, request: null };
  assert((await timeoutIsTestTraffic(canary, bucketFlag(false))) === true, "the canary's timeout is test traffic without a read");
  assert(asked.length === 0, "and no bucket was read for it");

  const lead = { caller: "regal" as const, request: { bucketCode: "411", dryRun: false, host } };
  assert((await timeoutIsTestTraffic(lead, bucketFlag(false))) === false, "a real bucket's timeout is real");
  assert((await timeoutIsTestTraffic(lead, bucketFlag(true))) === true, "a test bucket's timeout is test, by the bucket's flag");
  assert(asked.join(",") === "411,411", "the bucket asked is the one the body named");

  assert(
    (await timeoutIsTestTraffic({ caller: "regal", request: null }, bucketFlag(true))) === false,
    "a real caller with no body read is real, the direction that pages",
  );
  assert((await timeoutIsTestTraffic(newApiRequestProgress(), bucketFlag(true))) === false, "nothing known is real");
}

finish();
