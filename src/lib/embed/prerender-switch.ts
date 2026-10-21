import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import type { BookingSettings } from "@/lib/db/types";
import { makeEmbedPrerenderReader } from "@/lib/embed/prerender-switch-core";

/**
 * The prerender switch wired to the real database (#3706). The decisions (the TTL, the
 * deadline, which way a failure answers) live in `prerender-switch-core.ts`, re-exported
 * here so a server caller has one place to import the switch from. Client code imports
 * the core directly, because this module reads the database.
 */
export * from "@/lib/embed/prerender-switch-core";

/** The stored switch, read once. THROWS on a failed read; each caller decides what that means. */
async function readEmbedPrerenderColumn(): Promise<boolean> {
  const row = unwrap(
    await supabaseAdmin().from("booking_settings").select("embed_prerender_enabled").eq("id", 1).maybeSingle(),
    "booking_settings.embed_prerender_enabled",
  ) as Pick<BookingSettings, "embed_prerender_enabled"> | null;
  // An absent settings row is a real answer: nobody has ever turned it on.
  return row?.embed_prerender_enabled === true;
}

/** Does Slate honour a host's prerender? One read per isolate per TTL; a failed read answers off. */
export const readEmbedPrerender = makeEmbedPrerenderReader({
  read: readEmbedPrerenderColumn,
  now: () => Date.now(),
  onError: (err) =>
    log.error("embed-config", { msg: "prerender switch unreadable, answering no prerender" }, err),
});

/**
 * The switch as the admin page draws it: fresh, never cached, and null when it could not
 * be read, because "could not tell" is a different screen from either answer (L530).
 */
export async function readEmbedPrerenderSetting(): Promise<boolean | null> {
  try {
    return await readEmbedPrerenderColumn();
  } catch (err) {
    log.error("embed-config", { msg: "prerender switch unreadable on the admin page" }, err);
    return null;
  }
}
