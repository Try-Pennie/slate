import { NOT_FOUND_COPY } from "@/lib/booking/manage-copy";

interface ManageNotFoundProps {
  /** Presentational only; scopes the Pennie tokens via data-theme. */
  theme?: "light" | "dark";
}

// #634: a stale or mistyped manage link used to dead-end on one muted sentence.
// This branded terminal state names the likely causes and points the lead at the
// reschedule link inside the calendar invitation they already hold (#2364). There
// is no booking (and so no bucket) in scope here, so the path forward is guidance,
// not a rebook link. Every sentence comes from `manage-copy`, so all of it can be
// read before it ships through `pnpm preview:booker`.
export default function ManageNotFound({ theme = "light" }: ManageNotFoundProps) {
  return (
    <main
      data-theme={theme}
      className="flex min-h-dvh items-center justify-center bg-bg p-6 text-fg"
    >
      <div className="w-full max-w-md text-center">
        {/* Plain <img>: OpenNext on Cloudflare has no image loader configured.
            Both variants render; the data-theme dark variant toggles them. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/logo-pennie-charcoal.svg"
          alt="Pennie"
          className="mx-auto h-[22px] w-auto dark:hidden"
        />
        {/* eslint-disable-next-line @next/next/no-img-element -- cream variant for the dark theme */}
        <img
          src="/brand/logo-pennie-cream.svg"
          alt="Pennie"
          className="mx-auto hidden h-[22px] w-auto dark:block"
        />
        <h1 className="mt-8 text-[length:var(--fs-h4)] font-semibold leading-snug text-fg">
          {NOT_FOUND_COPY.heading}
        </h1>
        <p className="mt-3 text-sm text-fg-muted">{NOT_FOUND_COPY.causes}</p>
        <p className="mt-2 text-sm text-fg-muted">{NOT_FOUND_COPY.recovery}</p>
      </div>
    </main>
  );
}
