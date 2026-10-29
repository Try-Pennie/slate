import StandaloneTheme from "@/components/StandaloneTheme";
import { OAuthSignInButton } from "@/components/sign-in/OAuthSignInButton";
import { SignInErrorBanner } from "@/components/sign-in/SignInErrorBanner";
import { SignInFrame } from "@/components/sign-in/SignInFrame";
import { readDesignFixture } from "@/lib/admin/design-fixture-read";
import { MICROSOFT_PROVIDER } from "@/lib/auth/microsoft-identity";
import { PARTNER_SIGN_IN_COPY as COPY, partnerSignInRefusal } from "@/lib/auth/partner-sign-in-copy";

// Per request, never prerendered: the content security policy's nonce is applied only while
// serving one, and a prerendered page's scripts would all be refused (#2575).
export const dynamic = "force-dynamic";

// A literal, because the page title guard reads it from the source
// (`src/app/page-titles.test.ts`); it is the card's heading, which `page.test.tsx` holds it to.
export const metadata = { title: "Sign in to book calls" };

/** The settled design's frames, by id, and how the page draws each (docs/design/partner-sign-in.html). */
const DESIGN_FRAMES: Readonly<Record<string, { theme: "light" | "dark" }>> = { f1: { theme: "light" } };

/**
 * The partner sign in page (#4379), settled as docs/design/partner-sign-in.html: the call
 * center partner's scheduling coordinators sign in here with their work Microsoft account,
 * and it offers no other way in (D1). Staff keep `/login`, Google only, unchanged (D3).
 *
 * WHO: anybody; it is a sign in page and reads nothing. Whether a Microsoft account may come
 * in is decided after the redirect, by the before_user_created hook, the callback's
 * `linkCoordinator` and `realCurrentUser`, never here. WHOSE DATA: none.
 *
 * `?error=` is the code the callback sends a refused Microsoft sign in back with, shown in its
 * own words. `?frame=` draws the design's frame for the design match score; it answers only
 * when the run sets SLATE_DESIGN_FIXTURES and the request is to this machine
 * (`readDesignFixture`). The page draws no data, so the frame only fixes the theme.
 */
export default async function PartnerSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; frame?: string }>;
}) {
  const sp = await searchParams;
  const fixture = await readDesignFixture<unknown>(sp.frame, "partner-sign-in");
  const frame = fixture && sp.frame && Object.hasOwn(DESIGN_FRAMES, sp.frame) ? DESIGN_FRAMES[sp.frame]! : null;
  const refusal = partnerSignInRefusal(sp.error);

  return (
    <>
      {/* Outside <main>: the design's checks read main's words, and a script's text is words. */}
      {frame && <StandaloneTheme theme={frame.theme} />}
      <SignInFrame>
        <h1 className="pn-h3">{COPY.heading}</h1>
        <p className="mt-2 text-sm text-fg-muted">{COPY.line}</p>
        {refusal && <SignInErrorBanner message={refusal.message} link={refusal.link} />}
        <OAuthSignInButton provider={MICROSOFT_PROVIDER} />
      </SignInFrame>
    </>
  );
}
