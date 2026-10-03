// A retired booking API key being presented pages, naming where it came from (#2879).
// Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-retired-booking-keys.ts
//
// #2865 retired the shared key, and trypennie's staging project still held it: the
// confirmed page was refused 401 after a real booking and nothing noticed, because
// the caller sightings record only keys that AUTHENTICATE. So Slate keeps a hash of
// each retired key (never the key), and a refused request presenting one is recorded
// and paged once per retired key label and host kind per cooldown. Both directions are pinned: a retired
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
  combineRetiredKeyEntries,
  liveSlotsInRetiredList,
  sha256Hex,
  type RetiredKeyEvent,
} from "../src/lib/booking/retired-keys.ts";
import { CALLER_HOST_KINDS } from "../src/lib/booking/caller-seen.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { fileURLToPath } from "node:url";

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
  eq(parseRetiredKeyHashes(`shared:sha256:${h}`), [{ label: "shared", sha256: h }], "one labelled hash");
  eq(
    parseRetiredKeyHashes(` shared:sha256:${h.toUpperCase()} , regal-old:sha256:${nodeHash(OTHER_RETIRED)} `),
    [
      { label: "shared", sha256: h },
      { label: "regal-old", sha256: nodeHash(OTHER_RETIRED) },
    ],
    "several, comma separated, case and surrounding space forgiven",
  );

  // Every way the value can be unusable refuses by name, and never echoes it.
  const refusals: [string, string, RegExp][] = [
    ["no label", h, /entry 1/],
    ["short hash", "shared:sha256:abc123", /64 hex/],
    ["not hex", `shared:sha256:${"z".repeat(64)}`, /64 hex/],
    ["a raw key pasted instead of a hash", `shared:${RETIRED}`, /sha256:/],
    ["an entry with no sha256: part", `shared:${h}`, /sha256:/],
    ["a raw 64 hex key pasted as label:<key>", `shared:${"a1".repeat(32)}`, /sha256:/],
    ["an empty entry", `shared:sha256:${h},,x:sha256:${h}`, /entry 2/],
    ["a bad label", `Shared Key:sha256:${h}`, /label/],
    ["a repeated label", `shared:sha256:${h},shared:sha256:${nodeHash(OTHER_RETIRED)}`, /twice/],
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
  eq(line, `shared:sha256:${nodeHash(RETIRED)}`, "the arming line is label:sha256:hash");
  const hexLine = await retiredKeyHashLine("hexkey", "a1".repeat(32));
  eq(parseRetiredKeyHashes(hexLine), [{ label: "hexkey", sha256: nodeHash("a1".repeat(32)) }], "the line printed for a 64 hex key parses back too");
  assert(!line.includes(RETIRED), "and never carries the key");
  eq(parseRetiredKeyHashes(line), [{ label: "shared", sha256: nodeHash(RETIRED) }], "and reads straight back");
  for (const [what, label, key] of [
    ["a blank key", "shared", "   "],
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
  // A key minted with `openssl rand -hex 32` (DEPLOY.md) is 64 hex characters, the
  // same shape as a hash, and must still be retirable (#2879 review).
  const hexKey = "a1".repeat(32);
  eq(await retiredKeyHashLine("hexkey", hexKey), `hexkey:sha256:${nodeHash(hexKey)}`, "a 64 hex character key hashes like any other");
}

// --- retiring a second key keeps the first (the secret is replaced whole) ---------
//
// `wrangler secret put` REPLACES the value and a secret cannot be read back, so the
// list of retired entries is kept in a committed file of hashes (not secret) and the
// command prints the whole combined value. Piping one new line alone would silently
// stop noticing every key retired before it.
{
  const first = await retiredKeyHashLine("shared", RETIRED);
  const second = await retiredKeyHashLine("regal-old", OTHER_RETIRED);
  const combined = combineRetiredKeyEntries(first, second);
  eq(
    parseRetiredKeyHashes(combined).map((h) => h.label).join(","),
    "shared,regal-old",
    "the combined value holds the earlier entry and the new one",
  );
  eq(combineRetiredKeyEntries("", first), first, "the first entry on an empty list is just that entry");
  eq(
    parseRetiredKeyHashes(`${first}\n${second}\n`).map((h) => h.label).join(","),
    "shared,regal-old",
    "the committed file's one entry per line form parses, trailing newline and all",
  );
  // Adding an entry that is already there, same label and same hash, is a no op, so a
  // retry after a failed `wrangler secret put` succeeds rather than being refused.
  eq(combineRetiredKeyEntries(first, first), first, "re-adding the same entry leaves the list as it was");
  eq(
    parseRetiredKeyHashes(combineRetiredKeyEntries(`${first},${second}`, first)).map((h) => h.label).join(","),
    "shared,regal-old",
    "and does not duplicate it inside a longer list",
  );
  const sameLabelOtherKey = await retiredKeyHashLine("shared", UNKNOWN);
  for (const [what, existing, line, why] of [
    ["a label already in the list for a DIFFERENT key", first, sameLabelOtherKey, /twice/],
    ["an existing list that does not parse", "shared:not-a-hash", second, /sha256:/],
  ] as const) {
    let refused: unknown = null;
    try {
      combineRetiredKeyEntries(existing, line);
    } catch (err) {
      refused = err;
    }
    assert(refused instanceof RetiredKeyConfigError && why.test(refused.message), `${what} refuses rather than writing a list that cannot be read (got: ${String(refused)})`);
  }
  // The committed file carries a header comment; comment lines are not entries.
  eq(parseRetiredKeyHashes("# retired booking keys, none yet\n# one per line\n"), [], "a file holding only comments is an empty list");
  eq(
    parseRetiredKeyHashes(`# header, with a comma\n${first}\n`).map((h) => h.label).join(","),
    "shared",
    "and comments beside entries are skipped, commas in them included",
  );
}

// --- the real command: print, record, retry, and a missing file --------------------
//
// Driven end to end with RETIRED_KEY_HASHES_PATH pointing into a temporary directory
// and the working directory somewhere else again, so the repo's own file is never
// written and a cwd relative path would be caught.
{
  const { mkdtempSync, writeFileSync: write, readFileSync: read, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "retired-keys-file-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "retired-keys-cwd-"));
  const file = join(home, "retired-booking-key-hashes.txt");
  const script = fileURLToPath(new URL("./hash-retired-key.ts", import.meta.url));
  const hook = fileURLToPath(new URL("./register-paths.mjs", import.meta.url));
  const run = (args: string[], key: string, path: string | null = file) =>
    spawnSync(process.execPath, ["--experimental-strip-types", "--import", hook, script, ...args], {
      cwd: elsewhere,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", RETIRED_BOOKING_API_KEY: key, ...(path ? { RETIRED_KEY_HASHES_PATH: path } : {}) },
    });
  const last = (r: { stderr: string }) => r.stderr.trim().split("\n").pop();

  // A missing file is refused, never read as an empty list (L105): printing only the
  // new entry would have the secret put drop every key retired before it.
  const missing = run(["shared"], RETIRED);
  assert(missing.status !== 0 && /not found|missing/i.test(missing.stderr), `a missing list refuses (stderr: ${last(missing)})`);
  eq(missing.stdout, "", "and prints nothing that could be piped into the secret");

  write(file, "# retired booking keys\n");
  const printed = run(["shared"], RETIRED);
  eq(printed.status, 0, `printing succeeds (stderr: ${last(printed)})`);
  eq(parseRetiredKeyHashes(printed.stdout).map((h) => h.label).join(","), "shared", "and prints the combined list");
  eq(read(file, "utf8"), "# retired booking keys\n", "printing writes NOTHING, so a failed secret put leaves the list as it was");
  const retry = run(["shared"], RETIRED);
  eq(retry.stdout, printed.stdout, "a retry after a failed secret put prints the same value");

  const recorded = run(["--record", "shared"], RETIRED);
  eq(recorded.status, 0, `--record succeeds (stderr: ${last(recorded)})`);
  eq(parseRetiredKeyHashes(read(file, "utf8")).map((h) => h.label).join(","), "shared", "and --record writes the entry");
  assert(read(file, "utf8").startsWith("# retired booking keys\n"), "keeping the file's header");
  const recordedAgain = run(["--record", "shared"], RETIRED);
  eq(recordedAgain.status, 0, "recording the same entry again is a no op, not a refusal");
  eq(parseRetiredKeyHashes(read(file, "utf8")).length, 1, "and adds no duplicate");

  const secondPrint = run(["regal-old"], OTHER_RETIRED);
  eq(
    parseRetiredKeyHashes(secondPrint.stdout).map((h) => h.label).join(","),
    "shared,regal-old",
    "the next key prints BOTH entries, so the secret it replaces keeps the first",
  );
  assert(!secondPrint.stdout.includes(RETIRED) && !secondPrint.stdout.includes(OTHER_RETIRED), "and neither key appears in what it prints");
  const reused = run(["shared"], UNKNOWN);
  assert(reused.status !== 0 && /twice/.test(reused.stderr), `a label reused for a different key refuses (stderr: ${last(reused)})`);

  // With no override, the path comes from the script's own location, not the cwd:
  // run from an unrelated directory, it reads the repo's committed list and writes
  // nothing there.
  assert(!existsSync(join(elsewhere, "docs")), "nothing was written relative to the working directory");
  const { retiredKeyHashesPath } = await import("./lib/retired-key-file.ts");
  eq(retiredKeyHashesPath(), fileURLToPath(new URL("../docs/retired-booking-key-hashes.txt", import.meta.url)), "the default path is the repo's own file, resolved from the script");
  const repoFile = retiredKeyHashesPath();
  const before = read(repoFile, "utf8");
  const fromElsewhere = run(["probe-only"], "fixture-value-from-elsewhere", null);
  eq(fromElsewhere.status, 0, `run from another directory, it finds the repo's list (stderr: ${last(fromElsewhere)})`);
  eq(read(repoFile, "utf8"), before, "and a print run leaves the repo's list untouched");
}

// --- the committed list exists and is readable -------------------------------------
{
  const { existsSync } = await import("node:fs");
  const { retiredKeyHashesPath } = await import("./lib/retired-key-file.ts");
  const path = retiredKeyHashesPath();
  assert(existsSync(path), `${path} exists, so hash:retired-key never reads a missing list as empty`);
  let ok = true;
  try {
    parseRetiredKeyHashes(readFileSync(path, "utf8"));
  } catch {
    ok = false;
  }
  assert(ok, "and it parses, so the next hash:retired-key can extend it");
}

// --- matching a presented token ---------------------------------------------------
{
  const hashes = parseRetiredKeyHashes(`shared:sha256:${nodeHash(RETIRED)},regal-old:sha256:${nodeHash(OTHER_RETIRED)}`);
  eq((await matchRetiredKey(RETIRED, hashes))?.label, "shared", "a retired key matches its own label");
  eq((await matchRetiredKey(OTHER_RETIRED, hashes))?.label, "regal-old", "and the second one matches its own");
  eq(await matchRetiredKey(UNKNOWN, hashes), null, "an unknown key matches nothing");
  eq(await matchRetiredKey(RETIRED, []), null, "and nothing matches when nothing is retired");
}

// --- the alert key is bounded, and the copy names where and which route -----------
{
  for (const kind of CALLER_HOST_KINDS) {
    eq(retiredKeyAlertKey("shared", kind), `${RETIRED_KEY_ALERT_FAMILY}:shared:${kind}`, `the ${kind} key names the retired key and the host kind`);
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
const ARMED = `shared:sha256:${nodeHash(RETIRED)}`;

{
  const r = rig(ARMED);
  r.watch(RETIRED, "GET", "/api/bookings", H({ origin: "https://www.trypennie.com" }));
  eq((await r.drain()).length, 0, "a retired key's check finishes without error");
  eq(r.sent.length, 1, "a retired key pages");
  eq(r.sent[0]?.key, "retired_booking_key:shared:production", "keyed on the retired key and its host kind");
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
  const r = rig(`shared:sha256:${nodeHash(UNKNOWN)}`);
  r.watch(UNKNOWN, "POST", "/api/bookings", H({}));
  await r.drain();
  eq(r.sent.length, 1, "the same key configured as retired pages");
  eq(r.sent[0]?.key, "retired_booking_key:shared:unstated", "under the no host kind");
}

{
  // Once per retired key and host kind per cooldown: a burst from one kind makes one send attempt
  // per isolate throttle window, while another kind is not held behind it.
  const r = rig(ARMED);
  for (let i = 0; i < 5; i++) r.watch(RETIRED, "GET", "/api/bookings", H({ origin: "https://www.trypennie.com" }));
  r.watch(RETIRED, "GET", "/api/bookings", H({ origin: "http://localhost:3000" }));
  await r.drain();
  eq(r.sent.map((s) => s.key).sort().join(","), "retired_booking_key:shared:localhost,retired_booking_key:shared:production", "one attempt per retired key and host kind for a burst");
  eq(r.events.filter((e) => e.kind === "retired-key-presented").length, 6, "while every presentation is still recorded");
  r.advance(61_000);
  r.watch(RETIRED, "GET", "/api/bookings", H({ origin: "https://www.trypennie.com" }));
  await r.drain();
  eq(r.sent.length, 3, "after the isolate window the dispatcher is asked again (its own cooldown decides)");
}

{
  // Two retired keys from ONE host kind inside the cooldown both page (L707): a
  // cooldown keyed coarser than the label the message names would silence the second.
  const r = rig(`shared:sha256:${nodeHash(RETIRED)},regal-old:sha256:${nodeHash(OTHER_RETIRED)}`);
  r.watch(RETIRED, "GET", "/api/bookings", H({ origin: "https://www.trypennie.com" }));
  r.watch(OTHER_RETIRED, "POST", "/api/bookings", H({ origin: "https://www.trypennie.com" }));
  await r.drain();
  eq(
    r.sent.map((s) => s.key).sort().join(","),
    "retired_booking_key:regal-old:production,retired_booking_key:shared:production",
    "each retired key from the same host kind pages under its own key",
  );
  assert(/"regal-old"/.test(r.sent.find((s) => s.key.includes("regal-old"))?.text ?? ""), "and each message names its own key");
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
