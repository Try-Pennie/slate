// A retired booking API key being presented pages, naming where it came from (#2879).
// Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-retired-booking-keys.ts
//
// #2865 retired the shared key, and trypennie's staging project still held it: the
// confirmed page was refused 401 after a real booking and nothing noticed, because
// the caller sightings record only keys that AUTHENTICATE. So Slate keeps a hash of
// each retired key (never the key), and a refused request presenting one is recorded
// and paged once per host kind per cooldown. Both directions are pinned: a retired
// key pages, and an unknown key (a stale guess, a crawler, a typo) never pages as
// retired. So is the arming: a configured value this cannot read refuses loudly
// rather than reading as "nothing is retired".
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  RETIRED_KEY_ALERT_FAMILY,
  RETIRED_KEY_HASHES_ENV,
  RetiredKeyConfigError,
  formatRetiredKeyAlert,
  makeRetiredKeyWatcher,
  matchRetiredKey,
  parseRetiredKeyHashes,
  retiredKeyAlertKey,
  retiredKeyHashLine,
  liveSlotsInRetiredList,
  sha256Hex,
  type RetiredKeyEvent,
} from "../src/lib/booking/retired-keys.ts";
import { CALLER_HOST_KINDS } from "../src/lib/booking/caller-seen.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// Fixture keys are invented here; no real key value appears in this file.
const RETIRED = "retired-fixture-key-0001";
const OTHER_RETIRED = "retired-fixture-key-0002";
const UNKNOWN = "never-issued-fixture-key";
const nodeHash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// --- the hash is the same one a person computes by hand ---------------------------
{
  eq(await sha256Hex(RETIRED), nodeHash(RETIRED), "the hash is a plain SHA-256 of the exact token, hex encoded");
  eq(await sha256Hex(`${RETIRED} `), nodeHash(`${RETIRED} `), "nothing is trimmed, matching the auth path's exact comparison");
  assert((await sha256Hex(RETIRED)) !== (await sha256Hex(`${RETIRED} `)), "so a trailing space is a different key, as it is to the auth path");
}

// --- reading the configured hashes ------------------------------------------------
{
  eq(parseRetiredKeyHashes(""), [], "unset reads as nothing retired");
  eq(parseRetiredKeyHashes("   "), [], "and so does a blank value");
  const h = nodeHash(RETIRED);
  eq(parseRetiredKeyHashes(`shared:${h}`), [{ label: "shared", sha256: h }], "one labelled hash");
  eq(
    parseRetiredKeyHashes(` shared:${h.toUpperCase()} , regal-old:${nodeHash(OTHER_RETIRED)} `),
    [
      { label: "shared", sha256: h },
      { label: "regal-old", sha256: nodeHash(OTHER_RETIRED) },
    ],
    "several, comma separated, case and surrounding space forgiven",
  );

  // Every way the value can be unusable refuses by name, and never echoes it.
  const refusals: [string, string, RegExp][] = [
    ["no label", h, /entry 1/],
    ["short hash", "shared:abc123", /64 hex/],
    ["not hex", `shared:${"z".repeat(64)}`, /64 hex/],
    ["a raw key pasted instead of a hash", `shared:${RETIRED}`, /64 hex/],
    ["an empty entry", `shared:${h},,x:${h}`, /entry 2/],
    ["a bad label", `Shared Key:${h}`, /label/],
    ["a repeated label", `shared:${h},shared:${nodeHash(OTHER_RETIRED)}`, /twice/],
  ];
  for (const [what, raw, why] of refusals) {
    let caught: unknown = null;
    try {
      parseRetiredKeyHashes(raw);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof RetiredKeyConfigError, `${what} refuses with the config error (got ${String(caught)})`);
    const msg = caught instanceof Error ? caught.message : "";
    assert(why.test(msg), `${what}: the refusal says which rule it broke (got: ${msg})`);
    assert(msg.includes(RETIRED_KEY_HASHES_ENV), `${what}: and names the setting (got: ${msg})`);
    assert(!msg.includes(RETIRED) && !msg.includes(h), `${what}: and never echoes the value`);
  }
}

