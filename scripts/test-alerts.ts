// Sanity test for pure alert helpers (throttle + formatting).
// Run: node --experimental-strip-types scripts/test-alerts.ts
import {
  shouldSendAlert,
  formatWatchLapseAlert,
  formatSyncFailureAlert,
  isConsecutiveFailure,
  dedupeFailingAgents,
  isPageableFailure,
  alertStampMs,
  FAILED_SEND_RETRY_MS,
  shortFailureReason,
  relativeAge,
  applyBlastRadiusHold,
  formatSyncRecoveryNotice,
  TRANSIENT_HOLD_MS,
  TRANSIENT_HOLD_PASSES,
  SYNC_PAGING,
  WATCH_PAGING,
  type FailingAgent,
} from "../src/lib/notify/alerts.ts";
import { assert, finish } from "./lib/harness.ts";

const COOLDOWN = 30 * 60 * 1000; // 30 min
const now = 1_000_000_000;

/** A pinned "now" for every message-formatting assertion (#1133): `last ok` is
 *  rendered as an elapsed duration, so the clock must never be the real one. */
const NOW_MS = Date.parse("2026-07-28T12:00:00Z");
const agoIso = (ms: number) => new Date(NOW_MS - ms).toISOString();

assert(shouldSendAlert(null, now, COOLDOWN), "never-alerted: sends");
assert(!shouldSendAlert(now - 60_000, now, COOLDOWN), "within cooldown: suppressed");
assert(shouldSendAlert(now - COOLDOWN, now, COOLDOWN), "exactly at cooldown: sends");
assert(shouldSendAlert(now - COOLDOWN - 1, now, COOLDOWN), "past cooldown: sends");

// Named watch-lapse alert (#273 Phase 1.3): name the failing agent(s) + their
// consecutive-failure count + last success + the remediation, so the operator
// doesn't have to hand-query the DB to find who broke.
const oneFailing = formatWatchLapseAlert(
  [
    {
      email: "alice@pennie.com",
      consecutiveFailures: 5,
      lastSuccessAt: agoIso(3 * 60 * 60 * 1000),
      error: "404 account-gone",
    },
  ],
  110,
  NOW_MS,
);
assert(oneFailing.includes("alice@pennie.com"), "names the failing agent");
assert(oneFailing.includes("1 of 110"), "shows failing/total context");
assert(oneFailing.includes("5 consecutive failures"), "shows the consecutive-failure count");
// #1150: labelled "last renewed", not "last ok". This lane's stamp is the last
// successful RENEWAL, which is days old on a perfectly healthy channel.
assert(
  oneFailing.includes("last renewed 3 hours ago"),
  "shows how long ago the last successful renewal was",
);
assert(oneFailing.includes("404 account-gone"), "carries the underlying error");
assert(/re-?auth|deactivate/i.test(oneFailing), "includes the remediation");

const manyFailing = Array.from({ length: 7 }, (_, i) => ({
  email: `a${i}@pennie.com`,
  consecutiveFailures: 2,
  lastSuccessAt: null,
  error: null,
}));
const many = formatWatchLapseAlert(manyFailing, 110, NOW_MS);
assert(many.includes("never"), "shows 'never' when the calendar never succeeded");
assert(
  many.includes("a0@pennie.com") && !many.includes("a6@pennie.com"),
  "caps the named list instead of dumping all of them",
);
assert(/2 more/.test(many), "notes how many failing agents are beyond the cap");
assert(
  formatWatchLapseAlert([{ email: "a@b.com", consecutiveFailures: 2, lastSuccessAt: null, error: "x".repeat(500) }], 110, NOW_MS).length < 600,
  "per-agent error detail is truncated",
);

