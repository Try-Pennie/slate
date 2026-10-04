// How the preflight chooses and books its control slot (#3236).
//
// WHY. Load run 37225186978 (2026-10-04) declared itself warm about three seconds
// after hydration drive 7. That drive gave the only New York agent still free at
// the first offered time a stub meeting over it, and the preflight then booked that
// time from a slot list computed BEFORE the drive. The confirm path correctly found
// nobody free and answered 409 SLOT_TAKEN, so the run was lost to the preflight's
// own stale list. Whether it bit depended on the time of day the run was dispatched,
// because the stub meeting grid is anchored to each calendar's hydration time
// (src/lib/google/loadtest-stub.ts).
//
// Two changes, both here so they are driven offline with an injected fetch and no
// real clock (L524):
//
//   after a warm up that drove hydration, recompute once and read the times AGAIN,
//   so the control chooses from a list computed over the calendars as they now
//   stand;
//
//   on SLOT_TAKEN, read again and retry ONCE with the next offered time. A second
//   refusal still fails the preflight, naming both times, because two lost slots in
//   a row is no longer a race with our own drive and says something about the run.
import { offeredSlots } from "./book-plan.ts";
import { SLOT_TTL_SECONDS } from "../../src/lib/availability/slot-cache.ts";

/**
 * How long to wait before any re-read of the offered times.
 *
 * /api/availability answers first from the edge cache (`caches.default`) for
 * SLOT_TTL_SECONDS. A recompute drive deletes that entry only for the pools it
 * judges due (`poolsDueForRecompute`), and a SLOT_TAKEN deletes nothing, so a read
 * straight afterwards can be served the very list the refresh exists to replace.
 * Waiting out the cache lifetime, plus a margin for clock and delivery slack, means
 * the re-read reaches the stored row. Derived from the shipped TTL so raising it
 * raises this rather than leaving the wait short.
 */
const SLOT_CACHE_SETTLE_MARGIN_MS = 1_500;
export const SLOT_CACHE_SETTLE_MS = SLOT_TTL_SECONDS * 1000 + SLOT_CACHE_SETTLE_MARGIN_MS;

export type Sleep = (ms: number) => Promise<void>;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Whether the warm up's slot list may predate the calendars it judged.
 *
 * Any hydration drive can write stub meetings that the slot cache has not been
 * recomputed over yet, so a list read in the same pass is not to be trusted for a
 * real booking. With no drive the list was computed over calendars nothing touched.
 */
export function needsPostWarmupRefresh(p: { hydrationDrives: number }): boolean {
  return p.hydrationDrives > 0;
}

/** The times a bucket offers, through the shared reader; throws on a refusal. */
export async function readOfferedSlots(fetchImpl: FetchLike, baseUrl: string, code: string): Promise<string[]> {
  const res = await fetchImpl(`${baseUrl}/api/availability?bucket=${encodeURIComponent(code)}`);
  if (!res.ok) {
    throw new Error(`availability for bucket ${code} answered ${res.status}, so no control booking could be made`);
  }
  return offeredSlots(await res.json());
}

/**
 * Drive the recompute lane once and re-read the offered times, when the warm up
 * drove hydration. Otherwise the warm up's own list stands and nothing is spent.
 */
export async function refreshAfterWarmup(
  p: { hydrationDrives: number },
  slots: string[],
  deps: {
    driveRecompute: () => Promise<string>;
    readSlots: () => Promise<string[]>;
    sleep: Sleep;
    log?: (line: string) => void;
  },
): Promise<{ refreshed: boolean; slots: string[] }> {
  if (!needsPostWarmupRefresh(p)) return { refreshed: false, slots };
  const answered = await deps.driveRecompute();
  await deps.sleep(SLOT_CACHE_SETTLE_MS);
  const fresh = await deps.readSlots();
  deps.log?.(
    `recompute after ${p.hydrationDrives} hydration drive(s), before choosing the control slot: ` +
      `${answered}; ${fresh.length} times offered now`,
  );
  return { refreshed: true, slots: fresh };
}

export interface ControlBookingDeps {
  fetch: FetchLike;
  baseUrl: string;
  apiKey: string;
  bucketCode: string;
  /** The booking body for a given start; the caller owns the attendee and ids. */
  bodyFor: (start: string) => Record<string, unknown>;
  /** Waits out the edge slot cache before the retry's re-read. */
  sleep: Sleep;
  log?: (line: string) => void;
}

export type ControlBookingOutcome =
  | { ok: true; start: string; attempts: number; status: number; body: string }
  | { ok: false; why: string };

function refusalCode(text: string): string | null {
  try {
    const code = (JSON.parse(text) as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/**
 * Book the control on the first offered time, and on a lost slot read again and
 * try the next offered time once. Never a third attempt.
 */
export async function bookControlSlot(
  slots: string[],
  deps: ControlBookingDeps,
): Promise<ControlBookingOutcome> {
  const first = slots[0];
  if (first === undefined) {
    return { ok: false, why: `bucket ${deps.bucketCode} offered no times, so no control booking could be made` };
  }

  const attempt = async (start: string, n: number) => {
    deps.log?.(`control booking attempt ${n}: bucket ${deps.bucketCode} at ${start}`);
    const res = await deps.fetch(`${deps.baseUrl}/api/bookings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(deps.bodyFor(start)),
    });
    return { status: res.status, text: await res.text() };
  };

  const one = await attempt(first, 1);
  if (one.status === 200) return { ok: true, start: first, attempts: 1, status: one.status, body: one.text };
  if (one.status !== 409 || refusalCode(one.text) !== "SLOT_TAKEN") {
    return { ok: false, why: `the control booking was answered ${one.status}: ${one.text.slice(0, 300)}` };
  }

  // Read again rather than take the next entry of the stale list: the list that
  // offered a taken time is the thing in doubt. And wait out the edge cache first,
  // or the "fresh" read can be that same cached list.
  await deps.sleep(SLOT_CACHE_SETTLE_MS);
  const fresh =await readOfferedSlots(deps.fetch, deps.baseUrl, deps.bucketCode);
  const next = fresh.find((s) => s !== first);
  if (next === undefined) {
    return {
      ok: false,
      why:
        `the control booking at ${first} was answered 409 SLOT_TAKEN, and a fresh read of bucket ` +
        `${deps.bucketCode} offered no other time to retry on`,
    };
  }
  deps.log?.(`control booking at ${first} met SLOT_TAKEN; retrying once at the next offered time`);

  const two = await attempt(next, 2);
  if (two.status === 200) return { ok: true, start: next, attempts: 2, status: two.status, body: two.text };
  const secondCode = refusalCode(two.text);
  return {
    ok: false,
    why:
      `the control booking was refused twice in bucket ${deps.bucketCode}: ${first} answered 409 ` +
      `SLOT_TAKEN, then ${next} answered ${two.status}` +
      (secondCode ? ` ${secondCode}` : "") +
      `: ${two.text.slice(0, 300)}`,
  };
}
