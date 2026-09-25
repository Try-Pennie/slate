"use client";

import BookerErrorBoundary from "@/components/BookerErrorBoundary";

// The booker's boundary for `/booking/{salesforceId}`, the entry every trypennie
// link uses (#2732). Without it a throw here (the landing bucket read, or the
// Salesforce read for a blank code, #2638) reached `global-error`, which blanks
// the embedded frame and tells the host page nothing. The behaviour lives in the
// shared component so this route and `/book` cannot drift.
export default function BookingError(props: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <BookerErrorBoundary {...props} page="/booking/[id]" />;
}
