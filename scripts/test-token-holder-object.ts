// The shared Google token holder (#3512): every decision the object makes, driven with an
// injected clock and timer, so nothing here waits for real (L524).
//
// The holder keeps each advisor's delegated calendar token in MEMORY so a confirm on an
// isolate that has never minted for that advisor reads a token in milliseconds instead of
// minting one on the lead's path. It never mints: the app mints as it always has and PUTS
// the token here. What this suite pins:
//
// - a put is held and answered to a get until it is too close to expiry to use;
// - a later expiry wins and an earlier one never replaces it (a late put of an old token);
// - a token inside the refresh window is still served, and exactly ONE reader at a time is
//   told to refresh it, so a crowd of readers mints once rather than once each;
// - a refresh that never lands frees its claim, so the next reader is asked instead;
// - the keep alive timer is armed while anything is held, sweeps what has expired, and is
//   let go once the holder is empty;
// - a malformed message is refused by name and changes nothing.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-token-holder-object.ts
import {
  makeTokenHolderObject,
  TOKEN_HOLDER_PROTOCOL,
  TOKEN_USABLE_MARGIN_MS,
  TOKEN_REFRESH_AHEAD_MS,
  TOKEN_REFRESH_CLAIM_MS,
  TOKEN_HOLDER_KEEPALIVE_MS,
  TOKEN_HOLDER_MAX_HELD,
} from "../src/lib/google/token-holder-object.ts";
import { assert, eq, finish } from "./lib/harness.ts";

interface FakeTimer {
  at: number;
  fire: () => void;
  cleared: boolean;
}

function rig(startMs = 1_000_000) {
  let now = startMs;
  const timers: FakeTimer[] = [];
  const holder = makeTokenHolderObject({
    now: () => now,
    timer: (ms, fire) => {
      const t: FakeTimer = { at: now + ms, fire, cleared: false };
      timers.push(t);
      return () => {
        t.cleared = true;
      };
    },
  });
  const pending = () => timers.filter((t) => !t.cleared);
  return {
    holder,
    advance(ms: number) {
      now += ms;
      // Fire every timer now due, in order, the way the runtime would.
      for (;;) {
        const due = pending()
          .filter((t) => t.at <= now)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.cleared = true;
        due.fire();
      }
    },
    now: () => now,
    pending,
    get: (key: string) => holder.handle({ v: TOKEN_HOLDER_PROTOCOL, op: "get", key }),
    put: (key: string, token: string, expMs: number) => holder.handle({ v: TOKEN_HOLDER_PROTOCOL, op: "put", key, token, expMs }),
  };
}

const HOUR = 3_600_000;
const K = "calendar-scopes\nadvisor@trypennie.com";

// --- held, served, and refused once it is too close to expiry -----------------------
{
  const r = rig();
  eq(r.get(K), { kind: "miss" }, "an empty holder answers a miss");
  eq(r.put(K, "tok-1", r.now() + HOUR), { kind: "stored" }, "a fresh token is stored");
  eq(r.get(K), { kind: "hit", token: "tok-1", expMs: r.now() + HOUR, refresh: false }, "and served, with no refresh asked while it is young");
  eq(r.get("calendar-scopes\nsomebody-else@trypennie.com"), { kind: "miss" }, "another advisor's key is its own");

  r.advance(HOUR - TOKEN_USABLE_MARGIN_MS);
  eq(r.get(K), { kind: "miss" }, "a token with no more than the usable margin left is never served");
  eq(r.holder.size(), 0, "and is dropped as it is refused");
}

// --- the later expiry wins ------------------------------------------------------------
{
  const r = rig();
  r.put(K, "new", r.now() + HOUR);
  eq(r.put(K, "old", r.now() + HOUR - 5 * 60_000), { kind: "kept" }, "a put of an older token is refused");
  eq(r.put(K, "same-exp", r.now() + HOUR), { kind: "kept" }, "and so is one expiring at the same instant");
  eq((r.get(K) as { token?: string }).token, "new", "the newer token is the one still served");
  eq(r.put(K, "newer", r.now() + HOUR + 1), { kind: "stored" }, "a later expiry replaces it");
  eq((r.get(K) as { token?: string }).token, "newer", "and is served from then on");
  eq(r.put(K, "dead", r.now() + TOKEN_USABLE_MARGIN_MS), { kind: "kept" }, "a token that is already unusable is never stored");
  eq(r.put("calendar-scopes\nother@trypennie.com", "dead", r.now() - 1), { kind: "kept" }, "nor is an expired one, even for an empty key");
  eq(r.get("calendar-scopes\nother@trypennie.com"), { kind: "miss" }, "so that key still misses");
}

