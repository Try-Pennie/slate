// Which host each booking API caller has authenticated from, and when (#2717). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-caller-seen.ts
//
// trypennie's confirmed page reads every Slate booking with its own key. If that key
// is missing from their production environment every pilot booking ends on their not
// found page, and before this the only way to know was to ask. Slate already knew
// which caller each authenticated request came from; this pins the record of it:
// where the request said it came from, the once an hour write that keeps it off the
// hot path, a failed write that must not silence the next hour, and the verdict the
// readiness gate and the admin console both read.
import { readFileSync } from "node:fs";
import {
  CALLER_HOST_KINDS,
  CALLER_SEEN_REFRESH_MS,
  CANARY_LANES_CALLER,
  CANARY_SWITCH_GRACE_MS,
  PARTNER_KEY_MAX_AGE_DAYS,
  canaryMovedAtMs,
  judgePartnerKey,
  judgeSharedKeyExposure,
  makeCallerSeenRecorder,
  requestHost,
  type CallerSeenRow,
  type CallerSeenWrite,
} from "../src/lib/booking/caller-seen.ts";
import { assert, eq, finish } from "./lib/harness.ts";

function headers(h: Record<string, string>): Headers {
  return new Headers(h);
}

// --- where a request says it came from -------------------------------------------
{
  eq(requestHost(headers({ origin: "https://trypennie.com" })), { kind: "production", origin: "https://trypennie.com" }, "the apex site is production");
  eq(requestHost(headers({ origin: "https://www.trypennie.com" })).kind, "production", "and so is www");
  eq(
    requestHost(headers({ referer: "https://www.trypennie.com/booking/confirmed?id=abc" })),
    { kind: "production", origin: "https://www.trypennie.com" },
    "a referrer is reduced to its origin, so the path and query (a booking id) are never stored",
  );
  eq(requestHost(headers({ origin: "http://localhost:3000" })).kind, "localhost", "a local dev server is localhost");
  eq(requestHost(headers({ origin: "http://127.0.0.1:3000" })).kind, "localhost", "so is the loopback address");
  eq(requestHost(headers({ origin: "http://[::1]:3000" })).kind, "localhost", "and the IPv6 loopback");
  eq(requestHost(headers({ referer: "http://192.168.1.20:3000/x" })).kind, "localhost", "and a private network address");
  eq(
    requestHost(headers({ origin: "https://trypennie-git-feature-pennie.vercel.app" })),
    { kind: "other-host", origin: "https://trypennie-git-feature-pennie.vercel.app" },
    "a preview deployment is another host, and keeps its origin so a person can see which",
  );
  eq(requestHost(headers({ origin: "http://trypennie.com" })).kind, "other-host", "plain http is not the production site");
  eq(requestHost(headers({})), { kind: "unstated", origin: null }, "a server call with neither header states no host");
  eq(requestHost(headers({ origin: "null" })), { kind: "other-host", origin: null }, "an unreadable origin is something stated, never production, and is not stored");
  eq(
    requestHost(headers({ origin: "http://localhost:3000", referer: "https://trypennie.com/x" })).kind,
    "localhost",
    "the Origin header wins over the referrer when both are sent",
  );
}

// --- the stored vocabulary matches the migration's CHECK --------------------------
{
  const sql = readFileSync(new URL("../supabase/migrations/0140_api_caller_seen.sql", import.meta.url), "utf8");
  const m = sql.match(/host_kind\s+in\s*\(([^)]*)\)/i);
  assert(m !== null, "the migration constrains host_kind");
  const inSql = (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean);
  eq([...inSql].sort(), [...CALLER_HOST_KINDS].sort(), "the CHECK lists exactly the kinds the code writes");
}

// --- #2822: first_seen_at is stamped by the database on insert, and only then ------
{
  const sql = readFileSync(new URL("../supabase/migrations/0146_api_caller_seen_first_seen.sql", import.meta.url), "utf8");
  assert(/add column\s+first_seen_at\s+timestamptz\s+not null\s+default\s+now\(\)/i.test(sql), "the migration adds first_seen_at, filled by the database on insert");
  assert(/update\s+api_caller_seen\s+set\s+first_seen_at\s*=\s*last_seen_at/i.test(sql), "and backdates existing rows to their last sighting rather than to the migration");
}

