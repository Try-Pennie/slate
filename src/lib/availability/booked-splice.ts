import {
  affectedWindow,
  reachedDailyCap,
  spliceRanges,
  widenToLocalDay,
  type SlotLists,
  type SpliceEventType,
  type SpliceRange,
  type SpliceWindow,
} from "./slot-splice.ts";
import type { SpliceRowOutcome } from "./slot-row-write.ts";

export type { SpliceRange };

/**
 * After a booking, take the booked time out of what EVERY pool the booked advisor
 * serves is offering, within seconds, by re-judging only the window it can have
 * changed and splicing that into the stored rows (#3324).
 *
 * It replaced a whole pool recompute over the whole horizon for the booked code's
 * pool alone (#3293). That cost about 1.2s of CPU crowding per booking under load
 * (#3258) and left the advisor's other pools offering the taken time until the lane
 * reached them, up to four minutes. The window here is a call or so either side of
 * the booking, or the advisor's local day when the booking takes them to their cap,
 * so the compute is a few dozen starts rather than a few days of them.
 *
 * Pure and dependency injected, so the real slot predicate and the real row splice
 * can be driven over fakes: `scripts/test-booked-splice.ts`.
 */

/** The booking, as the confirm knew it once its busy block had committed. */
export interface BookedTime {
  userId: string;
  startsAt: string;
  endsAt: string;
  /** An instant at or after the booking's busy block committed. Recorded in each row
   *  as the fence an older full compute must respect (see `slot-splice.ts`). */
  fenceAtMs: number;
}

/** Who the loaded members are, for the cap check. */
interface LoadedMember {
  userId: string;
  timezone: string;
  dayCounts?: Map<string, number>;
}

export interface BookedSpliceDeps<
  R extends { eventType: SpliceEventType & { daily_cap: number | null } },
  L extends { members: LoadedMember[] },
> {
  now(): number;
  /** The advisor's pools, each as its bucket codes, the representative first. */
  agentPools(userId: string): Promise<string[][]>;
  /** The representative's bucket and event type, or null when it no longer exists. */
  resolve(code: string): Promise<R | null>;
  /** Every read the compute needs, over the range's READ window. */
  load(resolved: R, code: string, range: SpliceRange): Promise<L | null>;
  /** The shared slot predicate over the range's COMPUTE window. */
  compute(loaded: L, range: SpliceRange, nowMs: number): SlotLists;
  /** Splice one code's row (`spliceSlotRow`). */
  writeSplice(
    code: string,
    w: SpliceWindow,
    judge: SlotLists,
    fenceAtMs: number,
    computeStartedMs: number,
  ): Promise<SpliceRowOutcome>;
  /** Drop one code's edge cache entry, so the next read serves the spliced row. */
  invalidate(code: string): Promise<void>;
  warn(msg: string, err?: unknown): void;
}

export interface BookedSpliceOutcome {
  /** Pools the advisor serves, every one of which was attempted. */
  pools: number;
  /** Codes whose row now has the booked window spliced in. */
  spliced: number;
  /** Codes with no row yet, which the lane builds. */
  noRow: number;
  /** Codes whose splice failed; their rows are as they were and the lane covers them. */
  failed: number;
  /** Pools whose window widened to the advisor's whole day (the booking hit the cap). */
  widened: number;
}

/** How many times one pool's window is computed again because something landed
 *  after its reads began (`recompute`). Past it the code is a failure for the lane. */
const COMPUTE_ATTEMPTS = 2;

export async function spliceBookedTime<
  R extends { eventType: SpliceEventType & { daily_cap: number | null } },
  L extends { members: LoadedMember[] },
>(
  booked: BookedTime,
  deps: BookedSpliceDeps<R, L>,
  opts: { readsOnly?: boolean } = {},
): Promise<BookedSpliceOutcome> {
  const outcome: BookedSpliceOutcome = { pools: 0, spliced: 0, noRow: 0, failed: 0, widened: 0 };
  // parse-ok: both come from the stored booking, NOT NULL timestamptz columns.
  const startMs = Date.parse(booked.startsAt);
  // parse-ok: as above.
  const endMs = Date.parse(booked.endsAt);
  const pools = await deps.agentPools(booked.userId);
  outcome.pools = pools.length;

  // One pool at a time, each inside its own failure boundary (L73): a pool that
  // cannot be read must not cost another pool its splice.
  for (const codes of pools) {
    const representative = codes[0];
    if (!representative) continue;
    try {
      const r = await splicePool(codes, representative);
      outcome.spliced += r.spliced;
      outcome.noRow += r.noRow;
      outcome.failed += r.failed;
      if (r.widened) outcome.widened++;
    } catch (err) {
      outcome.failed += codes.length;
      deps.warn(`splice of pool ${codes.join("+")} failed: ${err instanceof Error ? err.message : String(err)}`, err);
    }
  }
  return outcome;

  async function splicePool(codes: string[], representative: string) {
    const r = { spliced: 0, noRow: 0, failed: 0, widened: false };
    const resolved = await deps.resolve(representative);
    if (!resolved) throw new Error(`bucket ${representative} no longer exists`);
    const ev = resolved.eventType;
    let window = affectedWindow(startMs, endMs, ev);

    let pending = codes;
    for (let attempt = 0; attempt < COMPUTE_ATTEMPTS && pending.length > 0; attempt++) {
      // Before anything is read, so a booking fenced at or after it is one this
      // compute cannot be shown to have seen.
      const computeStartedMs = deps.now();
      let range = spliceRanges(window, ev);
      let loaded = await deps.load(resolved, representative, range);
      if (!loaded) throw new Error(`bucket ${representative} could not be loaded`);

      // The count already includes this booking. At the cap the advisor is refused
      // for the rest of their local day, so the whole day is judged again.
      const advisor = loaded.members.find((m) => m.userId === booked.userId);
      if (!r.widened && advisor && reachedDailyCap(advisor, startMs, ev.daily_cap)) {
        r.widened = true;
        window = widenToLocalDay(window, startMs, advisor.timezone);
        range = spliceRanges(window, ev);
        loaded = await deps.load(resolved, representative, range);
        if (!loaded) throw new Error(`bucket ${representative} could not be loaded`);
      }
      if (opts.readsOnly) return r;

      const judge = deps.compute(loaded, range, deps.now());
      const again: string[] = [];
      // The codes' rows are independent, so their writes go together: a pool's wall
      // time is one row's read and swap rather than one per code. Each still has its
      // own failure boundary.
      const settled = await Promise.all(
        pending.map(async (code): Promise<[string, SpliceRowOutcome]> => {
          try {
            return [code, await deps.writeSplice(code, window, judge, booked.fenceAtMs, computeStartedMs)];
          } catch (err) {
            deps.warn(`splice of ${code} threw`, err);
            return [code, "failed"];
          }
        }),
      );
      for (const [code, result] of settled) {
        if (result === "spliced") r.spliced++;
        else if (result === "no-row") r.noRow++;
        else if (result === "recompute" && attempt + 1 < COMPUTE_ATTEMPTS) again.push(code);
        else {
          r.failed++;
          deps.warn(`splice of ${code} was not stored (${result}); its row is unchanged and the lane covers it`);
        }
        if (result === "spliced") {
          await deps.invalidate(code).catch((err) => deps.warn(`edge cache drop for ${code} failed`, err));
        }
      }
      pending = again;
    }
    return r;
  }
}