// --- dedupeFailingAgents: collapse calendar rows to one entry per agent ---
const deduped = dedupeFailingAgents([
  { consecutive_failures: 2, last_success_at: null, last_sync_error: "e1", email: "bob@pennie.com", bookable: true, deactivated_at: null },
  { consecutive_failures: 7, last_success_at: "2026-06-10T00:00:00Z", last_sync_error: "worst", email: "bob@pennie.com", bookable: true, deactivated_at: null },
  { consecutive_failures: 3, last_success_at: null, last_sync_error: "e3", email: "amy@pennie.com", bookable: true, deactivated_at: null },
  { consecutive_failures: 9, last_success_at: null, last_sync_error: "gone", email: "left@pennie.com", bookable: true, deactivated_at: "2026-06-01T00:00:00Z" },
  { consecutive_failures: 9, last_success_at: null, last_sync_error: "off", email: "off@pennie.com", bookable: false, deactivated_at: null },
  { consecutive_failures: 4, last_success_at: null, last_sync_error: "x", email: null, bookable: true, deactivated_at: null },
]);
assert(deduped.length === 2, "one entry per agent; deactivated/non-bookable/no-email dropped");
assert(deduped[0].email === "bob@pennie.com" && deduped[0].consecutiveFailures === 7, "keeps the worst calendar per agent, sorted by failures desc");
assert(deduped[0].error === "worst", "carries the worst calendar's error");
assert(deduped[1].email === "amy@pennie.com", "second agent follows in failure order");
assert(!deduped.some((a) => a.email === "left@pennie.com"), "a deactivated agent is excluded");
assert(!deduped.some((a) => a.email === "off@pennie.com"), "a non-bookable agent is excluded");

// --- #916: per-kind paging thresholds (gone pages at 2, transient at 4) ---
assert(isPageableFailure("gone", 2), "gone pages at streak 2");
assert(!isPageableFailure("gone", 1), "gone does not page at streak 1");
assert(!isPageableFailure("transient", 2), "transient backs off: does NOT page at streak 2");
assert(!isPageableFailure("transient", 3), "transient still quiet at streak 3");
assert(isPageableFailure("transient", 4), "transient pages once it persists to streak 4");
// A null/unclassified kind is treated conservatively as gone so a pre-#916
// streak that used to page never goes silent.
assert(isPageableFailure(null, 2), "an unclassified failure pages at 2 (treated as gone)");
assert(isPageableFailure(undefined, 2), "a missing kind pages at 2 (treated as gone)");

// dedupeFailingAgents carries the worst calendar's classification through, and
// the named alert lines label it so ops knows which need a human.
const kinded = dedupeFailingAgents([
  { consecutive_failures: 5, last_success_at: null, last_sync_error: "unauthorized_client", email: "gone@pennie.com", bookable: true, deactivated_at: null, last_failure_kind: "gone" },
  { consecutive_failures: 6, last_success_at: null, last_sync_error: "503", email: "flaky@pennie.com", bookable: true, deactivated_at: null, last_failure_kind: "transient" },
]);
assert(kinded.find((a) => a.email === "gone@pennie.com")?.failureKind === "gone", "carries a 'gone' classification");
assert(kinded.find((a) => a.email === "flaky@pennie.com")?.failureKind === "transient", "carries a 'transient' classification");
const kindMsg = formatWatchLapseAlert(kinded, 110, NOW_MS);
assert(/account gone: re-?auth or deactivate/i.test(kindMsg), "labels a gone account with its remediation");
assert(/transient: likely self-healing/i.test(kindMsg), "labels a transient failure as likely self-healing");

// --- sync-failure alerting (#43) ---
assert(!isConsecutiveFailure(0), "no failures -> no alert");
assert(!isConsecutiveFailure(1), "a single failing pass stays quiet (transient blip)");
assert(isConsecutiveFailure(2), "second consecutive failing pass alerts");
assert(isConsecutiveFailure(5), "longer streaks keep alerting (throttle handles spam)");

// Named sync-failure alert (#293): like the watch alert, name the failing
// agent(s) instead of an anonymous count, reusing the FailingAgent shape.
const syncFailing = [
  {
    email: "sync1@pennie.com",
    consecutiveFailures: 4,
    lastSuccessAt: agoIso(35 * 60 * 1000),
    error: "freeBusy failed: 503",
  },
];
const syncMsg = formatSyncFailureAlert(syncFailing, 110, NOW_MS);
assert(syncMsg.includes("sync1@pennie.com"), "sync alert names the failing agent");
assert(syncMsg.includes("1 of 110"), "sync alert shows failing/total context");
assert(syncMsg.includes("4 consecutive failures"), "sync alert shows the consecutive-failure count");
assert(syncMsg.includes("last ok 35 minutes ago"), "sync alert shows how long ago the last successful sync was");
assert(syncMsg.includes("503"), "sync alert carries the failure status");
assert(/re-?auth|deactivate/i.test(syncMsg), "sync alert includes the remediation");
assert(
  formatSyncFailureAlert(
    [{ email: "a@b.com", consecutiveFailures: 2, lastSuccessAt: null, error: "x".repeat(500) }],
    110,
    NOW_MS,
  ).length < 600,
  "sync alert truncates per-agent error detail",
);

