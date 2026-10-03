/**
 * Who may frame the booker, and what Slate records about who does (#3137).
 *
 * The booker and the pages it moves to inside its frame (the confirmation, the manage
 * page, the rebook page, an advisor link) carried no `frame-ancestors` at all, so any
 * site could embed a live booker, and anyone holding a manage link could put that
 * page under somebody else's clicks. Dan decided the allow list on 2026-10-03 and the
 * order to build it in: OBSERVE first, then LOCK behind a stored admin switch that
 * defaults off, so the lock is only ever turned on against a measured list of who
 * actually frames the booker.
 *
 * Pure: no request, no database. scripts/test-frame-policy.ts drives it.
 */

/**
 * The origins that may frame the booker once the lock is on. THE one list: a partner
 * is added here, as a bare origin (`https://partner.example`) or a CSP host source.
 *
 * The production site in both spellings (the same pair `PRODUCTION_ORIGINS` holds, and
 * scripts/test-frame-policy.ts fails if the two drift), trypennie's dev site, and
 * localhost on any port for whoever is building an embed. Written out rather than
 * imported, because this is read by the middleware on every request and the module
 * that holds `PRODUCTION_ORIGINS` brings the alert copy and its date library with it.
 */
export const FRAME_ANCESTOR_ALLOW_LIST: readonly string[] = [
  "https://trypennie.com",
  "https://www.trypennie.com",
  "https://dev.trypennie.com",
  "http://localhost:*",
  "https://localhost:*",
];

/** The `frame-ancestors` sources when locked: Slate itself, then the allow list. */
export function frameAncestorSources(list: readonly string[] = FRAME_ANCESTOR_ALLOW_LIST): string[] {
  return ["'self'", ...list];
}

/**
 * Would the browser let this origin frame the booker once the lock is on? Judged the
 * way CSP judges the sources above: scheme and host exactly, and a `:*` source matching
 * any port (or none). The admin page uses this to say which framers the lock would
 * refuse, so it and the lock cannot disagree.
 */
export function isOriginAllowed(origin: string, list: readonly string[] = FRAME_ANCESTOR_ALLOW_LIST): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return list.some((source) => {
    const anyPort = source.endsWith(":*");
    let allowed: URL;
    try {
      allowed = new URL(anyPort ? source.slice(0, -2) : source);
    } catch {
      return false;
    }
    if (allowed.protocol !== url.protocol || allowed.hostname !== url.hostname) return false;
    return anyPort || allowed.port === url.port;
  });
}

/** One recorded row of `frame_origin_daily`. */
export interface FrameOriginRow {
  day: string;
  origin: string;
  surface: string;
  loads: number;
  last_seen: string;
}

/** One framing origin over the admin page's window. */
export interface FrameOriginSummary {
  origin: string;
  /** `refused` is a site the lock would turn away; `self` and `unnamed` name no site. */
  kind: "refused" | "allowed" | "self" | "unnamed";
  loads: number;
  surfaces: Record<string, number>;
  lastSeen: string;
}

const KIND_ORDER: Record<FrameOriginSummary["kind"], number> = { refused: 0, allowed: 1, self: 2, unnamed: 3 };

/**
 * The rows summed per origin, the ones the lock would refuse FIRST and busiest first
 * within each kind (L609): those are what somebody deciding whether to lock has to look
 * at, and the allowed ones are the healthy majority.
 */
export function summarizeFrameOrigins(
  rows: readonly FrameOriginRow[],
  list: readonly string[] = FRAME_ANCESTOR_ALLOW_LIST,
): FrameOriginSummary[] {
  const byOrigin = new Map<string, FrameOriginSummary>();
  for (const row of rows) {
    let s = byOrigin.get(row.origin);
    if (!s) {
      const kind =
        row.origin === "self"
          ? "self"
          : row.origin === "unstated" || row.origin === "(other)"
            ? "unnamed"
            : isOriginAllowed(row.origin, list)
              ? "allowed"
              : "refused";
      s = { origin: row.origin, kind, loads: 0, surfaces: {}, lastSeen: row.last_seen };
      byOrigin.set(row.origin, s);
    }
    const loads = Number(row.loads) || 0;
    s.loads += loads;
    s.surfaces[row.surface] = (s.surfaces[row.surface] ?? 0) + loads;
    if (row.last_seen > s.lastSeen) s.lastSeen = row.last_seen;
  }
  return [...byOrigin.values()].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.loads - a.loads || a.origin.localeCompare(b.origin),
  );
}

