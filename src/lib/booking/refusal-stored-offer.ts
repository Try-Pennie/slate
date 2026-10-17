/**
 * After a `candidate_read_empty` refusal, does the stored row still offer the time
 * that was refused (#3366)?
 *
 * On 2026-10-06 two leads in bucket 112 were refused nine times in a minute and
 * re-offered the same times after each refusal, times that had been full for six to
 * fifteen hours. Two layers could have served them: the stored `bucket_slots` row,
 * or a colo's edge cache entry in front of it. Nothing recorded which, so the cause
 * had to be argued from reconstruction. This reads the row once, as the refusal is
 * answered, and says on one log line whether it still offers the refused instant and
 * how old it is:
 *
 * - `offered` on a fresh row: the row disagrees with the confirm's own predicate,
 *   which is a compute divergence and the thing to chase.
 * - `not_offered`: the row was right, so whatever the lead was shown came from in
 *   front of it (the edge cache, or a page that had not refetched). The route's
 *   `slots served` line names the tier and colo for that request.
 *
 * Unknown is never folded into either answer: a missing, malformed or unreadable row
 * is said as such and the overall answer is null (L11, L215).
 *
 * Pure apart from the injected read, log, refresh and timer, so the node suite drives
 * it. The live binding is `refusal-stored-offer-live.ts`. It
 * carries bucket codes, instants and stamps, and the refused lead's Salesforce lead
 * id (an external id) so it joins with the `confirm answered` line; nothing else
 * about the lead.
 */
import type { RefusalTrace } from "@/lib/booking/refusal-trace";
import type { LogFields } from "@/lib/log";
import { shapePrecomputedRow } from "@/lib/availability/precompute-shape";
import { servedSlotsForRung } from "@/lib/availability/offered-window";
import { parseStampMs } from "@/lib/date/stamp";
import { rowProvenance } from "@/lib/availability/slot-row-writer";
import type { ScheduleTimer } from "@/lib/read-within-deadline";

/** A `bucket_slots` row as read for this check. */
export interface StoredSlotRow {
  bucket_code: string;
  payload: unknown;
  computed_at: string;
}

export interface StoredOfferDeps {
  /** One read of `bucket_slots` by primary key for these codes. Throws on failure. */
  readRows(codes: string[]): Promise<StoredSlotRow[]>;
  nowMs(): number;
  /**
   * Refresh the pool a code is in, coalesced, so the stale time stops being offered
   * (#3633). Called only for a pool the confirm has just PROVEN stale (its stored row
   * still offers the refused instant); the live binding wires the booking path's own
   * coalesced refresh. May reject, which is logged, never thrown.
   */
  refreshPool(code: string): Promise<void>;
  /** Keep the started check running past the response (#3796); `afterResponse` live. */
  keepAlive(work: Promise<void>): void;
  /** The wait for the allowance to run out, cancellable, injected so a test never
   *  waits for real (L524). */
  timer: ScheduleTimer;
  log: {
    info(tag: string, fields: LogFields): void;
    warn(tag: string, fields: LogFields, err?: unknown): void;
  };
}

type Verdict = "offered" | "not_offered" | "no_row" | "unreadable";

const TAG = "booking";
const MSG = "refused time read against the stored row";
const MSG_REFRESH_FAILED = "could not refresh a pool a refused confirm proved stale";
const MSG_CHECK_FAILED = "stored offer check failed";

/**
 * The codes whose rows to read for this refusal, or null when it is not one this
 * check is for. Only `candidate_read_empty`: a Google refusal or a lost race was
 * right for the row to offer, so reading it would say nothing.
 */
export function storedOfferCodes(t: RefusalTrace): string[] | null {
  if (t.stage !== "candidate_read_empty" || !t.requestedStart) return null;
  const codes = t.rungs.length > 0 ? t.rungs.map((r) => r.code) : t.bucketCode ? [t.bucketCode] : [];
  const unique = [...new Set(codes)];
  return unique.length > 0 ? unique : null;
}

/**
 * The codes whose stored row still OFFERS the refused instant: the pools a confirm
 * has just proven stale and that should be refreshed (#3633). Empty when the refusal
 * is not one this check is for, or when no row offers it (a correct row, a missing
 * row and an unreadable row are all left alone; stale was never proven). Judged by the
 * same `servedSlotsForRung` rule the log line uses, so the pool refreshed is exactly
 * the one reported as `offered`.
 */
