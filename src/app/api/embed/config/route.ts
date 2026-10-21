import { NextResponse } from "next/server";
import { EMBED_CONFIG_MAX_AGE_SECONDS, readEmbedPrerender } from "@/lib/embed/prerender-switch";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * GET /api/embed/config (#3706): the embed's own settings, asked by widget.js from the
 * host page before it builds a booker at page load. Today one field, `prerender`, from
 * the admin Embedding page's switch.
 *
 * WHO may call it: anyone, with no credentials, because widget.js runs on partner sites.
 * WHOSE data: none. The answer is one org wide boolean that says nothing about a lead,
 * an advisor or a booking, so it is readable from any origin (`*`, never paired with
 * credentials) and cached briefly in the browser. The database read behind it is cached
 * per isolate (`prerender-switch-core.ts`), so a flood of requests costs at most one read
 * per isolate per 15 seconds.
 *
 * It ALWAYS answers a well formed 200: the read already turns its own failure into
 * `false` and logs it, and anything unexpected beyond that is logged here and answered
 * the same way. A host page cannot act on an error, and false is how the embed has
 * always run, so failing to off is the safe answer and never an outage.
 */
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": `public, max-age=${EMBED_CONFIG_MAX_AGE_SECONDS}`,
};

export async function GET(): Promise<NextResponse> {
  let prerender = false;
  try {
    prerender = await readEmbedPrerender();
  } catch (err) {
    log.error("embed-config", { msg: "embed config read threw, answering no prerender" }, err);
  }
  return NextResponse.json({ prerender }, { headers: HEADERS });
}
