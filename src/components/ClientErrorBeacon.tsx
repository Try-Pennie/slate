"use client";

import { useEffect } from "react";
import { scrubContactData, FIELD_LIMITS } from "@/lib/api/client-error-scrub";

/**
 * Reports uncaught browser errors from Slate's own booking page (#1368).
 *
 * A broken client bundle loses bookings SILENTLY: the customer sees a page that
 * does not work, and no request ever reaches the server, so every other detector
 * stays green. This is the one failure with no other evidence.
 *
 * WHY IT LIVES HERE AND NOT IN widget.js. This mounts inside Slate's own
 * document, which the standalone /book page and the embedded iframe both are. A
 * global handler in `widget.js` would run in the HOST page (trypennie.com), where
 * `window.onerror` fires for the host's own JavaScript: Slate would be collecting
 * somebody else's errors, which is both noise and not ours to collect.
 *
 * THE FAILURE MODE TO AVOID IS A LOOP. A component throwing inside a render cycle
 * can fire thousands of times a second, and an unhandled rejection from the
 * beacon's own fetch would itself be an unhandled rejection this listener hears.
 * So: a hard per page cap, one report per distinct message, and the post's own
 * failure is swallowed on purpose (the one place in this codebase where swallowing
 * is right, because the alternative is the beacon feeding itself).
 */

/** Reports allowed per page load. Past this the page is comprehensively broken
 *  and the next thousand messages add nothing a human would act on differently. */
export const MAX_REPORTS_PER_PAGE = 5;

/**
 * Send one report to the beacon endpoint. The one place a page posts a report, so
 * the Booker's origin mismatch (#2641) and the error listeners below cannot drift
 * into two ways of sending (L41). Contact data is scrubbed from the message here
 * too, whoever calls it.
 */
export function postClientReport(body: Record<string, unknown> & { message: string }): void {
  void fetch("/api/client-errors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // keepalive so a report survives the customer navigating away from the
    // page that just broke, which is exactly what they tend to do.
    keepalive: true,
    body: JSON.stringify({
      ...body,
      // An origin mismatch is two bare origins the page built itself, never free
      // text, and the scrub would rewrite a preview host's digit run so the server
      // could no longer read the pair (#2641). Every other kind is scrubbed.
      message: (body.kind === "origin_mismatch" ? body.message : scrubContactData(body.message)).slice(
        0,
        FIELD_LIMITS.message,
      ),
    }),
    // swallow-ok: this is the one place swallowing is correct. A rejected
    // post is itself an unhandled rejection, which the beacon's listener hears,
    // which posts again: the beacon would feed on its own failure. There is
    // also nowhere to report it TO (reporting is the thing that just broke),
    // and the customer must never see a monitoring failure. The endpoint's
    // own health is covered server side, not from the page that failed.
  }).catch(() => {});
}

interface Props {
  /** The surface, used to key the alert. */
  page: string;
  bucketCode?: string | null;
}

export function ClientErrorBeacon({ page, bucketCode }: Props): null {
  useEffect(() => {
    let sent = 0;
    const seen = new Set<string>();

    const report = (body: Record<string, unknown>): void => {
      const message = String(body.message ?? "").trim();
      if (!message) return;
      if (sent >= MAX_REPORTS_PER_PAGE || seen.has(message)) return;
      seen.add(message);
      sent++;

      postClientReport({ ...body, message, page, bucketCode: bucketCode ?? null });
    };

    const onError = (e: ErrorEvent): void => {
      report({
        kind: "error",
        message: e.message,
        source: e.filename ?? null,
        line: Number.isInteger(e.lineno) ? e.lineno : null,
        col: Number.isInteger(e.colno) ? e.colno : null,
        stack: e.error instanceof Error ? scrubContactData(e.error.stack ?? "") : null,
      });
    };

    const onRejection = (e: PromiseRejectionEvent): void => {
      const reason: unknown = e.reason;
      report({
        kind: "unhandledrejection",
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? scrubContactData(reason.stack ?? "") : null,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection as EventListener);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection as EventListener);
    };
  }, [page, bucketCode]);

  return null;
}
