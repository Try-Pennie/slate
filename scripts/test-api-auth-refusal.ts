// Telling a rotated booking API key apart from a throttled caller (#1429).
//
// `authorizeBookingApi` used to hand the route a ready-made response and nothing
// else, so the route could not tell WHICH refusal it was and neither could
// anything downstream. Two opposite things sat behind that one branch:
//
//   - a bad or rotated key means the bot cannot book AT ALL, and every lead it
//     handles is refused for as long as the key is wrong;
//   - a rate ceiling trip means one caller is going too fast, which is abuse
//     shaping and is what the ceiling is FOR.
//
// #1318 recorded this as deferred rather than counted badly, because feeding both
// in as one thing would let a noisy caller raise the same number a locked out
// integration does, and the page could not say which had happened. This suite pins
// the decision that unblocked it, in both directions: the credential refusals are
// counted, the throttles are deliberately not, and the read path is counted
// nowhere.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-api-auth-refusal.ts
import {
  AUTH_REFUSAL_REASONS,
  authRefusalCounting,
  authenticateBearer,
  parseApiKeys,
  refusalReasonForStatus,
} from "../src/lib/booking/api-auth.ts";
import { REFUSAL_CATALOG } from "../src/lib/booking/refusal-catalog.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the credential refusals are counted, and named apart -----------------
// A rotated key and an unconfigured endpoint are both "the integration cannot
// book", which is what the failure rate window exists to notice. They get
// DISTINCT codes because the instruction to the reader differs: one is a key to
// repair, the other is a secret that was never set.
{
  const rejected = authRefusalCounting("bad_credential", "write");
  eq(rejected.kind, "error", "a rejected key is counted as a failure");
  eq(
    rejected.kind === "error" ? rejected.code : "",
    "API_KEY_REJECTED",
    "under its own code, so the page can name a locked out integration",
  );

  const unconfigured = authRefusalCounting("not_configured", "write");
  eq(unconfigured.kind, "error", "an endpoint with no key configured is counted too");
  eq(
    unconfigured.kind === "error" ? unconfigured.code : "",
    "API_NOT_CONFIGURED",
    "under a DIFFERENT code: a secret nobody set is a different repair to a wrong one",
  );
  assert(
    (rejected.kind === "error" ? rejected.code : "") !==
      (unconfigured.kind === "error" ? unconfigured.code : ""),
    "#1429: the two credential failures never share a code, or the page cannot say which happened",
  );
}

// --- the throttles are deliberately NOT counted --------------------------
// The dilution rule from the refusal catalog: `attempts` is every recorded
// outcome summed, so recording a noisy caller's refusals would put its volume in
// the denominator and make a real outage look proportionally smaller. Not
// counting is the better of the two wrong answers, and the reasoning has to be
// on the decision rather than in someone's head.
{
  for (const reason of ["throttled_key", "throttled_ip"] as const) {
    const d = authRefusalCounting(reason, "write");
    eq(d.kind, "none", `${reason} is not counted into the failure share`);
    assert(
      d.kind === "none" && /dilut|denominator/i.test(d.why),
      `${reason} says what counting it would COST, not merely that it seemed unnecessary`,
    );
  }
}

// --- the read path is counted nowhere ------------------------------------
// The bookable check shares the authorizer. Its refusals must stay out of the
// window for the same reason the catalog already keeps read traffic out: the
// share being measured is a share of BOOKING attempts, and a rotated key refuses
// the write path too, so nothing is lost by leaving reads out.
{
  for (const reason of AUTH_REFUSAL_REASONS) {
    const d = authRefusalCounting(reason, "read");
    eq(d.kind, "none", `${reason} on the read path is not counted`);
    assert(
      d.kind === "none" && d.why.trim().length > 20,
      `${reason} on the read path records why it is not counted`,
    );
  }
}

// --- every reason is decided, so a new one cannot arrive undecided -------
// The omission this whole area keeps producing (L113): a lookup keyed on a
// vocabulary silently takes its default branch for the entry nobody added, and a
// default is indistinguishable from a deliberate choice.
{
  eq(AUTH_REFUSAL_REASONS.length, 4, "the four refusals the authorizer can make");
  for (const reason of AUTH_REFUSAL_REASONS) {
    for (const surface of ["write", "read"] as const) {
      const d = authRefusalCounting(reason, surface);
      assert(
        d.kind === "error" || (d.kind === "none" && d.why.trim().length > 0),
        `${reason}/${surface} has a real decision, never an empty fallback`,
      );
    }
  }
}