// --- the recorder writes once an hour, not once a request ------------------------
const HOUR = CALLER_SEEN_REFRESH_MS;
eq(HOUR, 60 * 60_000, "the refresh interval is one hour");
{
  const writes: CallerSeenWrite[] = [];
  const deferred: (() => Promise<unknown>)[] = [];
  let now = Date.parse("2026-09-25T12:00:00Z");
  const record = makeCallerSeenRecorder({
    write: async (w) => {
      writes.push(w);
    },
    defer: (work) => deferred.push(work),
    now: () => now,
  });
  const prod = headers({ referer: "https://trypennie.com/booking/confirmed" });

  record("trypennie", "GET", prod);
  eq(deferred.length, 1, "the first success is written");
  eq(writes.length, 0, "and the write is deferred, never done on the response path");
  await Promise.all(deferred.splice(0).map((w) => w()));
  eq(writes.length, 1, "the deferred work does the write");
  eq(writes[0], { caller: "trypennie", host_kind: "production", last_seen_at: "2026-09-25T12:00:00.000Z", method: "GET", origin: "https://trypennie.com" }, "with the caller, host, time, method and origin");
  // #2822: first_seen_at is the database's default on INSERT and must never be sent,
  // or every hourly refresh would move "when this caller first appeared" to now.
  assert(!("first_seen_at" in writes[0]), "the write never carries first_seen_at, so a refresh cannot move it");

  for (let i = 0; i < 50; i++) {
    now += 60_000 - 1; // just under a minute apart, 50 times: still inside the hour
    record("trypennie", "GET", prod);
  }
  eq(deferred.length, 0, "fifty more requests inside the hour write nothing");

  record("trypennie", "GET", headers({ origin: "http://localhost:3000" }));
  eq(deferred.length, 1, "a request from a DIFFERENT host is written at once, or production would hide a localhost test and the reverse");
  record("regal", "DELETE", headers({}));
  eq(deferred.length, 2, "and so is a different caller");
  await Promise.all(deferred.splice(0).map((w) => w()));

  now = Date.parse("2026-09-25T13:00:00Z");
  record("trypennie", "GET", prod);
  eq(deferred.length, 1, "an hour after the last write, the next success refreshes the row");
}

// --- a failed write is logged by the caller's defer, and does not silence the hour -----
{
  let fail = true;
  const writes: CallerSeenWrite[] = [];
  const deferred: (() => Promise<unknown>)[] = [];
  const now = Date.parse("2026-09-25T12:00:00Z");
  const record = makeCallerSeenRecorder({
    write: async (w) => {
      if (fail) throw new Error("relation api_caller_seen does not exist");
      writes.push(w);
    },
    defer: (work) => deferred.push(work),
    now: () => now,
  });
  const prod = headers({ origin: "https://trypennie.com" });
  record("trypennie", "POST", prod);
  let threw: unknown = null;
  try {
    await deferred.shift()!();
  } catch (err) {
    threw = err;
  }
  assert(
    threw instanceof Error && /api_caller_seen/.test(threw.message),
    "a failed write REJECTS the deferred work, so afterResponse logs it rather than it vanishing",
  );
  fail = false;
  record("trypennie", "POST", prod);
  eq(deferred.length, 1, "the next success retries at once rather than waiting out an hour nothing was written in");
  await deferred.shift()!();
  eq(writes.length, 1, "and that retry lands");
}

// --- nothing the recorder does can reach the request ------------------------------
{
  const record = makeCallerSeenRecorder({
    write: async () => undefined,
    defer: () => {
      throw new Error("no request scope");
    },
    now: () => 0,
  });
  let escaped = false;
  try {
    record("trypennie", "GET", headers({}));
  } catch {
    escaped = true;
  }
  assert(!escaped, "a scheduler that throws never reaches the booking request");
}

