import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { runSnowflakeHealthcheck } from "@/lib/snowflake/healthcheck";

export const dynamic = "force-dynamic";

/**
 * Admin-only Snowflake connectivity check (#1110). Signed-in admins can hit this
 * to confirm the archival-mirror login works end to end (account, host, key-pair,
 * grants). 200 when healthy, 503 when the login/query fails or the mirror is not
 * configured yet, 403 for non-admins. Read-only: runs a trivial SELECT.
 */
export async function GET() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const result = await runSnowflakeHealthcheck();
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
