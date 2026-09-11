/**
 * The address Slate SAW, echoed back to a load run (#2243). Off everywhere else.
 *
 * A booking path load run has to attribute its write 429s, and the per address
 * ceiling is keyed on `cf-connecting-ip`. The runner cannot work that out for
 * itself: a CI runner sits behind egress NAT, so it shares an address with
 * everything else on that host, and a run that assumed its own address would
 * report the limiter refusing IT when something else had spent the budget.
 *
 * Gated ENTIRELY behind `SLATE_LOADTEST`, exactly as the Google stub is. Echoing a
 * caller's address back is a small disclosure and it has no business on a
 * production response, so the gate is the feature: with the flag unset this adds
 * a header to nothing.
 */
import { LOADTEST } from "@/lib/google/loadtest-stub";
import { clientIp } from "@/lib/rate-limit-core";

export const SEEN_IP_HEADER = "x-loadtest-seen-ip";

/**
 * Stamp the header on a response, and return the SAME response so a call site can
 * wrap a return without restructuring it.
 *
 * It reads the address through `clientIp`, the same function the limiter keys on,
 * rather than reading the header itself: two readings of one fact would be free to
 * disagree, and the disagreement would be invisible precisely when somebody is
 * using this to explain a refusal (L70).
 */
export function stampSeenIp<T extends Response>(res: T, headers: Headers): T {
  if (!LOADTEST) return res;
  try {
    res.headers.set(SEEN_IP_HEADER, clientIp(headers));
  } catch {
    // An immutable response head is not worth failing a booking over: the run loses
    // one attribution and the booking is unaffected.
  }
  return res;
}
