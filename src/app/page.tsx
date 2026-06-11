import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";

export default function Home() {
  return (
    <main className="flex min-h-dvh flex-1 flex-col items-center justify-center bg-bg p-8 text-center">
      <div className="flex w-full max-w-2xl flex-col items-center gap-6">
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
        <h1 className="pn-h1">Slate</h1>
        <p className="max-w-xl text-xl leading-relaxed text-fg-muted">
          Availability aware booking for Pennie. Round robin scheduling, Google
          Calendar sync, an embeddable widget, and webhooks for Regal.
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/admin"
            className="group inline-flex min-h-14 items-center justify-center gap-2 rounded-xl bg-accent px-6 text-base font-semibold text-fg-on-sky hover:bg-accent-hover active:translate-y-px"
          >
            Admin
            <ArrowRightIcon className="h-4 w-4 transition-transform duration-150 ease-[cubic-bezier(0.2,0.8,0.2,1)] group-hover:translate-x-1" />
          </Link>
          <a
            href="/embed-example.html"
            className="pn-btn pn-btn--big pn-btn--additional"
          >
            Embed demo
          </a>
        </div>
      </div>
    </main>
  );
}
