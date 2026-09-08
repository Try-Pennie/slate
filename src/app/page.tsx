import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canManageAgents } from "@/lib/auth/roles";
import { ME_TABS } from "@/lib/me/nav";

export const dynamic = "force-dynamic";

/**
 * No marketing landing — Slate is an internal tool, not a product to sell. The
 * root routes by session: signed-out to login, signed-in to their surface
 * (mirrors the OAuth callback's role split).
 */
export default async function Home() {
  const me = await currentUser();
  if (!me) redirect("/login");
  redirect(canManageAgents(me.role) ? "/admin" : ME_TABS[0].href);
}
