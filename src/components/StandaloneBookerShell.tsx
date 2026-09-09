import LegalFooter from "@/components/LegalFooter";
import StandaloneTheme from "@/components/StandaloneTheme";
import {
  STANDALONE_CONTENT,
  mainClassFor,
} from "@/lib/booking/page-shell";

/**
 * Everything that wraps a standalone booker, in one place (#2159).
 *
 * `/book` (the embed and cal style links) and `/booking/[id]` (the Salesforce id
 * links) render the same page, and each used to carry its own `<main>`, its own
 * `!embedded && <StandaloneTheme>` and its own `!embedded && <LegalFooter>`, with
 * the same two comments copied into both. Three decisions written twice is three
 * chances to change one and not the other, and the centring added in #2159 would
 * have been a fourth.
 *
 * The `embedded` branch is load bearing rather than tidy: inside the iframe there
 * must be no viewport height (the host sizes the frame from the Booker's own
 * `slate:resize` message) and no second copy of Pennie's policies (the
 * trypennie.com page around it already carries them, #1041).
 */
export default function StandaloneBookerShell({
  embedded,
  theme,
  children,
}: {
  embedded: boolean;
  theme: "light" | "dark";
  children: React.ReactNode;
}) {
  if (embedded) return <main>{children}</main>;

  return (
    <main className={mainClassFor(false)}>
      {/* #706: standalone renders paint the theme at the document root so a dark
          booker has no beige gutter. The embed leaves the host in control. */}
      <StandaloneTheme theme={theme} />
      <div className={STANDALONE_CONTENT}>{children}</div>
      <LegalFooter />
    </main>
  );
}