// --- the line `pnpm hash:retired-key` prints is exactly what the parser reads ------
{
  const line = await retiredKeyHashLine("shared", RETIRED);
  eq(line, `shared:${nodeHash(RETIRED)}`, "the arming line is label:hash");
  assert(!line.includes(RETIRED), "and never carries the key");
  eq(parseRetiredKeyHashes(line), [{ label: "shared", sha256: nodeHash(RETIRED) }], "and reads straight back");
  for (const [what, label, key] of [
    ["a blank key", "shared", "   "],
    ["a key already shaped like a hash", "shared", nodeHash(RETIRED)],
    ["a bad label", "Shared", RETIRED],
  ] as const) {
    let refused = false;
    try {
      await retiredKeyHashLine(label, key);
    } catch (err) {
      refused = err instanceof RetiredKeyConfigError;
    }
    assert(refused, `${what} is refused rather than hashed into a line that could never match`);
  }
}

// --- matching a presented token ---------------------------------------------------
{
  const hashes = parseRetiredKeyHashes(`shared:${nodeHash(RETIRED)},regal-old:${nodeHash(OTHER_RETIRED)}`);
  eq((await matchRetiredKey(RETIRED, hashes))?.label, "shared", "a retired key matches its own label");
  eq((await matchRetiredKey(OTHER_RETIRED, hashes))?.label, "regal-old", "and the second one matches its own");
  eq(await matchRetiredKey(UNKNOWN, hashes), null, "an unknown key matches nothing");
  eq(await matchRetiredKey(RETIRED, []), null, "and nothing matches when nothing is retired");
}

// --- the alert key is bounded, and the copy names where and which route -----------
{
  for (const kind of CALLER_HOST_KINDS) {
    eq(retiredKeyAlertKey(kind), `${RETIRED_KEY_ALERT_FAMILY}:${kind}`, `the ${kind} key is one of a fixed set`);
  }
  const prod = formatRetiredKeyAlert({ label: "shared", host: { kind: "production", origin: "https://www.trypennie.com" }, route: "GET /api/bookings" });
  assert(/retired booking key "shared"/.test(prod), `names which retired key (got: ${prod})`);
  assert(/https:\/\/www\.trypennie\.com/.test(prod), `names the origin (got: ${prod})`);
  assert(/GET \/api\/bookings/.test(prod), `names the route (got: ${prod})`);
  assert(/refused/.test(prod), `says it was refused (got: ${prod})`);
  const server = formatRetiredKeyAlert({ label: "shared", host: { kind: "unstated", origin: null }, route: "POST /api/bookings" });
  assert(/named no host/.test(server), `a call naming no host says so (got: ${server})`);
  const unreadable = formatRetiredKeyAlert({ label: "shared", host: { kind: "other-host", origin: null }, route: "POST /api/bookings" });
  assert(/address unreadable/.test(unreadable), `an unreadable address says so rather than printing null (got: ${unreadable})`);
  assert(![prod, server, unreadable].some((t) => /undefined|null|NaN/.test(t)), "no copy leaks a placeholder");
}

// --- the watcher: both directions, the throttle, and arming ------------------------
function rig(raw: string, opts: { notifyFails?: boolean; live?: { id: string; secret: string }[] } = {}) {
  const pending: (() => Promise<unknown>)[] = [];
  const sent: { key: string; cooldownMs: number; text: string }[] = [];
  const events: RetiredKeyEvent[] = [];
  let nowMs = Date.parse("2026-09-29T14:00:00Z");
  let notifyFails = opts.notifyFails ?? false;
  const watch = makeRetiredKeyWatcher({
    rawHashes: () => raw,
    liveKeys: () => opts.live ?? [],
    cooldownMs: async () => 60 * 60_000,
    notify: async (key, cooldownMs, text) => {
      if (notifyFails) throw new Error("slack down");
      sent.push({ key, cooldownMs, text });
    },
    report: (e) => events.push(e),
    defer: (work) => pending.push(work),
    now: () => nowMs,
  });
  return {
    watch,
    sent,
    events,
    advance: (ms: number) => (nowMs += ms),
    heal: () => (notifyFails = false),
    drain: async () => {
      const errors: unknown[] = [];
      while (pending.length) {
        try {
          await pending.shift()!();
        } catch (err) {
          errors.push(err);
        }
      }
      return errors;
    },
  };
}
const H = (h: Record<string, string>) => new Headers(h);
const ARMED = `shared:${nodeHash(RETIRED)}`;