// alertStampMs (#1035): a FAILED Slack send must not burn the full cooldown, so
// the key frees up ~2 min later instead of being silenced for 15-60+ min. The
// stamp is chosen so next-eligible = stamp + cooldown lands at now + delay.
const T = 5_000_000; // an arbitrary "now"

// A successful send stamps `now`, so the next send waits the full cooldown.
assert(alertStampMs(true, T, COOLDOWN) === T, "ok send stamps now (full cooldown)");
assert(
  T - alertStampMs(true, T, COOLDOWN) === 0,
  "ok send: elapsed-at-stamp is zero (a full cooldown must pass)",
);

// A failed send with a long cooldown frees the key after the short retry window.
const failedStamp = alertStampMs(false, T, COOLDOWN);
assert(
  failedStamp + COOLDOWN === T + FAILED_SEND_RETRY_MS,
  "failed send: next-eligible is now + ~2min retry window, not now + full cooldown",
);
assert(
  failedStamp < T,
  "failed send: stamp is backdated so the next tick can retry soon",
);

// A failed send must NEVER wait longer than the cooldown would have: with a
// cooldown shorter than the retry window, it collapses to a normal `now` stamp.
const SHORT = 60 * 1000; // 1 min < 2 min retry window
assert(
  alertStampMs(false, T, SHORT) === T,
  "failed send with a sub-retry-window cooldown stamps now (never extends the wait)",
);
assert(
  alertStampMs(false, T, SHORT) + SHORT === T + SHORT,
  "failed send never pushes next-eligible past the cooldown it would have used",
);

// ---------------------------------------------------------------------------
// #1133: readable copy + blast-radius paging.
// ---------------------------------------------------------------------------

// --- shortFailureReason: a short human reason, never a raw JSON body ---
// The exact string that produced the unreadable 2026-07-28 page: `last_sync_error`
// is built as `${label} failed: ${status} ${text}` where text is Google's whole
// pretty-printed body, so the alert used to render eight lines of braces cut off
// mid-word at `"mess`.
const RAW_503 = `events.list failed: 503 {
  "error": {
    "errors": [
      {
        "domain": "global",
        "reason": "backendError",
        "message": "Backend Error"
      }
    ],
    "code": 503,
    "message": "Backend Error"
  }
}`;
assert(shortFailureReason(RAW_503) === "503 backendError", "extracts status + Google reason from a raw body");
assert(shortFailureReason(null) === null, "no error -> no reason");
assert(shortFailureReason("freeBusy failed: 503") === "503", "a body-less Google failure keeps just the status");
assert(
  shortFailureReason("token mint failed: 401 { \"error\": \"unauthorized_client\" }") === "401 unauthorized_client",
  "picks up a bare string error field as the reason",
);
// A non-Google failure (an abort/timeout) has no status to extract, so it falls
// back to a collapsed single line rather than being dropped.
assert(
  shortFailureReason("The operation was aborted due to timeout") ===
    "The operation was aborted due to timeout",
  "a non-HTTP failure passes through as its own text",
);
// #1135 changed this from "keep line one, drop the rest" to "join, then bound".
// Dropping everything after the first newline threw away the useful half of the
// errors this sweep had to cover: Snowflake answers a bad statement with
// "SQL compilation error:" on line one and the actual position and identifier on
// line two. Joining keeps that, and the width cap below still stops a stack from
// flooding Slack.
assert(
  shortFailureReason("first line\nsecond line") === "first line second line",
  "a multi-line non-HTTP failure collapses to ONE line, keeping what follows",
);
assert(
  shortFailureReason("SQL compilation error:\nsyntax error line 3 at position 8") ===
    "SQL compilation error: syntax error line 3 at position 8",
  "a Snowflake SQL error keeps the position, which is the part worth reading",
);
// #1128: the Snowflake SQL API's own throw shape, `Snowflake <status>: <body>`.
// Without a branch for it the JSON prefix eats the whole width budget and the
// reason truncates to `400 {"code":"000904","message":"SQL compilation error:
// invalid…`, dropping WHICH identifier was invalid. That is precisely the fact
// #1197 needed: a statement naming a column the warehouse does not have.
assert(
  shortFailureReason(
    'Snowflake 400: {"code":"000904","message":"SQL compilation error: invalid identifier \'PAYLOAD_ERASED\'"}',
  ) === "400 SQL compilation error: invalid identifier 'PAYLOAD_ERASED'",
  "a Snowflake API failure keeps the status and the identifier, not the JSON",
);
assert(
  !/[{}]/.test(
    shortFailureReason('Snowflake 400: {"code":"000904","message":"SQL compilation error: nope"}') ?? "",
  ),
  "the Snowflake reason carries no JSON punctuation",
);
// A body this branch cannot parse must still degrade to the collapsed line rather
// than to nothing: an unreadable error is still worth reporting.
assert(
  shortFailureReason("Snowflake 503: service unavailable") === "503 service unavailable",
  "a Snowflake failure with a non-JSON body keeps the status and the text",
);

