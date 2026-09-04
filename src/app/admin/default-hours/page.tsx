import { redirect } from "next/navigation";

/**
 * The new agent starting hours moved onto the Hours page (#1892).
 *
 * A REDIRECT rather than a deleted directory, deliberately. This is a real URL
 * people have open and bookmarked, and `adminNavHrefs()` feeds the navigation
 * tests, so an old link should land somewhere useful rather than on a 404.
 *
 * The form itself is the last section of `/admin/business-hours`, which now holds
 * every hours decision: the org's operating window, the holiday closures, the
 * booking horizon and this. The comment that used to sit here explained why this
 * page loaded only the org defaults and not the week, the exceptions or the
 * coverage readout, which was true of a page that drew none of them and describes
 * an arrangement that no longer exists.
 */
// nav-ok: this route only REDIRECTS (#1892). Nothing should send anybody to a
// redirect, and the destination carries the navigation entry. It exists so a link
// people already hold lands somewhere useful rather than on a 404.
export default function DefaultHoursPage() {
  redirect("/admin/business-hours");
}
