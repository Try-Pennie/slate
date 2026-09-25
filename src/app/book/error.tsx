"use client";

import BookerErrorBoundary from "@/components/BookerErrorBoundary";

// The booker's boundary for the standalone `/book` page (#2658). The behaviour
// lives in the shared component so the two booker routes cannot drift (#2732).
export default function BookError(props: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <BookerErrorBoundary {...props} page="/book" />;
}
