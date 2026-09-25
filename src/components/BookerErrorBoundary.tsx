"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { log } from "@/lib/log";
import { reportBoundaryCatch } from "@/lib/errors/report-boundary";
import { btnCls, cardCls, proseCls } from "@/components/ui/styles";
import {
  BOUNDARY_BODY,
  BOUNDARY_RETRY,
  BOUNDARY_TITLE,
  boundaryReference,
} from "@/lib/errors/boundary-copy";
import { embedParentOrigin } from "@/lib/embed/parent-origin";
import { EMBED_MESSAGE, LINK_FAILED } from "@/lib/embed/lifecycle-events";

/**
 * The booker's own error boundary (#2658).
 *
 * Until this existed a crash inside the booker fell through to `global-error`,
 * which replaces the whole document. Inside the embed that is a blank white
 * frame: the host page's modal stays open over it, the iframe's `load` already
 * fired, and nothing on either side says what happened, so the host's funnel
 * records a lead who viewed the booker and vanished. That is the same shape as
 * a lead who left, and the whole point of the lifecycle is to tell them apart.
 *
 * So this boundary does two things the backstop cannot: it keeps the root
 * layout (styles, theme) under the message, and inside an embed it announces
 * the crash to the host page as cal.com's `linkFailed`, with a code and a short
 * sentence, to the declared parent origin only (never "*", #593). The message
 * carries neither the error's text nor a stack: the log line and the boundary
 * report below hold those, and a GA4 parameter is no place for either.
 *
 * It reads `embed` and `parentOrigin` off the query itself because a boundary is
 * handed only the error and a retry, and the page that knew both has just failed.
 *
 * A lead facing surface, so there is no link out: nowhere honest to send them
 * (`boundaryWayBack`). `retry` is Next 16's name for this prop.
 *
 * ONE component for every route that renders the booker (#2732). `/booking/[id]`,
 * the entry every trypennie link uses, had no boundary at all and fell through to
 * the backstop, which is the defect above on the busier of the two routes. Each
 * route's `error.tsx` is a one line wrapper naming its own route pattern, and
 * `scripts/test-booker-route-boundaries.ts` fails a booker route with no boundary
 * or with one that is not this component.
 */
export type BookerBoundaryPage = "/book" | "/booking/[id]";

export default function BookerErrorBoundary({
  error,
  retry,
  page,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  /** The route PATTERN, never the path: `/booking/{id}` carries a lead's Salesforce id. */
  page: BookerBoundaryPage;
}) {
  const params = useSearchParams();
  const embedded = params.get("embed") === "1";
  const parentOrigin = params.get("parentOrigin");

  useEffect(() => {
    log.error("book-boundary", { msg: "page boundary caught", page, digest: error.digest }, error);
    // #1974: and TELL somebody. The route rather than `window.location`, so a
    // query string carrying a lead's details cannot travel with the report.
    reportBoundaryCatch({ page, digest: error.digest, message: error.message });
  }, [error, page]);

  useEffect(() => {
    if (!embedded) return;
    const target = embedParentOrigin(
      parentOrigin,
      typeof document === "undefined" ? null : document.referrer,
    );
    // No trustworthy origin: say nothing rather than broadcast, the same rule the
    // Booker's own messages follow.
    if (!target) return;
    window.parent.postMessage(
      { type: EMBED_MESSAGE.linkFailed, data: LINK_FAILED.bookerCrashed },
      target,
    );
  }, [embedded, parentOrigin, error]);

  const reference = boundaryReference(error.digest);

  return (
    <section className={cardCls} role="alert">
      <h1 className="text-lg font-semibold text-fg">{BOUNDARY_TITLE}</h1>
      <p className={`mt-2 text-sm text-fg-muted ${proseCls}`}>{BOUNDARY_BODY}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className={btnCls} onClick={() => retry()}>
          {BOUNDARY_RETRY}
        </button>
      </div>
      {reference && (
        <p className="mt-3 text-xs text-fg-muted">
          <span className="tabular-nums">{reference}</span>
        </p>
      )}
    </section>
  );
}