// --- the refresh window: served, and ONE reader at a time is asked to refresh ---------
{
  const r = rig();
  const exp = r.now() + HOUR;
  r.put(K, "tok", exp);
  r.advance(HOUR - TOKEN_REFRESH_AHEAD_MS + 1);
  const first = r.get(K);
  eq(first, { kind: "hit", token: "tok", expMs: exp, refresh: true }, "inside the refresh window the token is still served, and the first reader is asked to refresh it");
  // Concurrent readers while that refresh is in flight: none of them is asked again.
  const crowd = Array.from({ length: 25 }, () => r.get(K) as { kind: string; refresh?: boolean; token?: string });
  assert(crowd.every((a) => a.kind === "hit" && a.token === "tok" && a.refresh === false), "every concurrent reader during the refresh is served the token and NOT asked to refresh");

  // The refresh lands: the claim goes with the old entry.
  r.advance(1_000);
  eq(r.put(K, "tok-2", r.now() + HOUR), { kind: "stored" }, "the refreshed token is stored");
  eq(r.get(K), { kind: "hit", token: "tok-2", expMs: r.now() + HOUR, refresh: false }, "and served young, with nobody asked to refresh");
}

// --- a refresh that fails frees its claim for the next reader -------------------------
{
  const r = rig();
  const exp = r.now() + HOUR;
  r.put(K, "tok", exp);
  r.advance(HOUR - TOKEN_REFRESH_AHEAD_MS + 1);
  eq((r.get(K) as { refresh?: boolean }).refresh, true, "the first reader is asked to refresh");
  r.advance(TOKEN_REFRESH_CLAIM_MS - 1);
  eq((r.get(K) as { refresh?: boolean }).refresh, false, "while its claim stands nobody else is asked");
  r.advance(1);
  eq((r.get(K) as { refresh?: boolean }).refresh, true, "once the claim lapses with no new token, the next reader is asked");
  // Refreshes that keep failing all the way down: the old token is served until it is
  // unusable, and then it is a plain miss, which the caller answers by minting itself.
  r.advance(exp - TOKEN_USABLE_MARGIN_MS - r.now());
  eq(r.get(K), { kind: "miss" }, "a token whose refreshes all failed is a miss once it is unusable, never served late");
}

// --- the keep alive timer ---------------------------------------------------------------
{
  const r = rig();
  eq(r.pending().length, 0, "an empty holder arms no timer, so it can be let go");
  r.put(K, "a", r.now() + HOUR);
  r.put("calendar-scopes\nb@trypennie.com", "b", r.now() + 20 * 60_000);
  eq(r.pending().length, 1, "holding anything arms ONE timer (a pending timer is what keeps the memory alive)");
  assert(TOKEN_HOLDER_KEEPALIVE_MS < 15 * 60_000, "and it fires inside the 15 minutes a pending timer holds an object in memory");
  r.advance(TOKEN_HOLDER_KEEPALIVE_MS);
  eq(r.pending().length, 1, "it re-arms while tokens are still held");
  r.advance(TOKEN_HOLDER_KEEPALIVE_MS * 3);
  eq(r.holder.size(), 1, "the sweep dropped the token that had expired");
  r.advance(HOUR);
  eq(r.holder.size(), 0, "and the last one once it had too");
  eq(r.pending().length, 0, "an emptied holder lets its timer go");
  r.put(K, "c", r.now() + HOUR);
  eq(r.pending().length, 1, "and arms it again on the next put");
}

// --- a bounded memory ------------------------------------------------------------------
{
  const r = rig();
  for (let i = 0; i < TOKEN_HOLDER_MAX_HELD + 10; i++) r.put(`k${i}`, `t${i}`, r.now() + HOUR + i);
  eq(r.holder.size(), TOKEN_HOLDER_MAX_HELD, "it never holds more than its ceiling");
  eq(r.get("k0"), { kind: "miss" }, "the soonest to expire made room");
  eq((r.get(`k${TOKEN_HOLDER_MAX_HELD + 9}`) as { token?: string }).token, `t${TOKEN_HOLDER_MAX_HELD + 9}`, "the newest is held");
}

// --- malformed messages are refused and change nothing ------------------------------------
{
  const r = rig();
  r.put(K, "held-secret", r.now() + HOUR);
  const bad: [string, unknown][] = [
    ["no message", null],
    ["an array", []],
    ["another protocol", { v: TOKEN_HOLDER_PROTOCOL + 1, op: "get", key: K }],
    ["an unknown op", { v: TOKEN_HOLDER_PROTOCOL, op: "delete", key: K }],
    ["no key", { v: TOKEN_HOLDER_PROTOCOL, op: "get" }],
    ["an empty key", { v: TOKEN_HOLDER_PROTOCOL, op: "get", key: "" }],
    ["an oversized key", { v: TOKEN_HOLDER_PROTOCOL, op: "get", key: "x".repeat(1_000) }],
    ["a put with no token", { v: TOKEN_HOLDER_PROTOCOL, op: "put", key: K, expMs: 1 }],
    ["a put whose expiry is not a number", { v: TOKEN_HOLDER_PROTOCOL, op: "put", key: K, token: "t", expMs: "soon" }],
    ["a put whose expiry is not finite", { v: TOKEN_HOLDER_PROTOCOL, op: "put", key: K, token: "t", expMs: Infinity }],
  ];
  for (const [label, message] of bad) {
    const answer = r.holder.handle(message) as { kind: string; reason?: string };
    assert(answer.kind === "bad" && typeof answer.reason === "string" && answer.reason.length > 0, `${label} is refused as bad, with a reason`);
    assert(!JSON.stringify(answer).includes("held-secret"), `${label}: the refusal never echoes a held token`);
  }
  eq((r.get(K) as { token?: string }).token, "held-secret", "and nothing held was changed by any of them");
}

finish();
