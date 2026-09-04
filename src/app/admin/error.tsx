"use client";

import { useEffect } from "react";
import Link from "next/link";
import { log } from "@/lib/log";
import { btnCls, btnSecondaryCls, cardCls } from "@/components/ui/styles";
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
 * `retry` is Next 16's name for this prop, not the `reset` of earlier versions.
 * Worth knowing because the wrong name is not a type error at runtime, it is a
 * button that does nothing.
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
  }, [error]);

  const reference = boundaryReference(error.digest);

  return (
    <section className={cardCls} role="alert">
      <h1 className="text-lg font-semibold text-fg">{BOUNDARY_TITLE}</h1>
      <p className="mt-2 max-w-[70ch] text-sm text-fg-muted">{BOUNDARY_BODY}</p>
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