{
  const r = rig(ARMED);
  r.watch(RETIRED, "GET", "/api/bookings", H({ origin: "https://www.trypennie.com" }));
  eq((await r.drain()).length, 0, "a retired key's check finishes without error");
  eq(r.sent.length, 1, "a retired key pages");
  eq(r.sent[0]?.key, "retired_booking_key:production", "keyed on its host kind");
  eq(r.sent[0]?.cooldownMs, 60 * 60_000, "on the tunable cooldown");
  assert(/https:\/\/www\.trypennie\.com/.test(r.sent[0]?.text ?? "") && /GET \/api\/bookings/.test(r.sent[0]?.text ?? ""), "naming the origin and the route");
  const rec = r.events.find((e) => e.kind === "retired-key-presented");
  assert(rec !== undefined, "and it is recorded");
  if (rec?.kind === "retired-key-presented") {
    eq(rec.label, "shared", "the record names the retired key");
    eq(rec.origin, "https://www.trypennie.com", "and the origin");
    eq(rec.route, "GET /api/bookings", "and the route");
  }
}

{
  // The other direction: an unknown key never pages as retired, and records nothing.
  const r = rig(ARMED);
  r.watch(UNKNOWN, "POST", "/api/bookings", H({ origin: "https://www.trypennie.com" }));
  r.watch(null, "POST", "/api/bookings", H({}));
  eq((await r.drain()).length, 0, "an unknown key's check finishes without error");
  eq(r.sent.length, 0, "an unknown key does not page as retired");
  eq(r.events.length, 0, "and records nothing");
}

{
  // Positive control for the direction above: the SAME rig with the unknown key's
  // own hash configured does page, so the silence is the match, not a deaf watcher.
  const r = rig(`shared:${nodeHash(UNKNOWN)}`);
  r.watch(UNKNOWN, "POST", "/api/bookings", H({}));
  await r.drain();
  eq(r.sent.length, 1, "the same key configured as retired pages");
  eq(r.sent[0]?.key, "retired_booking_key:unstated", "under the no host kind");
}

{
  // Once per host kind per cooldown: a burst from one kind makes one send attempt
  // per isolate throttle window, while another kind is not held behind it.
  const r = rig(ARMED);
  for (let i = 0; i < 5; i++) r.watch(RETIRED, "GET", "/api/bookings", H({ origin: "https://www.trypennie.com" }));
  r.watch(RETIRED, "GET", "/api/bookings", H({ origin: "http://localhost:3000" }));
  await r.drain();
  eq(r.sent.map((s) => s.key).sort().join(","), "retired_booking_key:localhost,retired_booking_key:production", "one attempt per host kind for a burst");
  eq(r.events.filter((e) => e.kind === "retired-key-presented").length, 6, "while every presentation is still recorded");
  r.advance(61_000);
  r.watch(RETIRED, "GET", "/api/bookings", H({ origin: "https://www.trypennie.com" }));
  await r.drain();
  eq(r.sent.length, 3, "after the isolate window the dispatcher is asked again (its own cooldown decides)");
}

{
  // A failed send releases the isolate throttle, so the next presentation retries.
  const r = rig(ARMED, { notifyFails: true });
  r.watch(RETIRED, "GET", "/api/bookings", H({}));
  const errors = await r.drain();
  eq(errors.length, 1, "a failed send is rethrown to the scheduler, which logs it");
  r.heal();
  r.watch(RETIRED, "GET", "/api/bookings", H({}));
  await r.drain();
  eq(r.sent.length, 1, "and the next presentation retries at once");
}

