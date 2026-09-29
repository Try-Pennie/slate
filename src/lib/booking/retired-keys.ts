/**
 * Noticing a RETIRED booking API key being presented (#2879).
 *
 * #2865 retired the shared `BOOKING_API_KEY`. trypennie's staging project still held
 * it, and on 2026-09-29 its confirmed page was refused 401 after a real booking and
 * rendered its not found page. Nothing noticed: the caller sightings
 * (`caller-seen.ts`) record only keys that AUTHENTICATE, and a refusal is not
 * attributed to anybody. The same will happen at every future rotation, since each
 * caller's two slots exist precisely so keys can be retired.
 *
 * So Slate keeps a HASH of each retired key, never the key, in
 * `BOOKING_API_RETIRED_KEY_HASHES` (a Worker secret, so even the hash stays out of
 * the repo). When a refused request presents one, the refusal is exactly what it
 * was, and afterwards the presentation is recorded and paged once per host kind per
 * cooldown, naming the host and the route, so whoever still holds it can be found.
 *
 * THE HASH is a plain SHA-256 of the exact token, hex encoded, because the auth path
 * compares the exact token after `Bearer ` with nothing trimmed. `sha256Hex` is the
 * one implementation, used both here and by `pnpm hash:retired-key`, which is how a
 * person computes the value to store.
 *
 * WHY PER HOST KIND and not per origin: an alert key derived from request text must
 * be mapped onto a fixed set first (#2755), or any caller could mint throttle rows
 * without limit. The four host kinds are that set, and the ORIGIN is named in the
 * message instead.
 *
 * WHY IT COSTS NOTHING ON THE HOT PATH. It runs only on a 401 that carried a token,
 * and all of it (hashing, the cooldown read, the send) is deferred past the response.
 * An isolate throttle holds each host kind to one dispatcher call a minute, so a
 * client retrying a retired key in a loop costs one `alert_state` read a minute per
 * isolate rather than one per request; the dispatcher's own cooldown decides whether
 * that call pages. A failed send releases the throttle (L368).
 *
 * ARMING. Unset is inert, and that is a stated state rather than a silent one: the
 * one step that arms it is in DEPLOY.md. A value that is SET and cannot be read
 * (a raw key pasted instead of a hash, a missing label) refuses loudly on every
 * refused request rather than reading as "nothing is retired" (L98).
 *
 * Pure apart from its injected seams; `retired-key-watch.ts` wires the real ones and
 * `scripts/test-retired-booking-keys.ts` drives this.
 */
import { timingSafeEqual } from "@/lib/bearer-auth";
import type { ThrottledNotify } from "@/lib/monitor/alert-deps";
import { requestHost, type CallerHostKind, type HeaderSource } from "@/lib/booking/caller-seen";

/** The setting holding the hashes, as `label:sha256hex`, comma separated. */
export const RETIRED_KEY_HASHES_ENV = "BOOKING_API_RETIRED_KEY_HASHES";

/** The alert family, one member per host kind. Also the cooldown's key. */
export const RETIRED_KEY_ALERT_FAMILY = "retired_booking_key";

/** How long one isolate waits before asking the dispatcher again for one host kind. */
export const RETIRED_KEY_ISOLATE_THROTTLE_MS = 60_000;

export interface RetiredKeyHash {
  /** A name for the retired key, never the key: "shared", "regal-2026-09". */
  label: string;
  /** SHA-256 of the exact token, lowercase hex. */
  sha256: string;
}

export class RetiredKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetiredKeyConfigError";
  }
}

const LABEL = /^[a-z][a-z0-9-]{0,39}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Read the configured hashes. Blank is nothing retired. Anything set and unusable
 * THROWS, naming the entry by position and the rule it broke and never echoing the
 * value, because a raw key pasted here by mistake must not reach a log line.
 */
