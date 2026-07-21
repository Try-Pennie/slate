"use client";

import { useRouter } from "next/navigation";
import type { FormEvent, ReactNode } from "react";

/**
 * A GET-style filter form that navigates client-side instead of performing a
 * native form submit. A native GET submit is a hard document reload: on a
 * `force-dynamic` page the whole server component re-renders, the page flashes,
 * and the scroll position resets (#951). Instead, this intercepts the submit
 * (fired by an {@link AutoSubmitSelect} change, a "Search" button, or Enter in
 * a text field), builds a query string from the form's own fields, and does a
 * scroll-preserving `router.replace`, so only the list region swaps in.
 *
 * Filter state still lives in the URL, so it stays shareable and survives a
 * manual refresh. With JS off it degrades to a plain GET form pointed at
 * `action`.
 */
export function FilterForm({
  action,
  className,
  id,
  children,
}: {
  action: string;
  className?: string;
  id?: string;
  children: ReactNode;
}) {
  const router = useRouter();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(e.currentTarget).entries()) {
      const v = typeof value === "string" ? value.trim() : "";
      if (v) params.set(key, v);
    }
    const qs = params.toString();
    router.replace(`${action}${qs ? `?${qs}` : ""}`, { scroll: false });
  }

  return (
    <form method="get" action={action} id={id} className={className} onSubmit={onSubmit}>
      {children}
    </form>
  );
}
