import type { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import type { OooRequest } from "@/lib/db/types";

/**
 * Every OOO request for an org, across all time, paged past PostgREST's
 * 1,000-row cap (#828). The admin OOO insights aggregate over the FULL history
 * (not the 90-day list), and that history grows monotonically (~200 agents,
 * a handful of requests a year) crosses 1,000 within the first year, so a
 * single-page read would silently under-report every insight. Throws on a read
 * error (via selectAllPages) rather than degrading to a short list.
 */
export async function loadOrgOooHistory(
  db: ReturnType<typeof supabaseAdmin>,
  orgId: string,
): Promise<OooRequest[]> {
  return selectAllPages<OooRequest>("ooo_requests history", (from, to) =>
    db.from("ooo_requests").select("*").eq("org_id", orgId).range(from, to),
  );
}
