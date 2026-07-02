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
): { items: T[]; loading: boolean; error: boolean; retry: () => void } {
  const [state, setState] = useState<{ key: string; items: T[]; error: boolean }>({
    key: "",
    items: [],
    error: false,
  });
  const [nonce, setNonce] = useState(0);

  // The request identity: changes when the target or a retry changes, and is
  // empty while inactive. `loading` is derived from it (not set in an effect),
  // so the very first render after activation already shows the loading state —
  // no one-frame flash of the empty copy before the effect runs.
  const key = active && url ? `${url}#${nonce}` : "";

  useEffect(() => {
    if (!key || !url) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as unknown;
          if (!cancelled) setState({ key, items: extract(json), error: false });
        } else {
          setState({ key, items: [], error: true });
        }
      } catch {
        if (!cancelled) setState({ key, items: [], error: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, url, extract]);

  const settled = key !== "" && state.key === key;
  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return {
    items: settled ? state.items : [],
    loading: key !== "" && !settled,
    error: settled && state.error,
    retry,
  };
}

/**
 * Renders one of four states for an async list: loading skeletons, an error
 * with a retry, the caller's empty node, or the children. The skeleton region
 * is a labelled `role="status"` live region so assistive tech announces the
 * "still loading" state rather than a misleading empty message.
 */
export function AsyncListStates({
  loading,
  error,
  isEmpty,
  onRetry,
  loadingLabel,
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
  skeletonCount: number;
  skeletonClassName: string;
  /** Wraps the skeletons so they match the populated list's layout (grid/rows). */
  containerClassName?: string;
  emptyNode: ReactNode;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div role="status" aria-label={loadingLabel} className={containerClassName}>
        {Array.from({ length: skeletonCount }).map((_, i) => (
          <div key={i} className={`animate-pulse rounded-md bg-fg/10 ${skeletonClassName}`} />
        ))}
        <span className="sr-only">{loadingLabel}</span>
      </div>
    );
  }
  if (error) {
    return (
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
    );
  }
  if (isEmpty) return <>{emptyNode}</>;
  return <>{children}</>;
}