const longReason = shortFailureReason("x".repeat(300));
assert(longReason !== null && longReason.length <= 90, "an overlong reason is truncated");
assert(
  !/[{}"]/.test(shortFailureReason(RAW_503) ?? ""),
  "the extracted reason carries no JSON punctuation",
);

// --- relativeAge: elapsed time, not a bare date ---
assert(relativeAge(null, NOW_MS) === "never", "a never-successful calendar reads 'never'");
assert(relativeAge(agoIso(30 * 1000), NOW_MS) === "just now", "under a minute reads 'just now'");
assert(relativeAge(agoIso(60 * 1000), NOW_MS) === "1 minute ago", "one minute is singular");
assert(relativeAge(agoIso(4 * 60 * 1000), NOW_MS) === "4 minutes ago", "minutes are plural");
assert(relativeAge(agoIso(60 * 60 * 1000), NOW_MS) === "1 hour ago", "one hour is singular");
assert(relativeAge(agoIso(5 * 60 * 60 * 1000), NOW_MS) === "5 hours ago", "hours are plural");
assert(relativeAge(agoIso(48 * 60 * 60 * 1000), NOW_MS) === "2 days ago", "days are plural");
assert(relativeAge("not-a-date", NOW_MS) === "unknown", "an unparseable timestamp says so rather than lying");

// --- applyBlastRadiusHold: one agent waits, many page fast ---
// Both signals are required for a lone transient agent (elapsed unavailability
// AND enough observed passes), so a healthy agent whose last sync was skipped for
// a while can't look like a long outage and page early.
const transientAgent = (over: { streak: number; downMs: number | null; email?: string }): FailingAgent => ({
  email: over.email ?? "lone@pennie.com",
  consecutiveFailures: over.streak,
  lastSuccessAt: over.downMs === null ? null : agoIso(over.downMs),
  error: RAW_503,
  failureKind: "transient",
});

assert(TRANSIENT_HOLD_MS === 10 * 60 * 1000, "the single-agent hold is 10 minutes");
assert(TRANSIENT_HOLD_PASSES === 10, "10 minutes at the 1-minute sync cadence is 10 observed passes");

// The incident itself: one agent, 4 consecutive failures, down ~4 minutes. Must NOT page.
assert(
  applyBlastRadiusHold([transientAgent({ streak: 4, downMs: 4 * 60 * 1000 })], NOW_MS).length === 0,
  "a lone transient agent down 4 minutes is held, not paged (the 2026-07-28 incident)",
);
// Just under the boundary on time, streak satisfied.
assert(
  applyBlastRadiusHold([transientAgent({ streak: 12, downMs: TRANSIENT_HOLD_MS - 1_000 })], NOW_MS).length === 0,
  "a lone transient agent one second short of 10 minutes is still held",
);
// Exactly at the boundary, both signals satisfied.
assert(
  applyBlastRadiusHold([transientAgent({ streak: 10, downMs: TRANSIENT_HOLD_MS })], NOW_MS).length === 1,
  "a lone transient agent at exactly 10 minutes with 10 observed passes pages",
);
// The gap this closes: the elapsed clock alone says 20 minutes, but we have only
// watched it fail twice, so it must stay quiet.
assert(
  applyBlastRadiusHold([transientAgent({ streak: 2, downMs: 20 * 60 * 1000 })], NOW_MS).length === 0,
  "a stale last-success timestamp cannot page on its own: the observed streak must agree",
);
// A calendar that has NEVER succeeded has no elapsed signal, so the streak decides.
assert(
  applyBlastRadiusHold([transientAgent({ streak: TRANSIENT_HOLD_PASSES, downMs: null })], NOW_MS).length === 1,
  "a never-successful lone transient calendar pages on the streak alone",
);
assert(
  applyBlastRadiusHold([transientAgent({ streak: 3, downMs: null })], NOW_MS).length === 0,
  "a never-successful lone transient calendar still needs the full streak",
);
// #1169 regression guard: an unparseable last-success stamp must land on the
// PAGED side (as if never successful), never read as "inside the hold".
assert(
  applyBlastRadiusHold(
    [{ ...transientAgent({ streak: 12, downMs: 0 }), lastSuccessAt: "not-a-timestamp" }],
    NOW_MS,
  ).length === 1,
  "an unparseable last-success stamp never hides a lone transient failure",
);

// Two or more transient agents at once is systemic: page on the fast threshold.
const twoTransient = [
  transientAgent({ streak: 4, downMs: 4 * 60 * 1000, email: "a@pennie.com" }),
  transientAgent({ streak: 4, downMs: 4 * 60 * 1000, email: "b@pennie.com" }),
];
assert(
  applyBlastRadiusHold(twoTransient, NOW_MS).length === 2,
  "two transient agents failing together page fast, with no 10-minute hold",
);

// gone is never held, alone or otherwise: a revoked account is a human task from
// its first confirmation.
const goneAgent: FailingAgent = {
  email: "gone@pennie.com",
  consecutiveFailures: 2,
  lastSuccessAt: agoIso(60 * 1000),
  error: "token mint failed: 401 { \"error\": \"unauthorized_client\" }",
  failureKind: "gone",
};
assert(
  applyBlastRadiusHold([goneAgent], NOW_MS).length === 1,
  "a lone gone calendar pages immediately, unaffected by the transient hold",
);
const unclassified: FailingAgent = { ...goneAgent, email: "old@pennie.com", failureKind: null };
assert(
  applyBlastRadiusHold([unclassified], NOW_MS).length === 1,
  "an unclassified failure is treated as gone and never held",
);
// Mixed list: the gone account pages, the lone brief transient is held. One gone
// calendar must not convert a quiet blip into a fast page.
const mixed = applyBlastRadiusHold(
  [goneAgent, transientAgent({ streak: 4, downMs: 4 * 60 * 1000 })],
  NOW_MS,
);
assert(mixed.length === 1 && mixed[0].email === "gone@pennie.com", "mixed list: gone pages, brief lone transient held");

// --- copy: the header instruction must match the classification ---
const transientOnlyMsg = formatSyncFailureAlert(
  [transientAgent({ streak: 12, downMs: 15 * 60 * 1000 })],
  97,
  NOW_MS,
);
assert(
  !/re-?auth|deactivate/i.test(transientOnlyMsg),
  "an all-transient list never tells anyone to re-auth (the 2026-07-28 contradiction)",
);
assert(/no action/i.test(transientOnlyMsg), "an all-transient list says no action is needed unless it persists");
assert(transientOnlyMsg.includes("503 backendError"), "the alert shows the short reason");
assert(!transientOnlyMsg.includes("\"error\""), "the alert body carries no raw JSON");
assert(!/"mess$|"mess\b/.test(transientOnlyMsg), "the alert body is never cut off mid-word");
const goneMsg = formatSyncFailureAlert([goneAgent], 97, NOW_MS);
assert(/re-?auth|deactivate/i.test(goneMsg), "a gone account still carries the re-auth instruction");
const mixedMsg = formatSyncFailureAlert([goneAgent, transientAgent({ streak: 12, downMs: 15 * 60 * 1000 })], 97, NOW_MS);
assert(/re-?auth|deactivate/i.test(mixedMsg), "a mixed list keeps the re-auth instruction for the gone account");

// --- copy: counts read grammatically, and breadth is legible ---
assert(
  formatSyncFailureAlert([goneAgent], 97, NOW_MS).includes("1 of 97 bookable agents"),
  "the total noun pluralizes on the total, not the failing count (was '1 of 97 bookable agent')",
);
assert(
  formatWatchLapseAlert([goneAgent], 97, NOW_MS).includes("1 of 97 bookable agents has"),
  "the watch-lapse verb agrees with the failing count",
);
assert(
  formatWatchLapseAlert([goneAgent, unclassified], 97, NOW_MS).includes("2 of 97 bookable agents have"),
  "several failing agents take the plural verb",
);
const broadMsg = formatSyncFailureAlert(twoTransient, 97, NOW_MS);
assert(/systemic|broad|across/i.test(broadMsg), "a multi-agent failure reads as systemic, not as one bad calendar");
assert(
  !/systemic/i.test(formatSyncFailureAlert([goneAgent], 97, NOW_MS)),
  "a single-agent failure does not claim a systemic problem",
);
// A broad transient outage IS actionable (check Google, the credential path, the
// last deploy), so it must not inherit the lone-agent "nothing to do" framing.
assert(
  !/no action needed/i.test(broadMsg),
  "a systemic failure never says no action is needed",
);
assert(/google/i.test(broadMsg), "a systemic transient failure points at Google as the thing to check");
// A mixed list's instruction must say WHICH accounts need the re-auth, since only
// the ones marked gone do.
assert(
  /marked gone/i.test(mixedMsg),
  "the re-auth instruction names which accounts it applies to",
);

// --- recovery notice: a cleared page says it cleared ---
const recovery = formatSyncRecoveryNotice();
assert(/recover|cleared|resolved|back/i.test(recovery), "the recovery notice says the condition cleared");
assert(/no action/i.test(recovery), "the recovery notice tells the reader there is nothing to do");
assert(!/re-?auth|deactivate/i.test(recovery), "the recovery notice carries no stale remediation");

// --- #1150: the watch lane pages on its own cadence, with its own signals ---
//
// The watch lane runs every ~5 min and only attempts a calendar within 3 days of
// expiry, so a HEALTHY calendar's last renewal is days old by design. That makes
// the #1133 elapsed-since-success signal useless here: every calendar always looks
// "down for days". The watch policy therefore holds a lone transient on the pass
// count alone, sized to the 5-min cadence.
assert(
  WATCH_PAGING.loneTransientHoldMs === null,
  "the watch policy disables the elapsed-time signal, which cannot work at its cadence",
);
assert(
  SYNC_PAGING.loneTransientHoldMs === TRANSIENT_HOLD_MS,
  "the sync policy keeps the elapsed-time signal it was calibrated with",
);
assert(
  SYNC_PAGING.loneTransientPasses === TRANSIENT_HOLD_PASSES,
  "the sync policy keeps its existing pass count, so #1133's behaviour is unchanged",
);

const staleRenewal: FailingAgent = {
  email: "lone@x.com",
  consecutiveFailures: 4,
  // Four days: normal for a healthy watch, and far past any elapsed-time hold.
  lastSuccessAt: new Date(NOW_MS - 4 * 24 * 60 * 60 * 1000).toISOString(),
  error: "watch failed: 503 backendError",
  failureKind: "transient",
};
assert(
  applyBlastRadiusHold([staleRenewal], NOW_MS, WATCH_PAGING).length === 0,
  "a lone transient renewal is held on pass count despite an ancient last-renewal stamp",
);
assert(
  applyBlastRadiusHold(
    [{ ...staleRenewal, consecutiveFailures: WATCH_PAGING.loneTransientPasses }],
    NOW_MS,
    WATCH_PAGING,
  ).length === 1,
  "a lone transient renewal pages once it clears the watch-cadence pass count",
);
// The same agent on the SYNC policy would be released immediately by the ancient
// stamp, which is exactly why the watch lane needs its own policy.
assert(
  applyBlastRadiusHold([{ ...staleRenewal, consecutiveFailures: TRANSIENT_HOLD_PASSES }], NOW_MS, SYNC_PAGING)
    .length === 1,
  "the sync policy releases on elapsed time, the behaviour the watch lane must not inherit",
);
// A gone account is never held on either lane: a revoked account is a human task.
assert(
  applyBlastRadiusHold(
    [{ ...staleRenewal, failureKind: "gone", consecutiveFailures: 2 }],
    NOW_MS,
    WATCH_PAGING,
  ).length === 1,
  "the watch policy never holds a gone account",
);
assert(
  isPageableFailure("transient", WATCH_PAGING.transientPageAt - 1, WATCH_PAGING) === false &&
    isPageableFailure("transient", WATCH_PAGING.transientPageAt, WATCH_PAGING) === true,
  "the watch policy applies its own per-kind transient threshold",
);

// --- #1150: the watch alert describes a DEGRADATION, not an outage ---
const watchMsg = formatWatchLapseAlert([staleRenewal], 97, NOW_MS, WATCH_PAGING);
assert(
  /renew/i.test(watchMsg),
  "the watch alert says what is failing: push-channel renewal, not the sync",
);
assert(
  !/failing to sync/i.test(watchMsg),
  "the watch alert no longer claims the calendar is failing to sync, which it is not",
);
assert(
  /last renewed/i.test(watchMsg),
  "the watch alert labels its timestamp as the last renewal, since days old is normal there",
);
assert(
  !/last ok/i.test(watchMsg),
  "the watch alert avoids 'last ok', which reads as an outage on a days-old stamp",
);
assert(
  /backup cron|back-?up/i.test(watchMsg),
  "the watch alert says availability falls back to the backup cron",
);

finish();
