/**
 * Which host each booking API caller has authenticated from, and when (#2717).
 *
 * trypennie's confirmed page reads every Slate booking through the key authed lookup
 * with its own key (#2645). If that key is missing from their production environment
 * every pilot booking ends on their not found page, and the first person to find out
 * is the first real lead. Slate already knows which caller each authenticated request
 * came from (`authorizeBookingApi` reports `caller`); this keeps that as a fact
 * somebody can ask for, in `api_caller_seen` (migration 0140), one row per caller and
 * host kind.
 *
 * WHY PER HOST KIND and not one row per caller: a single "last seen" row would let a
 * localhost test at 10:30 overwrite the production call at 10:00, and the readiness
 * gate would then report the key as seen only from localhost. Four kinds times four
 * callers bounds the table at sixteen rows.
 *
 * WHAT A HOST IS. The request's `Origin` header, else the origin of its `Referer`,
 * reduced to scheme, host and port so a path or query (a booking id on the confirmed
 * page) is never stored. A server to server call sends neither, which is `unstated`.
 * trypennie's lookup is exactly such a call, so Dan decided (2026-09-25) that a
 * recent server call ALSO proves the key: a browser on localhost or a preview names
 * its host, and a server call that names none is taken as their deployment. A
 * trypennie developer calling with the production key from their own server would
 * satisfy it too, and that was accepted. The verdict says which of the two it
 * passed on, so nobody reads a server call as a production page load.
 *
 * WHY IT COSTS NOTHING ON THE HOT PATH. A row is written on a caller's first success
 * from a host kind and refreshed at most once an hour per isolate after that, by a
 * throttle held in memory, so almost every request does no I/O at all. The write it
 * does make is deferred past the response. A failed write releases the throttle, so
 * the next success retries rather than an hour passing with nothing recorded (L368).
 *
 * Pure apart from its injected write and scheduler, so scripts/test-caller-seen.ts
 * drives it; `record-caller-seen.ts` wires the real ones.
 */
import { PRODUCTION_ORIGINS } from "@/lib/monitor/offsite-origin";
import { BOOKING_API_CALLERS } from "@/lib/booking/api-auth";

/** Every kind of host a request can be recorded under. The migration's CHECK lists
 *  the same four, held equal by scripts/test-caller-seen.ts. */
export const CALLER_HOST_KINDS = ["production", "localhost", "other-host", "unstated"] as const;
export type CallerHostKind = (typeof CALLER_HOST_KINDS)[number];

/** How long a recorded host kind stands before the next success refreshes it. */
export const CALLER_SEEN_REFRESH_MS = 60 * 60_000;

/**
 * How recently the partner key must have authenticated from production for the
 * readiness gate to pass. A week: long enough that the gate does not need a test
 * booking the same morning, short enough that a rotation which broke the partner
 * last week is not vouched for by the week before.
 */
export const PARTNER_KEY_MAX_AGE_DAYS = 7;

/** A row of `api_caller_seen`. A type alias rather than an interface, so it
 *  satisfies the typed client's row constraint on the upsert. */
export type CallerSeenRow = {
  caller: string;
  host_kind: CallerHostKind;
  last_seen_at: string;
  method: string;
  origin: string | null;
  /**
   * When this caller was first seen from this host kind (#2822, migration 0146).
   * Stamped by the database on insert and never written by the recorder, so a
   * refresh cannot move it. Optional because a read that did not select it (or a
   * database before 0146) has none, and the judge then treats it as unknown.
   */
  first_seen_at?: string | null;
};

/** What one write stores: the row WITHOUT `first_seen_at`, which the database owns. */
export type CallerSeenWrite = Omit<CallerSeenRow, "first_seen_at">;

/** The two headers this reads, so a plain `Headers` and a Next request's both fit. */
export interface HeaderSource {
  get(name: string): string | null;
}

function isLocalHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  return m !== null && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

