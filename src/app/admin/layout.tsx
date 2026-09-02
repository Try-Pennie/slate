import { currentUser } from "@/lib/auth";
import { oooOnlyFor } from "@/lib/env";
import { AppHeader } from "@/components/AppHeader";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { adminNavFor } from "@/lib/admin/nav";
import { PAGE_WIDTHS } from "@/components/ui/PageShell";

/**
 * The admin area's chrome (#1748): one header, one sidebar, one content column,
 * rendered once around every console page instead of each page building its own.
 *
 * This makes NO access decision. Every page under `/admin` carries its own gate
 * already, and a second copy of one here would be a rule maintained in two places
 * that can disagree. It would also deadlock: the OOO-only phase redirects to
 * `/admin/ooo`, which is itself under this layout, so a redirect here is a loop.
 * What the layout does instead is show the person only what they can use, which
 * is `adminNavFor`'s job and is tested without rendering anything.
 *
 * The `<main id="main">` lives here rather than in PageShell for these pages,
 * because the content column is one part of a three part layout now; a page that
 * re-centred itself inside it would be centred twice.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await currentUser();
  // Signed out: the page itself redirects to /login. Rendering an account menu
  // for nobody would be chrome around a redirect.
  if (!me) return <>{children}</>;

  const groups = adminNavFor(me.role, oooOnlyFor(me.role));

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
      <div
        className={`mx-auto flex w-full min-w-0 ${PAGE_WIDTHS.wide} flex-col gap-0 px-6 sm:px-8 lg:flex-row lg:gap-8`}
      >
        <AdminSidebar groups={groups} />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 space-y-8 py-10">
          {children}
        </main>
      </div>
    </>
  );
}
