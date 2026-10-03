import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import type { BookingSettings } from "@/lib/db/types";
import { makeFrameLockReader } from "@/lib/embed/frame-lock";
import type { FramingObservation } from "@/lib/embed/frame-policy";
import { FRAME_DAY_ZONE, makeFramingRecorder, type Defer } from "@/lib/embed/frame-observe";

/**
 * The frame lock and the framing record, wired to the real database (#3137). The
 * decisions live in the pure modules beside this one: `frame-policy.ts` (who may frame,
 * what a request says about who did) and `frame-lock.ts` (how the switch is cached and
 * which way an unreadable one fails).
 */

/** The stored switch, read once. THROWS on a failed read; each caller decides what that means. */
async function readFrameLockColumn(): Promise<boolean> {
  const row = unwrap(
    await supabaseAdmin().from("booking_settings").select("frame_lock_enabled").eq("id", 1).maybeSingle(),
    "booking_settings.frame_lock_enabled",
  ) as Pick<BookingSettings, "frame_lock_enabled"> | null;
  // An absent settings row is a real answer: nobody has ever turned the lock on.
  return row?.frame_lock_enabled === true;
}

/** Is the frame lock on? One read per isolate per `FRAME_LOCK_TTL_MS`. */
export const readFrameLock = makeFrameLockReader({
  read: readFrameLockColumn,
  now: () => Date.now(),
  onError: (err) => log.warn("frame-lock", { msg: "frame lock unreadable, keeping the last value read, or unlocked with none" }, err),
});

/**
 * The switch as the admin page draws it: fresh, never cached, and null when it could
 * not be read, because "could not tell whether framing is locked" is a different screen
 * from either answer (L530).
 */
export async function readFrameLockSetting(): Promise<boolean | null> {
  try {
    return await readFrameLockColumn();
  } catch (err) {
    log.error("frame-lock", { msg: "frame lock unreadable on the admin page" }, err);
    return null;
  }
}

/**
 * Count one framed booker load, batched per isolate (`frame-observe.ts`), so the write
 * volume is never the caller's to choose. A refused write is logged and its counts kept
 * for the next flush, rather than going silently missing (a table that never fills reads
 * exactly like a booker nobody frames, L98). The day is keyed in FRAME_DAY_ZONE, the zone
 * the admin page reads it in.
 */
const framingRecorder = makeFramingRecorder({
  write: async (rows) => {
    const { data, error } = await supabaseAdmin().rpc("record_frame_origins", {
      p_zone: FRAME_DAY_ZONE,
      p_rows: rows,
    });
    if (error) throw new Error(`record_frame_origins failed: ${error.message}`);
    // The batch landed; a row the database judged invalid was dropped rather than
    // failing the rest, and is reported here rather than vanishing.
    if (typeof data === "number" && data > 0) {
      log.warn("frame-observe", { msg: "framing rows dropped as invalid", dropped: data, batch: rows.length });
    }
  },
  now: () => Date.now(),
  onError: (err) => log.warn("frame-observe", { msg: "framing record failed, counts kept for the next flush" }, err),
});

export function recordFramingObservation(obs: FramingObservation, defer: Defer): void {
  framingRecorder(obs, defer);
}