/**
 * The booker's pages, by name. A framed load is counted under one of these, so the
 * admin page can say whether the inner pages are really reached inside a frame, which
 * is what tells you the lock has to cover them. Never an id or a token.
 */
export const FRAME_SURFACES = ["book", "advisor-link", "confirmation", "manage", "rebook", "other"] as const;
export type FrameSurface = (typeof FRAME_SURFACES)[number];

/** Which booker page a path is, or null when it is not one at all. */
export function frameSurface(pathname: string): FrameSurface | null {
  if (pathname === "/book") return "book";
  if (pathname.startsWith("/book/advisor/")) return "advisor-link";
  if (/^\/booking\/manage\/[^/]+\/rebook$/.test(pathname)) return "rebook";
  if (/^\/booking\/manage\/[^/]+$/.test(pathname)) return "manage";
  if (/^\/booking\/(?!manage(?:\/|$))[^/]+$/.test(pathname)) return "confirmation";
  if (pathname === "/booking" || pathname.startsWith("/booking/") || pathname.startsWith("/book/")) {
    return "other";
  }
  return null;
}

/**
 * The fetch destinations `frame-ancestors` governs. `Sec-Fetch-Dest` names one of
 * these exactly when a browser is loading the page INTO something; a top level visit
 * says `document`, and a client side navigation's data fetch says `empty`.
 */
const FRAMING_DESTS = new Set(["iframe", "frame", "embed", "object"]);

/** Longer than any real origin; past it the value is not stored. */
export const FRAME_ORIGIN_MAX_LENGTH = 200;

/** A web origin, or null. Deliberately a local copy of the two lines it needs, so the
 *  middleware does not pull in the postMessage helpers beside `httpOrigin`. */
function webOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin.length > FRAME_ORIGIN_MAX_LENGTH ? null : url.origin;
  } catch {
    return null;
  }
}

export interface FramingObservation {
  /** The framing page's bare origin, `self` for a navigation inside the frame, or
   *  `unstated` when the browser and the host named nothing readable. */
  origin: string;
  surface: FrameSurface;
}

/**
 * What one request says about who framed the booker, or null when it is not a framed
 * load of a booker page.
 *
 * The REFERRER first: it is the browser's statement of the page that loaded the
 * frame, and under the default referrer policy a cross origin page sends its origin.
 * A referrer on Slate's own origin is a navigation inside the frame (the booker moving
 * to its confirmation), recorded as `self` rather than as Slate framing itself. With no
 * referrer, the `parentOrigin` widget.js declares is the fallback, since a host page
 * whose referrer policy strips everything still declares itself there. Both are
 * reduced to an origin here, so no path or query, which on a host page can carry a
 * lead's details, ever reaches storage.
 *
 * It is evidence for a person deciding the allow list, not a gate: a caller can send
 * any referrer it likes. The lock itself is enforced by the browser from the real
 * ancestor chain, never from this.
 */
export function framingObservation(input: {
  method: string;
  dest: string | null;
  referer: string | null;
  declared: string | null;
  ownOrigin: string;
  pathname: string;
}): FramingObservation | null {
  if (input.method !== "GET" && input.method !== "HEAD") return null;
  if (!input.dest || !FRAMING_DESTS.has(input.dest)) return null;
  const surface = frameSurface(input.pathname);
  if (!surface) return null;

  const own = webOrigin(input.ownOrigin);
  const referred = webOrigin(input.referer);
  if (referred) return { origin: referred === own ? "self" : referred, surface };
  if (input.referer) return { origin: "unstated", surface };
  const declared = webOrigin(input.declared);
  return { origin: declared ?? "unstated", surface };
}
