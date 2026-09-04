// nav-ok: not a screen anybody navigates to. It exists to THROW, so the error
// boundary can be seen working, and it 404s outside development. A link to it in
// the sidebar would be a link to a broken page.
import { notFound } from "next/navigation";
import { devPreviewEnabled } from "@/lib/auth/dev-preview";

export const dynamic = "force-dynamic";

/**
 * A page that throws, so the error boundary can be SEEN working (#1970).
 *
 * The boundary is wired by a file convention rather than by any code of ours, so
 * nothing in this repo proves Next still honours it: a rename, an upgrade or a
 * moved file would leave `error.tsx` sitting there, passing every static check,
 * while the framework's raw screen came back. The static guard checks the file
 * says the right things; this is what checks it is REACHED.
 *
 * 404s in production, through the same predicate `/dev/preview` uses, because a
 * route that always throws is not something to leave reachable on a live
 * deployment. `scripts/test-error-boundary.ts` holds it to that.
 */
export default async function BoundaryProbe() {
  if (!devPreviewEnabled()) notFound();
  throw new Error("Deliberate error, so the boundary can be seen working (#1970).");
}
