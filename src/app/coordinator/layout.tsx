import { staffPhotoSrc } from "@/lib/advisor-photos/own";
import { coordinatorDeskUser } from "@/lib/auth";
import { AppHeader } from "@/components/AppHeader";

/**
 * The chrome around the coordinator booking page (#4205): the header with the Pennie
 * logo and the account menu only, no section links (D32: a coordinator opens no staff
 * page). The page draws its own content column (`PageShell`), so a design frame's theme
 * script can sit outside `<main>`, where the design's checks read the page's words.
 *
 * It makes NO access decision; the page does (`coordinatorDeskUser`), matching the
 * console's and /me's layouts. Signed out or refused, the page redirects to sign in, so
 * there is no header to draw for nobody.
 */
export default async function CoordinatorLayout({ children }: { children: React.ReactNode }) {
  const me = await coordinatorDeskUser();
  if (!me) return <>{children}</>;
  return (
    <>
      <AppHeader email={me.email} role={me.role} themePreference={me.theme_preference} photoSrc={await staffPhotoSrc(me)} sections={false} />
      {children}
    </>
  );
}