export function parseRetiredKeyHashes(raw: string): RetiredKeyHash[] {
  if (!raw.trim()) return [];
  const out: RetiredKeyHash[] = [];
  const entries = raw.split(",");
  entries.forEach((entry, i) => {
    const where = `${RETIRED_KEY_HASHES_ENV} entry ${i + 1}`;
    const text = entry.trim();
    if (!text) throw new RetiredKeyConfigError(`${where} is empty; write label:hash pairs separated by commas`);
    const sep = text.indexOf(":");
    if (sep < 0) throw new RetiredKeyConfigError(`${where} has no label; write it as label:hash`);
    const label = text.slice(0, sep).trim();
    const sha256 = text.slice(sep + 1).trim().toLowerCase();
    if (!LABEL.test(label)) {
      throw new RetiredKeyConfigError(`${where} has a label that is not lowercase letters, digits and hyphens`);
    }
    if (!HEX64.test(sha256)) {
      throw new RetiredKeyConfigError(
        `${where} is not a 64 hex character SHA-256; store the output of pnpm hash:retired-key, never the key`,
      );
    }
    if (out.some((h) => h.label === label)) throw new RetiredKeyConfigError(`${where} uses the label "${label}" twice`);
    out.push({ label, sha256 });
  });
  return out;
}

/** SHA-256 of the exact text, lowercase hex. Web Crypto, so the Worker and node agree. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The `label:hash` entry for one retired key, which is what `pnpm hash:retired-key`
 * prints and `parseRetiredKeyHashes` reads. Refuses a blank key, and a key that is
 * already 64 hex characters, since that is almost certainly a hash pasted where the
 * key belongs and hashing it again would store a value no request could ever match.
 */
export async function retiredKeyHashLine(
  label: string,
  key: string,
  /** Every booking key configured where this runs; a match means the key is not retired. */
  live: readonly LiveKey[] = [],
): Promise<string> {
  if (!LABEL.test(label)) throw new RetiredKeyConfigError(`${RETIRED_KEY_HASHES_ENV} label must be lowercase letters, digits and hyphens`);
  if (!key.trim()) throw new RetiredKeyConfigError(`the retired key is empty, so there is nothing to hash for ${RETIRED_KEY_HASHES_ENV}`);
  if (HEX64.test(key.trim().toLowerCase())) {
    throw new RetiredKeyConfigError(`that value is already shaped like a hash; ${RETIRED_KEY_HASHES_ENV} needs the hash of the key itself`);
  }
  const liveIn = live.filter((k) => timingSafeEqual(k.secret, key)).map((k) => k.id);
  if (liveIn.length) {
    throw new RetiredKeyConfigError(
      `that key is still live in ${liveIn.join(", ")}, so it is not retired: it authenticates, the watcher never sees it, ` +
        `and its hash in ${RETIRED_KEY_HASHES_ENV} would cover nothing. Hash it at the rotation that removes it from that slot`,
    );
  }
  return `${label}:${await sha256Hex(key)}`;
}

/** A configured booking key, by its slot label. The secret never leaves this module. */
export interface LiveKey {
  id: string;
  secret: string;
}

/**
 * Retired hashes that equal a key still configured in a live slot. Such an entry can
 * never fire (the key authenticates, so the watcher never sees it) while the list
 * reads as armed, so the watcher treats it as a misconfiguration.
 */
export async function liveSlotsInRetiredList(
  hashes: readonly RetiredKeyHash[],
  live: readonly LiveKey[],
): Promise<{ label: string; slot: string }[]> {
  if (hashes.length === 0 || live.length === 0) return [];
  const out: { label: string; slot: string }[] = [];
  for (const k of live) {
    const h = await sha256Hex(k.secret);
    for (const r of hashes) if (timingSafeEqual(h, r.sha256)) out.push({ label: r.label, slot: k.id });
  }
  return out;
}

/** The retired key this token is, or null. Every hash is compared, in constant time. */
export async function matchRetiredKey(token: string, hashes: readonly RetiredKeyHash[]): Promise<RetiredKeyHash | null> {
  if (hashes.length === 0) return null;
  const presented = await sha256Hex(token);
  let found: RetiredKeyHash | null = null;
  for (const h of hashes) {
    if (timingSafeEqual(presented, h.sha256) && found === null) found = h;
  }
  return found;
}

export function retiredKeyAlertKey(kind: CallerHostKind): string {
  return `${RETIRED_KEY_ALERT_FAMILY}:${kind}`;
}

