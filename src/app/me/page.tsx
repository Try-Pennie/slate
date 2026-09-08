import { redirect } from "next/navigation";
import { ME_TABS } from "@/lib/me/nav";

/**
 * The old address of the availability page (#2107).
 *
 * Dan, 2026-09-08: "let's make the my availability page
 * https://slate.trypennie.app/me/my-availability. It can stay as
 * https://slate.trypennie.app/me as well, but I want the format to match the
 * other pages".
 *
 * A REDIRECT rather than a second copy of the page, so there is one canonical
 * address. The header decides which tab is current by matching the path against
 * the tab's href, so a page served at an address no tab names would draw with no
 * tab highlighted, on the landing page somebody sees most often. It also means an
 * old bookmark, a link somebody has already shared, and every place that still
 * says `/me` all end up somewhere real.
 *
 * The destination is read from the tab list rather than written out here, so the
 * address cannot drift from the tab that points at it (L41).
 */
export default function MeLandingPage() {
  redirect(ME_TABS[0].href);
}
