import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import type { BookingSettings } from "@/lib/db/types";
import { makeFrameLockReader } from "@/lib/embed/frame-lock";
import type { FramingObservation } from "@/lib/embed/frame-policy";

/**
 * The frame lock and the framing record, wired to the real database (#3137). The
 * decisions live in the pure modules beside this one: `frame-policy.ts` (who may frame,
 * what a request says about who did) and `frame-lock.ts` (how the switch is cached and
 * which way an unreadable one fails).
 */

/** Is the frame lock on? One read per isolate per `FRAME_LOCK_TTL_MS`. */
export const readFrameLock = makeFrameLockReader({
  read: async () => {
    const row = unwrap(
      await supabaseAdmin().from("booking_settings").select("frame_lock_enabled").eq("id", 1).maybeSingle(),
      "booking_settings.frame_lock_enabled",
    ) as Pick<BookingSettings, "frame_lock_enabled"> | null;
    // An absent settings row is a real answer: nobody has ever turned the lock on.
    return row?.frame_lock_enabled === true;
  },
  now: () => Date.now(),
  onError: (err) => log.warn("frame-lock", { msg: "frame lock unreadable, keeping the last value read" }, err),
});

/**
 * The switch as the admin page draws it: fresh, never cached, and null when it could
 * not be read, because "could not tell whether framing is locked" is a different screen
 * from either answer (L530).
 */
export async function readFrameLockSetting(): Promise<boolean | null> {
  try {
    const row = unwrap(
      await supabaseAdmin().from("booking_settings").select("frame_lock_enabled").eq("id", 1).maybeSingle(),
      "booking_settings.frame_lock_enabled",
    ) as Pick<BookingSettings, "frame_lock_enabled"> | null;
    return row?.frame_lock_enabled === true;
  } catch (err) {
    log.error("frame-lock", { msg: "frame lock unreadable on the admin page" }, err);
    return null;
  }
}

/**
 * Count one framed booker load. THROWS on a refused write, so the caller's deferral
 * logs it rather than the count silently going missing (a table that never fills reads
 * exactly like a booker nobody frames, L98).
 */
export async function recordFramingObservation(obs: FramingObservation): Promise<void> {
  const { error } = await supabaseAdmin().rpc("record_frame_origin", {
    p_origin: obs.origin,
    p_surface: obs.surface,
  });
  if (error) throw new Error(`record_frame_origin failed: ${error.message}`);
}