function describeHost(host: { kind: CallerHostKind; origin: string | null }): string {
  const at = host.origin ?? "address unreadable";
  switch (host.kind) {
    case "production":
      return `the production site (${at})`;
    case "localhost":
      return `localhost or a private address (${at})`;
    case "other-host":
      return `another host (${at})`;
    case "unstated":
      return "a call that named no host, so a server or a script";
  }
}

export interface RetiredKeyPresentation {
  label: string;
  host: { kind: CallerHostKind; origin: string | null };
  /** Method and path, never the query: `GET /api/bookings`. */
  route: string;
}

/** The page. One builder, called by the send site and by `pnpm preview:alerts`. */
export function formatRetiredKeyAlert(p: RetiredKeyPresentation): string {
  return (
    `A request used the retired booking key "${p.label}" from ${describeHost(p.host)}, on ${p.route}. ` +
    `It was refused, so whoever still holds that key is being turned away: find the system ` +
    `calling from there and give it its own key (docs/booking-api.md section 2).`
  );
}

export type RetiredKeyEvent =
  | ({ kind: "retired-key-presented" } & { label: string; hostKind: CallerHostKind; origin: string | null; route: string })
  | { kind: "config-unreadable"; error: RetiredKeyConfigError };

export interface RetiredKeyWatchDeps {
  /** The raw setting, read at use so a changed secret needs no restart. */
  rawHashes: () => string;
  /** The booking keys configured on this deployment, to refuse a retired hash that is still live. */
  liveKeys: () => readonly LiveKey[];
  /** The alert's cooldown. Never throws (`loadMonitorCooldowns`). */
  cooldownMs: () => Promise<number>;
  /** The throttled dispatcher. Rejects on failure. */
  notify: ThrottledNotify<unknown>;
  /** The record: a log line in production. */
  report: (event: RetiredKeyEvent) => void;
  /** Run work after the response (`afterResponse`), logging a rejection. */
  defer: (work: () => Promise<unknown>) => void;
  now: () => number;
}

/**
 * Build the watcher the booking API's authorizer calls on every refused request that
 * carried a token. It returns at once; everything else happens after the response.
 */
export function makeRetiredKeyWatcher(deps: RetiredKeyWatchDeps) {
  const lastAsked = new Map<string, number>();
  return function watchRetiredKey(
    token: string | null,
    method: string,
    pathname: string,
    headers: HeaderSource,
  ): void {
    if (token === null) return;
    try {
      const raw = deps.rawHashes();
      if (!raw.trim()) return;
      const host = requestHost(headers);
      const route = `${method} ${pathname}`;
      deps.defer(async () => {
        let hashes: RetiredKeyHash[];
        try {
          hashes = parseRetiredKeyHashes(raw);
        } catch (err) {
          if (err instanceof RetiredKeyConfigError) deps.report({ kind: "config-unreadable", error: err });
          throw err;
        }
        const stillLive = await liveSlotsInRetiredList(hashes, deps.liveKeys());
        if (stillLive.length) {
          const err = new RetiredKeyConfigError(
            `${RETIRED_KEY_HASHES_ENV} names a key still live on this deployment (` +
              stillLive.map((m) => `${m.label} in ${m.slot}`).join(", ") +
              `), which authenticates and so can never be noticed; remove that entry or retire the slot`,
          );
          deps.report({ kind: "config-unreadable", error: err });
          throw err;
        }
        const match = await matchRetiredKey(token, hashes);
        if (!match) return;
        deps.report({ kind: "retired-key-presented", label: match.label, hostKind: host.kind, origin: host.origin, route });
        const key = retiredKeyAlertKey(host.kind);
        const nowMs = deps.now();
        const last = lastAsked.get(key);
        if (last !== undefined && nowMs - last < RETIRED_KEY_ISOLATE_THROTTLE_MS) return;
        lastAsked.set(key, nowMs);
        try {
          await deps.notify(key, await deps.cooldownMs(), formatRetiredKeyAlert({ label: match.label, host, route }));
        } catch (err) {
          if (lastAsked.get(key) === nowMs) lastAsked.delete(key);
          throw err;
        }
      });
    } catch {
      // Nothing about noticing a retired key may reach the refusal itself. The
      // scheduler is the only thing here that can throw synchronously.
    }
  };
}
