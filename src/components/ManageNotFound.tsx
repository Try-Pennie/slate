interface ManageNotFoundProps {
  /** Presentational only; scopes the Pennie tokens via data-theme. */
  theme?: "light" | "dark";
}

// #634: a stale or mistyped manage link used to dead-end on one muted sentence.
// This branded terminal state names the likely causes and points the lead back
// to the manage link in their confirmation email. There is no booking (and so
// no bucket) in scope here, so the path forward is guidance, not a rebook link.
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
          We couldn&apos;t find that booking
        </h1>
        <p className="mt-3 text-sm text-fg-muted">
          The link may have expired, the booking may have already been cancelled,
          or the address might be slightly off.
        </p>
        <p className="mt-2 text-sm text-fg-muted">
          Open the most recent confirmation email from Pennie and follow the
          manage link there. It will bring you right back to your booking.
        </p>
      </div>
    </main>
  );
}