/**
 * Where a request says it came from. The Origin header wins over the referrer when
 * both are present, because it is the one a browser sets without the page's help.
 * An unreadable value (`Origin: null` from a sandboxed frame, or text that is not a
 * URL) is recorded as another host with no origin: something was stated, it is not
 * production, and it is not echoed into a table.
 */
export function requestHost(headers: HeaderSource): { kind: CallerHostKind; origin: string | null } {
  const stated = headers.get("origin")?.trim() || headers.get("referer")?.trim() || "";
  if (!stated) return { kind: "unstated", origin: null };
  let url: URL;
  try {
    url = new URL(stated);
  } catch {
    return { kind: "other-host", origin: null };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "other-host", origin: null };
  const origin = url.origin;
  if (isLocalHostname(url.hostname)) return { kind: "localhost", origin };
  return { kind: PRODUCTION_ORIGINS.includes(origin) ? "production" : "other-host", origin };
}

export interface CallerSeenDeps {
  /** Upsert one row on (caller, host_kind). Rejects on failure. */
  write: (w: CallerSeenWrite) => Promise<void>;
  /** Run work after the response (`afterResponse`), logging a rejection. */
  defer: (work: () => Promise<unknown>) => void;
  now: () => number;
}

/**
 * Build the recorder the booking API's authorizer calls on every success. The
 * throttle lives in the returned closure, so it is per isolate: several isolates may
 * each write within one hour, which costs a handful of upserts and keeps the hot path
 * free of any read to coordinate them.
 */
export function makeCallerSeenRecorder(deps: CallerSeenDeps) {
  const lastClaimed = new Map<string, number>();
  return function recordCallerSeen(caller: string, method: string, headers: HeaderSource): void {
    try {
      const nowMs = deps.now();
      const host = requestHost(headers);
      const key = `${caller}:${host.kind}`;
      const last = lastClaimed.get(key);
      if (last !== undefined && nowMs - last < CALLER_SEEN_REFRESH_MS) return;
      lastClaimed.set(key, nowMs);
      const row: CallerSeenWrite = {
        caller,
        host_kind: host.kind,
        last_seen_at: new Date(nowMs).toISOString(),
        method,
        origin: host.origin,
      };
      deps.defer(async () => {
        try {
          await deps.write(row);
        } catch (err) {
          // Released only if nothing newer claimed it meanwhile, then rethrown so the
          // scheduler logs it: a stamp that failed must not read as one that landed.
          if (lastClaimed.get(key) === nowMs) lastClaimed.delete(key);
          throw err;
        }
      });
    } catch {
      // Nothing about recording who called may reach the booking request. The
      // scheduler is the only thing here that can throw synchronously, and
      // `afterResponse` already falls back rather than throwing.
    }
  };
}

/**
 * The caller the shared `BOOKING_API_KEY` authenticates as (#2645). The smoke canary
 * held it too until #2822, which is what made a sighting on it hard to read (#2819).
 */
export const SHARED_CALLER = "shared";

/** The caller the smoke canary authenticates as once it holds its own key (#2822). */
export const CANARY_CALLER = "canary";

/**
 * The partners a shared key sighting can belong to once the canary has left it: every
 * caller that is neither the shared pair nor the canary, derived from the list the
 * authorizer uses so a partner added there is a suspect here without an edit (L41).
 */
const PARTNER_CALLERS: readonly string[] = BOOKING_API_CALLERS.filter((c) => c !== SHARED_CALLER && c !== CANARY_CALLER);

/**
 * How long after the canary first authenticates on its own key a shared sighting may
 * still be the canary's: a run that started on the old workflow file finishes on the
 * shared key. One refresh interval, which is far longer than a canary run (its jobs
 * time out in fifteen minutes) and short enough that a partner calling within the
 * hour of the move is caught the next day at the latest.
 */
export const CANARY_SWITCH_GRACE_MS = CALLER_SEEN_REFRESH_MS;