// --- the verdict the readiness gate and the admin console both read ------------------
const NOW = Date.parse("2026-09-25T16:00:00Z");
const DAY = 24 * 60 * 60_000;
const MAX = PARTNER_KEY_MAX_AGE_DAYS * DAY;
function row(host_kind: CallerSeenRow["host_kind"], agoMs: number, origin: string | null = null): CallerSeenRow {
  return { caller: "trypennie", host_kind, last_seen_at: new Date(NOW - agoMs).toISOString(), method: "GET", origin };
}
{
  const never = judgePartnerKey("trypennie", [], NOW, MAX);
  eq(never.status, "never-seen", "no row at all is never seen");
  assert(/never/i.test(never.detail) && /trypennie/.test(never.detail), `and says so, naming the caller (got: ${never.detail})`);

  const local = judgePartnerKey("trypennie", [row("localhost", DAY, "http://localhost:3000")], NOW, MAX);
  eq(local.status, "not-from-production", "seen only from localhost is not production");
  assert(/localhost:3000/.test(local.detail), `and names the host it was seen from (got: ${local.detail})`);

  const preview = judgePartnerKey("trypennie", [row("other-host", DAY, "https://x.vercel.app")], NOW, MAX);
  eq(preview.status, "not-from-production", "seen only from a preview host is not production");
  assert(/x\.vercel\.app/.test(preview.detail), `and names that host (got: ${preview.detail})`);

  // Dan, 2026-09-25: trypennie's lookup is a server call that names no host, so a
  // recent one PASSES, and the sentence says it passed on that and not on a page.
  const server = judgePartnerKey("trypennie", [row("unstated", DAY), row("localhost", 60_000, "http://localhost:3000")], NOW, MAX);
  eq(server.status, "proven", "a recent server call that named no host passes");
  eq(server.via, "server-call", "and says it passed on the server call");
  assert(/server call that named no host/.test(server.detail), `in its sentence too (got: ${server.detail})`);

  const staleServer = judgePartnerKey("trypennie", [row("unstated", MAX + DAY)], NOW, MAX);
  eq(staleServer.status, "stale", "a server call older than the window is stale, not a pass");
  assert(/server call/.test(staleServer.detail) && /outside the/.test(staleServer.detail), `and says so (got: ${staleServer.detail})`);

  const details = new Set([never.detail, local.detail, preview.detail, staleServer.detail]);
  eq(details.size, 4, "each way of not being proven reads differently");

  const prod = judgePartnerKey("trypennie", [row("production", 2 * DAY, "https://trypennie.com"), row("localhost", 60_000)], NOW, MAX);
  eq(prod.status, "proven", "seen from production inside the window is proven, whatever else it was seen from");
  eq(prod.via, "production", "and a production host is preferred over a server call when both are recent");
  const both = judgePartnerKey("trypennie", [row("unstated", 60_000), row("production", DAY, "https://trypennie.com")], NOW, MAX);
  eq(both.via, "production", "even when the server call is the newer of the two");
  assert(/production site/.test(both.detail), `and the sentence names the production site (got: ${both.detail})`);

  const stale = judgePartnerKey("trypennie", [row("production", MAX + DAY, "https://trypennie.com")], NOW, MAX);
  eq(stale.status, "stale", "seen from production, but not inside the window, is stale");
  assert(new RegExp(`${PARTNER_KEY_MAX_AGE_DAYS} day`).test(stale.detail), `and names the bound (got: ${stale.detail})`);
  assert(stale.detail !== never.detail && stale.detail !== local.detail, "and reads differently from never seen");

  const junk = judgePartnerKey("trypennie", [{ ...row("production", DAY), last_seen_at: "not a time" }], NOW, MAX);
  assert(junk.status !== "proven", "an unreadable stamp never proves anything (L50)");

  const other = judgePartnerKey("trypennie", [{ ...row("production", DAY), caller: "regal" }], NOW, MAX);
  eq(other.status, "never-seen", "another caller's row never answers for this one");
}

