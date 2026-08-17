import { LEGAL_COPY, legalLinks } from "@/lib/booking/booker-copy";

/**
 * Pennie's policy links, for the lead-facing surfaces that stand alone (#1041).
 *
 * The 2026-07-23 production readiness audit found the standalone booker
 * collecting a name, an email and a phone number for a debt consultation call
 * with no privacy policy and no terms anywhere on the page.
 *
 * The EMBEDDED booker sits inside a trypennie.com page that carries Pennie's own
 * policies, so it inherits them and this is not rendered there. The standalone
 * booker at slate.trypennie.app/book and the manage page have no page around
 * them, and a lead can reach both directly.
 *
 * The words live in `booker-copy.ts`, not here, so `pnpm preview:booker` shows
 * what actually ships (L41).
 */
export default function LegalFooter() {
  return (
    <footer
      aria-label={LEGAL_COPY.heading}
      className="mx-auto flex max-w-2xl flex-wrap items-center justify-center gap-x-6 gap-y-2 px-4 pb-8 pt-4 text-xs text-fg-muted"
    >
      {legalLinks().map(({ label, href }) => (
        <a
          key={href}
          href={href}
          // A new tab, so a lead reading the policy does not lose the booking
          // they were halfway through. noopener/noreferrer because a tab we hand
          // window.opener to can navigate this one.
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-sm underline underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pennie-sky)]"
        >
          {label}
        </a>
      ))}
    </footer>
  );
}
