import { currentUser } from "@/lib/auth";
import { AppHeader } from "@/components/AppHeader";
import { PageShell } from "@/components/ui/PageShell";

/**
 * The chrome around a person's own pages (#2103): one header, one content
 * column, rendered once around My Availability and My Time Off instead of each
 * page building its own.
 *
 * IT EXISTS BECAUSE OF THE LOADING BOUNDARY, and without it that boundary would
 * make things worse rather than better. Next replaces everything below the
 * nearest layout while a page is fetching, so with the header rendered inside
 * each page the skeleton would replace the header too: click a tab and the
 * header vanishes and comes back. That is the fault #2045 fixed for a 26px
 * spinner, at the scale of the whole top of the screen.
 *
 * It makes NO access decision, matching the console's layout for the same
 * reason: each page already carries its own `currentUser` check and redirect,
 * and a second copy here would be one rule maintained in two places that can
 * disagree.
 *
 * `narrow` because these are a single column of form. Stretching a stack of time
 * pickers across a wide window puts every control on the left and reads worse
 * than a column.
 */
export default async function MeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await currentUser();
  // Signed out: the page itself redirects to /login. Rendering an account menu
  // for nobody would be chrome around a redirect.
  if (!me) return <>{children}</>;

  return (
    <>
      <AppHeader
        email={me.email}
        role={me.role}
        themePreference={me.theme_preference}
        userId={me.id}
        orgId={me.org_id}
        bookable={me.bookable}
        avatarUrl={me.avatar_url}
      />
      <PageShell width="narrow">{children}</PageShell>
    </>
  );
}