// --- #2819: trypennie on the SHARED key ------------------------------------------------
//
// With no trypennie row, "not deployed yet" and "deployed holding BOOKING_API_KEY
// instead of its own" used to read the same. The canary also holds the shared key and
// calls it from a server that names no host, so only a sighting that names a trypennie
// production origin is evidence about trypennie; a server call on it is not.
function shared(host_kind: CallerSeenRow["host_kind"], agoMs: number, origin: string | null = null): CallerSeenRow {
  return { ...row(host_kind, agoMs, origin), caller: "shared" };
}
{
  const onShared = judgePartnerKey("trypennie", [shared("production", DAY, "https://www.trypennie.com"), shared("unstated", 60_000)], NOW, MAX);
  eq(onShared.status, "on-shared-key", "a production origin on the shared key, with no trypennie row, is its own outcome");
  assert(/shared key/.test(onShared.detail) && /www\.trypennie\.com/.test(onShared.detail), `and names the key and the origin (got: ${onShared.detail})`);
  assert(/may hold the shared key instead of its own/.test(onShared.detail), `and says what it suggests (got: ${onShared.detail})`);
  assert(/never authenticated/.test(onShared.detail), `and still says trypennie's own key has not (got: ${onShared.detail})`);

  // The canary alone: server calls on the shared key, no origin. Must NOT be read as
  // trypennie, and must say it cannot tell rather than claiming nothing is arriving.
  const canaryOnly = judgePartnerKey("trypennie", [shared("unstated", 60_000)], NOW, MAX);
  eq(canaryOnly.status, "never-seen", "canary server calls on the shared key are not trypennie");
  assert(!/may hold the shared key/.test(canaryOnly.detail), `and are not reported as trypennie on the shared key (got: ${canaryOnly.detail})`);
  assert(/canary/.test(canaryOnly.detail), `and say a server call there cannot be told from the canary's (got: ${canaryOnly.detail})`);

  // Nothing on either key: plain "not yet", in words distinct from the canary case.
  const nothing = judgePartnerKey("trypennie", [], NOW, MAX);
  assert(/nothing has authenticated on the shared key/.test(nothing.detail), `nothing on the shared key either says so (got: ${nothing.detail})`);
  assert(nothing.detail !== canaryOnly.detail, "and reads differently from the canary only case");

  // Localhost or a preview on the shared key names no trypennie production site.
  const sharedLocal = judgePartnerKey("trypennie", [shared("localhost", DAY, "http://localhost:3000"), shared("other-host", DAY, "https://x.vercel.app")], NOW, MAX);
  eq(sharedLocal.status, "never-seen", "a localhost or preview host on the shared key is not a trypennie production sighting");

  const oldShared = judgePartnerKey("trypennie", [shared("production", MAX + DAY, "https://trypennie.com")], NOW, MAX);
  eq(oldShared.status, "never-seen", "a production sighting on the shared key outside the window is not evidence of today");

  // trypennie's own key tested locally, then deployed on the shared key.
  const localThenShared = judgePartnerKey("trypennie", [row("localhost", DAY, "http://localhost:3000"), shared("production", DAY, "https://trypennie.com")], NOW, MAX);
  eq(localThenShared.status, "on-shared-key", "its own key only on localhost plus the shared key from production is the shared key outcome");
  assert(/localhost:3000/.test(localThenShared.detail), `and still names where its own key was seen (got: ${localThenShared.detail})`);

  const provenAnyway = judgePartnerKey("trypennie", [row("unstated", DAY), shared("production", DAY, "https://trypennie.com")], NOW, MAX);
  eq(provenAnyway.status, "proven", "its own key proven wins over any shared key sighting");

  const selfJudged = judgePartnerKey("shared", [shared("production", DAY, "https://trypennie.com")], NOW, MAX);
  eq(selfJudged.status, "proven", "judging the shared caller itself never reports it as on the shared key");
}

