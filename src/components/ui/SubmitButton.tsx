"use client";

import { useFormStatus } from "react-dom";

/**
 * Submit button that reflects the form action's in-flight state via
 * useFormStatus: disabled + a spinner + a "doing it" label while pending, so a
 * submit never feels like nothing happened. Must live inside the <form>.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={className}>
      {pending ? (
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
          />
          {pendingLabel}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