/**
 * The sighting that says the canary's SCHEDULED LANES have left the shared key
 * (#2822, review of #2855). Written only by `/api/smoke/heartbeat` when the canary's
 * own key stamps, and every heartbeat is stamped by a scheduled workflow step, never by
 * a hand run. A plain `canary` row cannot stand in for it: a person smoke testing the
 * canary key by hand, or any booking on it, writes one while the lanes are still on
 * the shared key, and taking that as the move would read the lanes' own shared calls
 * as a partner's. Not a caller the authorizer knows, so it never appears in
 * `BOOKING_API_CALLERS` and is never a partner suspect.
 */
export const CANARY_LANES_CALLER = "canary-lanes";

/**
 * When the canary's scheduled lanes first stamped a heartbeat on its own key, or null
 * when they never have or the stamp is unreadable. The EARLIEST first sighting across
 * its host kinds. Null is the fail safe reading: the judge then hedges about the canary
 * rather than accusing a partner. `first_seen_at` is the database's insert stamp, and
 * this row cannot predate migration 0146 (the heartbeat route never recorded one before
 * it), so no backfilled value can reach it.
 */
export function canaryMovedAtMs(rows: readonly CallerSeenRow[]): number | null {
  const stamps = rows
    .filter((r) => r.caller === CANARY_LANES_CALLER)
    .map((r) => (r.first_seen_at ? Date.parse(r.first_seen_at) : Number.NaN))
    .filter((ms) => Number.isFinite(ms));
  return stamps.length ? Math.min(...stamps) : null;
}

export type PartnerKeyStatus = "proven" | "never-seen" | "not-from-production" | "stale" | "on-shared-key";

export interface PartnerKeyVerdict {
  status: PartnerKeyStatus;
  /** Which sighting proved it, when it is proven: a named production host, or a
   *  server call that named no host (accepted by Dan, 2026-09-25). */
  via: "production" | "server-call" | null;
  /** One sentence for the terminal and the admin console, the same words in both. */
  detail: string;
}

function ageDays(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) return "less than a day ago";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

type SeenAt = CallerSeenRow & { ms: number };

function readable(rows: readonly CallerSeenRow[], caller: string): SeenAt[] {
  return rows
    .filter((r) => r.caller === caller)
    .map((r) => ({ ...r, ms: Date.parse(r.last_seen_at) }))
    .filter((r) => Number.isFinite(r.ms));
}

/**
 * Has this caller's key authenticated from their deployment recently? The one judge,
 * read by `pnpm verify:parallel-run-readiness` and the admin console, so the two
 * cannot disagree about the same rows (L41).
 *
 * Passes on a sighting inside `maxAgeMs` from a production host OR from a server call
 * that named no host, a production host first. Localhost or a private address alone,
 * another host alone, and a sighting of either passing kind that is too old all fail,
 * each in its own sentence.
 *
 * THE SHARED KEY (#2819). When the caller's own key is not proven, `rows` may also
 * carry the `shared` caller's rows, and they separate "not deployed yet" from
 * "deployed holding `BOOKING_API_KEY` instead of its own". What `api_caller_seen`
 * records is only caller, host kind, origin, method and a last seen time, and the
 * smoke canary calls the shared key from a server that names no host, refreshing
 * that row every half hour. So:
 *   - a recent shared sighting from a PRODUCTION origin is evidence about the
 *     partner, because the canary never names a host: `on-shared-key`;
 *   - a shared server call is NOT, because it cannot be told apart from the canary's,
 *     and the sentence says so rather than reading silence as "not deployed";
 *   - no recent shared sighting at all is the plain "nothing suggests it has
 *     deployed".
 * The production origins are trypennie's (`PRODUCTION_ORIGINS`), which is the only
 * partner this gates.
 *
 * THE CANARY ON ITS OWN KEY (#2822). Once the canary's scheduled lanes stamp a
 * heartbeat on its own key, the hedge above ends: a shared server call made after the
 * first such stamp (`canaryMovedAtMs`, plus `CANARY_SWITCH_GRACE_MS`) can only be a
 * partner's. A plain `canary` sighting never ends it, since a hand run writes one too.
 * If this caller is the only partner not seen on its own key inside the bound, that
 * is `on-shared-key` outright; if another partner (Regal, until it holds its own key)
 * is also unaccounted for, the sentence names both and asks which. A shared row from
 * before the move is the canary's history and reads as nothing.
 */
