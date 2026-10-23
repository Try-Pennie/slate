"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { AlertIcon } from "@/components/icons";

/**
 * Shared fetch + loading/error/empty state for the on-demand lists behind the
 * reschedule and reassign panels (#627). Before this, three call sites each
 * fetched with `r.ok ? json : { …: [] }` and no `.catch`, so an in-flight or
 * failed fetch rendered the *empty* copy ("No times left") — a lead reading it
 * gives up. This mirrors the Booker: loading and error are distinct states, and
 * the empty copy shows only after a confirmed empty response.
 */
export function useFetchList<T>(
  url: string | null,
  active: boolean,
  extract: (json: unknown) => T[],
  /** Extra request headers (#2666: the public test bucket's pass). Keep the
   *  object's identity stable across renders: it is part of the fetch's deps. */
  headers?: Record<string, string>,
  /** A JSON body, sent as a POST (#3399), for a list whose request carries a
   *  person's details: those never go in the address, which Cloudflare logs in
   *  full before any of our code runs. Part of the request's identity, so a new
   *  body is a new fetch. */
  jsonBody?: string,
): {
  items: T[];
  loading: boolean;
  error: boolean;
  retry: () => void;
  /** The last body that parsed, kept across a later load or failure (#1336).
   *  The booker reads the org name, event name and duration out of the same
   *  availability response its slots come from; clearing it while the next
   *  month loads would blank the event panel for the length of the fetch. */
  payload: unknown;
  /** The body of the reply that FAILED, when it had one, so a caller can read a
   *  refusal's own sentence (#2666). Null on success and on a network failure. */
  errorPayload: unknown;
} {
  const [state, setState] = useState<{
    key: string;
    items: T[];
    error: boolean;
    payload: unknown;
    errorPayload: unknown;
  }>({
    key: "",
    items: [],
    error: false,
    payload: null,
    errorPayload: null,
  });
  const [nonce, setNonce] = useState(0);

  // The request identity: changes when the target or a retry changes, and is
  // empty while inactive. `loading` is derived from it (not set in an effect),
  // so the very first render after activation already shows the loading state —
  // no one-frame flash of the empty copy before the effect runs.
  const key = active && url ? `${url}#${jsonBody ?? ""}#${nonce}` : "";

  useEffect(() => {
    if (!key || !url) return;
    // Abort the request on supersession (key/url change) or unmount so a slow
    // stale response can't touch state, matching the Booker guard (#629/#698).
    // `cancelled` still gates every setState below: abort races the resolution,
    // so the flag is the authoritative "ignore this run" signal.
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
          ...(jsonBody !== undefined
            ? {
                method: "POST",
                body: jsonBody,
                headers: { "content-type": "application/json", ...(headers ?? {}) },
              }
            : headers
              ? { headers }
              : {}),
        });
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as unknown;
          if (!cancelled) setState({ key, items: extract(json), error: false, payload: json, errorPayload: null });
        } else {
          const body = (await res.json().catch(() => null)) as unknown;
          if (!cancelled) {
            setState((prev) => ({ key, items: [], error: true, payload: prev.payload, errorPayload: body }));
          }
        }
      } catch {
        // Aborts (supersession/unmount) leave state to the newer/next run; only
        // a live failure surfaces the retry affordance.
        if (!cancelled) {
          setState((prev) => ({ key, items: [], error: true, payload: prev.payload, errorPayload: null }));
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, url, extract, headers, jsonBody]);

  const settled = key !== "" && state.key === key;
  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return {
    items: settled ? state.items : [],
    loading: key !== "" && !settled,
    error: settled && state.error,
    retry,
    payload: state.payload,
    errorPayload: settled && state.error ? state.errorPayload : null,
  };
}

/**
 * Renders one of four states for an async list: loading skeletons, an error
 * with a retry, the caller's empty node, or the children.
 *
 * A single persistent `role="status"` polite live region sits above the visual
 * branch and carries the current announcement (#633): the loading label, then
 * the settled count (`resultLabel`) or empty message (`emptyLabel`). Because the
 * region stays mounted across the load→settle swap, assistive tech announces the
 * outcome, so a screen-reader user selecting a day hears the count instead of
 * silence. Errors are announced by the `role="alert"` below, so the polite
 * region stays quiet in that state to avoid a double read.
 */
export function AsyncListStates({
  loading,
  error,
  isEmpty,
  onRetry,
  loadingLabel,
  resultLabel,
  emptyLabel,
  skeletonCount,
  skeletonClassName,
  containerClassName,
  emptyNode,
  children,
}: {
  loading: boolean;
  error: boolean;
  isEmpty: boolean;
  onRetry: () => void;
  loadingLabel: string;
  /** Announced once the list settles with items, e.g. "12 times available". */
  resultLabel?: string;
  /** Announced once the list settles empty, e.g. "No times left". */
  emptyLabel?: string;
  skeletonCount: number;
  skeletonClassName: string;
  /** Wraps the skeletons so they match the populated list's layout (grid/rows). */
  containerClassName?: string;
  emptyNode: ReactNode;
  children: ReactNode;
}) {
  const announcement = loading
    ? loadingLabel
    : error
      ? ""
      : isEmpty
        ? (emptyLabel ?? "")
        : (resultLabel ?? "");

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      {loading ? (
        // aria-hidden: the polite region above already announces the load.
        <div aria-hidden="true" className={containerClassName}>
          {Array.from({ length: skeletonCount }).map((_, i) => (
            <div key={i} className={`animate-pulse rounded-md bg-fg/10 ${skeletonClassName}`} />
          ))}
        </div>
      ) : error ? (
        <div className="space-y-2">
          <p role="alert" className="flex items-start gap-2 text-sm text-[var(--error)]">
            <span className="mt-0.5 shrink-0">
              <AlertIcon width={15} height={15} />
            </span>
            Couldn&apos;t load. Check your connection.
          </p>
          <button
            onClick={onRetry}
            className="inline-flex min-h-9 items-center rounded-md border border-border px-3 text-sm text-fg hover:border-fg/45"
          >
            Try again
          </button>
        </div>
      ) : isEmpty ? (
        <>{emptyNode}</>
      ) : (
        <>{children}</>
      )}
    </>
  );
}
