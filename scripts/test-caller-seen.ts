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
  PARTNER_KEY_MAX_AGE_DAYS,
  judgePartnerKey,
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

finish();
