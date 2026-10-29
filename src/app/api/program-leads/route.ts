import { NextResponse, type NextRequest } from "next/server";
import { refuseCredential } from "@/lib/bearer-failure";
import { programLeadApiKey, programLeadApiKey2 } from "@/lib/env";
import { bearerTokenMatches } from "@/lib/bearer-auth";
import { reportInternalError } from "@/lib/api/errors";
import { log } from "@/lib/log";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { readProgramLeadId, registerProgramLead } from "@/lib/program-leads/register";

export const dynamic = "force-dynamic";

/**
 * Bidspoke registers an accepted lead as a program lead (#4388, part of #4255), BEFORE
 * the first text carrying the booking link goes out, so the link is recognised the
 * moment the lead opens it.
 *
 *   POST (Bearer BOOKING_API_KEY_BIDSPOKE) { salesforceLeadId }
 *     200  { registered: true, expiresAt }   registering again extends the mark
 *     400  { code: VALIDATION | NOT_A_LEAD_ID | LEAD_ID_CASE_MISMATCH }
 *     401  a missing or wrong key, a booking API key included
 *     429  too many refused keys from one address in a minute
 *     503  { code: NOT_CONFIGURED }     no Bidspoke key is set on this deployment
 *     503  { code: STORE_UNAVAILABLE }  nothing was recorded: RETRY
 *
 * Who may call: Bidspoke's key alone. It is not a booking API key and no booking route
 * accepts it, and this route accepts no other (`scripts/test-program-lead-key-scope.ts`).
 * What it touches: `program_leads`, through `register_program_lead`, and nothing else.
 */
export async function POST(req: NextRequest) {
  const key = programLeadApiKey();
  if (!key) {
    return NextResponse.json(
      { error: "program leads api not configured: BOOKING_API_KEY_BIDSPOKE is unset", code: "NOT_CONFIGURED" },
      { status: 503 },
    );
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), [key, programLeadApiKey2()])) {
    return refuseCredential(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }

  const read = readProgramLeadId(await req.json().catch(() => null));
  if (!read.ok) {
    return NextResponse.json({ error: read.error, code: read.code }, { status: 400 });
  }

  try {
    const expiresAt = await registerProgramLead(supabaseAdmin(), read.leadKey);
    log.info("program-leads", { msg: "registered", lead_key: read.leadKey, expires_at: expiresAt });
    return NextResponse.json({ registered: true, expiresAt });
  } catch (err) {
    // A registration the store did not confirm is never answered as made: Bidspoke
    // retries on a 503, and a lead it believes registered but is not would be shown the
    // ordinary times only, with nothing anywhere saying why.
    // `reportInternalError` logs the fault in full and pages, throttled per route.
    await reportInternalError(err, "program-leads").catch((alertErr) =>
      log.error("program-leads", { msg: "store failure alert failed", lead_key: read.leadKey }, alertErr),
    );
    return NextResponse.json(
      { error: "The lead was not registered. Try again.", code: "STORE_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
