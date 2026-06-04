import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { provisionUser } from "@/lib/provision";
import { ensureWatches, runIncrementalSync } from "@/lib/google/sync";
import { appUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * OAuth callback for Supabase Google SSO (admin login). Exchanges the code for
 * a session, provisions the Slate user, and warms their calendar cache.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(`${appUrl()}/login?error=missing_code`);
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session) {
    return NextResponse.redirect(`${appUrl()}/login?error=exchange_failed`);
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
  await runIncrementalSync(slateUser.id).catch(() => {});

  // Admins manage everything; agents land on their own availability page.
  const dest = slateUser.role === "admin" ? "/admin" : "/me";
  return NextResponse.redirect(`${appUrl()}${dest}`);
}
