"use client";

import { useEffect } from "react";
import Link from "next/link";
import { log } from "@/lib/log";
import { reportBoundaryCatch } from "@/lib/errors/report-boundary";
import { btnCls, btnSecondaryCls, cardCls, proseCls } from "@/components/ui/styles";
import {
  BOUNDARY_BODY,
  BOUNDARY_HOME,
  BOUNDARY_RETRY,
  BOUNDARY_TITLE,
  boundaryReference,
} from "@/lib/errors/boundary-copy";

/**
 * The admin surface's error boundary (#1970).
 *
 * There was NO boundary anywhere in this product, so every unhandled error fell
 * through to the framework's own unstyled dark screen. Dan met it twice while
 * saving an agent's hours.
 *
 * It sits under `/admin`, so the layout above it survives: the header and the
 * whole navigation are still there, and the failure is contained to the page
 * rather than replacing the app. That is why this is the boundary that matters
 * and `global-error` is only the backstop.
 *
 * Try again is wired to `retry`, never `reset` (L753, #3425). Both props exist in
 * this Next: `retry` re-fetches the boundary's children from the server and
 * re-renders them, while `reset` only clears the error and re-renders what the
 * browser already holds. After a server error that re-renders the same failure,
 * so a button wired to `reset` looks dead (node_modules/next/dist/docs, error.md).
 */
export default function AdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  // The digest is the only thing tying this screen to a line in the Worker's
  // logs, so it is logged from here too, with the tag the runbook searches on.
  useEffect(() => {
    log.error("admin-boundary", { msg: "page boundary caught", digest: error.digest }, error);
    // #1974: and TELL somebody. The log line above is the forensic trail and it
    // speaks to nobody: a page that throws for everyone after a deploy looks
    // exactly like one stray fault until a person happens to open it or a person
    // happens to query the logs.
    //
    // The route rather than `window.location`, so a query string carrying an
    // address or a token cannot travel with the report.
    reportBoundaryCatch({ page: "/admin", digest: error.digest, message: error.message });
  }, [error]);

  const reference = boundaryReference(error.digest);

  return (
    <section className={cardCls} role="alert">
      <h1 className="text-lg font-semibold text-fg">{BOUNDARY_TITLE}</h1>
      <p className={`mt-2 text-sm text-fg-muted ${proseCls}`}>{BOUNDARY_BODY}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className={btnCls} onClick={() => retry()}>
          {BOUNDARY_RETRY}
        </button>
        <Link href="/admin" className={btnSecondaryCls}>
          {BOUNDARY_HOME}
        </Link>
      </div>
      {reference && (
        <p className="mt-3 text-xs text-fg-muted">
          <span className="tabular-nums">{reference}</span>
        </p>
      )}
    </section>
  );
}
