// Live proof that an approved time off is really blocking (#1478). Run:
//   pnpm verify:ooo-protection                 # sweep the approved future ones
//   OOO_VERIFY_REQUEST_ID=<uuid> pnpm verify:ooo-protection
//
// WHY THIS IS NOT A UNIT TEST, AND NOT A DATABASE QUERY EITHER. Proving that an
// approved time off blocks the agent means asking GOOGLE, because everything
// Slate stores about it was written by the very code under test (L58). #1464 is
// what that costs: a busy block was deleted 31 seconds after it was written, and
// the request went on recording it as "ok (slate fallback)" for weeks, with both
// Slack messages reading as healthy. Anything reading `ooo_requests.side_effects`
// or `busy_blocks` would have agreed with them.
//
// WHY BOTH READS. Google's free/busy alone is not enough: busy periods MERGE, so
// a neighbouring meeting makes an oversized, mistimed, or entirely absent time
// off event read as a perfectly occupied window. So this reads the EVENT ITSELF
// by the id Slate recorded and checks its start and end against the request,
// AND asks free/busy whether the window really reads as occupied. Both, or it
// proves nothing (L1).
//
// The free/busy read is over the agent's PRIMARY calendar only, which is the
// calendar Slate writes the time off event to. Counting another calendar's busy
// time would let something unrelated to this request answer for it, which is the
// exact false pass the event read exists to close.
//
// It talks to LIVE Google and Supabase, so it is deliberately NOT named
// `test-*.ts` (that glob is the offline unit suite). It WRITES NOTHING: no
// calendar, no database, no alert. Its decision logic is pinned offline by
// scripts/test-ooo-protection-live-check.ts.
//
// Needs the Google service-account creds (GOOGLE_SA_CLIENT_EMAIL /
// GOOGLE_SA_PRIVATE_KEY) and the Supabase secret key in .env.local / .dev.vars.
//
// Env overrides:
//   OOO_VERIFY_REQUEST_ID          check one request instead of sweeping
//   OOO_VERIFY_INCLUDE_UNHANDLED   also check the imported rows Slate never ran (#1485)
//   OOO_VERIFY_TOLERANCE_MINUTES   how far an event bound may sit from the record (default 1)
//
// EVERY way of finding nothing to check exits non-zero with its own reason.
// Finding nothing is never a pass (L98).
import { loadEnvFiles } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { freeBusyMany, getEventOnPrimary } = await import("@/lib/google/calendar");
const { GoogleHttpError } = await import("@/lib/google/http-error");
const { reachabilityFromError } = await import("@/lib/google/reachability-classify");
const { shortErrorReason } = await import("@/lib/notify/error-text");
const { selectRequests, judgeRequest, summarize } = await import(
  "./lib/ooo-protection-live-check.ts"
);
type CalendarReading = import("./lib/ooo-protection-live-check.ts").CalendarReading;
type ApprovedRequestRow = import("./lib/ooo-protection-live-check.ts").ApprovedRequestRow;
type Verdict = import("./lib/ooo-protection-live-check.ts").Verdict;

/** Every refusal exits non-zero, and says which refusal it is. */
function fail(code: string, why: string): never {
  console.error(`\nFAILED (${code}): ${why}`);
  process.exit(1);
}

const requestedId = process.env.OOO_VERIFY_REQUEST_ID || process.argv[2] || null;
const includeUnhandled = process.env.OOO_VERIFY_INCLUDE_UNHANDLED === "1";
const toleranceMs = Number(process.env.OOO_VERIFY_TOLERANCE_MINUTES ?? "1") * 60_000;
const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();

const db = supabaseAdmin();

// The status filter is deliberately left OFF when one request was named, so a
// request that is pending or cancelled is refused BY ITS OWN STATUS rather than
// coming back as "no such row", which would send the reader hunting for a typo.
const columns = "id, status, user_id, starts_at, ends_at, display_tz_id, agent_event_id, side_effects";
// cap-safe: approved time off whose window has not ended, tens of rows against a
// roster of ~200 agents. A named request is a primary-key lookup.
const { data, error } = requestedId
  ? await db.from("ooo_requests").select(columns).eq("id", requestedId)
  : await db
      .from("ooo_requests")
      .select(columns)
      .eq("status", "approved")
      .gte("ends_at", nowIso)
      .order("starts_at", { ascending: true });
if (error) {
  fail("requests-unreadable", `could not read ooo_requests: ${error.message}`);
}

type RawRow = {
  id: string;
  status: string;
  user_id: string;
  starts_at: string;
  ends_at: string;
  display_tz_id: string;
  agent_event_id: string | null;
  side_effects: Record<string, string> | null;
};
const raw = (data ?? []) as RawRow[];

