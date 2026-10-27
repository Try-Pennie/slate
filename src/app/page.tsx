import { redirect } from "next/navigation";
import { coordinatorDeskUser, currentUser } from "@/lib/auth";
import { COORDINATOR_PAGE, landingPathFor } from "@/lib/auth/landing";

export const dynamic = "force-dynamic";

/**
 * No marketing landing — Slate is an internal tool, not a product to sell. The
 * root routes by session: signed-out to login, signed-in to their surface
 * (`landingPathFor`, the same split the OAuth callback makes).
 *
 * #4205: a coordinator resolves to nobody through `currentUser`, which keeps them off
 * every staff page, so they are found by the coordinator page's own gate and sent to
 * it rather than round to the sign in page they have already passed.
 */
export default async function Home() {
  const me = await currentUser();
  if (me) redirect(landingPathFor(me.role));
  if (await coordinatorDeskUser()) redirect(COORDINATOR_PAGE);
  redirect("/login");
}
