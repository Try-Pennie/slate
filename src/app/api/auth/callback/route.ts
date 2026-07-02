import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { provisionUser } from "@/lib/provision";
import { ensureWatches } from "@/lib/google/sync";
import { canManageAgents } from "@/lib/auth/roles";
import { isAllowedEmail } from "@/lib/auth/domain";
import { googleHostedDomain } from "@/lib/env";

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
  const email = user.email ?? (meta.email as string) ?? "";

  // Enforce the Google Workspace domain server-side (#589). The `hd` hint on the
  // login page is browser-supplied and bypassable; this is the real gate. Reject
  // unverified or out-of-domain emails BEFORE provisioning so an outside account
  // never gets a live users row. Sign out first to clear the session cookies the
  // code exchange just set.
  if (meta.email_verified === false || !isAllowedEmail(email, googleHostedDomain())) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=domain_not_allowed`);
  }

  const slateUser = await provisionUser({
    authUserId: user.id,
    email,
    name: (meta.full_name as string) ?? (meta.name as string) ?? null,
    googleSub: (meta.sub as string) ?? (meta.provider_id as string) ?? null,
    avatarUrl: (meta.avatar_url as string) ?? (meta.picture as string) ?? null,
  });

  // Register/refresh this user's calendar push channels (reachable via
  // domain-wide delegation by email). We do NOT run the event sync here: a
  // large calendar's first bootstrap is heavy, and awaiting it is exactly what
  // hung first logins. The watch registered here + the 1-min cron backstop warm
  // the busy-block cache within a minute, off the login hot path.
  await ensureWatches(slateUser.id); // never throws; returns a status

  // Managers + admins get the admin console; agents land on their own page.
  const dest = canManageAgents(slateUser.role) ? "/admin" : "/me";
  const res = NextResponse.redirect(`${origin}${dest}`);
  // Seed the theme cookie from the account so the preference follows the user
  // onto this device (the no-flash script reads it before first paint).
  res.cookies.set("slate-theme", slateUser.theme_preference ?? "system", {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  return res;
}