export function offeredCodes(t: RefusalTrace, rows: StoredSlotRow[]): string[] {
  const codes = storedOfferCodes(t);
  if (!codes) return [];
  const requestedCode = t.bucketCode ?? codes[0] ?? "";
  const startMs = parseStampMs(t.requestedStart);
  const byCode = new Map(rows.map((r) => [r.bucket_code, r]));
  return codes.filter((code) => verdictFor(requestedCode, code, byCode.get(code), startMs) === "offered");
}

function verdictFor(requestedCode: string, code: string, row: StoredSlotRow | undefined, startMs: number | null): Verdict {
  if (!row) return "no_row";
  const shaped = shapePrecomputedRow(row);
  if (!shaped || startMs === null) return "unreadable";
  const served = servedSlotsForRung(requestedCode, code, shaped);
  return served.some((s) => parseStampMs(s) === startMs) ? "offered" : "not_offered";
}

/** The log fields for a read that returned `rows`. */
export function storedOfferFields(t: RefusalTrace, rows: StoredSlotRow[], nowMs: number): LogFields {
  const codes = storedOfferCodes(t) ?? [];
  const requestedCode = t.bucketCode ?? codes[0] ?? "";
  const startMs = parseStampMs(t.requestedStart);
  const byCode = new Map(rows.map((r) => [r.bucket_code, r]));
  const verdicts = codes.map((code) => ({ code, row: byCode.get(code), v: verdictFor(requestedCode, code, byCode.get(code), startMs) }));
  const age = (stamp: string | undefined) => {
    const ms = parseStampMs(stamp);
    return ms === null ? "-" : String(Math.max(0, Math.round((nowMs - ms) / 1000)));
  };
  return {
    msg: MSG,
    ...common(t),
    stored_offer: verdicts.map((x) => `${x.code}:${x.v}`).join(","),
    stored_computed_at: verdicts.map((x) => `${x.code}:${x.row?.computed_at ?? "-"}`).join(","),
    stored_age_s: verdicts.map((x) => `${x.code}:${age(x.row?.computed_at)}`).join(","),
    // #3381: which path wrote each row, and the newest booking splice since its
    // compute ("+reoffer" when a move re-offered a window, the one splice that can add a
    // time). "-" is not recorded, never a writer.
    stored_written_by: verdicts.map((x) => `${x.code}:${provenance(x.row).writtenBy ?? "-"}`).join(","),
    stored_spliced: verdicts.map((x) => `${x.code}:${provenance(x.row).spliced ?? "-"}`).join(","),
    stored_row_offers_start: overall(verdicts.map((x) => x.v)),
  };
}

const provenance = (row: StoredSlotRow | undefined) => rowProvenance(row?.payload);

function common(t: RefusalTrace): LogFields {
  return { requested_start: t.requestedStart, bucket_code: t.bucketCode, lead_id: t.leadId ?? null };
}

/** Offered anywhere is offered; otherwise any unknown makes the whole answer unknown. */
function overall(vs: Verdict[]): boolean | null {
  if (vs.includes("offered")) return true;
  if (vs.length === 0 || vs.some((v) => v === "no_row" || v === "unreadable")) return null;
  return false;
}

/** A started check: what the route holds its answer for, and the whole check. */
export interface StoredOfferCheck {
  /**
   * Wait at most `maxMs` for the refresh a proven-stale row asked for (#3796), then
   * let the response go. Resolves at once when no refresh was asked for, or as soon
   * as it settles either way, so a lead is never held behind a refresh that failed.
   * Never rejects. Call it once, as the response is about to be sent.
   */
  beforeResponse(maxMs: number): Promise<void>;
  /** The whole check, read and refresh, settled. Never rejects. */
  settled: Promise<void>;
}

/** The check for a refusal there is nothing to read for: holds nothing, reads nothing. */
export const NOTHING_TO_CHECK: StoredOfferCheck = { beforeResponse: async () => {}, settled: Promise.resolve() };