export function judgePartnerKey(
  caller: string,
  rows: readonly CallerSeenRow[],
  nowMs: number,
  maxAgeMs: number,
): PartnerKeyVerdict {
  const mine = readable(rows, caller);
  const bound = `${Math.round(maxAgeMs / 86_400_000)} day`;
  const prod = mine.find((r) => r.host_kind === "production");
  const server = mine.find((r) => r.host_kind === "unstated");
  const recent = (r: { ms: number } | undefined) => r !== undefined && nowMs - r.ms <= maxAgeMs;
  if (prod && recent(prod)) {
    return {
      status: "proven",
      via: "production",
      detail: `${caller}'s key last authenticated from their production site (${prod.origin ?? "address unreadable"}) ${ageDays(nowMs - prod.ms)}`,
    };
  }
  if (server && recent(server)) {
    return {
      status: "proven",
      via: "server-call",
      detail: `${caller}'s key last authenticated from a server call that named no host ${ageDays(nowMs - server.ms)}, taken as their deployment`,
    };
  }

  // What the caller's own key did, as a clause, and the sentence it ends in when the
  // shared key says nothing about it.
  let status: "never-seen" | "not-from-production" | "stale";
  let ownFact: string;
  let alone: string;
  const passing = [prod, server].filter((r): r is NonNullable<typeof r> => r !== undefined).sort((a, b) => b.ms - a.ms)[0];
  if (passing) {
    const from = passing.host_kind === "production" ? `their production site (${passing.origin ?? "address unreadable"})` : "a server call that named no host";
    status = "stale";
    ownFact = `${caller}'s key last authenticated from ${from} ${ageDays(nowMs - passing.ms)}, outside the ${bound} bound`;
    alone = `${ownFact}, so a rotation since then is not proven`;
  } else if (mine.length === 0) {
    status = "never-seen";
    ownFact = `${caller}'s key has never authenticated`;
    alone = `${ownFact}, so it is not known to be in their production environment`;
  } else {
    const hosts = (kind: CallerHostKind) =>
      [...new Set(mine.filter((r) => r.host_kind === kind).map((r) => r.origin).filter((o): o is string => !!o))].join(", ");
    const seen: string[] = [];
    if (mine.some((r) => r.host_kind === "localhost")) seen.push(`localhost or a private address (${hosts("localhost") || "address unreadable"})`);
    if (mine.some((r) => r.host_kind === "other-host")) seen.push(`another host (${hosts("other-host") || "address unreadable"})`);
    status = "not-from-production";
    ownFact = `${caller}'s key has authenticated only from ${seen.join(" and from ")}`;
    alone = `${ownFact}, never from their production site or their server`;
  }

  if (caller === SHARED_CALLER) return { status, via: null, detail: alone };
  const shared = readable(rows, SHARED_CALLER).filter((r) => recent(r));
  const sharedProd = shared
    .filter((r) => r.host_kind === "production" && r.origin !== null && PRODUCTION_ORIGINS.includes(r.origin))
    .sort((a, b) => b.ms - a.ms)[0];
  if (sharedProd) {
    return {
      status: "on-shared-key",
      via: null,
      detail: `${ownFact}, but calls are arriving on the shared key from ${sharedProd.origin}, the latest ${ageDays(nowMs - sharedProd.ms)}, so ${caller} may hold the shared key instead of its own`,
    };
  }

  // #2822: once the canary authenticates on its own key, a shared server call made
  // after that moment is a partner's. A shared row last written before it (or inside
  // the grace after it) is the canary's own history and says nothing about anybody.
  const movedMs = canaryMovedAtMs(rows);
  if (movedMs !== null) {
    const since = ageDays(nowMs - movedMs);
    const partnerCall = shared
      .filter((r) => r.host_kind === "unstated" && r.ms > movedMs + CANARY_SWITCH_GRACE_MS)
      .sort((a, b) => b.ms - a.ms)[0];
    if (partnerCall) {
      // Which partners could it be: this caller (its own key is not proven), and any
      // other partner with no recent sighting on its own key. One suspect is a fact;
      // several is a question, asked by name.
      const suspects = PARTNER_CALLERS.filter((p) => p === caller || !readable(rows, p).some((r) => recent(r)));
      if (!suspects.includes(caller)) suspects.push(caller);
      const latest = `a server is calling on the shared key, the latest ${ageDays(nowMs - partnerCall.ms)}, and since the smoke canary moved to its own key ${since} only a partner holds it`;
      if (suspects.length === 1) {
        return {
          status: "on-shared-key",
          via: null,
          detail: `${ownFact}, but ${latest}; ${caller} is the only partner not seen on its own key, so it holds the shared key instead of its own`,
        };
      }
      return {
        status,
        via: null,
        detail: `${ownFact}, but ${latest}; ${suspects.join(" and ")} are not seen on their own keys, so confirm which key ${caller} holds`,
      };
    }
    if (status !== "never-seen") return { status, via: null, detail: alone };
    return {
      status,
      via: null,
      detail: `${ownFact} and no server has called on the shared key since the smoke canary moved to its own key ${since}, so nothing suggests ${caller} has deployed`,
    };
  }

  if (status !== "never-seen") return { status, via: null, detail: alone };
  if (shared.length === 0) {
    return {
      status,
      via: null,
      detail: `${ownFact} and nothing has authenticated on the shared key inside the ${bound} bound either, so nothing suggests ${caller} has deployed`,
    };
  }
  return {
    status,
    via: null,
    detail: `${ownFact}, and nothing on the shared key came from ${caller}'s production site; the smoke canary has not yet authenticated on its own key, so a server call on the shared key cannot be told apart from the canary's, and if ${caller} has deployed, confirm which key it holds`,
  };
}