// --- the status the caller sees still maps to the reason -----------------
// The reason has to be derivable from what `authenticateBearer` decided, or the
// authorizer would be inventing a second classification beside the response it
// already built (L53: two things that must agree cannot both be authoritative).
{
  eq(refusalReasonForStatus(401), "bad_credential", "401 is a wrong or rotated key");
  eq(refusalReasonForStatus(503), "not_configured", "503 is an endpoint with no key at all");

  const noKeys = authenticateBearer("Bearer whatever", parseApiKeys([{ caller: "shared", primary: "", secondary: "" }]));
  assert(!noKeys.ok, "no configured key refuses");
  eq(
    refusalReasonForStatus(noKeys.ok ? 200 : noKeys.status),
    "not_configured",
    "and the real authenticator's own status maps to not_configured",
  );

  const wrong = authenticateBearer("Bearer nope", parseApiKeys([{ caller: "shared", primary: "realsecret", secondary: "" }]));
  assert(!wrong.ok, "a wrong key refuses");
  eq(
    refusalReasonForStatus(wrong.ok ? 200 : wrong.status),
    "bad_credential",
    "and maps to bad_credential rather than being guessed at the call site",
  );

  const right = authenticateBearer("Bearer realsecret", parseApiKeys([{ caller: "shared", primary: "realsecret", secondary: "" }]));
  assert(right.ok, "the matching key still authenticates");
}

// --- the catalog and the code agree ------------------------------------
// The decision is only true if the catalog says the same thing the code does. A
// catalog entry claiming the window covers a path it never records is a decision
// that reads exactly like coverage.
{
  const entry = (id: string) => REFUSAL_CATALOG.find((r) => r.id === id);
  assert(!entry("api_auth_refused"), "#1429: the single deferred auth entry is gone, replaced by the decisions");

  for (const [id, reason] of [
    ["api_key_rejected", "bad_credential"],
    ["api_not_configured", "not_configured"],
  ] as const) {
    const e = entry(id);
    assert(!!e, `${id} is in the catalog`);
    eq(e?.counting.kind, "error", `${id} is recorded as an error outcome`);
    const decided = authRefusalCounting(reason, "write");
    eq(
      e?.counting.kind === "error" ? e.counting.code : "",
      decided.kind === "error" ? decided.code : "",
      `${id} names the SAME code the authorizer records, not a hand-copied one`,
    );
    // #1450: still counted into the failure share, AND now carrying a signal of
    // its own, because that window ignores quiet periods (minAttempts 20 an hour)
    // and a completely locked out integration below that floor would stay silent
    // while every lead it handles is refused.
    eq(
      e?.rateSignal.kind,
      "covered-and-pages",
      `${id} is counted in the failure share AND pages independently of it`,
    );
    assert(
      e?.rateSignal.kind === "covered-and-pages" && e.rateSignal.alertKey === "booking_api_credential",
      `${id} pages on the credential key, so its all clear can find it again`,
    );
  }

  const throttled = entry("api_rate_limited");
  assert(!!throttled, "api_rate_limited is in the catalog");
  // #1442: still out of the failure SHARE, which was always the settled half, but
  // no longer uncounted. It records under its own outcome names, outside
  // OUTCOME_ORDER, so it can be measured without entering the denominator.
  eq(throttled?.counting.kind, "own-counter", "the throttle stays out of the failure share");
  assert(
    !!throttled && /dilut|denominator/i.test(throttled.why),
    "with the dilution cost written down, matching the booker's rate limit entries",
  );
  // L77 is only half answered by not counting it. A SUSTAINED trip on the write
  // path means the ceiling is wrong for the bot's real volume, so leads are turned
  // away by our own limit with nothing saying so, and one benign trip and a
  // systemic one arrive on the identical path. That was recorded as a deferred
  // signal naming its issue (L65); #1442 built it, so the entry now names the
  // measurement rather than the promise.
  eq(
    throttled?.rateSignal.kind,
    "uncounted-but-pages",
    "the sustained case is measured against the ceiling, not against the share",
  );
  assert(
    throttled?.rateSignal.kind === "uncounted-but-pages" &&
      throttled.rateSignal.alertKey === "booking_api_ceiling",
    "naming the key it pages on, so the all clear can find it again",
  );
}

finish();