{
  // Arming: a value that cannot be read refuses loudly, never as "nothing retired".
  const r = rig("shared:not-a-hash");
  r.watch(RETIRED, "GET", "/api/bookings", H({}));
  const errors = await r.drain();
  eq(r.sent.length, 0, "an unreadable setting sends nothing");
  const bad = r.events.find((e) => e.kind === "config-unreadable");
  assert(bad !== undefined, "and reports the setting as unreadable");
  assert(errors.length === 1 && errors[0] instanceof RetiredKeyConfigError, "and the check fails rather than passing quietly");
}

{
  // Unset is inert, and costs no hashing at all.
  const r = rig("");
  r.watch(RETIRED, "GET", "/api/bookings", H({}));
  eq((await r.drain()).length, 0, "an unset setting is inert");
  eq(r.sent.length + r.events.length, 0, "and says and sends nothing");
}

{
  // Nothing about this may reach the request: a scheduler that throws is contained.
  const watch = makeRetiredKeyWatcher({
    rawHashes: () => ARMED,
    liveKeys: () => [],
    cooldownMs: async () => 1,
    notify: async () => {},
    report: () => {},
    defer: () => {
      throw new Error("no request scope");
    },
    now: () => 0,
  });
  let escaped = false;
  try {
    watch(RETIRED, "GET", "/api/bookings", H({}));
  } catch {
    escaped = true;
  }
  assert(!escaped, "a scheduler that throws never reaches the booking request");
}

// --- a key still in a live slot is not retired, and hashing it covers nothing -----
//
// A live key authenticates, so the watcher (which only sees refused tokens) could
// never fire on it: the list would read as armed while covering nothing. Both the
// hash command and the Worker refuse that, naming the slot and never the value.
{
  const live = [
    { id: "trypennie:secondary", secret: RETIRED },
    { id: "regal:primary", secret: UNKNOWN },
  ];
  eq(
    await liveSlotsInRetiredList(parseRetiredKeyHashes(ARMED), live),
    [{ label: "shared", slot: "trypennie:secondary" }],
    "a retired hash equal to a live slot's key is found, by label and slot",
  );
  eq(await liveSlotsInRetiredList(parseRetiredKeyHashes(ARMED), [{ id: "regal:primary", secret: UNKNOWN }]), [], "and none when no live key matches");

  let refused: unknown = null;
  try {
    await retiredKeyHashLine("shared", RETIRED, [{ id: "trypennie:secondary", secret: RETIRED }]);
  } catch (err) {
    refused = err;
  }
  assert(refused instanceof RetiredKeyConfigError, "the hash command refuses a key that is still live");
  const msg = refused instanceof Error ? refused.message : "";
  assert(/trypennie:secondary/.test(msg) && /live/.test(msg), `naming the slot it is live in (got: ${msg})`);
  assert(!msg.includes(RETIRED), "and never the value");

  const r = rig(ARMED, { live: [{ id: "trypennie:secondary", secret: RETIRED }] });
  r.watch(UNKNOWN, "GET", "/api/bookings", H({}));
  const errors = await r.drain();
  eq(r.sent.length, 0, "a list naming a live key sends nothing");
  assert(r.events.some((e) => e.kind === "config-unreadable" && /trypennie:secondary/.test(e.error.message)), "and reports it as a misconfiguration naming the slot");
  assert(errors.length === 1, "and the check fails rather than passing quietly");
}

// --- wiring: the authorizer asks only on a refused, present token ------------------
{
  const src = readFileSync(new URL("../src/lib/booking/route-auth.ts", import.meta.url), "utf8");
  assert(/watchRetiredKey\(/.test(src), "the booking API's authorizer calls the retired key watcher");
  const env = readFileSync(new URL("../src/lib/env.ts", import.meta.url), "utf8");
  assert(env.includes(`process.env.${RETIRED_KEY_HASHES_ENV}`), "the setting is read literally, so the deploy runbook guard sees it");
}

finish();