export interface SharedKeyExposure {
  exposed: boolean;
  /** One sentence naming every exposing origin, or null when there is none. */
  detail: string | null;
}

/**
 * Was the SHARED key sent from a browser recently (#2822)? A request carrying an
 * `Origin` or `Referer` was made by a browser, so a shared key sighting from a public
 * host means the key sat in page code any visitor to that page can read. That is a
 * security finding in its own right, separate from which partner holds the key, and
 * the repair is to move the call to a server AND rotate the key, because a key a page
 * has shipped must be treated as known.
 *
 * Public hosts only: a production origin, or another host (a preview, or an origin a
 * browser stated and this could not read). A developer's own machine is left out,
 * since no visitor loads that page. A partner's OWN key from its production site is
 * not judged here: Dan accepted that as the proof the partner deployed (2026-09-25).
 */
export function judgeSharedKeyExposure(rows: readonly CallerSeenRow[], nowMs: number, maxAgeMs: number): SharedKeyExposure {
  const hits = readable(rows, SHARED_CALLER)
    .filter((r) => (r.host_kind === "production" || r.host_kind === "other-host") && nowMs - r.ms <= maxAgeMs)
    .sort((a, b) => b.ms - a.ms);
  if (hits.length === 0) return { exposed: false, detail: null };
  const where = hits.map((r) => `${r.origin ?? "an unreadable address"} (${ageDays(nowMs - r.ms)})`).join(", ");
  return {
    exposed: true,
    detail: `the shared booking key was sent from a browser at ${where}, where any visitor to that page can read it: move that call to a server and rotate BOOKING_API_KEY`,
  };
}
