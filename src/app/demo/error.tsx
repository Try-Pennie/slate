"use client";

import BookerErrorBoundary from "@/components/BookerErrorBoundary";

// The booker's boundary for the demo page (#3424), the same shared component the
// other booker routes use (#2732), so a broken demo fails the way a broken booker does.
export default function DemoError(props: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <BookerErrorBoundary {...props} page="/demo" />;
}
