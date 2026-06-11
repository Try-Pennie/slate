import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { provisionUser } from "@/lib/provision";
import { ensureWatches, runIncrementalSync } from "@/lib/google/sync";
import { SYNC_TICK_BUDGET_MS } from "@/lib/google/sync-coalesce";
import { canManageAgents } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

/**
 * OAuth callback for Supabase Google SSO (admin login). Exchanges the code for
 * a session, provisions the Slate user, and warms their calendar cache.
 *
 * Redirects use the REQUEST origin, not NEXT_PUBLIC_APP_URL: the session
 * cookies are set on the host that served this callback, so bouncing to the
 * canonical app URL from a different host (local dev) would strand the
 * fresh session on an origin the user never lands on (#40).
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session) {
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  const { user } = data.session;
  const meta = user.user_metadata ?? {};

  const slateUser = await provisionUser({
    authUserId: user.id,
    email: user.email ?? (meta.email as string) ?? "",
    name: (meta.full_name as string) ?? (meta.name as string) ?? null,
    googleSub: (meta.sub as string) ?? (meta.provider_id as string) ?? null,
  });

  // Calendar is reachable via domain-wide delegation (by email), so warm the
  // cache + watch channel for this user regardless of OAuth token.
  await ensureWatches(slateUser.id); // never throws; returns a status
  // Budgeted (#44): a fleet bootstrap must not hang the login redirect; the
  // cron resumes any remainder within a minute.
  await runIncrementalSync(slateUser.id, Date.now() + SYNC_TICK_BUDGET_MS).catch(() => {});

  // Managers + admins get the admin console; agents land on their own page.
  const dest = canManageAgents(slateUser.role) ? "/admin" : "/me";
  return NextResponse.redirect(`${origin}${dest}`);
}
