/**
 * How a times read says it is a program lead's (#4390). A client module: the Booker, the
 * manage page's reschedule picker and the routes all read these names from here.
 *
 * The token goes in a HEADER, never the address: Cloudflare logs the address in full
 * before any of Slate's code runs, and the token is a credential for as long as it lives.
 * The lead's zone goes in the address, only on a program lead's read, because the
 * placeholder's starts are judged against the calling window in that zone: a change of
 * zone is then a new read, shown loading, rather than old starts kept on screen. An
 * ordinary lead's address and headers are unchanged.
 */

export const PROGRAM_LEAD_HEADER = "x-slate-program-lead";
export const PROGRAM_LEAD_ZONE_PARAM = "leadZone";

/** The header carrying the token, or undefined for an ordinary lead. */
export function programLeadHeaders(token: string | null | undefined): Record<string, string> | undefined {
  return token ? { [PROGRAM_LEAD_HEADER]: token } : undefined;
}

/** `url` with the lead's zone added when a token rides along; unchanged otherwise. */
export function programLeadTimesUrl(url: string, token: string | null | undefined, zone: string): string {
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${PROGRAM_LEAD_ZONE_PARAM}=${encodeURIComponent(zone)}`;
}
