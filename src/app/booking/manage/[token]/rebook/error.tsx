"use client";

import BookerErrorBoundary from "@/components/BookerErrorBoundary";
import { REBOOK_ROUTE } from "@/lib/booking/book-link";

// The booker's boundary for the rebook page (#2982), the same shared one the
// other booker routes use, so a throw here offers a retry rather than reaching
// global-error.
export default function RebookError(props: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <BookerErrorBoundary {...props} page={REBOOK_ROUTE} />;
}
