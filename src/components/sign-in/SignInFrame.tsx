import type { ReactNode } from "react";
import type { SignInPanelWords } from "@/lib/auth/sign-in-copy";

/**
 * The page both sign in pages are drawn in (#4379): the photograph panel and the card on
 * the beige ground. `/login` has always looked like this; the partner sign in page is drawn
 * in the same frame (docs/design/partner-sign-in.html), so the frame lives here once and
 * each page fills the card and names its panel's words. The words are required, never a
 * default: each page speaks to its own reader (#4399, docs/design/partner-sign-in.html, D4, D5).
 */
export function SignInFrame({ panel, children }: { panel: SignInPanelWords; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh flex-1 grid-rows-[auto_1fr] bg-bg lg:grid-cols-2 lg:grid-rows-1">
      <section className="relative hidden flex-col gap-6 overflow-hidden bg-pennie-navy p-8 sm:flex lg:justify-between lg:p-12">
        {/* eslint-disable-next-line @next/next/no-img-element -- decorative brand art; OpenNext/CF has no image loader */}
        <img
          src="/brand/login-art.webp"
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover object-center"
        />
        {/* Navy scrim: darkens the top + bottom so the cream wordmark and copy
            stay legible, while the concrete mark breathes through the middle. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-pennie-navy/85 via-pennie-navy/25 to-pennie-navy/90"
        />
        {/* eslint-disable-next-line @next/next/no-img-element -- concrete-fill SVG logo; OpenNext/CF has no image loader */}
        <img
          src="/brand/logo-pennie-cream.svg"
          alt="Pennie"
          className="relative z-10 h-[22px] w-auto self-start"
        />
        <div className="relative z-10 max-w-md">
          <p className="pn-h2 hidden text-pennie-beige lg:block">
            {panel.headline}
          </p>
          <p className="text-lg leading-relaxed text-pennie-beige/80 lg:mt-4 lg:text-xl">
            {panel.line}
          </p>
        </div>
      </section>
      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm rounded-xl bg-surface p-8 shadow-xs">
          <div className="mb-8 sm:hidden">
            {/* eslint-disable-next-line @next/next/no-img-element -- concrete-fill SVG logo; OpenNext/CF has no image loader */}
            <img
              src="/brand/logo-pennie-charcoal.svg"
              alt="Pennie"
              className="h-[22px] w-auto dark:hidden"
            />
            {/* eslint-disable-next-line @next/next/no-img-element -- cream variant for the dark theme */}
            <img
              src="/brand/logo-pennie-cream.svg"
              alt="Pennie"
              className="hidden h-[22px] w-auto dark:block"
            />
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}
