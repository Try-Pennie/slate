import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import type { BookingSettings } from "@/lib/db/types";

/**
 * Direct-booking settings (#1015, migration 0086). A single-row config table
 * (id pinned to 1), server-read via the secret-key admin client.
 *
 * `default_bucket_code` is the bucket a keyed direct-booking caller falls back to
 * when it passes no XBC. A null return means "no default configured" (the caller
 * decides what that means: the #1017 bookable endpoint answers 400 NO_DEFAULT_BUCKET,
 * fail-loud). We deliberately do NOT swallow a read error into null: a genuine DB
 * error (e.g. a missing column mid-migration) would otherwise masquerade as an
 * intentional "no default", so it flows through `unwrap` and throws instead.
 */
export async function getDefaultBucketCode(): Promise<string | null> {
  const db = supabaseAdmin();
  const row = unwrap(
    await db.from("booking_settings").select("default_bucket_code").eq("id", 1).maybeSingle(),
    "booking_settings.default_bucket_code",
  ) as Pick<BookingSettings, "default_bucket_code"> | null;
  const code = row?.default_bucket_code?.trim();
  return code ? code : null;
}
