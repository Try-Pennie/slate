/**
 * What has to come out of a log line before it leaves Cloudflare (#3105).
 *
 * The tail worker (`worker/log-tail/index.ts`) ships Slate's lines to Better Stack,
 * which keeps them for far longer than Cloudflare's 7 days. A longer lived copy of
 * a log is a longer lived copy of whatever the log carries, so three things are
 * removed on the way out, in this order:
 *
 *   1. Every URL's query string and fragment, WHOLE. The booker's address carries a
 *      lead's name, email and phone as query parameters, percent encoded, and `%40`
 *      defeats any shape a scrub looks for (L741). `scrubContactData` already does
 *      this for free text; `redactUrl` does it for a field that IS one address.
 *   2. Path segments that are themselves a credential: a manage token, a legacy
 *      advisor link token. Anybody holding the URL can act on the booking, so the
 *      segment is replaced rather than shortened.
 *   3. Contact data shapes (email, phone, long digit runs), through the one
 *      scrubber the repo already has (L41: never a second copy of it).
 *
 * No `@/` imports, so the tail worker bundles it and the node tests run it
 * directly.
 */
import { scrubContactData, withoutUrlQuery } from "../api/client-error-scrub.ts";

/** What a redacted path segment reads as. A marker rather than an empty segment, so
 *  a reader can tell something was removed and which route it was. */
export const REDACTED_SEGMENT = "[redacted]";

/**
 * Every DYNAMIC route segment under `src/app`, and what the shipped log does with
 * its value. `scripts/test-log-shipping-routes.ts` walks the route tree and fails
 * when this list and the tree disagree in EITHER direction, so a new `[param]`
 * route cannot ship its value to Better Stack unclassified (L96).
 *
 * `siblings` are the STATIC directories beside the dynamic one. Next routes a
 * static name before a dynamic one, so `/api/bookings/cancel` is the cancel route
 * and not a token, and the redaction must not eat it. The same test derives them
 * from the tree, so a new static route there cannot be redacted by mistake.
 */
export const DYNAMIC_SEGMENT_POLICY: readonly {
  route: string;
  action: "redact" | "keep";
  siblings: readonly string[];
  why: string;
}[] = [
  {
    route: "/booking/manage/[token]",
    action: "redact",
    siblings: [],
    why: "the manage token is the lead's only credential: whoever holds it can cancel or move the call",
  },
  {
    route: "/api/bookings/[token]",
    action: "redact",
    siblings: ["bookable", "cancel", "cancel-duplicate", "reassign"],
    why: "the same manage token, on the cancel and phone routes the manage page posts to",
  },
  {
    route: "/book/advisor/[link]",
    action: "redact",
    siblings: [],
    why: "a link sent before #3026 carries the advisor's 64 hex link token, which books with them",
  },
  {
    route: "/booking/[id]",
    action: "keep",
    siblings: ["manage"],
    why: "the lead's Salesforce id, an external id that is safe to store (Dan, 2026-10-01); the contact details ride in the query, which is stripped",
  },
  {
    route: "/admin/agents/[id]",
    action: "keep",
    siblings: [],
    why: "a staff user's internal uuid, behind sign in",
  },
  {
    route: "/admin/bookings/[id]",
    action: "keep",
    siblings: [],
    why: "a booking's internal uuid, behind sign in; it grants nothing on its own",
  },
  {
    route: "/api/admin/agents/[id]",
    action: "keep",
    siblings: [],
    why: "a staff user's internal uuid, behind sign in",
  },
  {
    route: "/api/admin/bookings/[id]",
    action: "keep",
    siblings: ["search"],
    why: "a booking's internal uuid, behind sign in",
  },
  {
    route: "/advisor-photo/[sha]",
    action: "keep",
    siblings: [],
    why: "a content hash of a staff photo",
  },
];

/** Each redacted route as its static segments (`["booking", "manage"]`) and the
 *  static siblings that sit where the token would. Built once, at load. */
const REDACTIONS: readonly { statics: readonly string[]; siblings: readonly string[] }[] =
  DYNAMIC_SEGMENT_POLICY.filter((p) => p.action === "redact").map((p) => ({
    statics: p.route.split("/").filter(Boolean).slice(0, -1),
    siblings: p.siblings,
  }));

/**
 * Something path shaped inside free text: an optional `scheme://host`, then a run
 * starting at a slash or an encoded one, up to whitespace, a query or fragment, a
 * quote or a bracket. The host is captured apart so the scheme's own `//` is never
 * collapsed as if it were a doubled path slash.
 */
const PATH_SPAN = /([a-z][a-z0-9+.-]*:\/\/[^\s/?#"'<>()]*)?((?:\/|%2f)[^\s?#"'<>()]*)/gi;

/** One segment as a router would compare it: decoded ONCE (never repeatedly, so a
 *  double encoding stays what it is), then lowercased. Undecodable stays raw. */
function comparable(segment: string): string {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return segment.toLowerCase();
  }
}

/**
 * Redact the token in one path, matched the way a request can actually reach the
 * route (review of #3160): an encoded slash splits a segment, a run of slashes is
 * one separator, and the static segments match in any case or encoding. A path
 * that matches no redacted route comes back EXACTLY as it was, so a Salesforce id
 * keeps its case and nothing is decoded that did not need to be. A matched one
 * comes back normalised, with its static segments in their canonical spelling;
 * every other segment keeps its raw text, so nothing decoded reaches the output.
 */
function redactPath(path: string): string {
  const trailing = /(?:\/|%2f)$/i.test(path);
  const segments = path.split(/\/|%2f/i).filter((s) => s !== "");
  const out = [...segments];
  let matched = false;
  for (let i = 0; i < segments.length; i++) {
    for (const rule of REDACTIONS) {
      const at = i + rule.statics.length;
      if (at >= segments.length) continue;
      if (!rule.statics.every((s, j) => comparable(segments[i + j]) === s)) continue;
      rule.statics.forEach((s, j) => (out[i + j] = s));
      const sibling = rule.siblings.find((s) => s === comparable(segments[at]));
      out[at] = sibling ?? REDACTED_SEGMENT;
      matched = true;
      i = at;
      break;
    }
  }
  if (!matched) return path;
  return `/${out.join("/")}${trailing ? "/" : ""}`;
}

/** Replace every credential bearing path segment inside `text`, wherever it sits:
 *  a bare path, an absolute URL, or a sentence quoting one. */
export function redactTokenPaths(text: string): string {
  return text.replace(PATH_SPAN, (_m, host: string | undefined, path: string) => (host ?? "") + redactPath(path));
}

/** A field that IS one address: cut the query and fragment first (a decoded query
 *  can hold a space, which would end any free text match), then the token paths. */
export function redactUrl(url: string): string {
  return redactTokenPaths(withoutUrlQuery(url));
}

/** Free text: the token paths, then the shared contact data scrub, which also cuts
 *  every query string it finds attached to something URL shaped. */
export function redactText(text: string): string {
  return scrubContactData(redactTokenPaths(text));
}