const userIds = [...new Set(raw.map((r) => r.user_id))];
const users = new Map<string, { email: string; name: string | null }>();
if (userIds.length > 0) {
  const { data: userRows, error: userErr } = await db
    .from("users")
    // cap-safe: primary-key lookup of the few agents on those requests.
    .select("id, email, name")
    .in("id", userIds);
  if (userErr) {
    fail("users-unreadable", `could not read the agents on those requests: ${userErr.message}`);
  }
  for (const u of (userRows ?? []) as { id: string; email: string; name: string | null }[]) {
    users.set(u.id, { email: u.email, name: u.name });
  }
}

const rows: ApprovedRequestRow[] = raw.map((r) => ({
  id: r.id,
  status: r.status,
  userId: r.user_id,
  agentEmail: users.get(r.user_id)?.email ?? null,
  agentName: users.get(r.user_id)?.name ?? null,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  displayTzId: r.display_tz_id,
  agentEventId: r.agent_event_id,
  busyBlockEffect: r.side_effects?.busy_block ?? null,
  agentEventEffect: r.side_effects?.agent_event ?? null,
}));

const selection = selectRequests(rows, { nowMs, requestedId, includeUnhandled });
if (!selection.ok) fail(selection.code, selection.why);

console.log(
  requestedId
    ? `Checking time off request ${requestedId} against Google, read only.`
    : `Checking ${selection.requests.length} approved future time off request(s) against Google, read only.`,
);
if (selection.skippedUnhandled > 0) {
  // Never silent: an exclusion nobody can see is how a check ends up reporting
  // on almost nothing while reading as a full sweep (L129).
  console.log(
    `  ${selection.skippedUnhandled} imported request(s) excluded, because Slate never ran a step ` +
      "for them (#1485). OOO_VERIFY_INCLUDE_UNHANDLED=1 checks them here too.",
  );
}
console.log("");

/**
 * A Google failure, classified through the SAME classifier the sync health path
 * uses (#1396), so this command cannot invent a fourth vocabulary. Three
 * outcomes, because an account that has never been given Calendar needs a
 * Workspace admin rather than a credential repair, and a transient blip needs
 * only a re-run.
 */
function classifyFailure(err: unknown): CalendarReading {
  const kind = reachabilityFromError(err);
  const detail =
    err instanceof GoogleHttpError && err.reason
      ? `${err.status} ${err.reason}`
      : shortErrorReason(err, { fallback: "no detail" });
  if (kind === "not-provisioned") return { kind: "not-provisioned", detail };
  if (kind === "gone") return { kind: "refused", detail };
  return { kind: "unreadable", detail };
}

/**
 * One request's live reading.
 *
 * Free/busy runs FIRST on purpose. It is the read that proves the calendar can
 * be reached at all, and `events.get` answers 404 both for an event that is gone
 * and for a calendar that cannot be found: asking it first would report an
 * unreachable calendar as a deleted event, which is a different failure with a
 * different repair.
 */
async function readCalendar(request: ApprovedRequestRow): Promise<CalendarReading> {
  const email = request.agentEmail;
  if (!email) return { kind: "no-agent" };

  let busy: { start: string; end: string }[];
  try {
    const res = await freeBusyMany(email, request.startsAt, request.endsAt, [email]);
    const entry = res.get(email);
    if (!entry) {
      return { kind: "refused", detail: "Google returned no answer for this calendar at all" };
    }
    if (entry.error) {
      return { kind: "refused", detail: "Google reported an error for this calendar" };
    }
    busy = entry.busy;
  } catch (err) {
    return classifyFailure(err);
  }

  if (!request.agentEventId) return { kind: "read", event: { state: "not-recorded" }, busy };
  try {
    const event = await getEventOnPrimary(email, request.agentEventId);
    return {
      kind: "read",
      event: event === null ? { state: "gone" } : { state: "found", event },
      busy,
    };
  } catch (err) {
    return classifyFailure(err);
  }
}

const verdicts: Verdict[] = [];
for (const request of selection.requests) {
  const reading = await readCalendar(request);
  const verdict = judgeRequest(request, reading, { toleranceMs, nowMs });
  const who = request.agentName?.trim() || request.agentEmail || request.userId;
  console.log(`${verdict.ok ? "VERIFIED" : "FAILED  "} ${who}  ${request.startsAt} to ${request.endsAt}`);
  console.log(`         ${request.id}  ${verdict.code}: ${verdict.detail}`);
  verdicts.push(verdict);
}

const summary = summarize(verdicts);
console.log(
  `\n${summary.verified} verified, ${summary.failed} failed, out of ${verdicts.length} checked.`,
);
if (!summary.ok) {
  fail(
    "protection-not-proved",
    `${summary.failed} approved time off window(s) could not be proved to be blocking. ` +
      "Each line above says what Google actually reported.",
  );
}
console.log(
  "\nPASSED: every checked time off has a matching event on the agent's own calendar, and " +
    "Google's own free/busy reports its window as occupied.",
);
