/**
 * The contract behind `pnpm verify:burst-counter` (#1564): the key it reports, the vocabulary
 * the endpoint answers in, and the one decision about whether the object really answered.
 *
 * WHY THERE IS A COMMAND AT ALL. The monitor lane reports the burst counter missing from a
 * deployment (#1558) by resolving `BURST_LIMITER` as a property read, and it stops there
 * deliberately: asking the object whether it ANSWERS would create it, spend a subrequest out of
 * the invocation four lanes share, and give it an alarm to clean up on every tick forever. The
 * cost of that correct choice is that a counter which is bound but unreachable reads as fine,
 * and stays that way until one caller crosses the escalation threshold, which before cutover
 * could be months away. That is the #1394 family: a detector that has never once concluded.
 *
 * So the answering half is proved out of band instead, on the `pnpm verify:availability-truth`
 * precedent (#1315): report a fixed key, read the count back, report it again, and require the
 * count to have RISEN. Both directions or it proves nothing (L1).
 *
 * This module is shared rather than duplicated at each end. The route builds its replies from
 * the vocabulary below and the reader in `scripts/lib/burst-counter-live-control.ts` reads them
 * from the same one, so a renamed reason cannot leave the reader quietly mapping every failure
 * onto the same guess (L41).
 */
import { burstKey } from "@/lib/rate-limit-burst";

/**
 * The key space the verification reports into, and the entire reason it cannot touch a real
 * caller's count.
 *
 * A real caller's key is `burstKey(spec.area, callerKey)` for a spec in `EDGE_LIMITERS`, and the
 * Durable Object id is derived from that whole string, so the area prefix is what keeps two
 * counts apart. No edge limiter has this area, and none can take it: the caller half of a real
 * key is an address or an API key id, which cannot change the prefix, so the only way to collide
 * is a new limiter adopting this area name. `scripts/test-burst-counter-live-control.ts` walks
 * the shipped `EDGE_LIMITERS` table and fails if one ever does.
 *
 * The distinction matters because this command WRITES. A verification landing on a lead's count
 * would inflate it toward a ceiling, and the thing at the far end of an inflated count is a real
 * lead being refused.
 */
export const BURST_VERIFY_AREA = "verify-counter";

/** The fixed key. Fixed on purpose: the count has to be able to rise between two reports, which
 *  a fresh key each run could never show. It is one object, and its own alarm deletes it two
 *  windows after the last report, so a run leaves nothing behind. */
export const BURST_VERIFY_KEY = burstKey(BURST_VERIFY_AREA, "slate-verify-command");

/**
 * What the endpoint says happened, as a machine reason rather than as prose.
 *
 * Distinct causes, distinct answers (L11). A reader that had to tell these apart by matching
 * words in a sentence would be reading text that quotes the binding name in the success case and
 * in three of the failures (L156).
 */
export const BURST_PROBE_REASON = {
  /** The object answered and this is the count for its current window. */
  counted: "counted",
  /** The running deployment could not read its own request context, so nothing was looked up.
   *  Not the same finding as a binding that is absent, and not the same remedy. */
  contextUnreadable: "context-unreadable",
  /** The context read fine and `BURST_LIMITER` is not in it: a deploy that shipped without it. */
  bindingMissing: "binding-missing",
  /** The namespace resolved, and the object did not answer when actually called. This is the
   *  gap the presence read cannot see, and the whole reason the command exists. */
  objectUnreachable: "object-unreachable",
  /** The object answered with something that is not a count, so there is nothing to compare. */
  noCount: "no-count",
} as const;

export type BurstProbeReason = (typeof BURST_PROBE_REASON)[keyof typeof BURST_PROBE_REASON];

/**
 * Read what the Durable Object answered.
 *
 * Both fields are required, and an unreadable one is refused rather than defaulted: a count
 * defaulted to 0 would make an object that answered nothing indistinguishable from one that has
 * counted nothing, and a window defaulted to now would let two readings from different windows
 * be compared as though they were one count.
 */
export function readBurstCountReply(
  raw: unknown,
): { ok: true; count: number; windowStartMs: number } | { ok: false; detail: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, detail: "the counter's reply was not an object" };
  }
  const body = raw as { count?: unknown; windowStartMs?: unknown };
  if (typeof body.count !== "number" || !Number.isFinite(body.count)) {
    return { ok: false, detail: "the counter's reply carried no readable count" };
  }
  if (typeof body.windowStartMs !== "number" || !Number.isFinite(body.windowStartMs)) {
    return { ok: false, detail: "the counter's reply carried no readable window" };
  }
  return { ok: true, count: body.count, windowStartMs: body.windowStartMs };
}