/**
 * Start the read, the log line and the refresh of any pool the row proves stale, at
 * once, and hand back what the route holds its answer for. Never throws: a failed
 * read is said at warn with every code unreadable rather than as not offered, and a
 * failed refresh is said at warn too.
 *
 * The refresh (#3633) fires only for a pool whose stored row still offers the refused
 * instant, which the confirm has just proven wrong. It is coalesced with the booking
 * and push refreshes, so a crowd retrying one dead time costs one recompute.
 *
 * #3796: the booker reloads its times about 300ms after the 409, and that reload is
 * the read the refresh exists for. Refreshed after the response, the reload usually
 * won the race and was served the row the confirm had just proven wrong, so the lead
 * could pick a second time the same calendar change had killed. So the route holds
 * its answer for the refresh (`beforeResponse`), but only for what is left of its
 * failure path allowance: a refresh that cannot finish inside it carries on after the
 * response (`keepAlive`), as it always did. Which way it went is on the stored offer
 * line, `refreshed_before_response`, so the share that still races is measurable;
 * null when no refresh was asked for, never false. The read happens before the
 * response too, because whether to refresh at all is its verdict, and the line is
 * written when that answer is known: the refresh settling, or the response going.
 *
 * If the compute ever DISAGREED with the confirm (a recomputed row still offering a
 * time the confirm refuses), each retry would ask for another refresh that cannot
 * help. That is bounded, not open ended: the coalescer allows one compute per pool
 * per `POST_CONFIRM_REFRESH_WINDOW_MS` per isolate, the rate a hot pool's bookings
 * already cause and the #3258 load run measured. A refresh joining one inside that
 * window waits for the trailing compute, so it cannot finish inside the allowance and
 * reads `refreshed_before_response=false`. And a divergence stays visible: the line
 * then reads `offered` on a row only seconds old. A refusal carries no confirm
 * timestamp, so skipping on row age would be a guess that also skips genuinely stale
 * rows.
 */
export function startStoredOfferCheck(t: RefusalTrace, deps: StoredOfferDeps): StoredOfferCheck {
  const codes = storedOfferCodes(t);
  if (!codes) return NOTHING_TO_CHECK;

  let responded = false;
  // Writes the stored offer line once the read is in, with the refresh's answer.
  let writeLine: ((refreshedBeforeResponse: boolean) => void) | null = null;

  const settled = (async () => {
    let rows: StoredSlotRow[];
    try {
      // #3797: the rows the lost race judgement already read as the refusal was
      // recorded, in this same request, rather than a second read of them.
      rows = t.storedRows ?? (await deps.readRows(codes));
    } catch (err) {
      deps.log.warn(
        TAG,
        {
          msg: MSG,
          ...common(t),
          stored_offer: codes.map((c) => `${c}:unreadable`).join(","),
          stored_row_offers_start: null,
        },
        err,
      );
      return;
    }
    const fields = storedOfferFields(t, rows, deps.nowMs());
    const stale = offeredCodes(t, rows);
    if (stale.length === 0) {
      deps.log.info(TAG, { ...fields, refreshed_before_response: null });
      return;
    }
    let written = false;
    writeLine = (refreshedBeforeResponse) => {
      if (written) return;
      written = true;
      deps.log.info(TAG, { ...fields, refreshed_before_response: refreshedBeforeResponse });
    };
    if (responded) writeLine(false);
    // `Promise.resolve().then` so a SYNCHRONOUS throw from refreshPool becomes a
    // rejection `allSettled` can catch, rather than escaping this check (which must
    // never throw).
    const results = await Promise.allSettled(
      stale.map((code) => Promise.resolve().then(() => deps.refreshPool(code))),
    );
    // Refreshed only when every pool it asked for was, and before the response went.
    writeLine(!responded && results.every((r) => r.status === "fulfilled"));
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        deps.log.warn(TAG, { msg: MSG_REFRESH_FAILED, ...common(t), refreshed_code: stale[i] }, r.reason);
      }
    });
  })().catch((err) => {
    // The route awaits this before its 409, so a fault nobody predicted here must
    // never become the lead's answer: it is said, and the refusal goes out as it was.
    deps.log.warn(TAG, { msg: MSG_CHECK_FAILED, ...common(t) }, err);
  });

  // The refresh is shared with every other request refreshing the pool, so it must
  // outlive this response rather than end with it.
  deps.keepAlive(settled);

  return {
    settled,
    async beforeResponse(maxMs) {
      if (maxMs > 0) {
        let cancel = () => {};
        const allowanceSpent = new Promise<void>((resolve) => { cancel = deps.timer(maxMs, resolve); });
        await Promise.race([settled, allowanceSpent]);
        cancel();
      }
      responded = true;
      writeLine?.(false);
    },
  };
}