// --- #2822: the canary on its OWN key, so a shared sighting is a partner's ------------
//
// The canary used to hold the shared key, so a shared server call could be the canary.
// The move is when the SCHEDULED LANES first stamped a heartbeat on the canary's own key
// (`canary-lanes`, written only by /api/smoke/heartbeat), never when anything first
// authenticated as `canary`: a hand run smoke on the canary key before the lanes switch
// would otherwise set a move that has not happened, and read the lanes' own shared calls
// as a partner's. A shared row last written before the move (plus a grace for a run in
// flight) is the canary's own history.
function canary(host_kind: CallerSeenRow["host_kind"], agoMs: number, firstAgoMs: number): CallerSeenRow {
  return { ...row(host_kind, agoMs), caller: CANARY_LANES_CALLER, first_seen_at: new Date(NOW - firstAgoMs).toISOString() };
}
/** A plain `canary` sighting, as a hand run or a booking on the canary key leaves. */
function canaryHandRun(agoMs: number, firstAgoMs: number): CallerSeenRow {
  return { ...row("unstated", agoMs), caller: "canary", method: "POST", first_seen_at: new Date(NOW - firstAgoMs).toISOString() };
}
function regal(agoMs: number): CallerSeenRow {
  return { ...row("unstated", agoMs), caller: "regal", method: "POST" };
}
{
  eq(CANARY_SWITCH_GRACE_MS, CALLER_SEEN_REFRESH_MS, "the grace after the move is one refresh interval");
  eq(canaryMovedAtMs([]), null, "no canary row: the canary has not moved");
  eq(
    canaryMovedAtMs([canary("unstated", 60_000, 3 * DAY), canary("production", 60_000, 5 * DAY)]),
    NOW - 5 * DAY,
    "the move is the EARLIEST first sighting across its rows",
  );
  eq(canaryMovedAtMs([{ ...canary("unstated", 60_000, DAY), first_seen_at: null }]), null, "an unreadable first sighting is not a move, so the verdict hedges rather than accuses");
  eq(canaryMovedAtMs([{ ...canary("unstated", 60_000, DAY), first_seen_at: "garbage" }]), null, "and neither is garbage");
  eq(canaryMovedAtMs([{ ...shared("unstated", 60_000), first_seen_at: new Date(NOW - DAY).toISOString() }]), null, "another caller's first sighting is never the canary's");
  eq(canaryMovedAtMs([canaryHandRun(60_000, 5 * DAY)]), null, "a plain canary sighting (a hand run, a booking) is NOT the lanes moving");
  eq(
    canaryMovedAtMs([canaryHandRun(60_000, 5 * DAY), canary("unstated", 60_000, 2 * DAY)]),
    NOW - 2 * DAY,
    "with both, the move is the lanes' first heartbeat, not the earlier hand run",
  );

  // The review's case (#2855): somebody smoke tested the canary key by hand five days
  // ago, before the lanes switched, and the lanes are STILL calling on the shared key.
  // That must hedge about the canary, never accuse a partner.
  const handRunOnly = judgePartnerKey("trypennie", [canaryHandRun(5 * DAY, 5 * DAY), regal(DAY), shared("unstated", 60 * 60_000)], NOW, MAX);
  eq(handRunOnly.status, "never-seen", "a hand run on the canary key before the lanes move does not turn the lanes' shared calls into a partner's");
  assert(/cannot be told apart from the canary/.test(handRunOnly.detail), `and hedges about the canary (got: ${handRunOnly.detail})`);
  // And once the lanes did move, a shared call from BEFORE their first heartbeat but
  // after the hand run is still the lanes' own.
  const betweenRunAndMove = judgePartnerKey(
    "trypennie",
    [canaryHandRun(5 * DAY, 5 * DAY), canary("unstated", 60_000, 2 * DAY), regal(DAY), shared("unstated", 3 * DAY)],
    NOW,
    MAX,
  );
  eq(betweenRunAndMove.status, "never-seen", "a shared call between the hand run and the lanes' move is the lanes' own");

  // The canary moved three days ago; a server called on the shared key an hour ago.
  // Regal has not been seen on its own key, so either partner could hold it.
  const both = judgePartnerKey("trypennie", [canary("unstated", 60_000, 3 * DAY), shared("unstated", 60 * 60_000)], NOW, MAX);
  eq(both.status, "never-seen", "with two partners off their own keys, the caller is not named as the holder");
  assert(/since the smoke canary moved to its own key/.test(both.detail), `says the canary is no longer on the shared key (got: ${both.detail})`);
  assert(/regal/.test(both.detail) && /trypennie/.test(both.detail), `and names both partners it could be (got: ${both.detail})`);
  assert(!/cannot be told apart/.test(both.detail), `and no longer hedges about the canary (got: ${both.detail})`);

  // Regal seen on its own key: trypennie is the only partner left, so it is named.
  const sole = judgePartnerKey("trypennie", [canary("unstated", 60_000, 3 * DAY), regal(DAY), shared("unstated", 60 * 60_000)], NOW, MAX);
  eq(sole.status, "on-shared-key", "the only partner off its own key, with a partner on the shared key, is on the shared key");
  assert(/only partner not seen on its own key/.test(sole.detail), `and says why it is named, with no heuristic (got: ${sole.detail})`);

  // A regal sighting outside the bound does not clear regal.
  const oldRegal = judgePartnerKey("trypennie", [canary("unstated", 60_000, 3 * DAY), regal(MAX + DAY), shared("unstated", 60 * 60_000)], NOW, MAX);
  eq(oldRegal.status, "never-seen", "a partner last seen on its own key outside the bound is still a suspect");

  // A shared server row last written BEFORE the move is the canary's own history.
  const history = judgePartnerKey("trypennie", [canary("unstated", 60_000, 2 * DAY), shared("unstated", 2 * DAY + 30 * 60_000)], NOW, MAX);
  eq(history.status, "never-seen", "a shared server row from before the move is the canary's, not a partner's");
  assert(/nothing suggests trypennie has deployed/.test(history.detail), `and reads as nothing on the shared key since (got: ${history.detail})`);

  // Inside the grace after the move, still the canary's (a run in flight at the switch).
  const inFlight = judgePartnerKey("trypennie", [canary("unstated", 60_000, 2 * DAY), shared("unstated", 2 * DAY - 30 * 60_000)], NOW, MAX);
  eq(inFlight.status, "never-seen", "a shared call inside the grace after the move is still the canary's");
  assert(/nothing suggests/.test(inFlight.detail), `(got: ${inFlight.detail})`);

  // Before the move the hedge stays, and now says what will end it.
  const before = judgePartnerKey("trypennie", [shared("unstated", 60_000)], NOW, MAX);
  assert(/canary/.test(before.detail) && /own key/.test(before.detail), `before the move the hedge names the canary's own key as the fix (got: ${before.detail})`);

  const sentences = new Set([both.detail, sole.detail, history.detail, before.detail]);
  eq(sentences.size, 4, "each reading of the shared key says something different");

  const proven = judgePartnerKey("trypennie", [row("unstated", DAY), canary("unstated", 60_000, 3 * DAY), shared("unstated", 60_000)], NOW, MAX);
  eq(proven.status, "proven", "its own key proven wins over any shared sighting after the move");
}

