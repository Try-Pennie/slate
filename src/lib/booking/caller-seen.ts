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
 * gate would then report the key as seen only from localhost. Four kinds times the
 * callers, the same again for their marked probes (`probe:<caller>`, #2868), plus the
 * rows the retired shared key left (#2865), bounds the table at a few dozen rows.
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

/**
 * The marker a hand run probe sends (#2868): `X-Slate-Probe: <why>`. A probe with a
 * partner's key names no host, exactly as trypennie's server lookup does, so without
 * it the probe would be recorded as their deployment and prove their key (L58: the
 * proof would be written by us). A marked call is recorded under
 * `probeCallerName(caller)` with its real host kind, so which key it used stays
 * visible. It never counts as proof: the readiness gate reads only the real callers
 * (`BOOKING_API_CALLERS`), and `judgePartnerKey` reads only the named caller's own
 * rows. The admin page deliberately reads both the real callers and their `probe:`
 * names, and lists the probes under their own heading ("Slate's own probes"). Only
 * the recording changes: the request is authenticated,
 * rate limited and served exactly as an unmarked one. A blank value is no marker.
 */
export const PROBE_HEADER = "x-slate-probe";

/** The caller a marked probe is recorded under: `probe:trypennie`. */
export function probeCallerName(caller: string): string {
  return `probe:${caller}`;
}

/** Whether a request carries the probe marker. */
export function isSlateProbe(headers: HeaderSource): boolean {
  return (headers.get(PROBE_HEADER)?.trim() ?? "") !== "";
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
  return function recordCallerSeen(authenticated: string, method: string, headers: HeaderSource): void {
    try {
      const nowMs = deps.now();
      const caller = isSlateProbe(headers) ? probeCallerName(authenticated) : authenticated;
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

export type PartnerKeyStatus = "proven" | "never-seen" | "not-from-production" | "stale";

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

  // The caller's own key has not proven itself, so say what it DID do.
  const passing = [prod, server].filter((r): r is NonNullable<typeof r> => r !== undefined).sort((a, b) => b.ms - a.ms)[0];
  if (passing) {
    const from = passing.host_kind === "production" ? `their production site (${passing.origin ?? "address unreadable"})` : "a server call that named no host";
    return {
      status: "stale",
      via: null,
      detail: `${caller}'s key last authenticated from ${from} ${ageDays(nowMs - passing.ms)}, outside the ${bound} bound, so a rotation since then is not proven`,
    };
  }
  if (mine.length === 0) {
    return {
      status: "never-seen",
      via: null,
      detail: `${caller}'s key has never authenticated, so it is not known to be in their production environment`,
    };
  }
  const hosts = (kind: CallerHostKind) =>
    [...new Set(mine.filter((r) => r.host_kind === kind).map((r) => r.origin).filter((o): o is string => !!o))].join(", ");
  const seen: string[] = [];
  if (mine.some((r) => r.host_kind === "localhost")) seen.push(`localhost or a private address (${hosts("localhost") || "address unreadable"})`);
  if (mine.some((r) => r.host_kind === "other-host")) seen.push(`another host (${hosts("other-host") || "address unreadable"})`);
  return {
    status: "not-from-production",
    via: null,
    detail: `${caller}'s key has authenticated only from ${seen.join(" and from ")}, never from their production site or their server`,
  };
}
