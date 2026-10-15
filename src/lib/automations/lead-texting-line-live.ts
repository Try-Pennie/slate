import type { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import type { TextingLineStore } from "./lead-texting-line";

/**
 * The `lead_texting_lines` table as a `TextingLineStore` (#3718, migration 0183). The
 * decisions live in `textingLineForLead`; this is only the wiring, tested by
 * `lead-texting-line-live.test.ts`.
 *
 * Both writes end by reading the row back, because what the caller needs is the line
 * that is SAVED, not the one it offered: a claim that lost to a press a moment earlier,
 * or a swap whose line had already been replaced, wrote nothing and must hand back the
 * winner's line.
 */
export function liveTextingLineStore(db: ReturnType<typeof supabaseAdmin>): TextingLineStore {
  const read = async (key: string): Promise<string | null> => {
    const row = unwrap(
      await db.from("lead_texting_lines").select("line").eq("lead_key", key).maybeSingle(),
      "lead texting line",
    ) as { line: string } | null;
    return row?.line ?? null;
  };
  const saved = async (key: string, what: string): Promise<string> => {
    const line = await read(key);
    if (line === null) throw new Error(`lead texting line missing after ${what}`);
    return line;
  };
  return {
    read,
    async claim(key, line) {
      // ON CONFLICT DO NOTHING: the first press's line stands.
      unwrap(
        await db.from("lead_texting_lines").upsert({ lead_key: key, line }, { onConflict: "lead_key", ignoreDuplicates: true }),
        "lead texting line claim",
      );
      return saved(key, "claim");
    },
    async swap(key, from, to) {
      // Only over the line being replaced, so a second replacement of the same dead
      // line changes nothing and is handed the first one's line.
      unwrap(
        await db
          .from("lead_texting_lines")
          .update({ line: to, replaced_at: new Date().toISOString() })
          .eq("lead_key", key)
          .eq("line", from),
        "lead texting line swap",
      );
      return saved(key, "swap");
    },
  };
}
