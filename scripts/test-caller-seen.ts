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

  // #2868 reverses the 2026-09-25 acceptance: a call that names no host is also what
  // one hand run curl or script with the partner's key produces, so it is written by
  // us as easily as by the partner (L58) and can never prove their deployment. It is
  // REPORTED as seen, with its age, in a sentence of its own, and never as proof.
  const server = judgePartnerKey("trypennie", [row("unstated", DAY), row("localhost", 60_000, "http://localhost:3000")], NOW, MAX);
  eq(server.status, "no-host-named", "a recent call that named no host does NOT prove the deployment");
  eq(server.via, null, "and names no passing sighting");
  assert(/named no host/.test(server.detail) && /1 day ago/.test(server.detail), `the sentence still reports it as seen, with its age (got: ${server.detail})`);
  assert(/does not prove/.test(server.detail), `and says it is not proof (got: ${server.detail})`);
  assert(/localhost:3000/.test(server.detail), `and still names the other hosts it was seen from (got: ${server.detail})`);

  const staleServer = judgePartnerKey("trypennie", [row("unstated", MAX + DAY)], NOW, MAX);
  eq(staleServer.status, "no-host-named", "an old call that named no host is the same finding, not a stale pass");
  assert(/8 days ago/.test(staleServer.detail), `and carries its own age (got: ${staleServer.detail})`);

  // The same call beside a stale production sighting: the production one is what
  // could have proven it, so the verdict is stale and the sentence names it.
  const staleProdNewServer = judgePartnerKey(
    "trypennie",
    [row("production", MAX + DAY, "https://trypennie.com"), row("unstated", 60_000)],
    NOW,
    MAX,
  );
  eq(staleProdNewServer.status, "stale", "a fresh no host call never rescues a stale production sighting");

  const details = new Set([never.detail, local.detail, preview.detail, server.detail, staleProdNewServer.detail]);
  eq(details.size, 5, "each way of not being proven reads differently");

  const prod = judgePartnerKey("trypennie", [row("production", 2 * DAY, "https://trypennie.com"), row("localhost", 60_000)], NOW, MAX);
  eq(prod.status, "proven", "seen from production inside the window is proven, whatever else it was seen from");
  eq(prod.via, "production", "and says it passed on the production host");
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

// --- #2865: rows the retired shared key left behind prove nothing -------------------
//
// The shared caller is gone, but its rows (and the canary lanes marker) stay in the
// table. A leftover row must neither prove trypennie nor change what is said about it.
{
  const leftover = (host_kind: CallerSeenRow["host_kind"], agoMs: number, origin: string | null = null): CallerSeenRow => ({
    ...row(host_kind, agoMs, origin),
    caller: "shared",
  });
  const alone = judgePartnerKey("trypennie", [], NOW, MAX);
  const withLeftovers = judgePartnerKey(
    "trypennie",
    [leftover("production", DAY, "https://www.trypennie.com"), leftover("unstated", 60_000), { ...leftover("unstated", 60_000), caller: "canary-lanes" }],
    NOW,
    MAX,
  );
  eq(withLeftovers.status, "never-seen", "a leftover shared row from trypennie's own site does not prove trypennie");
  eq(withLeftovers.detail, alone.detail, "and says exactly what no rows at all would say");
  // Positive control: the same rows under trypennie's own name DO prove it, so the
  // equality above is the retired caller being ignored, not the judge being deaf (L1).
  const own = judgePartnerKey("trypennie", [row("production", DAY, "https://www.trypennie.com")], NOW, MAX);
  eq(own.status, "proven", "the same sighting under trypennie's own key proves it");
}

finish();
