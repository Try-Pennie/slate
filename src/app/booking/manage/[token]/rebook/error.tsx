"use client";

import BookerErrorBoundary from "@/components/BookerErrorBoundary";

// The booker's boundary for the rebook page (#2982), the same shared one the
// other booker routes use, so a throw here offers a retry rather than reaching
// global-error.
export default function RebookError(props: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <BookerErrorBoundary {...props} page="/booking/manage/[token]/rebook" />;
}