// --- #2822: the shared key sent from a BROWSER ------------------------------------------
//
// An Origin or Referer is set by a browser. A shared key sighting carrying a public one
// means the key was in page code any visitor can read: a security finding in its own
// right, whoever sent it and whatever the partner verdict says.
{
  const none = judgeSharedKeyExposure([shared("unstated", 60_000), canary("unstated", 60_000, DAY)], NOW, MAX);
  eq(none.exposed, false, "server calls on the shared key are not an exposure");
  eq(none.detail, null, "and say nothing");

  const prod = judgeSharedKeyExposure([shared("production", DAY, "https://www.trypennie.com")], NOW, MAX);
  eq(prod.exposed, true, "a trypennie production origin on the shared key is an exposure");
  assert(
    /www\.trypennie\.com/.test(prod.detail ?? "") && /browser/.test(prod.detail ?? "") && /rotate/i.test(prod.detail ?? ""),
    `naming the origin, the browser and the repair (got: ${prod.detail})`,
  );

  const preview = judgeSharedKeyExposure([shared("other-host", DAY, "https://x.vercel.app")], NOW, MAX);
  eq(preview.exposed, true, "a preview or other public host on the shared key is an exposure too");
  const opaque = judgeSharedKeyExposure([shared("other-host", DAY, null)], NOW, MAX);
  eq(opaque.exposed, true, "an unreadable origin is still something a browser stated");
  assert(/at an unreadable address \(/.test(opaque.detail ?? ""), `and says the address was unreadable, in plain words (got: ${opaque.detail})`);

  const two = judgeSharedKeyExposure([shared("production", DAY, "https://trypennie.com"), shared("other-host", 2 * DAY, "https://x.vercel.app")], NOW, MAX);
  assert(/trypennie\.com/.test(two.detail ?? "") && /x\.vercel\.app/.test(two.detail ?? ""), `every exposing origin is named (got: ${two.detail})`);

  const local = judgeSharedKeyExposure([shared("localhost", DAY, "http://localhost:3000")], NOW, MAX);
  eq(local.exposed, false, "a developer's own machine is not a page a visitor can load");

  const old = judgeSharedKeyExposure([shared("production", MAX + DAY, "https://trypennie.com")], NOW, MAX);
  eq(old.exposed, false, "a browser sighting outside the bound is not today's exposure");

  const own = judgeSharedKeyExposure([row("production", DAY, "https://trypennie.com")], NOW, MAX);
  eq(own.exposed, false, "a partner's OWN key from its production site is the accepted proof (Dan, 2026-09-25), not this finding");

  const junk = judgeSharedKeyExposure([{ ...shared("production", DAY, "https://trypennie.com"), last_seen_at: "nope" }], NOW, MAX);
  eq(junk.exposed, false, "an unreadable stamp accuses nobody");
}

finish();
